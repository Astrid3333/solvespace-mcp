"use strict";
// Thin wrapper around the solvespace-cli binary: run exports, parse results.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DEFAULT_BIN =
  process.env.SOLVESPACE_CLI ||
  path.join(os.homedir(), "solvespace-cli/usr/bin/solvespace-cli");

function resolveBin(bin) {
  const b = bin || DEFAULT_BIN;
  if (!fs.existsSync(b)) {
    throw new Error(
      `solvespace-cli not found at ${b}. Set SOLVESPACE_CLI to the binary path.`
    );
  }
  return b;
}

function runCli(args, { bin, timeout = 60000 } = {}) {
  const r = spawnSync(resolveBin(bin), args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  const out = (r.stdout || "") + (r.stderr || "");
  if (r.status !== 0) {
    const err = new Error(`solvespace-cli exited ${r.status}: ${out.trim()}`);
    err.code = r.status;
    err.output = out;
    throw err;
  }
  return out;
}

// Binary STL -> { triangles, bbox: {min:[x,y,z], max:[x,y,z], size:[..]} }
function parseBinaryStl(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 84) throw new Error(`STL too small: ${file}`);
  const n = buf.readUInt32LE(80);
  const expected = 84 + n * 50;
  if (buf.length < expected) {
    // ASCII STL?
    const text = buf.toString("utf8", 0, Math.min(buf.length, 200));
    if (text.startsWith("solid")) return parseAsciiStl(buf.toString("utf8"));
    throw new Error(`Truncated binary STL: ${file}`);
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const off = 84 + i * 50;
    for (let v = 0; v < 3; v++) {
      for (let c = 0; c < 3; c++) {
        const val = buf.readFloatLE(off + 12 + v * 12 + c * 4);
        if (val < min[c]) min[c] = val;
        if (val > max[c]) max[c] = val;
      }
    }
  }
  const size = max.map((m, i) => m - min[i]);
  return { triangles: n, min, max, size };
}

function parseAsciiStl(text) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let n = 0;
  const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let m;
  while ((m = re.exec(text))) {
    n++;
    for (let c = 0; c < 3; c++) {
      const val = parseFloat(m[c + 1]);
      if (val < min[c]) min[c] = val;
      if (val > max[c]) max[c] = val;
    }
  }
  return { triangles: n / 3, min, max, size: max.map((m, i) => m - min[i]) };
}

function exportMesh({ slvsFile, outFile, chordTolerance, bin, timeout }) {
  const args = ["export-mesh", "-o", outFile];
  if (chordTolerance != null) args.push("-t", String(chordTolerance));
  args.push(slvsFile);
  const output = runCli(args, { bin, timeout });
  if (!fs.existsSync(outFile)) {
    throw new Error(`export-mesh produced no file at ${outFile}\n${output}`);
  }
  // Weld float-noise vertices (boolean ops leave -2e-14-style residues that
  // fake open edges in any edge-count watertightness check).
  let welded = null;
  try {
    const { weldStlFile } = require("./stlmerge.js");
    welded = weldStlFile(outFile);
  } catch (e) {
    // welding is best-effort: keep the original STL if anything goes wrong
    welded = { error: e.message };
  }
  const stats = parseBinaryStl(outFile);
  return { outFile, ...stats, welded, cliOutput: output.trim() };
}

function exportView({ slvsFile, outFile, view, chordTolerance, bin, timeout }) {
  if (!view) throw new Error("export-view requires a view: top|bottom|left|right|front|back|isometric");
  const args = ["export-view", "-o", outFile, "-v", view];
  if (chordTolerance != null) args.push("-t", String(chordTolerance));
  args.push(slvsFile);
  const output = runCli(args, { bin, timeout });
  if (!fs.existsSync(outFile)) {
    throw new Error(`export-view produced no file at ${outFile}\n${output}`);
  }
  return { outFile, bytes: fs.statSync(outFile).size, cliOutput: output.trim() };
}

