# Changelog

Notable changes to this project are documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning: [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-27

First stable release: 15 MCP tools over solvespace-cli 3.1.

### Added

- MCP server over stdio (`src/index.js`) exposing 15 tools:
  `solvespace_version`, `create_model`, `export_model`, `model_to_stl`,
  `list_parts`, `create_part`, `part_to_stl`, `batch_parts`, `measure_model`,
  `repair_stl`, `open_in_gui`, `export_png`, `export_format`, `section_view`,
  `assemble`.
- JSON spec -> `.slvs` writer (`src/slvs.js`): sketches (line, circle, arc,
  point), constraints, extrude / translate / rotate / lathe / revolve / helix,
  and `combine` / `symmetric` boolean ops (difference must be the last
  operation of the group).
- Parametric parts library (10 generators): flange, lBracket, tube, pulley,
  spring, plateSlot, hexNut, cone, drilledPlate, involute spur `gear`
  (sampled involute, `line`/`circle` contour only).
- `assemble`: multi-part STL merge with per-part translate / rotate.
- `measure_model`: volume, area, center of mass, naked-edge watertightness.
- `repair_stl`: cap closed boundary loops with a centroid triangle fan;
  reports before/after `nakedEdges`, uncapped open chains and degenerate
  edges honestly, plus per-loop planarity deviation (Newell, mm).
- `section_view`: plane-cut cross-section -> SVG; `export_png`;
  `export_format` (stl, obj, svg, pdf, dxf, step, ...); `open_in_gui`.
- STL vertex weld at 1e-6 after every export (watertight by construction)
  and an end-to-end test suite over stdio (`npm test`, ALL TESTS PASSED).

### Fixed

- Boolean silent failure: overlapping cut loops in one sketch left
  `Group.meshCombine` in a failed state without raising an error and the
  solid base was exported instead. `gear()` now clamps the kidney span to
  `min(40deg, 2*pi/n - 2*capAng - 1.5/rmid)` (drop cut when <= 8deg);
  regression-tested (N=32, 6 kidneys -> volume in [13000, 22000]).

[1.0.0]: https://github.com/Astrid3333/solvespace-mcp/commits/main
