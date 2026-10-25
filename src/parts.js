"use strict";
// Parametric part generators. Each takes a params object and returns a model spec
// consumable by buildSlvs(). Units: millimeters. Angles: degrees.

const { buildSlvs } = require("./slvs");

// --- helpers ---

function circleEntities(cx, cy, r) {
  return [{ id: "c0", type: "circle", center: [cx, cy], r }];
}

// closed polygon from [[x,y],...]
function polygonLines(pts, idPrefix = "L") {
  const ents = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    ents.push({ id: `${idPrefix}${i}`, type: "line", a, b });
  }
  return ents;
}

// arc entities for a rounded-rect (4 corners). cornerR = corner radius.
// returns lines + arcs; total outer profile closed.
function roundedRect(w, h, cornerR) {
  if (cornerR <= 0) return polygonLines([[0,0],[w,0],[w,h],[0,h]]);
  const r = cornerR;
  const ents = [];
  // corners at (r,r), (w-r,r), (w-r,h-r), (r,h-r)
  // lines: bottom, right, top, left
  ents.push({ id:"lb", type:"line", a:[r,0], b:[w-r,0] });
  ents.push({ id:"lr", type:"line", a:[w,r], b:[w,h-r] });
  ents.push({ id:"lt", type:"line", a:[w-r,h], b:[r,h] });
  ents.push({ id:"ll", type:"line", a:[0,h-r], b:[0,r] });
  // arcs: bottom-right, top-right, top-left, bottom-left (CCW)
  ents.push({ id:"abr", type:"arc", center:[w-r,r], start:[w, r], end:[w-r, 0] });
  ents.push({ id:"atr", type:"arc", center:[w-r,h-r], start:[w-r, h], end:[w, h-r] });
  ents.push({ id:"atl", type:"arc", center:[r,h-r], start:[r, h], end:[w-r===r?r:r, h-r] , });
  // fix top-left arc: start top edge end (r,h), end left edge (0, h-r)
  ents[ents.length-1] = { id:"atl", type:"arc", center:[r,h-r], start:[r, h], end:[0, h-r] };
  ents.push({ id:"abl", type:"arc", center:[r,r], start:[0, r], end:[r, 0] });
  return ents;
}

// --- generators ---

/**
 * Flange: circular plate, central bore, N bolt holes on a bolt circle.
 */
function flange(p = {}) {
  const {
    outerD = 100, boreD = 40, boltCircleD = 70, boltD = 10,
    nBolts = 6, thickness = 10,
  } = p;
  const R = outerD / 2, bore = boreD / 2, bcd = boltCircleD / 2, br = boltD / 2;
  const n = Math.max(3, Math.round(nBolts));
  const params = { R, bore, bcd, br, thickness, n };
  // Single-sketch CSG leaves tessellation artifacts (naked edges); cut the
  // bore + bolt holes with a symmetric difference instead (watertight).
  const holes = [{ id: "bore", type: "circle", center: [0, 0], r: "bore" }];
  for (let k = 0; k < n; k++) {
    const ang = (k * 2 * Math.PI) / n;
    holes.push({
      id: `b${k}`, type: "circle",
      center: [`bcd * ${Math.cos(ang)}`, `bcd * ${Math.sin(ang)}`],
      r: "br",
    });
  }
  return {
    name: "flange",
    params,
    sketches: [
      { name: "profile", plane: "XY", entities: [{ id: "outer", type: "circle", center: [0, 0], r: "R" }] },
      { name: "holes", plane: "XY", entities: holes },
    ],
    operations: [
      { type: "extrude", from: "profile", vector: [0, 0, "thickness"], name: "solid" },
      {
        type: "extrude",
        from: "holes",
        vector: [0, 0, "thickness * 2 + 4"],
        symmetric: true,
        combine: "difference",
        name: "bore+bolts",
      },
    ],
  };
}

/**
 * L-bracket: vertical + horizontal leg, extruded along Z (depth).
 */
function lBracket(p = {}) {
  const { width = 60, height = 40, leg = 8, depth = 30 } = p;
  // L profile in XY: outer L
  const pts = [
    [0, 0], [width, 0], [width, leg],
    [leg, leg], [leg, height], [0, height],
  ];
  return {
    name: "l_bracket",
    params: { width, height, leg, depth },
    sketches: [{
      name: "profile", plane: "XY",
      entities: polygonLines(pts),
    }],
    operations: [
      { type: "extrude", from: "profile", vector: [0, 0, "depth"], name: "solid" },
    ],
  };
}

/**
 * Tube / spacer: lathe of a rectangle offset from the axis.
 */
