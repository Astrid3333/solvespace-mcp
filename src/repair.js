"use strict";
// Mesh repair for open (non-watertight) STLs: detect naked (boundary) edges,
// group them into directed loops, and cap each closed loop with an
// ear-clipped triangulation of its Newell-plane projection. Every boundary
// edge is reused exactly once in reverse winding, so measureStl reports
// nakedEdges=0 afterwards.
//
// Honest reporting: loops that do not close (open sheets) and pre-existing
// degenerate edges are counted, never silently dropped. A cap of a
// non-planar loop still closes the topology; its planarity deviation (mm,
// Newell plane) is reported so the caller can judge the geometry. If
// ear-clipping fails (degenerate projection), a centroid fan is used as
// fallback and the method per loop is reported.

const { readStlTris, weldPoint } = require("./measure.js");
const { writeBinaryStl } = require("./stlmerge.js");

// Same key as measureStl (weld to 1e-6 grid, then 4 decimals) so the loop
// detection agrees exactly with the naked-edge count we are trying to fix.
function vkey(p) {
  const w = weldPoint(p);
  return `${w[0].toFixed(4)},${w[1].toFixed(4)},${w[2].toFixed(4)}`;
}

function edgeKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// Directed boundary edges (a->b as wound in their owning triangle).
function nakedEdges(tris) {
  const keys = tris.map((t) => t.map(vkey));
  const count = new Map();
  for (const t of keys)
    for (let i = 0; i < 3; i++) {
      const k = edgeKey(t[i], t[(i + 1) % 3]);
      count.set(k, (count.get(k) || 0) + 1);
    }
  const dir = [];
  let degenerate = 0;
  for (let ti = 0; ti < tris.length; ti++) {
    const t = keys[ti];
    for (let i = 0; i < 3; i++) {
      const a = t[i], b = t[(i + 1) % 3];
      if (count.get(edgeKey(a, b)) !== 1) continue;
      if (a === b) {
        degenerate++; // zero-length edge: no cap can cover it, report honestly
        continue;
      }
      dir.push({ a, b });
    }
  }
  return { dir, degenerate };
}

// Walk directed edges into loops (closed) or chains (open boundary).
function walkLoops(edges) {
  const out = new Map();
  edges.forEach((e, i) => {
    if (!out.has(e.a)) out.set(e.a, []);
    out.get(e.a).push(i);
  });
  const used = new Array(edges.length).fill(false);
  const loops = [];
  const chains = [];
  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue;
    const walk = [i];
    used[i] = true;
    let v = edges[i].b;
    while (v !== edges[i].a) {
      const cand = (out.get(v) || []).find((j) => !used[j]);
      if (cand === undefined) break;
      used[cand] = true;
      walk.push(cand);
      v = edges[cand].b;
    }
    if (v === edges[i].a) loops.push(walk);
    else chains.push(walk);
  }
  return { loops, chains };
}

// Orthonormal basis (u, v) on the plane with unit normal n.
function planeBasis(nx, ny, nz) {
  // Pick the world axis least aligned with n for numerical stability.
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  let a;
  if (ax <= ay && ax <= az) a = [1, 0, 0];
  else if (ay <= az) a = [0, 1, 0];
  else a = [0, 0, 1];
  // u = normalize(a - (a.n) n)
  let ux = a[0] - (a[0] * nx + a[1] * ny + a[2] * nz) * nx;
  let uy = a[1] - (a[0] * nx + a[1] * ny + a[2] * nz) * ny;
  let uz = a[2] - (a[0] * nx + a[1] * ny + a[2] * nz) * nz;
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  // v = n x u  =>  u x v = n
  return [ux, uy, uz, ny * uz - nz * uy, nz * ux - nx * uz, nx * uy - ny * ux];
}

