"use strict";
// Cross-section of an STL mesh by a plane → SVG line segments.
// Plane: normal axis (x|y|z) + offset value in mm.
// Collects triangle-plane intersection segments, outputs a 2D SVG.

const fs = require("node:fs");
const { readStlTris } = require("./measure");

/**
 * Intersect mesh with plane axis=val.
 * axis: "x"|"y"|"z", val: mm.
 * Returns array of 2D segments [[u1,v1,u2,v2]] in the plane's 2D coords:
 *   z=const → (x,y);  x=const → (y,z);  y=const → (x,z).
 */
function sectionSegments(tris, axis, val) {
  const ai = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  const u = ai === 0 ? 1 : 0; // for z: u=x,v=y; for x: u=y,v=z; for y: u=x,v=z
  const v = ai === 2 ? 1 : 2;
  const segs = [];
  for (const [a, b, c] of tris) {
    const pts = [];
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const dp = p[ai] - val, dq = q[ai] - val;
      if ((dp <= 0 && dq > 0) || (dp > 0 && dq <= 0)) {
        const t = dp / (dp - dq);
        pts.push([
          p[0] + t * (q[0] - p[0]),
          p[1] + t * (q[1] - p[1]),
          p[2] + t * (q[2] - p[2]),
        ]);
      }
    }
    if (pts.length === 2) {
      segs.push([pts[0][u], pts[0][v], pts[1][u], pts[1][v]]);
    }
  }
  return segs;
}

/**
 * Write section segments as SVG.
 * segs: [[u1,v1,u2,v2], ...] 2D coords in mm.
 * Returns { svg, bounds } where bounds = {minU,minV,maxU,maxV}.
 */
function writeSectionSvg(segs, outFile, { pad = 5 } = {}) {
  if (segs.length === 0) throw new Error("section: no intersection segments (plane misses mesh?)");
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  for (const [u1, v1, u2, v2] of segs) {
    for (const [u, v] of [[u1, v1], [u2, v2]]) {
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
  }
  const w = maxU - minU + pad * 2;
  const h = maxV - minV + pad * 2;
  // SVG y axis is flipped relative to CAD y; flip v
  const lines = segs.map(([u1, v1, u2, v2]) => {
    const sx1 = u1 - minU + pad;
    const sy1 = maxV - v1 + pad;
    const sx2 = u2 - minU + pad;
    const sy2 = maxV - v2 + pad;
    return `<line x1="${sx1.toFixed(3)}" y1="${sy1.toFixed(3)}" x2="${sx2.toFixed(3)}" y2="${sy2.toFixed(3)}"/>`;
  }).join("\n");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(1)}" height="${h.toFixed(1)}" ` +
    `viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}">\n` +
    `<rect width="100%" height="100%" fill="white"/>\n` +
    `<g stroke="black" stroke-width="0.4">\n${lines}\n</g>\n</svg>\n`;
  fs.writeFileSync(outFile, svg);
  return { outFile, segmentCount: segs.length, bounds: { minU, minV, maxU, maxV }, width: w, height: h };
}

/**
 * Full section pipeline: STL file + plane → SVG file.
 */
function sectionStl(stlPath, axis, val, outFile) {
  const tris = readStlTris(stlPath);
  const segs = sectionSegments(tris, axis, val);
  const r = writeSectionSvg(segs, outFile);
  return r;
}

module.exports = { sectionStl, sectionSegments, writeSectionSvg };