function tube(p = {}) {
  const { innerR = 8, outerR = 12, height = 20 } = p;
  // profile on XY, lathe around Y axis... actually lathe around X? 
  // our lathe: axis is typically Y for vertical parts; use axis [0,1,0]
  // profile: rectangle from (innerR, 0) to (outerR, height) — wait lathe expects
  // profile in a plane containing the axis. Use XY plane, axis = Y, profile
  // is a vertical strip at x in [innerR, outerR], y in [0, height].
  return {
    name: "tube",
    params: { innerR, outerR, height },
    sketches: [{
      name: "profile", plane: "XY",
      entities: polygonLines([
        ["innerR", 0], ["outerR", 0], ["outerR", "height"], ["innerR", "height"],
      ]),
    }],
    operations: [
      { type: "lathe", from: "profile", center: [0, 0, 0], axis: [0, 1, 0], name: "solid" },
    ],
  };
}

/**
 * Pulley blank: lathe of stepped profile (hub + rim), with optional bore.
 */
function pulley(p = {}) {
  const { rimR = 30, hubR = 12, boreR = 5, rimW = 10, hubW = 20 } = p;
  // profile: from axis outward — stepped: (0,0)->(boreR? use solid hub) 
  // simple: outer cylinder rimR over width rimW, plus smaller hub cylinder.
  // lathe of an L-profile: points (boreR,0),(rimR,0),(rimR,rimW),(hubR,rimW),(hubR,hubW),(boreR,hubW)
  // For a solid pulley without bore, start from 0.
  const pts = [
    [0, 0], [rimR, 0], [rimR, rimW],
    [hubR, rimW], [hubR, hubW], [0, hubW],
  ];
  return {
    name: "pulley",
    params: { rimR, hubR, boreR, rimW, hubW },
    sketches: [{
      name: "profile", plane: "XY",
      entities: polygonLines(pts.map(([x, y]) =>
        typeof x === "string" ? [x, y] : [x, y])),
    }],
    operations: [
      { type: "lathe", from: "profile", center: [0, 0, 0], axis: [0, 1, 0], name: "solid" },
    ],
  };
}

/**
 * Coil spring: helix of a small circular cross-section.
 */
function spring(p = {}) {
  const { coilR = 15, wireR = 2, coils = 5, pitch = 8 } = p;
  return {
    name: "spring",
    params: { coilR, wireR, coils, pitch },
    sketches: [{
      name: "wire", plane: "XY",
      entities: [{ id: "w", type: "circle", center: ["coilR", 0], r: "wireR" }],
    }],
    operations: [{
      type: "helix", from: "wire",
      center: [0, 0, 0], axis: [0, 0, 1],
      angleDeg: "coils * 360", distance: "coils * pitch",
      name: "solid",
    }],
  };
}

/**
 * Plate with slot: rounded-rect outer + elongated slot cutout (approx via two arcs + lines).
 */
function plateSlot(p = {}) {
  const { w = 80, h = 40, cornerR = 8, slotL = 30, slotW = 8, thickness = 6 } = p;
  const sw = slotW / 2, sl = slotL / 2;
  const outer = roundedRect(w, h, cornerR);
  // slot: two horizontal lines + two semicircle arcs
  const slot = [
    { id: "slb", type: "line", a: [w/2 - sl, h/2 - sw], b: [w/2 + sl, h/2 - sw] },
    { id: "slt", type: "line", a: [w/2 + sl, h/2 + sw], b: [w/2 - sl, h/2 + sw] },
    { id: "slr", type: "arc", center: [w/2 + sl, h/2], start: [w/2 + sl, h/2 + sw], end: [w/2 + sl, h/2 - sw] },
    { id: "sll", type: "arc", center: [w/2 - sl, h/2], start: [w/2 - sl, h/2 - sw], end: [w/2 - sl, h/2 + sw] },
  ];
  return {
    name: "plate_slot",
    params: { w, h, cornerR, slotL, slotW, thickness },
    sketches: [{
      name: "profile", plane: "XY",
      entities: [...outer, ...slot],
    }],
    operations: [
      { type: "extrude", from: "profile", vector: [0, 0, "thickness"], name: "solid" },
    ],
  };
}

/**
 * Hex nut: hexagonal prism (6 lines) with central bore, extruded.
 */
