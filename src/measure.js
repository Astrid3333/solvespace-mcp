"use strict";
// STL mesh analysis: volume, surface area, center of mass, naked (boundary) edges.
// Volume/COM via signed tetrahedra (divergence theorem). Naked edges via edge counts.

const fs = require("node:fs");

// Parse binary or ASCII STL -> { triangles: [[ax,ay,az],[bx,by,bz],[cx,cy,cz]], ... }
function readStlTris(file) {
  const buf = fs.readFileSync(file);
  // Detect ASCII
  if (buf.length > 6 && buf.toString("utf8", 0, 5) === "solid") {
    // Could still be binary starting with "solid" — check length
    const n = buf.length >= 84 ? buf.readUInt32LE(80) : 0;
    if (84 + n * 50 === buf.length) return readBinaryTris(buf, n);
    return readAsciiTris(buf.toString("utf8"));
  }
  if (buf.length < 84) throw new Error(`STL too small: ${file}`);
  const n = buf.readUInt32LE(80);
  return readBinaryTris(buf, n);
}

function readBinaryTris(buf, n) {
  const tris = [];
  for (let i = 0; i < n; i++) {
    const off = 84 + i * 50;
    const t = [];
    for (let v = 0; v < 3; v++) {
      t.push([
        buf.readFloatLE(off + 12 + v * 12),
        buf.readFloatLE(off + 16 + v * 12),
        buf.readFloatLE(off + 20 + v * 12),
      ]);
    }
    tris.push(t);
  }
  return tris;
}

function readAsciiTris(text) {
  const tris = [];
  const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let m;
  let cur = [];
  while ((m = re.exec(text))) {
    cur.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
    if (cur.length === 3) {
      tris.push(cur);
      cur = [];
    }
  }
  return tris;
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function norm(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

// Weld tolerance: coordinates snapped to this grid (and -0 normalized) so that
// float noise from boolean ops (e.g. -2e-14 vs 0) does not fake open edges.
const WELD_EPS = 1e-6;
function weldCoord(v) {
  return Math.round(v / WELD_EPS) * WELD_EPS + 0;
}

function weldPoint(p) {
  return [weldCoord(p[0]), weldCoord(p[1]), weldCoord(p[2])];
}

/**
 * Full mesh analysis from STL file.
 * Returns { volume, surfaceArea, com:[x,y,z], triangleCount, nakedEdges, isClosed, bbox }.
 * volume in mm^3, area in mm^2. volume > 0 if normals are outward-consistent.
 */
function measureStl(file) {
  const tris = readStlTris(file);
  let vol6 = 0; // 6 * signed volume accumulator
  let area = 0;
  let cx = 0, cy = 0, cz = 0; // volume-weighted COM accumulators (6x)
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (const [a, b, c] of tris) {
    // signed volume of tetrahedron (origin, a, b, c) = dot(a, cross(b, c)) / 6
    const cr = cross(b, c);
    const v6 = dot(a, cr); // = 6 * signed volume
    vol6 += v6;
    // COM contribution of tetrahedron: (a+b+c+0)/4 * vol = (a+b+c)*v6/24
    cx += (a[0] + b[0] + c[0]) * v6;
    cy += (a[1] + b[1] + c[1]) * v6;
    cz += (a[2] + b[2] + c[2]) * v6;
    // surface area
    const cr2 = cross(sub(b, a), sub(c, a));
    area += 0.5 * norm(cr2);
    // bbox
    for (const p of [a, b, c]) {
      for (let k = 0; k < 3; k++) {
        if (p[k] < min[k]) min[k] = p[k];
        if (p[k] > max[k]) max[k] = p[k];
      }
    }
  }

  const volume = vol6 / 6;
  const com = volume !== 0
    ? [cx / (24 * (vol6 / 6)), cy / (24 * (vol6 / 6)), cz / (24 * (vol6 / 6))]
    : [0, 0, 0];

  // naked edges: count undirected edges; boundary = count === 1.
  // Vertices are welded first so float noise cannot fake open edges.
  const edgeCount = new Map();
  const key = (p) => {
    const w = weldPoint(p);
    return `${w[0].toFixed(4)},${w[1].toFixed(4)},${w[2].toFixed(4)}`;
  };
  for (const [a, b, c] of tris) {
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const ku = key(u), kv = key(v);
      const ek = ku < kv ? `${ku}|${kv}` : `${kv}|${ku}`;
      edgeCount.set(ek, (edgeCount.get(ek) || 0) + 1);
    }
  }
  let naked = 0;
  for (const cnt of edgeCount.values()) if (cnt === 1) naked++;

  const size = max.map((m, i) => m - min[i]);
  return {
    triangleCount: tris.length,
    volume,
    surfaceArea: area,
    com,
    nakedEdges: naked,
    isClosed: naked === 0,
    bbox: { min, max, size },
  };
}

module.exports = { measureStl, readStlTris, weldCoord, weldPoint, WELD_EPS };
