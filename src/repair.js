"use strict";
// Mesh repair for open (non-watertight) STLs: detect naked (boundary) edges,
// group them into directed loops, and cap each closed loop with a triangle
// fan from the loop centroid. Every boundary edge is reused exactly once in
// reverse winding, so measureStl reports nakedEdges=0 afterwards.
//
// Honest reporting: loops that do not close (open sheets) and pre-existing
// degenerate edges are counted, never silently dropped. A fan cap of a
// non-planar loop still closes the topology; its planarity deviation (mm,
// Newell plane) is reported so the caller can judge the geometry.

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

// Cap one closed ring of welded points: centroid fan, wound so each boundary
// edge a->b is covered by cap edge b->a. Returns { tris, deviation } where
// deviation = max distance of ring vertices from the Newell plane (mm).
function capLoop(ring, keyFn) {
  const n = ring.length;

  // centroid; nudge off any coinciding vertex so the fan keys stay distinct
  let c = [0, 0, 0];
  for (const p of ring) {
    c[0] += p[0]; c[1] += p[1]; c[2] += p[2];
  }
  c = [c[0] / n, c[1] / n, c[2] / n];
  const ck = keyFn(c);
  if (ring.some((p) => keyFn(p) === ck)) {
    c = [c[0] + 1e-3, c[1] + 1e-3, c[2] + 1e-3];
  }

  // Newell normal + planarity deviation
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const nl = Math.hypot(nx, ny, nz);
  let deviation = 0;
  if (nl > 0) {
    const [ux, uy, uz] = [nx / nl, ny / nl, nz / nl];
    for (const p of ring) {
      const d = Math.abs((p[0] - c[0]) * ux + (p[1] - c[1]) * uy + (p[2] - c[2]) * uz);
      if (d > deviation) deviation = d;
    }
  }

  const tris = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    if (keyFn(a) === keyFn(b) || keyFn(a) === ck || keyFn(b) === ck) continue;
    tris.push([b, a, c]); // reverse boundary edge a->b into b->a
  }
  return { tris, deviation };
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
  for (const loop of loops) {
    const ring = loop.map((i) => dirPts[i].pa);
    const r = capLoop(ring, vkey);
    caps.push(...r.tris);
    deviations.push(+r.deviation.toFixed(6));
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
    output: {
      path: outFile,
      triangles: out.length,
      nakedEdges: after.dir.length + after.degenerate,
      isClosed: after.dir.length + after.degenerate === 0,
    },
  };
}

module.exports = { repairStl };
