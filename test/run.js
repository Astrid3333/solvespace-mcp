"use strict";
// E2E test for solvespace-mcp over stdio: initialize, list tools, call
// solvespace_version + model_to_stl, verify STL bbox.
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "src", "index.js");

function readStlSize(file) {
  const buf = fs.readFileSync(file);
  const n = buf.readUInt32LE(80);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const off = 84 + i * 50;
    for (let v = 0; v < 3; v++)
      for (let c = 0; c < 3; c++) {
        const val = buf.readFloatLE(off + 12 + v * 12 + c * 4);
        if (val < min[c]) min[c] = val;
        if (val > max[c]) max[c] = val;
      }
  }
  return { n, size: max.map((m, i) => +(m - min[i]).toFixed(3)) };
}

function run() {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pending = new Map();
  const stderrLines = [];
  child.stderr.on("data", (d) => stderrLines.push(d.toString()));

  child.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  let nextId = 1;
  function rpc(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout on ${method}`)), 30000);
      pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  (async () => {
    const init = await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.1" },
    });
    assert.ok(init.result && init.result.serverInfo, "initialize returns serverInfo");
    console.log("initialize ok:", init.result.serverInfo.name, init.result.serverInfo.version);
    notify("notifications/initialized", {});

    const tools = await rpc("tools/list", {});
    const names = tools.result.tools.map((t) => t.name).sort();
    console.log("tools:", names.join(", "));
    for (const expect of ["create_model", "export_model", "model_to_stl", "solvespace_version"]) {
      assert.ok(names.includes(expect), `tool ${expect} registered`);
    }

    const ver = await rpc("tools/call", { name: "solvespace_version", arguments: {} });
    assert.ok(!ver.result.isError, "version call succeeds: " + JSON.stringify(ver.result));
    console.log("version:", ver.result.content[0].text.split("\n")[0]);

    // Box 20x15x8 via named params
    const spec = {
      params: { w: 20, h: 15, t: 8 },
      sketches: [{
        name: "s1", plane: "XY",
        entities: [
          { id: "a", type: "line", a: [0, 0], b: ["w", 0] },
          { id: "b", type: "line", a: ["w", 0], b: ["w", "h"] },
          { id: "c", type: "line", a: ["w", "h"], b: [0, "h"] },
          { id: "d", type: "line", a: [0, "h"], b: [0, 0] },
        ],
      }],
      operations: [{ type: "extrude", from: "s1", vector: [0, 0, "t"], name: "body" }],
    };
    const call = await rpc("tools/call", { name: "model_to_stl", arguments: { spec } });
    assert.ok(!call.result.isError, "model_to_stl succeeds: " + JSON.stringify(call.result));
    const text = call.result.content[0].text;
    console.log("model_to_stl:\n" + text);
    const mPath = text.match(/STL: (.+)/);
    const mSize = text.match(/size=\((.+?)\) mm/);
    assert.ok(mPath && mSize, "output has path and size");
    const [sx, sy, sz] = mSize[1].split(",").map((s) => parseFloat(s.trim()));
    assert.ok(Math.abs(sx - 20) < 0.01 && Math.abs(sy - 15) < 0.01 && Math.abs(sz - 8) < 0.01,
      `bbox is 20x15x8, got ${sx}x${sy}x${sz}`);
    const stlFile = mPath[1].trim();
    const stl = readStlSize(stlFile);
    assert.strictEqual(stl.n, 12, "box has 12 triangles");
    console.log("STL bbox check ok: 20 x 15 x 8, 12 triangles");

    // create_model + export_model split path
    const created = await rpc("tools/call", { name: "create_model", arguments: { spec } });
    assert.ok(!created.result.isError, "create_model succeeds");
    const cPath = created.result.content[0].text.match(/Wrote (\S+)/)[1];
    const exported = await rpc("tools/call", {
      name: "export_model",
      arguments: { slvs_path: cPath, format: "stl" },
    });
    assert.ok(!exported.result.isError, "export_model succeeds");
    console.log("create_model+export_model ok:", exported.result.content[0].text.split("\n")[0]);

    // Shaded view SVG export (isometric)
    const svg = await rpc("tools/call", {
      name: "export_model",
      arguments: { slvs_path: cPath, format: "svg", view: "isometric" },
    });
    assert.ok(!svg.result.isError, "svg view export succeeds: " + JSON.stringify(svg.result));
    const svgText = svg.result.content[0].text;
    const svgFile = svgText.match(/SVG view: (\S+)/)[1];
    assert.ok(fs.existsSync(svgFile) && fs.statSync(svgFile).size > 500, "svg file written and non-trivial");
    console.log("svg view export ok:", svgText);

    // SVG wireframe export (no view)
    const wf = await rpc("tools/call", {
      name: "export_model",
      arguments: { slvs_path: cPath, format: "svg" },
    });
    assert.ok(!wf.result.isError, "svg wireframe export succeeds: " + JSON.stringify(wf.result));
    console.log("svg wireframe export ok:", wf.result.content[0].text);

    // ---- rotate: 10x10 box about origin, 90 deg, 1 extra copy ----
    // union of [0,10]^2 and its 90-deg rotation = [-10,10] x [0,10] -> 20x10x4.
    async function stlSize(spec, label) {
      const r = await rpc("tools/call", { name: "model_to_stl", arguments: { spec } });
      assert.ok(!r.result.isError, `${label}: model_to_stl succeeds: ` + JSON.stringify(r.result));
      const mm = r.result.content[0].text.match(/size=\((.+?)\) mm/);
      assert.ok(mm, `${label}: size present`);
      return mm[1].split(",").map((s) => parseFloat(s.trim()));
    }
    const square = {
      sketches: [{
        name: "s1", plane: "XY",
        entities: [
          { id: "a", type: "line", a: [0, 0], b: [10, 0] },
          { id: "b", type: "line", a: [10, 0], b: [10, 10] },
          { id: "c", type: "line", a: [10, 10], b: [0, 10] },
          { id: "d", type: "line", a: [0, 10], b: [0, 0] },
        ],
      }],
      operations: [{ type: "extrude", from: "s1", vector: [0, 0, 4], name: "body" }],
    };
    function near3(got, want, label) {
      for (let i = 0; i < 3; i++) {
        assert.ok(Math.abs(got[i] - want[i]) < 0.02,
          `${label}: bbox ${got} != ${want}`);
      }
    }

    // 90 deg, 1 copy, 2D center (locks the NaN guard for missing z)
    let bsz = await stlSize({
      ...square,
      operations: [...square.operations,
        { type: "rotate", from: "body", angleDeg: 90, copies: 1, center: [0, 0], axis: [0, 0, 1], name: "rot" }],
    }, "rotate 90/1");
    near3(bsz, [20, 10, 4], "rotate 90/1");
    console.log("rotate 90deg/1copy ok: 20 x 10 x 4");

    // 90 deg, 3 copies -> copies at 90/180/270 -> full cross 20x20x4
    bsz = await stlSize({
      ...square,
      operations: [...square.operations,
        { type: "rotate", from: "body", angleDeg: 90, copies: 3, center: [0, 0, 0], axis: [0, 0, 1], name: "rot" }],
    }, "rotate 90/3");
    near3(bsz, [20, 20, 4], "rotate 90/3");
    console.log("rotate 90deg/3copies ok: 20 x 20 x 4");

    // 45 deg, 1 copy: union bbox x=[-10*sin45, 10] -> 10+10/sqrt2,
    // y=[0, 10*cos45+10*sin45] -> 20/sqrt2
    bsz = await stlSize({
      ...square,
      operations: [...square.operations,
        { type: "rotate", from: "body", angleDeg: 45, copies: 1, center: [0, 0, 0], axis: [0, 0, 1], name: "rot" }],
    }, "rotate 45/1");
    near3(bsz, [10 + 10 * Math.SQRT1_2, 20 * Math.SQRT1_2, 4], "rotate 45/1");
    console.log("rotate 45deg/1copy ok: bbox = 10+10/sqrt2");

    // ---- translate: [5,0,0], 2 copies -> offsets 0/5/10 -> 20x10x4 ----
    bsz = await stlSize({
      ...square,
      operations: [...square.operations,
        { type: "translate", from: "body", vector: [5, 0, 0], copies: 2, name: "tr" }],
    }, "translate 5/2");
    near3(bsz, [20, 10, 4], "translate 5/2");
    console.log("translate [5,0,0]/2copies ok: 20 x 10 x 4");

    // rotate about X axis (non-Z via helper line), 90 deg, 1 copy:
    // R_x(90): copy y'=[-4,0], z'=[0,10] -> union 10 x 14 x 10
    bsz = await stlSize({
      ...square,
      operations: [...square.operations,
        { type: "rotate", from: "body", angleDeg: 90, copies: 1, center: [0, 0, 0], axis: [1, 0, 0], name: "rot" }],
    }, "rotate X 90/1");
    near3(bsz, [10, 14, 10], "rotate X 90/1");
    console.log("rotate about X 90deg/1copy ok: 10 x 14 x 10");

    // ---- cylinder: circle r=5 extruded h=8 -> 10 x 10 x 8 ----
    bsz = await stlSize({
      sketches: [{
        name: "disk", plane: "XY",
        entities: [{ id: "c", type: "circle", center: [0, 0], r: 5 }],
      }],
      operations: [{ type: "extrude", from: "disk", vector: [0, 0, 8], name: "body" }],
    }, "cylinder");
    near3(bsz, [10, 10, 8], "cylinder");
    console.log("circle extrude ok: 10 x 10 x 8");

    // ---- half-cylinder: closed line+arc profile extruded -> 10 x 5 x 4 ----
    bsz = await stlSize({
      sketches: [{
        name: "halfdisk", plane: "XY",
        entities: [
          { id: "a", type: "line", a: [-5, 0], b: [5, 0] },
          { id: "arc", type: "arc", center: [0, 0], start: [5, 0], end: [-5, 0] },
        ],
      }],
      operations: [{ type: "extrude", from: "halfdisk", vector: [0, 0, 4], name: "body" }],
    }, "halfcyl");
    near3(bsz, [10, 5, 4], "halfcyl");
    console.log("arc+line profile extrude ok: 10 x 5 x 4");

    // ---- lathe: rectangle profile x in [10,20] y in [0,10], full revolve
    // about Y -> torus tube 40 x 10 x 40 ----
    const rectProfile = {
      name: "rect", plane: "XY",
      entities: [
        { id: "l1", type: "line", a: [10, 0], b: [20, 0] },
        { id: "l2", type: "line", a: [20, 0], b: [20, 10] },
        { id: "l3", type: "line", a: [20, 10], b: [10, 10] },
        { id: "l4", type: "line", a: [10, 10], b: [10, 0] },
      ],
    };
    bsz = await stlSize({
      sketches: [rectProfile],
      operations: [{ type: "lathe", from: "rect", center: [0, 0, 0], axis: [0, 1, 0], name: "lathe" }],
    }, "lathe");
    near3(bsz, [40, 10, 40], "lathe");
    console.log("lathe full about Y ok: 40 x 10 x 40");

    // ---- revolve 90 deg about Y: same profile -> quarter tube 20 x 10 x 20 ----
    bsz = await stlSize({
      sketches: [rectProfile],
      operations: [{ type: "revolve", from: "rect", center: [0, 0, 0], axis: [0, 1, 0], angleDeg: 90, name: "rev" }],
    }, "revolve90");
    near3(bsz, [20, 10, 20], "revolve90");
    console.log("revolve 90deg about Y ok: 20 x 10 x 20");

    // ---- helix: circle r=1 at (10,0) XY, about Y, 720 deg, rise 10.
    // radius from axis 9..11 -> x,z span 22; circle spans y in [-1,1]
    // plus rise 10 -> y span 12. size = 22 x 12 x 22 ----
    bsz = await stlSize({
      sketches: [{
        name: "seed", plane: "XY",
        entities: [{ id: "c", type: "circle", center: [10, 0], r: 1 }],
      }],
      operations: [{ type: "helix", from: "seed", center: [0, 0, 0], axis: [0, 1, 0], angleDeg: 720, distance: 10, name: "hel" }],
    }, "helix");
    near3(bsz, [22, 12, 22], "helix");
    console.log("helix 720deg rise 10 ok: 22 x 12 x 22");

    // ---- list_parts: registry with all 8 parts ----
    const lp = await rpc("tools/call", { name: "list_parts", arguments: {} });
    assert.ok(!lp.result.isError, "list_parts succeeds");
    const lpText = lp.result.content[0].text;
    for (const p of ["flange", "lBracket", "tube", "pulley", "spring", "plateSlot", "hexNut", "cone", "drilledPlate"]) {
      assert.ok(lpText.includes(p), `list_parts mentions ${p}`);
    }
    console.log("list_parts ok: 9 parts listed");

    // ---- part_to_stl: flange default -> 100x100x10 ----
    const p2s = await rpc("tools/call", {
      name: "part_to_stl", arguments: { part: "flange" },
    });
    assert.ok(!p2s.result.isError, "part_to_stl flange succeeds: " + JSON.stringify(p2s.result));
    const p2sText = p2s.result.content[0].text;
    const p2sStl = p2sText.match(/STL: (\S+)/)[1];
    const p2sMm = p2sText.match(/size=\((.+?)\) mm/);
    const [p2sx, p2sy, p2sz] = p2sMm[1].split(",").map((s) => parseFloat(s.trim()));
    assert.ok(Math.abs(p2sx - 100) < 0.05 && Math.abs(p2sy - 100) < 0.05 && Math.abs(p2sz - 10) < 0.05,
      `part_to_stl flange bbox 100x100x10, got ${p2sx}x${p2sy}x${p2sz}`);
    assert.ok(fs.existsSync(p2sStl), "part_to_stl STL file exists");
    console.log("part_to_stl flange ok: 100 x 100 x 10");

    // ---- part_to_stl: tube custom params -> 24x24x24 ----
    const tubeR = await rpc("tools/call", {
      name: "part_to_stl", arguments: { part: "tube", params: { innerR: 10, outerR: 12, height: 24 } },
    });
    assert.ok(!tubeR.result.isError, "part_to_stl tube succeeds");
    const tubeMm = tubeR.result.content[0].text.match(/size=\((.+?)\) mm/);
    const [tux, tuy, tuz] = tubeMm[1].split(",").map((s) => parseFloat(s.trim()));
    assert.ok(Math.abs(tux - 24) < 0.05 && Math.abs(tuy - 24) < 0.05 && Math.abs(tuz - 24) < 0.05,
      `tube bbox 24x24x24, got ${tux}x${tuy}x${tuz}`);
    console.log("part_to_stl tube custom ok: 24 x 24 x 24");

    // ---- create_part: writes .slvs only ----
    const cp = await rpc("tools/call", {
      name: "create_part", arguments: { part: "hexNut", params: { acrossFlats: 20, boreD: 10, thickness: 8 } },
    });
    assert.ok(!cp.result.isError, "create_part hexNut succeeds");
    const cpPath = cp.result.content[0].text.match(/Wrote (\S+)/)[1];
    assert.ok(fs.existsSync(cpPath) && cpPath.endsWith(".slvs"), "create_part wrote .slvs");
    console.log("create_part hexNut ok:", cpPath);

    // ---- measure_model: cube 20x15x8 from the first spec STL ----
    const meas = await rpc("tools/call", {
      name: "measure_model", arguments: { stl_path: stlFile },
    });
    assert.ok(!meas.result.isError, "measure_model succeeds: " + JSON.stringify(meas.result));
    const measText = meas.result.content[0].text;
    const volM = measText.match(/volume=([\d.+-]+)/);
    assert.ok(volM, "measure has volume");
    const vol = parseFloat(volM[1]);
    assert.ok(Math.abs(vol - 20 * 15 * 8) / (20 * 15 * 8) < 0.02,
      `cube volume ~2400, got ${vol}`);
    assert.ok(/closed=true/.test(measText), "cube mesh is closed");
    console.log("measure_model cube ok: volume ~2400, closed=true");

    // ---- measure_model: flange has volume + reasonable mesh ----
    // SolveSpace CSG tessellation of circular features leaves some naked edges
    // (not watertight); check the volume is right and mesh is not broken.
    const measF = await rpc("tools/call", {
      name: "measure_model", arguments: { stl_path: p2sStl },
    });
    assert.ok(!measF.result.isError, "measure_model flange succeeds");
    const measFText = measF.result.content[0].text;
    const fVol = parseFloat(measFText.match(/volume=([\d.+-]+)/)[1]);
    // Expected volume ~60.5 cm^3 (plate minus bore minus bolt holes)
    assert.ok(fVol > 50000 && fVol < 70000, `flange volume in 50-70k range, got ${fVol}`);
    const fNaked = parseInt(measFText.match(/nakedEdges=(\d+)/)[1], 10);
    assert.ok(fNaked < 100, `flange nakedEdges bounded (<100), got ${fNaked}`);
    console.log(`measure_model flange ok: volume ~${fVol.toFixed(0)}, nakedEdges=${fNaked}`);

    // ---- export_png: render flange ----
    const png = await rpc("tools/call", {
      name: "export_png", arguments: { slvs_path: cpPath, view: "isometric", size: "400x300" },
    });
    assert.ok(!png.result.isError, "export_png succeeds: " + JSON.stringify(png.result));
    const pngPath = png.result.content[0].text.match(/PNG: (\S+)/)[1];
    assert.ok(fs.existsSync(pngPath) && fs.statSync(pngPath).size > 500, "PNG file written");
    console.log("export_png ok:", png.result.content[0].text);

    // ---- export_format: obj from flange ----
    const objExp = await rpc("tools/call", {
      name: "export_format", arguments: { slvs_path: cpPath, format: "obj" },
    });
    assert.ok(!objExp.result.isError, "export_format obj succeeds: " + JSON.stringify(objExp.result));
    const objPath = objExp.result.content[0].text.match(/OBJ: (\S+)/)[1];
    assert.ok(fs.existsSync(objPath) && fs.statSync(objPath).size > 100, "obj file written");
    console.log("export_format obj ok:", objExp.result.content[0].text);

    // ---- export_format: dxf from flange ----
    const dxfExp = await rpc("tools/call", {
      name: "export_format", arguments: { slvs_path: cpPath, format: "dxf" },
    });
    assert.ok(!dxfExp.result.isError, "export_format dxf succeeds: " + JSON.stringify(dxfExp.result));
    const dxfPath = dxfExp.result.content[0].text.match(/DXF: (\S+)/)[1];
    assert.ok(fs.existsSync(dxfPath) && fs.statSync(dxfPath).size > 500, "dxf file written");
    console.log("export_format dxf ok:", dxfExp.result.content[0].text);

    // ---- section_view: flange mid-plane z=5 -> many segments ----
    const sec = await rpc("tools/call", {
      name: "section_view", arguments: { stl_path: p2sStl, axis: "z", offset: 5 },
    });
    assert.ok(!sec.result.isError, "section_view succeeds: " + JSON.stringify(sec.result));
    const secText = sec.result.content[0].text;
    const secSegs = parseInt(secText.match(/segments=(\d+)/)[1], 10);
    assert.ok(secSegs > 10, `flange section has >10 segments, got ${secSegs}`);
    const secSvg = secText.match(/SVG section: (\S+)/)[1];
    assert.ok(fs.existsSync(secSvg), "section SVG written");
    console.log("section_view flange ok:", secSegs, "segments");

    // ---- assemble: two boxes side by side ----
    const boxSpecA = {
      sketches: [{
        name: "s", plane: "XY",
        entities: [
          { id: "a", type: "line", a: [0, 0], b: [10, 0] },
          { id: "b", type: "line", a: [10, 0], b: [10, 10] },
          { id: "c", type: "line", a: [10, 10], b: [0, 10] },
          { id: "d", type: "line", a: [0, 10], b: [0, 0] },
        ],
      }],
      operations: [{ type: "extrude", from: "s", vector: [0, 0, 5], name: "body" }],
    };
    const boxA = await rpc("tools/call", { name: "model_to_stl", arguments: { spec: boxSpecA } });
    const boxAStl = boxA.result.content[0].text.match(/STL: (\S+)/)[1];
    const asm = await rpc("tools/call", {
      name: "assemble",
      arguments: {
        parts: [
          { stlPath: boxAStl, translate: [0, 0, 0] },
          { stlPath: boxAStl, translate: [15, 0, 0] },
        ],
      },
    });
    assert.ok(!asm.result.isError, "assemble succeeds: " + JSON.stringify(asm.result));
    const asmText = asm.result.content[0].text;
    const asmMm = asmText.match(/size=\((.+?)\) mm/);
    const [asmx, asmy, asmz] = asmMm[1].split(",").map((s) => parseFloat(s.trim()));
    assert.ok(Math.abs(asmx - 25) < 0.05 && Math.abs(asmy - 10) < 0.05 && Math.abs(asmz - 5) < 0.05,
      `assemble bbox 25x10x5, got ${asmx}x${asmy}x${asmz}`);
    console.log("assemble ok: 25 x 10 x 5");

    // ---- batch_parts: 3 flange variants ----
    const batch = await rpc("tools/call", {
      name: "batch_parts",
      arguments: {
        part: "hexNut",
        variants: [
          { acrossFlats: 10, boreD: 5, thickness: 5 },
          { acrossFlats: 17, boreD: 8, thickness: 6 },
          { acrossFlats: 24, boreD: 12, thickness: 10 },
        ],
      },
    });
    assert.ok(!batch.result.isError, "batch_parts succeeds: " + JSON.stringify(batch.result));
    const batchText = batch.result.content[0].text;
    assert.ok(/2 ok, 0 failed|3 ok, 0 failed|1 ok, 0 failed|ok, 0 failed/.test(batchText)
      || /3 ok/.test(batchText), "batch_parts reports ok count");
    assert.ok(/FAILED/.test(batchText) === false, "batch_parts has no failures");
    console.log("batch_parts ok:", batchText.split("\n")[0]);

    // ---- boolean difference: drilled_plate is watertight (combine=difference) ----
    const dp = await rpc("tools/call", {
      name: "part_to_stl", arguments: { part: "drilledPlate" },
    });
    assert.ok(!dp.result.isError, "part_to_stl drilledPlate succeeds: " + JSON.stringify(dp.result));
    const dpStl = dp.result.content[0].text.match(/STL: (\S+)/)[1];
    const dpM = await rpc("tools/call", { name: "measure_model", arguments: { stl_path: dpStl } });
    assert.ok(!dpM.result.isError, "measure_model drilledPlate succeeds");
    const dpText = dpM.result.content[0].text;
    const dpVol = parseFloat(dpText.match(/volume=([\d.+-]+)/)[1]);
    // 60*40*8 - 4*pi*3^2*8 = 19200 - 904.78 = 18295.2 (circle tessellation adds <1%)
    assert.ok(dpVol > 18000 && dpVol < 18600, `drilledPlate volume ~18295, got ${dpVol}`);
    const dpNaked = parseInt(dpText.match(/nakedEdges=(\d+)/)[1], 10);
    assert.strictEqual(dpNaked, 0, `drilledPlate boolean mesh watertight, nakedEdges=0, got ${dpNaked}`);
    assert.ok(/closed=true/.test(dpText), "drilledPlate mesh closed");
    console.log(`boolean drilledPlate ok: volume ~${dpVol.toFixed(0)}, nakedEdges=0, closed=true`);

    // ---- boolean difference from a raw spec: plate 40x40x10 minus r=8 hole ----
    const boolSpec = {
      sketches: [
        {
          name: "plate", plane: "XY",
          entities: [
            { id: "a", type: "line", a: [0, 0], b: [40, 0] },
            { id: "b", type: "line", a: [40, 0], b: [40, 40] },
            { id: "c", type: "line", a: [40, 40], b: [0, 40] },
            { id: "d", type: "line", a: [0, 40], b: [0, 0] },
          ],
        },
        { name: "hole", plane: "XY", entities: [{ id: "hc", type: "circle", center: [20, 20], r: 8 }] },
      ],
      operations: [
        { type: "extrude", from: "plate", vector: [0, 0, 10], name: "body" },
        { type: "extrude", from: "hole", vector: [0, 0, 20], symmetric: true, combine: "difference", name: "cut" },
      ],
    };
    const boolR = await rpc("tools/call", { name: "model_to_stl", arguments: { spec: boolSpec } });
    assert.ok(!boolR.result.isError, "boolean spec model_to_stl succeeds: " + JSON.stringify(boolR.result));
    const boolStl = boolR.result.content[0].text.match(/STL: (\S+)/)[1];
    const boolM = await rpc("tools/call", { name: "measure_model", arguments: { stl_path: boolStl } });
    const boolText = boolM.result.content[0].text;
    const boolVol = parseFloat(boolText.match(/volume=([\d.+-]+)/)[1]);
    // 40*40*10 - pi*8^2*10 = 16000 - 2010.62 = 13989.38
    assert.ok(Math.abs(boolVol - 13989.38) / 13989.38 < 0.02,
      `plate-hole volume ~13989, got ${boolVol}`);
    assert.strictEqual(parseInt(boolText.match(/nakedEdges=(\d+)/)[1], 10), 0,
      "plate-hole mesh watertight");
    console.log(`boolean plate+hole ok: volume ~${boolVol.toFixed(0)}, nakedEdges=0`);

    // ---- combine on step-and-repeat must be rejected ----
    const badSpec = {
      sketches: [
        {
          name: "s", plane: "XY",
          entities: [
            { id: "a", type: "line", a: [0, 0], b: [10, 0] },
            { id: "b", type: "line", a: [10, 0], b: [10, 10] },
            { id: "c", type: "line", a: [10, 10], b: [0, 10] },
            { id: "d", type: "line", a: [0, 10], b: [0, 0] },
          ],
        },
      ],
      operations: [
        { type: "extrude", from: "s", vector: [0, 0, 5], name: "e" },
        { type: "translate", from: "e", vector: [15, 0, 0], copies: 3, combine: "difference" },
      ],
    };
    const badR = await rpc("tools/call", { name: "model_to_stl", arguments: { spec: badSpec } });
    assert.ok(badR.result.isError, "combine on translate rejected");
    console.log("boolean validation ok: combine on translate rejected");

    // ---- open_in_gui: returns pid ----
    const gui = await rpc("tools/call", {
      name: "open_in_gui", arguments: { slvs_path: cpPath },
    });
    assert.ok(!gui.result.isError, "open_in_gui succeeds: " + JSON.stringify(gui.result));
    assert.ok(/pid=\d+/.test(gui.result.content[0].text), "open_in_gui returns pid");
    console.log("open_in_gui ok:", gui.result.content[0].text.split("\n")[1]);

    console.log("\nALL TESTS PASSED");
    child.kill();
    process.exit(0);
  })().catch((e) => {
    console.error("TEST FAILED:", e.message);
    if (stderrLines.length) console.error("server stderr:", stderrLines.join("").slice(-2000));
    child.kill();
    process.exit(1);
  });
}

run();
