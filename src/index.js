#!/usr/bin/env node
"use strict";
// solvespace-mcp: MCP server driving SolveSpace CLI for parametric CAD.
// Tools: create model from JSON spec (.slvs), export STL/SVG/PNG, version.

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { buildSlvs, PLANES } = require("./slvs.js");
const cli = require("./cli.js");
const { PART_REGISTRY, partNames } = require("./parts.js");
const { measureStl } = require("./measure.js");
const { assembleStls } = require("./stlmerge.js");
const { sectionStl } = require("./section.js");

const BUILD_DIR = path.join(os.homedir(), "solvespace-mcp", "build");

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function stampName(prefix, ext) {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  return path.join(
    BUILD_DIR,
    `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.${ext}`
  );
}

const server = new McpServer({
  name: "solvespace-mcp",
  version: "0.1.0",
});

// JSON spec schema for the model. Kept loose (z.any) because the spec has
// sketches/constraints/operations nested structures; validation errors from
// buildSlvs are returned as tool errors with detail.
const modelSpecSchema = z.object({
  params: z.record(z.union([z.number(), z.string()])).optional()
    .describe("Named parameters, numbers or arithmetic expressions (e.g. {w:20, t:\"w/2\"})"),
  sketches: z.array(z.any()).describe(
    "Sketch definitions: {name, plane:'XY'|'YZ'|'ZX'|custom quaternion, entities:[{id,type,...}]}"
  ).optional(),
  constraints: z.array(z.any()).optional()
    .describe("Constraints: {type:'coincident'|'distance'|..., entities:[...], ...}"),
  operations: z.array(z.any()).optional()
    .describe("Operations: {type:'extrude'|'translate'|'rotate'|'lathe'|'revolve'|'helix', from:'sketchName', vector/angleDeg/copies, center+axis for rotation family, distance/pitch for helix}"),
});

const exportFormat = z.enum(["stl", "svg"]);
const viewDir = z.enum(["top", "bottom", "left", "right", "front", "back", "isometric"]);

server.registerTool(
  "create_model",
  {
    title: "Create SolveSpace model (.slvs)",
    description:
      "Build a parametric CAD model from a JSON spec and write it as a SolveSpace .slvs file. " +
      "Spec: {params:{name:number|expr}, sketches:[{name, plane, entities:[line|circle|arc|point]}], " +
      "constraints:[...], operations:[{type:extrude|translate|rotate|lathe|revolve|helix, from, vector|angleDeg|center+axis|distance|pitch, copies}]}. " +
      "Returns the .slvs path plus counts. Use export_model afterwards to get STL/PNG/SVG, " +
      "or model_to_stl for both steps at once.",
    inputSchema: {
      spec: modelSpecSchema,
      outfile: z.string().optional()
        .describe("Output .slvs path (default: auto under ~/solvespace-mcp/build/)"),
    },
  },
  async ({ spec, outfile }) => {
    let slvs;
    try {
      slvs = buildSlvs(spec);
    } catch (e) {
      return { content: [{ type: "text", text: `Spec error: ${e.message}` }], isError: true };
    }
    const file = outfile ? ensureParent(path.resolve(outfile)) : stampName("model", "slvs");
    fs.writeFileSync(file, slvs);
    const nSketch = (spec.sketches || []).length;
    const nOp = (spec.operations || []).length;
    const nCon = (spec.constraints || []).length;
    return {
      content: [{
        type: "text",
        text: `Wrote ${file}\nbytes=${slvs.length} sketches=${nSketch} constraints=${nCon} operations=${nOp}\n` +
          `Known planes: ${Object.keys(PLANES).join(", ")}. Next: export_model or model_to_stl.`,
      }],
    };
  }
);