function exportWireframe({ slvsFile, outFile, view, bin, timeout }) {
  const args = ["export-wireframe", "-o", outFile];
  if (view) args.push("-v", view);
  args.push(slvsFile);
  const output = runCli(args, { bin, timeout });
  if (!fs.existsSync(outFile)) {
    throw new Error(`export-wireframe produced no file at ${outFile}\n${output}`);
  }
  return { outFile, bytes: fs.statSync(outFile).size, cliOutput: output.trim() };
}

// Rendered PNG thumbnail via the CLI "thumbnail" command.
function exportThumbnail({ slvsFile, outFile, size = "800x600", view = "isometric", chordTolerance, bin, timeout }) {
  const args = ["thumbnail", "-o", outFile, "--size", size, "-v", view];
  if (chordTolerance != null) args.push("-t", String(chordTolerance));
  args.push(slvsFile);
  const output = runCli(args, { bin, timeout });
  if (!fs.existsSync(outFile)) {
    throw new Error(`thumbnail produced no file at ${outFile}\n${output}`);
  }
  return { outFile, bytes: fs.statSync(outFile).size, cliOutput: output.trim() };
}

// export-view into any 2D vector format the CLI supports (svg/pdf/dxf/step/eps/ps/plt/ngc).
function exportViewFormat({ slvsFile, outFile, view = "isometric", chordTolerance, bg, bin, timeout }) {
  const args = ["export-view", "-o", outFile];
  if (view) args.push("-v", view);
  if (chordTolerance != null) args.push("-t", String(chordTolerance));
  if (bg != null) args.push("-b", bg ? "on" : "off");
  args.push(slvsFile);
  const output = runCli(args, { bin, timeout });
  if (!fs.existsSync(outFile)) {
    throw new Error(`export-view produced no file at ${outFile}\n${output}`);
  }
  return { outFile, bytes: fs.statSync(outFile).size, cliOutput: output.trim() };
}

// export-mesh into any mesh format (stl/obj).
function exportMeshFormat({ slvsFile, outFile, chordTolerance, bin, timeout }) {
  const args = ["export-mesh", "-o", outFile];
  if (chordTolerance != null) args.push("-t", String(chordTolerance));
  args.push(slvsFile);
  const output = runCli(args, { bin, timeout });
  if (!fs.existsSync(outFile)) {
    throw new Error(`export-mesh produced no file at ${outFile}\n${output}`);
  }
  return { outFile, bytes: fs.statSync(outFile).size, cliOutput: output.trim() };
}

function version({ bin } = {}) {
  // solvespace-cli 3.1 prints the version but exits nonzero; tolerate it.
  try {
    const out = runCli(["version"], { bin, timeout: 10000 });
    return out.trim();
  } catch (e) {
    if (e.output && /SolveSpace version/.test(e.output)) return e.output.trim();
    throw e;
  }
}

const GUI_BIN =
  process.env.SOLVESPACE_GUI ||
  path.join(os.homedir(), "solvespace-cli/usr/bin/solvespace");

function resolveGuiBin(bin) {
  const b = bin || GUI_BIN;
  if (!fs.existsSync(b)) {
    throw new Error(
      `solvespace GUI not found at ${b}. Set SOLVESPACE_GUI to the binary path.`
    );
  }
  return b;
}

// Open a .slvs file in the SolveSpace GUI (detached, non-blocking).
function openInGui({ slvsFile, bin, timeout = 10000 } = {}) {
  const { spawn } = require("node:child_process");
  const b = resolveGuiBin(bin);
  const child = spawn(b, [slvsFile], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { pid: child.pid, bin: b, file: slvsFile };
}

module.exports = {
  DEFAULT_BIN,
  GUI_BIN,
  runCli,
  parseBinaryStl,
  exportMesh,
  exportMeshFormat,
  exportView,
  exportViewFormat,
  exportWireframe,
  exportThumbnail,
  openInGui,
  version,
};
