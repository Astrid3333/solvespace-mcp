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