server.registerTool(
  "export_model",
  {
    title: "Export SolveSpace model (STL/SVG)",
    description:
      "Run solvespace-cli on a .slvs file. format=stl returns triangle count + bounding box (mm). " +
      "format=svg with view=front|back|left|right|top|bottom|isometric exports a shaded view; " +
      "without view it exports the wireframe. chord_tolerance: mm, default 1.0 (smaller = finer mesh).",
    inputSchema: {
      slvs_path: z.string().describe("Path to the .slvs file"),
      format: exportFormat.default("stl"),
      view: viewDir.optional().describe("Camera direction for shaded SVG"),
      chord_tolerance: z.number().positive().optional(),
      outfile: z.string().optional().describe("Output path (default: alongside .slvs)"),
    },
  },
  async ({ slvs_path, format, view, chord_tolerance, outfile }) => {
    const slvsFile = path.resolve(slvs_path);
    if (!fs.existsSync(slvsFile)) {
      return { content: [{ type: "text", text: `File not found: ${slvsFile}` }], isError: true };
    }
    const base = slvsFile.replace(/\.slvs$/i, "");
    const outFile = outfile ? path.resolve(outfile) : `${base}.${format === "svg" ? "svg" : format}`;
    try {
      if (format === "stl") {
        const r = cli.exportMesh({ slvsFile, outFile, chordTolerance: chord_tolerance });
        const fmt3 = (a) => a.map((x) => +x.toFixed(3)).join(", ");
        return {
          content: [{
            type: "text",
            text: `STL: ${r.outFile}\ntriangles=${r.triangles}\nbbox min=(${fmt3(r.min)}) max=(${fmt3(r.max)})\nsize=(${fmt3(r.size)}) mm`,
          }],
        };
      }
      if (format === "svg" && view) {
        const r = cli.exportView({ slvsFile, outFile, view, chordTolerance: chord_tolerance });
        return { content: [{ type: "text", text: `SVG view: ${r.outFile} (${r.bytes} bytes)` }] };
      }
      const r = cli.exportWireframe({ slvsFile, outFile, view });
      return { content: [{ type: "text", text: `SVG wireframe: ${r.outFile} (${r.bytes} bytes)` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Export failed: ${e.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "model_to_stl",
  {
    title: "Parametric model -> STL in one step",
    description:
      "Build a .slvs from a JSON spec and export it to STL immediately. " +
      "Returns STL path, triangle count and bounding box. Convenience wrapper over create_model+export_model.",
    inputSchema: {
      spec: modelSpecSchema,
      chord_tolerance: z.number().positive().optional(),
      keep_slvs: z.boolean().default(true).describe("Keep the intermediate .slvs file"),
    },
  },
  async ({ spec, chord_tolerance, keep_slvs }) => {
    let slvs;
    try {
      slvs = buildSlvs(spec);
    } catch (e) {
      return { content: [{ type: "text", text: `Spec error: ${e.message}` }], isError: true };
    }
    const slvsFile = stampName("model", "slvs");
    const stlFile = slvsFile.replace(/\.slvs$/, ".stl");
    fs.writeFileSync(slvsFile, slvs);
    try {
      const r = cli.exportMesh({ slvsFile, outFile: stlFile, chordTolerance: chord_tolerance });
      if (!keep_slvs) fs.unlinkSync(slvsFile);
      const fmt3 = (a) => a.map((x) => +x.toFixed(3)).join(", ");
      return {
        content: [{
          type: "text",
          text: `STL: ${r.outFile}\nslvs=${keep_slvs ? slvsFile : "(deleted)"}\n` +
            `triangles=${r.triangles}\nsize=(${fmt3(r.size)}) mm\n` +
            `bbox min=(${fmt3(r.min)}) max=(${fmt3(r.max)})`,
        }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Export failed: ${e.message}\nslvs kept at ${slvsFile}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "solvespace_version",
  {
    title: "SolveSpace CLI version",
    description: "Return the solvespace-cli version in use.",
    inputSchema: {},
  },
  async () => {
    try {
      return { content: [{ type: "text", text: cli.version() }] };
    } catch (e) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  }
);

// ---- Parts library tools ----

server.registerTool(
  "list_parts",
  {
    title: "List parametric parts",
    description:
      "List the built-in parametric part generators with their parameters, defaults, and bounds. " +
      "Use create_part or part_to_stl to instantiate one.",
    inputSchema: {},
  },
  async () => {
    const lines = partNames.map((name) => {
      const meta = PART_REGISTRY[name];
      const params = Object.entries(meta.params)
        .map(([k, v]) => `  ${k}=${v.default} (${v.desc}; min=${v.min} max=${v.max})`)
        .join("\n");
      return `${name} — ${meta.title}: ${meta.description}\n${params}`;
    });
    return {
      content: [{
        type: "text",
        text: `Available parts (${partNames.length}):\n\n${lines.join("\n\n")}`,
      }],
    };
  }
);

server.registerTool(
  "create_part",
  {
    title: "Create parametric part (.slvs)",
    description:
      "Generate a parametric part from the built-in library and write it as a .slvs file. " +
      "part = flange|lBracket|tube|pulley|spring|plateSlot|hexNut|cone (see list_parts). " +
      "params overrides the defaults. Returns the .slvs path. Use export_model / model_to_stl after.",
    inputSchema: {
      part: z.enum(partNames).describe("Which part generator to use"),
      params: z.record(z.union([z.number(), z.string()])).optional()
        .describe("Parameter overrides (numbers or expressions)"),
      outfile: z.string().optional().describe("Output .slvs path (default: auto under build/)"),
    },
  },
  async ({ part, params, outfile }) => {
    try {
      const spec = PART_REGISTRY[part].fn(params || {});
      const slvs = buildSlvs(spec);
      const file = outfile ? ensureParent(path.resolve(outfile)) : stampName(part, "slvs");
      fs.writeFileSync(file, slvs);
      return {
        content: [{
          type: "text",
          text: `Wrote ${file}\npart=${part} bytes=${slvs.length}\nNext: export_model or part_to_stl.`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `create_part failed: ${e.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "part_to_stl",
  {
    title: "Parametric part → STL in one step",
    description:
      "Generate a library part and export it to STL immediately. Returns STL path, " +
      "triangle count, and bounding box. Convenience wrapper over create_part + export_model.",
    inputSchema: {
      part: z.enum(partNames).describe("Which part generator to use"),
      params: z.record(z.union([z.number(), z.string()])).optional(),
      chord_tolerance: z.number().positive().optional(),
      keep_slvs: z.boolean().default(false),
    },
  },
  async ({ part, params, chord_tolerance, keep_slvs }) => {
    try {
      const spec = PART_REGISTRY[part].fn(params || {});
      const slvs = buildSlvs(spec);
      const slvsFile = stampName(part, "slvs");
      const stlFile = slvsFile.replace(/\.slvs$/, ".stl");
      fs.writeFileSync(slvsFile, slvs);
      const r = cli.exportMesh({ slvsFile, outFile: stlFile, chordTolerance: chord_tolerance });
      if (!keep_slvs) fs.unlinkSync(slvsFile);
      const fmt3 = (a) => a.map((x) => +x.toFixed(3)).join(", ");
      return {
        content: [{
          type: "text",
          text: `STL: ${r.outFile}\npart=${part} triangles=${r.triangles}\n` +
            `size=(${fmt3(r.size)}) mm\nbbox min=(${fmt3(r.min)}) max=(${fmt3(r.max)})`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `part_to_stl failed: ${e.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "batch_parts",
  {
    title: "Batch-generate parametric parts",
    description:
      "Generate the same part with multiple parameter sets in one call. " +
      "variants: array of params objects (each overrides defaults). " +
      "format: 'stl' exports STL per variant; 'slvs' writes .slvs only. " +
      "Returns a list of output paths with bbox stats.",
    inputSchema: {
      part: z.enum(partNames).describe("Which part generator to use"),
      variants: z.array(z.record(z.union([z.number(), z.string()])))
        .min(1).max(50)
        .describe("Array of parameter override objects, one per variant"),
      format: z.enum(["stl", "slvs"]).default("stl"),
      chord_tolerance: z.number().positive().optional(),
    },
  },
  async ({ part, variants, format, chord_tolerance }) => {
    const results = [];
    const errors = [];
    for (let i = 0; i < variants.length; i++) {
      try {
        const spec = PART_REGISTRY[part].fn(variants[i]);
        const slvs = buildSlvs(spec);
        const slvsFile = stampName(`${part}-v${i}`, "slvs");
        fs.writeFileSync(slvsFile, slvs);
        if (format === "slvs") {
          results.push({ variant: i, params: variants[i], slvs: slvsFile });
          continue;
        }
        const stlFile = slvsFile.replace(/\.slvs$/, ".stl");
        const r = cli.exportMesh({ slvsFile, outFile: stlFile, chordTolerance: chord_tolerance });
        const fmt3 = (a) => a.map((x) => +x.toFixed(3)).join(", ");
        results.push({
          variant: i, params: variants[i], stl: r.outFile,
          triangles: r.triangles, size: fmt3(r.size),
        });
      } catch (e) {
        errors.push({ variant: i, error: e.message });
      }
    }
    const lines = results.map((r) =>
      `v${r.variant} ${JSON.stringify(r.params)} → ${r.stl || r.slvs}` +
      (r.triangles ? ` (${r.triangles} tris, size=${r.size})` : "")
    );
    const errLines = errors.map((e) => `v${e.variant} FAILED: ${e.error}`);
    return {
      content: [{
        type: "text",
        text: `batch_parts ${part}: ${results.length} ok, ${errors.length} failed\n\n` +
          [...lines, ...errLines].join("\n"),
      }],
      isError: errors.length > 0 && results.length === 0,
    };
  }
);

// ---- Analysis / inspection ----

server.registerTool(
  "measure_model",
  {
    title: "Measure STL model",
    description:
      "Compute volume, surface area, center of mass, and naked (boundary) edge count " +
      "of an STL file. isClosed=true means the mesh is watertight. " +
      "volume in mm^3, area in mm^2, com in mm. Useful for validating a solid before printing.",
    inputSchema: {
      stl_path: z.string().describe("Path to the STL file"),
    },
  },
  async ({ stl_path }) => {
    const f = path.resolve(stl_path);
    if (!fs.existsSync(f)) {
      return { content: [{ type: "text", text: `File not found: ${f}` }], isError: true };
    }
    try {
      const m = measureStl(f);
      const fmt = (x) => +x.toFixed(3);
      const fmt3 = (a) => a.map(fmt).join(", ");
      return {
        content: [{
          type: "text",
          text: `STL: ${f}\n` +
            `triangles=${m.triangleCount}\n` +
            `volume=${fmt(m.volume)} mm^3 (${fmt(m.volume / 1000)} cm^3)\n` +
            `surfaceArea=${fmt(m.surfaceArea)} mm^2\n` +
            `centerOfMass=(${fmt3(m.com)}) mm\n` +
            `closed=${m.isClosed} nakedEdges=${m.nakedEdges}\n` +
            `bbox size=(${fmt3(m.bbox.size)}) mm`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `measure failed: ${e.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "open_in_gui",
  {
    title: "Open .slvs in SolveSpace GUI",
    description:
      "Launch the SolveSpace GUI with the given .slvs file for visual inspection. " +
      "Non-blocking (returns immediately with the PID).",
    inputSchema: {
      slvs_path: z.string().describe("Path to the .slvs file"),
    },
  },
  async ({ slvs_path }) => {
    const f = path.resolve(slvs_path);
    if (!fs.existsSync(f)) {
      return { content: [{ type: "text", text: `File not found: ${f}` }], isError: true };
    }
    try {
      const r = cli.openInGui({ slvsFile: f });
      return {
        content: [{ type: "text", text: `Opened in GUI: ${f}\npid=${r.pid} bin=${r.bin}` }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `open_in_gui failed: ${e.message}` }], isError: true };
    }
  }
);

// ---- Export formats ----

server.registerTool(
  "export_png",
  {
    title: "Export PNG render",
    description:
      "Render a .slvs model to a PNG image via solvespace-cli thumbnail. " +
      "view: top|bottom|left|right|front|back|isometric. size: WIDTHxHEIGHT in pixels.",
    inputSchema: {
      slvs_path: z.string().describe("Path to the .slvs file"),
      view: viewDir.default("isometric"),
      size: z.string().default("800x600").describe("PNG size, e.g. '800x600'"),
      chord_tolerance: z.number().positive().optional(),
      outfile: z.string().optional(),
    },
  },
  async ({ slvs_path, view, size, chord_tolerance, outfile }) => {
    const f = path.resolve(slvs_path);
    if (!fs.existsSync(f)) {
      return { content: [{ type: "text", text: `File not found: ${f}` }], isError: true };
    }
    const out = outfile ? path.resolve(outfile) : f.replace(/\.slvs$/i, ".png");
    try {
      const r = cli.exportThumbnail({
        slvsFile: f, outFile: out, size, view, chordTolerance: chord_tolerance,
      });
      return {
        content: [{ type: "text", text: `PNG: ${r.outFile} (${r.bytes} bytes, view=${view}, size=${size})` }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `export_png failed: ${e.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "export_format",
  {
    title: "Export to CAD/vector format",
    description:
      "Export a .slvs to a 2D vector or mesh format via solvespace-cli. " +
      "Formats: stl|obj (mesh, export-mesh) or svg|pdf|dxf|step|eps|ps|plt|ngc (view, export-view). " +
      "view applies to export-view formats. Returns the output path and size.",
    inputSchema: {
      slvs_path: z.string().describe("Path to the .slvs file"),
      format: z.enum(["stl", "obj", "svg", "pdf", "dxf", "step", "eps", "ps", "plt", "ngc"])
        .describe("Target format"),
      view: viewDir.optional().describe("Camera direction (for view formats)"),
      chord_tolerance: z.number().positive().optional(),
      outfile: z.string().optional(),
    },
  },
  async ({ slvs_path, format, view, chord_tolerance, outfile }) => {
    const f = path.resolve(slvs_path);
    if (!fs.existsSync(f)) {
      return { content: [{ type: "text", text: `File not found: ${f}` }], isError: true };
    }
    const out = outfile ? path.resolve(outfile) : f.replace(/\.slvs$/i, `.${format}`);
    const meshFormats = new Set(["stl", "obj"]);
    try {
      let r;
      if (meshFormats.has(format)) {
        r = cli.exportMeshFormat({ slvsFile: f, outFile: out, chordTolerance: chord_tolerance });
      } else {
        r = cli.exportViewFormat({
          slvsFile: f, outFile: out, view: view || "isometric", chordTolerance: chord_tolerance,
        });
      }
      return {
        content: [{ type: "text", text: `${format.toUpperCase()}: ${r.outFile} (${r.bytes} bytes)` }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `export_format failed: ${e.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "section_view",
  {
    title: "Cross-section SVG",
    description:
      "Cut an STL with a plane and export the intersection profile as SVG. " +
      "axis: which plane normal ('x','y','z'). offset: position along that axis in mm. " +
      "Returns segment count and 2D bounds. Useful for inspecting internal geometry.",
    inputSchema: {
      stl_path: z.string().describe("Path to the STL file"),
      axis: z.enum(["x", "y", "z"]).default("z").describe("Plane normal axis"),
      offset: z.number().describe("Plane position along the axis (mm)"),
      outfile: z.string().optional(),
    },
  },
  async ({ stl_path, axis, offset, outfile }) => {
    const f = path.resolve(stl_path);
    if (!fs.existsSync(f)) {
      return { content: [{ type: "text", text: `File not found: ${f}` }], isError: true };
    }
    const out = outfile
      ? path.resolve(outfile)
      : path.join(BUILD_DIR, `section-${Date.now().toString(36)}.svg`);
    try {
      const r = sectionStl(f, axis, offset, out);
      const fmt = (x) => +x.toFixed(3);
      return {
        content: [{
          type: "text",
          text: `SVG section: ${r.outFile}\nsegments=${r.segmentCount}\n` +
            `bounds u=[${fmt(r.bounds.minU)}, ${fmt(r.bounds.maxU)}] ` +
            `v=[${fmt(r.bounds.minV)}, ${fmt(r.bounds.maxV)}] mm\n` +
            `image=${fmt(r.width)}x${fmt(r.height)} px`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `section_view failed: ${e.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "assemble",
  {
    title: "Assemble STLs (mesh merge with transforms)",
    description:
      "Merge multiple STL files into one, applying a rigid transform per part. " +
      "parts: array of {stlPath, translate?:[x,y,z] mm, rotate?:[rx,ry,rz] degrees XYZ}. " +
      "Returns merged STL path, total triangles, and bounding box. " +
      "Note: this is a mesh-level union (for 3D printing / preview), not a parametric boolean.",
    inputSchema: {
      parts: z.array(z.object({
        stlPath: z.string().describe("Path to an STL file"),
        translate: z.array(z.number()).length(3).optional().describe("[tx,ty,tz] mm"),
        rotate: z.array(z.number()).length(3).optional().describe("[rx,ry,rz] degrees, XYZ order"),
      })).min(1).max(20).describe("Parts to assemble"),
      outfile: z.string().optional(),
    },
  },
  async ({ parts, outfile }) => {
    for (const p of parts) {
      if (!fs.existsSync(path.resolve(p.stlPath))) {
        return { content: [{ type: "text", text: `File not found: ${p.stlPath}` }], isError: true };
      }
    }
    const out = outfile
      ? path.resolve(outfile)
      : stampName("assembly", "stl");
    try {
      const r = assembleStls(
        parts.map((p) => ({
          stlPath: path.resolve(p.stlPath),
          translate: p.translate,
          rotate: p.rotate,
        })),
        out,
      );
      const fmt3 = (a) => a.map((x) => +x.toFixed(3)).join(", ");
      return {
        content: [{
          type: "text",
          text: `Assembly STL: ${r.outFile}\nparts=${parts.length} triangles=${r.triangles}\n` +
            `size=(${fmt3(r.bbox.size)}) mm\nbbox min=(${fmt3(r.bbox.min)}) max=(${fmt3(r.bbox.max)})`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `assemble failed: ${e.message}` }], isError: true };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("solvespace-mcp running on stdio");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