// Signed double-area of a 2D polygon (shoelace).
function shoelace2(pts, idx) {
  let s = 0;
  for (let i = 0; i < idx.length; i++) {
    const a = pts[idx[i]], b = pts[idx[(i + 1) % idx.length]];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
}

// 2D cross product of (b-o) x (c-o).
function cross2(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

// Strict point-in-triangle (no boundary) so colinear vertices don't block ears.
function pointInTri(p, a, b, c) {
  const d1 = cross2(a, b, p);
  const d2 = cross2(b, c, p);
  const d3 = cross2(c, a, p);
  return d1 > 0 && d2 > 0 && d3 > 0;
}

// Ear-clipping triangulation of a simple 2D polygon.
// Returns array of triangles [i, j, k] (indices into pts), CCW, or null on failure.
function earClip2D(pts) {
  const n = pts.length;
  if (n < 3) return null;
  if (n === 3) return [[0, 1, 2]];

  let idx = Array.from({ length: n }, (_, i) => i);
  if (shoelace2(pts, idx) < 0) idx.reverse(); // ensure CCW

  const out = [];
  let remaining = idx.slice();
  const guard = n * n + 8;
  let steps = 0;
  while (remaining.length > 3) {
    if (steps++ > guard) return null; // degenerate: give up, caller falls back
    let clipped = false;
    for (let i = 0; i < remaining.length; i++) {
      const ia = remaining[(i + remaining.length - 1) % remaining.length];
      const ib = remaining[i];
      const ic = remaining[(i + 1) % remaining.length];
      const a = pts[ia], b = pts[ib], c = pts[ic];
      if (cross2(a, b, c) <= 0) continue; // reflex or colinear: not an ear
      let hasPoint = false;
      for (const j of remaining) {
        if (j === ia || j === ib || j === ic) continue;
        if (pointInTri(pts[j], a, b, c)) { hasPoint = true; break; }
      }
      if (hasPoint) continue;
      out.push([ia, ib, ic]);
      remaining.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) return null; // stuck (self-touching projection): fallback
  }
  if (remaining.length === 3) out.push([remaining[0], remaining[1], remaining[2]]);
  return out.length > 0 ? out : null;
}

// Cap one closed ring of welded points: project onto the Newell plane,
// ear-clip the 2D polygon, flip winding so each boundary edge a->b is
// covered by cap edge b->a. Falls back to a centroid fan if ear-clipping
// fails. Returns { tris, deviation, method }.
function capLoop(ring, keyFn) {
  const n = ring.length;

  // Newell normal + centroid + planarity deviation
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const nl = Math.hypot(nx, ny, nz);
  let c = [0, 0, 0];
  for (const p of ring) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  c = [c[0] / n, c[1] / n, c[2] / n];

  let deviation = 0;
  if (nl > 0) {
    const [ux, uy, uz] = [nx / nl, ny / nl, nz / nl];
    for (const p of ring) {
      const d = Math.abs((p[0] - c[0]) * ux + (p[1] - c[1]) * uy + (p[2] - c[2]) * uz);
      if (d > deviation) deviation = d;
    }
  }

  // --- ear-clip path ---
  if (nl > 0 && n >= 3) {
    const nnx = nx / nl, nny = ny / nl, nnz = nz / nl;
    const [u0, u1, u2, v0, v1, v2] = planeBasis(nnx, nny, nnz);
    const pts2 = ring.map((p) => {
      const dx = p[0] - c[0], dy = p[1] - c[1], dz = p[2] - c[2];
      return [dx * u0 + dy * u1 + dz * u2, dx * v0 + dy * v1 + dz * v2];
    });
    const trisIdx = earClip2D(pts2);
    if (trisIdx) {
      const ck = keyFn(c);
      const tris = [];
      for (const [i, j, k] of trisIdx) {
        // Flip [i,j,k] -> [k,j,i] so cap covers boundary a->b with b->a
        const a = ring[k], b = ring[j], d = ring[i];
        const ka = keyFn(a), kb = keyFn(b), kd = keyFn(d);
        if (ka === kb || kb === kd || kd === ka || ka === ck || kb === ck || kd === ck) continue;
        tris.push([a, b, d]);
      }
      if (tris.length > 0) return { tris, deviation, method: "earclip" };
    }
  }

  // --- fan fallback ---
  const ck = keyFn(c);
  if (ring.some((p) => keyFn(p) === ck)) {
    c = [c[0] + 1e-3, c[1] + 1e-3, c[2] + 1e-3];
  }
  const tris = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    if (keyFn(a) === keyFn(b) || keyFn(a) === ck || keyFn(b) === ck) continue;
    tris.push([b, a, c]);
  }
  return { tris, deviation, method: "fan" };
}

/**
 * Cap the holes of an open STL mesh.
 * @param {string} inFile  input STL
 * @param {string} outFile output STL (welded originals + cap triangles)
 * @returns {object} repair report with before/after watertightness
 */
function repairStl(inFile, outFile) {
  const tris = readStlTris(inFile).map((t) => t.map(weldPoint));
  const { dir, degenerate } = nakedEdges(tris);
  const nakedBefore = dir.length + degenerate; // what measureStl reports

  if (nakedBefore === 0) {
    return {
      alreadyWatertight: true,
      input: { triangles: tris.length, nakedEdges: 0 },
      loops: 0, capped: 0, uncapped: 0, uncappedEdges: 0, degenerate: 0,
      addedTriangles: 0,
      deviationsMm: [],
      methods: [],
      output: null,
    };
  }

  const pts = new Map(); // key -> welded point (first occurrence wins)
  for (const t of tris) for (const p of t) if (!pts.has(vkey(p))) pts.set(vkey(p), p);
  const dirPts = dir.map((e) => ({ a: e.a, b: e.b, pa: pts.get(e.a), pb: pts.get(e.b) }));
  if (dirPts.some((e) => !e.pa || !e.pb)) {
    throw new Error("internal: naked edge vertex missing from mesh index");
  }

  const { loops, chains } = walkLoops(dirPts);
  const caps = [];
  const deviations = [];
  const methods = [];
  for (const loop of loops) {
    const ring = loop.map((i) => dirPts[i].pa);
    const r = capLoop(ring, vkey);
    caps.push(...r.tris);
    deviations.push(+r.deviation.toFixed(6));
    methods.push(r.method);
  }

  const out = tris.concat(caps);
  writeBinaryStl(out, outFile, "solvespace-mcp repair");

  const after = nakedEdges(out);
  return {
    alreadyWatertight: false,
    input: { triangles: tris.length, nakedEdges: nakedBefore },
    loops: loops.length,
    capped: loops.length,
    uncapped: chains.length,
    uncappedEdges: chains.reduce((s, w) => s + w.length, 0),
    degenerate,
    addedTriangles: caps.length,
    deviationsMm: deviations,
    methods,
    output: {
      path: outFile,
      triangles: out.length,
      nakedEdges: after.dir.length + after.degenerate,
      isClosed: after.dir.length + after.degenerate === 0,
    },
  };
}

module.exports = { repairStl };
