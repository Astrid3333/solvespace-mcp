"use strict";
// Minimal MCP client example: spawns the solvespace-mcp server over stdio,
// generates a flange, and verifies the mesh is watertight.
// Run from the repo root:  node examples/flange-to-stl.js
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const ROOT = path.join(__dirname, "..");

function text(result) {
  if (result.isError) throw new Error(result.content.map((c) => c.text).join("\n"));
  return result.content.map((c) => c.text).join("\n");
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "src", "index.js")],
    cwd: ROOT,
  });
  const client = new Client({ name: "flange-example", version: "0.1.0" });
  await client.connect(transport);

  console.log(text(await client.callTool({ name: "solvespace_version", arguments: {} })));

  const part = text(await client.callTool({
    name: "part_to_stl",
    arguments: { part: "flange", params: { outerD: 100, nBolts: 6 } },
  }));
  console.log(part);

  const stl = part.match(/STL: (\S+)/)[1];
  const measured = text(await client.callTool({
    name: "measure_model",
    arguments: { stl_path: stl },
  }));
  console.log(measured);

  const closed = /closed=true/.test(measured);
  const naked = parseInt(measured.match(/nakedEdges=(\d+)/)[1], 10);
  if (!closed || naked !== 0) throw new Error(`mesh not watertight: closed=${closed} nakedEdges=${naked}`);
  console.log(`\nOK: watertight flange at ${stl}`);

  await client.close();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
