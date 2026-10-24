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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("solvespace-mcp running on stdio");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
