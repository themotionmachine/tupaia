# P0 audit reconciliation (Opus)

Haiku children wrote the audit files in this directory, except `bench-harness.md` (see below). Opus spot-checked the load-bearing claims against current code with Grep and Read. Current code is authoritative. Any claim not re-checked keeps the audit's own UNPROVEN marking.

## Spot checks

| Claim | Audit | Result | Evidence |
|---|---|---|---|
| Vendored d3 is v5.8.0 | pins-d3-three-fonts.md:10 | CONFIRMED. Banner `d3js.org v5.8.0` at line 1; `t.version="5.8.0"` at line 2, which is the line the audit cites | public/libs/d3.min.js:1-2 |
| d3.min.js, fonts.ts, demo.map, bench/ and tests are absent (README, REWRITE-PLAN, PROOF-PLAN, backlog O01) | pins-d3-three-fonts.md:100 | CONTRADICTED: all are present | Glob of public/libs/d3.min.js, src/services/fonts.ts, tests/fixtures/demo.map, bench/*.ts |
| Initial `scaleExtent([1, 20])` | hatch-zoom.md:38 | CONFIRMED. The same default is restored in `changeZoomExtent` | public/main.js:238; public/modules/ui/options.js:531 |
| `isOlderThan("1.652.0")` sits between 1.65.0 and 1.7.0 | io-format-undo.md:101,111 | CONFIRMED location. Intent is still UNPROVEN, so behaviour is preserved and no edit was made | src/io/auto-update.ts:496, 538, 544 |
| No pre-existing `?renderer` flag | hatch-zoom.md:113,121 | CONFIRMED before P0. P0 adds it in src/renderers/renderer-mode.ts | Grep for `renderer` URL parsing |
| The bench reliefWorker expectation uses `.has` while the source requires `"1"` | hatch-zoom.md:115 | CONFIRMED and recorded. Not fixed, because it is outside the P0 ownership | bench/navigation-quality.ts:382; src/renderers/relief-raster-worker.ts:38-41 |
| navigation.ts input is synthetic DOM; navigation-quality.ts uses page.mouse | bench-harness.md §1 | CONFIRMED | bench/navigation.ts:261; bench/navigation-quality.ts:279-280 |
| Runtime three is r140 while the npm package is 0.184 | pins-d3-three-fonts.md:51-62 | Not re-checked. It does not affect P0 because P0 imports no three. P1 must decide the pin (O05) | n/a |

## Backlog mapping

| Backlog | Planned output | Delivered | Gap |
|---|---|---|---|
| O01 pins | pins | p0-audits/pins-d3-three-fonts.md | None for P0. The three version decision is deferred to P1 |
| H01 | DOM attribute census | p0-audits/census-dom-attributes.md | None |
| H02 | audits/census-document-lookups.md | p0-audits/census-lookups-globals.md (path differs) | The path differs. The content is also merged with H08 |
| H08 | map globals census | merged into census-lookups-globals.md | None |
| H03 | tests/save/sections.test.ts | Not created. src/renderers/scene-document.test.ts checks the 46-section count and the byte roundtrip of demo.map | No per-section semantic tests |
| H04 | tests/save/binary-roundtrip.test.ts | Not created. scene-document.test.ts checks that `BinaryMapArchive.text()` and `section(5)` equal the text format for demo.map | No multi-fixture binary corpus |
| H05 | tests/fixtures/CORPUS.md | Not created. demo.map is the only file fixture, and the generated 100k world is identified by its parameters in the bench `fixtures` record | No corpus manifest; G0 corpus remains UNRUN |
| H06 | src/gpu/camera-math.ts | Not created. This is a camera change, which this P0 excludes ("no canvas/camera changes") | Move to P1 alongside O05 |
| H07 | bench/README.md | Not created. The protocol was added to bench/navigation.md, which already serves as the bench README | None in substance |
| (bench audit) | p0-audits/bench-harness.md | The child did not write the file. Opus transcribed it from the child's report after re-checking the lines | None |

## Corrections to planning docs

- PROOF-PLAN.md says bench/, tests/, the vitest config and demo.map are absent. That is wrong: all exist. Read P0-GATE-REPORT.md alongside it, and treat the gate report as overriding it.
- REWRITE-PLAN.md and the backlog O01 say d3.min.js is absent. That is wrong: it is present and is v5.8.0.
- Backlog O04 places routing in `invokeActiveZooming`. P0 routes on world lifecycle events only (map:generated, map:loaded, map:resampled) and leaves the camera and zoom path untouched. That keeps `?renderer=svg` behaviour identical. The per-frame hook moves to P1.
- The backlog's H02 path (`audits/`) is superseded by `p0-audits/census-lookups-globals.md`.