function hexNut(p = {}) {
  const { acrossFlats = 20, boreD = 10, thickness = 8 } = p;
  const R = acrossFlats / 2 / Math.cos(Math.PI / 6); // circumradius
  const bore = boreD / 2;
  const pts = [];
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3 + Math.PI / 6;
    pts.push([`R * ${Math.cos(a)}`, `R * ${Math.sin(a)}`]);
  }
  return {
    name: "hex_nut",
    params: { R, bore, thickness },
    sketches: [{
      name: "profile", plane: "XY",
      entities: [
        ...polygonLines(pts),
        { id: "bore", type: "circle", center: [0, 0], r: "bore" },
      ],
    }],
    operations: [
      { type: "extrude", from: "profile", vector: [0, 0, "thickness"], name: "solid" },
    ],
  };
}

/**
 * Cone / funnel: lathe of a right triangle profile (optionally hollow).
 */
function cone(p = {}) {
  const { baseR = 25, topR = 8, height = 30, wall = 0 } = p;
  // solid cone: triangle (0,0)->(baseR,0)->(topR,height)->(0,height)
  // hollow (wall>0): offset profile inward
  let pts;
  if (wall > 0) {
    pts = [
      [baseR, 0], [topR, height],
      [topR - wall, height], [baseR - wall, 0],
    ];
  } else {
    pts = [[0, 0], [baseR, 0], [topR, height], [0, height]];
  }
  return {
    name: "cone",
    params: { baseR, topR, height, wall },
    sketches: [{
      name: "profile", plane: "XY",
      entities: polygonLines(pts),
    }],
    operations: [
      { type: "lathe", from: "profile", center: [0, 0, 0], axis: [0, 1, 0], name: "solid" },
    ],
  };
}

/**
 * Drilled plate: rectangular plate with a grid of through holes, cut with a
 * parametric boolean (Group.meshCombine = difference). The hole extrusion is
 * symmetric about z=0 so its faces pierce both plate faces without becoming
 * coplanar with them.
 */
function drilledPlate(p = {}) {
  const { w = 60, h = 40, thickness = 8, holeD = 6, margin = 7, nHolesX = 2, nHolesY = 2 } = p;
  if (nHolesX < 1 || nHolesY < 1) throw new Error("drilledPlate: nHolesX/nHolesY must be >= 1");
  const holes = [];
  for (let i = 0; i < nHolesX; i++) {
    for (let j = 0; j < nHolesY; j++) {
      const x = nHolesX === 1 ? w / 2 : margin + (i * (w - 2 * margin)) / (nHolesX - 1);
      const y = nHolesY === 1 ? h / 2 : margin + (j * (h - 2 * margin)) / (nHolesY - 1);
      holes.push({ id: `h${i}_${j}`, type: "circle", center: [x, y], r: "holeD / 2" });
    }
  }
  return {
    name: "drilled_plate",
    params: { w, h, thickness, holeD, margin, nHolesX, nHolesY },
    sketches: [
      {
        name: "profile", plane: "XY",
        entities: [
          { id: "a", type: "line", a: [0, 0], b: ["w", 0] },
          { id: "b", type: "line", a: ["w", 0], b: ["w", "h"] },
          { id: "c", type: "line", a: ["w", "h"], b: [0, "h"] },
          { id: "d", type: "line", a: [0, "h"], b: [0, 0] },
        ],
      },
      { name: "holes", plane: "XY", entities: holes },
    ],
    operations: [
      { type: "extrude", from: "profile", vector: [0, 0, "thickness"], name: "body" },
      {
        type: "extrude",
        from: "holes",
        vector: [0, 0, "thickness * 2 + 4"],
        symmetric: true,
        combine: "difference",
        name: "holes",
      },
    ],
  };
}

module.exports = { flange, lBracket, tube, pulley, spring, plateSlot, hexNut, cone, drilledPlate, buildSlvs };

