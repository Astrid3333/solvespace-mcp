# solvespace-mcp

MCP server for parametric CAD driven by [SolveSpace](https://solvespace.com) 3.1
(`solvespace-cli`). Describe solids as a JSON spec — sketches, constraints and
solid operations — and export STL / SVG / PNG without opening the GUI.

```
JSON spec  ->  .slvs (SolveSpace source)  ->  solvespace-cli  ->  STL / SVG / PNG
```

- 15 MCP tools, 10 ready-made parametric parts, boolean ops (union /
  difference / intersection), watertight-mesh validation on export, and hole
  capping (`repair_stl`).
- Units are **millimetres** everywhere.

## Requirements

- Node.js >= 18
- `solvespace-cli` (SolveSpace 3.1). Expected at `~/solvespace-cli/usr/bin/solvespace-cli`,
  or set `SOLVESPACE_CLI=/path/to/solvespace-cli`.
  CLI tessellation is controlled with `-t <chord-tolerance>` (mm).

## Install

```bash
git clone https://github.com/Astrid3333/solvespace-mcp.git
cd solvespace-mcp
npm install
npm test          # ALL TESTS PASSED
```

Register in `opencode.json`:

```json
{
  "mcp": {
    "solvespace": {
      "type": "local",
      "command": ["/bin/bash", "-lc", "cd ~/solvespace-mcp && exec node src/index.js"]
    }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `create_model` | JSON spec -> `.slvs` file |
| `model_to_stl` | JSON spec -> STL in one step, reports `volume/closed/nakedEdges` |
| `export_model` | `.slvs` -> STL / SVG |
| `export_png` | `.slvs` -> rendered PNG (any view: top/front/isometric/…) |
| `export_format` | `.slvs` -> obj / svg / dxf / step / pdf / … via CLI `export-view`/`export-mesh` |
| `section_view` | cut an STL with a plane, export the profile as SVG |
| `measure_model` | STL volume, area, center of mass, naked-edge (watertightness) check |
| `repair_stl` | cap the holes of a non-watertight STL (centroid fan per boundary loop) |
| `create_part` | library part -> `.slvs` |
| `part_to_stl` | library part -> STL in one step |
| `batch_parts` | same part, N parameter sets, one call |
| `list_parts` | the 10 library parts with params, defaults and bounds |
| `assemble` | merge several STLs with per-part translate/rotate |
| `open_in_gui` | open a `.slvs` in the SolveSpace GUI |
| `solvespace_version` | CLI version in use |

## JSON spec

```jsonc
{
  "params": { "w": 40, "t": "w/2" },          // numbers or arithmetic expressions
  "sketches": [
    { "name": "plate", "plane": "XY",
      "entities": [ { "id": "a", "type": "line", "a": [0,0], "b": [40,0] }, … ] },
    { "name": "hole", "plane": "XY",
      "entities": [ { "id": "hc", "type": "circle", "center": [20,20], "r": 8 } ] }
  ],
  "constraints": [ { "type": "distance", "…": "…" } ],
  "operations": [
    { "type": "extrude", "from": "plate", "vector": [0,0,10], "name": "body" },
    { "type": "extrude", "from": "hole", "vector": [0,0,20],
      "symmetric": true, "combine": "difference", "name": "cut" }
  ]
}
```

Operation types: `extrude`, `translate`, `rotate`, `lathe`, `revolve`, `helix`.
Known planes: `XY`, `YZ`, `ZX` (or a custom quaternion).

### Conventions that bite if you ignore them

- **Booleans only on solid ops.** `combine` / `symmetric` are valid on
  `extrude`, `lathe`, `revolve`, `helix` — never on `translate`/`rotate`
  (step-and-repeat). The server rejects them.
- **Put the `difference` op LAST.** The exported solid is the last group; a
  cut followed by another op silently loses the cut (and `model_to_stl` will
  print a watertightness WARN).
- **`symmetric: true`** extrudes `±v/2` around the sketch plane, so a cutting
  profile pierces a body of any thickness — that is how all library holes work.
- **Mesh weld.** Boolean residues like `-2e-14` would otherwise show up as
  spurious naked edges; every exported STL is welded to a 1e-6 grid, so a
  correct model reports `nakedEdges=0 closed=true`.

## Library parts

| Part | Key params (defaults) |
|---|---|
| `flange` | outerD=100, boreD=40, boltCircleD=70, boltD=10, nBolts=6, thickness=10 |
| `lBracket` | width=60, height=40, leg=8, depth=30 |
| `tube` | innerR=8, outerR=12, height=20 (lathe) |
| `pulley` | rimR=30, hubR=12, boreR=5, rimW=10, hubW=20 (lathe) |
| `spring` | coilR=15, wireR=2, coils=5, pitch=8 (helix) |
| `plateSlot` | w=80, h=40, cornerR=8, slotL=30, slotW=8, thickness=6 |
| `hexNut` | acrossFlats=20, boreD=10, thickness=8 |
| `cone` | baseR=25, topR=8, height=30, wall=0 (lathe) |
| `drilledPlate` | w=60, h=40, thickness=8, holeD=6, margin=7, nHolesX=2, nHolesY=2 (boolean grid) |
| `gear` | teeth=24, module=2, thickness=8, boreD=10, hubD=26, rimW=4, nSpokes=5, nRivets=6, rivetD=4 (involute, boolean) |

## Examples

- `examples/flange-to-stl.js` — minimal MCP client (SDK + stdio): spawns the
  server, generates a flange, checks watertightness. Run from the repo root:
  `node examples/flange-to-stl.js`
- `examples/spec-plate-hole.json` — the exact `arguments` payload for
  `model_to_stl` / `create_model`: 40x40x10 plate with a Ø16 through hole
  (measured volume ≈ 14041 mm³, `closed=true nakedEdges=0`).

## Testing

```bash
npm test
```

End-to-end over stdio: tool listing, specs, booleans, library parts,
determinism, measurements, exports, mesh repair. Asserts watertightness
(`nakedEdges=0 closed=true`) on every boolean part and on `repair_stl` output.

## Repo layout

```
src/index.js     MCP server, 15 tool registrations
src/slvs.js      JSON spec -> .slvs binary writer
src/parts.js     10 parametric part generators
src/cli.js       solvespace-cli wrappers (export/render, -t tolerance)
src/measure.js   STL reader + volume/area/watertightness (weld at 1e-6)
src/stlmerge.js  STL merge with transforms, weld, binary writer
src/section.js   plane-cut cross-section -> SVG
src/repair.js    boundary-loop detection + hole capping (watertight fix)
test/run.js      E2E suite (node test/run.js)
build/           generated .slvs/.stl (gitignored)
```
