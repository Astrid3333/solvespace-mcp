"use strict";
// STL merge with rigid transform: used by the assemble tool.
// Reads binary/ASCII STLs, applies [rx,ry,rz] degrees + [tx,ty,tz] mm to each,
// writes a single binary STL.

const fs = require("node:fs");
const { readStlTris, weldPoint } = require("./measure");

function rotMatrix(rx, ry, rz) {
  // degrees → radians, XYZ order (apply X, then Y, then Z)
  const d = Math.PI / 180;
  const cx = Math.cos(rx * d), sx = Math.sin(rx * d);
  const cy = Math.cos(ry * d), sy = Math.sin(ry * d);
  const cz = Math.cos(rz * d), sz = Math.sin(rz * d);
  // R = Rz * Ry * Rx
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy,     cy * sx,                cy * cx],
  ];
}

function applyTransform(p, R, t) {
  return [
    R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2] + t[0],
    R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2] + t[1],
    R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2] + t[2],
  ];
}

function writeBinaryStl(tris, file, header = "solvespace-mcp assemble") {
  const n = tris.length;
  const buf = Buffer.alloc(84 + n * 50);
  buf.write(header, 0, "ascii");
  buf.writeUInt32LE(n, 80);
  for (let i = 0; i < n; i++) {
    const off = 84 + i * 50;
    const [a, b, c] = tris[i];
    // normal
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    buf.writeFloatLE(nx / len, off);
    buf.writeFloatLE(ny / len, off + 4);
    buf.writeFloatLE(nz / len, off + 8);
    let o = off + 12;
    for (const p of [a, b, c]) {
      buf.writeFloatLE(p[0], o); buf.writeFloatLE(p[1], o + 4); buf.writeFloatLE(p[2], o + 8);
      o += 12;
    }
  }
  fs.writeFileSync(file, buf);
  return { triangles: n };
}

/**
 * Weld float-noise vertices in an STL file (snap to 1e-6 grid, normalize -0).
 * Boolean ops leave sub-epsilon residues (e.g. -2e-14 vs 0) that fake open
 * edges; welding makes shared vertices byte-identical again. Rewrites the
 * file in place as binary STL. Returns { triangles, changed }.
 */
function weldStlFile(file) {
  const tris = readStlTris(file);
  let changed = 0;
  const welded = tris.map((t) =>
    t.map((p) => {
      const w = weldPoint(p);
      if (w[0] !== p[0] || w[1] !== p[1] || w[2] !== p[2] ||
          Object.is(p[0], -0) || Object.is(p[1], -0) || Object.is(p[2], -0)) changed++;
      return w;
    })
  );
  if (changed) writeBinaryStl(welded, file, "solvespace-mcp weld");
  return { triangles: welded.length, changed };
}

/**
 * Merge multiple STL files into one, applying a rigid transform per part.
 * parts: [{ stlPath, translate?:[x,y,z], rotate?:[rx,ry,rz] (degrees XYZ) }]
 * Returns { outFile, triangles, bbox }.
 */
function assembleStls(parts, outFile) {
  const all = [];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const tris = readStlTris(part.stlPath);
    const R = rotMatrix(...(part.rotate || [0, 0, 0]));
    const t = part.translate || [0, 0, 0];
    for (const tri of tris) {
      const nt = tri.map((p) => applyTransform(p, R, t));
      all.push(nt);
      for (const p of nt) {
        for (let k = 0; k < 3; k++) {
          if (p[k] < min[k]) min[k] = p[k];
          if (p[k] > max[k]) max[k] = p[k];
        }
      }
    }
  }
  writeBinaryStl(all, outFile);
  const size = max.map((m, i) => m - min[i]);
  return { outFile, triangles: all.length, bbox: { min, max, size } };
}

module.exports = { assembleStls, rotMatrix, applyTransform, writeBinaryStl, weldStlFile };