// --- registry for list_parts / create_part ---
const PART_REGISTRY = {
  flange: {
    fn: flange,
    title: "Flange",
    description: "Circular plate with central bore and N bolt holes on a bolt circle.",
    params: {
      outerD: { default: 100, min: 10, max: 1000, desc: "Outer diameter (mm)" },
      boreD: { default: 40, min: 1, max: 900, desc: "Central bore diameter (mm)" },
      boltCircleD: { default: 70, min: 5, max: 950, desc: "Bolt circle diameter (mm)" },
      boltD: { default: 10, min: 1, max: 100, desc: "Bolt hole diameter (mm)" },
      nBolts: { default: 6, min: 3, max: 36, desc: "Number of bolt holes" },
      thickness: { default: 10, min: 1, max: 200, desc: "Plate thickness (mm)" },
    },
  },
  lBracket: {
    fn: lBracket,
    title: "L-Bracket",
    description: "L-shaped bracket: vertical + horizontal leg, extruded along Z.",
    params: {
      width: { default: 60, min: 5, max: 500, desc: "Overall width (mm)" },
      height: { default: 40, min: 5, max: 500, desc: "Overall height (mm)" },
      leg: { default: 8, min: 1, max: 100, desc: "Leg thickness (mm)" },
      depth: { default: 30, min: 1, max: 500, desc: "Extrusion depth (mm)" },
    },
  },
  tube: {
    fn: tube,
    title: "Tube / Spacer",
    description: "Hollow cylinder (lathe of rectangular profile offset from axis).",
    params: {
      innerR: { default: 8, min: 0.5, max: 400, desc: "Inner radius (mm)" },
      outerR: { default: 12, min: 1, max: 500, desc: "Outer radius (mm)" },
      height: { default: 20, min: 1, max: 500, desc: "Height (mm)" },
    },
  },
  pulley: {
    fn: pulley,
    title: "Pulley Blank",
    description: "Stepped lathe profile: wide rim + narrower hub.",
    params: {
      rimR: { default: 30, min: 2, max: 500, desc: "Rim radius (mm)" },
      hubR: { default: 12, min: 1, max: 400, desc: "Hub radius (mm)" },
      boreR: { default: 5, min: 0, max: 300, desc: "Bore radius (mm, 0 = solid)" },
      rimW: { default: 10, min: 1, max: 300, desc: "Rim width (mm)" },
      hubW: { default: 20, min: 1, max: 400, desc: "Hub width (mm)" },
    },
  },
  spring: {
    fn: spring,
    title: "Coil Spring",
    description: "Helical spring of circular wire cross-section.",
    params: {
      coilR: { default: 15, min: 2, max: 300, desc: "Coil radius (mm)" },
      wireR: { default: 2, min: 0.5, max: 50, desc: "Wire radius (mm)" },
      coils: { default: 5, min: 1, max: 50, desc: "Number of coils" },
      pitch: { default: 8, min: 1, max: 100, desc: "Axial pitch per coil (mm)" },
    },
  },
  plateSlot: {
    fn: plateSlot,
    title: "Plate with Slot",
    description: "Rounded-rect plate with a central elongated slot cutout.",
    params: {
      w: { default: 80, min: 10, max: 500, desc: "Width (mm)" },
      h: { default: 40, min: 10, max: 500, desc: "Height (mm)" },
      cornerR: { default: 8, min: 0, max: 100, desc: "Corner radius (mm, 0 = sharp)" },
      slotL: { default: 30, min: 2, max: 400, desc: "Slot length (mm)" },
      slotW: { default: 8, min: 1, max: 100, desc: "Slot width (mm)" },
      thickness: { default: 6, min: 0.5, max: 100, desc: "Plate thickness (mm)" },
    },
  },
  hexNut: {
    fn: hexNut,
    title: "Hex Nut",
    description: "Hexagonal prism with central bore.",
    params: {
      acrossFlats: { default: 20, min: 3, max: 300, desc: "Width across flats (mm)" },
      boreD: { default: 10, min: 0.5, max: 200, desc: "Bore diameter (mm)" },
      thickness: { default: 8, min: 1, max: 100, desc: "Thickness (mm)" },
    },
  },
  cone: {
    fn: cone,
    title: "Cone / Funnel",
    description: "Lathe of a trapezoidal profile (optionally hollow with wall).",
    params: {
      baseR: { default: 25, min: 2, max: 500, desc: "Base radius (mm)" },
      topR: { default: 8, min: 0, max: 400, desc: "Top radius (mm)" },
      height: { default: 30, min: 1, max: 500, desc: "Height (mm)" },
      wall: { default: 0, min: 0, max: 100, desc: "Wall thickness (mm, 0 = solid)" },
    },
  },
  drilledPlate: {
    fn: drilledPlate,
    title: "Drilled Plate",
    description:
      "Rectangular plate with a grid of through holes cut by a boolean " +
      "(combine=difference, symmetric extrusion).",
    params: {
      w: { default: 60, min: 10, max: 500, desc: "Width (mm)" },
      h: { default: 40, min: 10, max: 500, desc: "Height (mm)" },
      thickness: { default: 8, min: 0.5, max: 100, desc: "Plate thickness (mm)" },
      holeD: { default: 6, min: 0.5, max: 100, desc: "Hole diameter (mm)" },
      margin: { default: 7, min: 0.5, max: 250, desc: "Hole center offset from edges (mm)" },
      nHolesX: { default: 2, min: 1, max: 20, desc: "Holes along X" },
      nHolesY: { default: 2, min: 1, max: 20, desc: "Holes along Y" },
    },
  },
};

module.exports.PART_REGISTRY = PART_REGISTRY;
module.exports.partNames = Object.keys(PART_REGISTRY);
