# Parity fixture

`tests/fixtures/parity/parity-v1.map` is a small, deterministic map in which every row of the REWRITE-PLAN §5
parity matrix has real content. The shared-v8 snapshot and the 100K world lack halo, regiments, emoji and image
markers, a legend, measurers, dashed grid, ice, stock-hatch zones, lakes, the data layers and more, so a golden or
replay over them proves nothing for those rows.

| File | What |
|---|---|
| `tests/fixtures/parity/parity-v1.map` | the map: text `.map`, 2.86 MB, loads with `fns.loadMap({text})` |
| `tests/fixtures/parity/parity-v1.json` | manifest: sha256, config, per-layer census, feature to matrix-row table, camera presets |
| `index.ts` | `resolveFixture("parity" \| "shared")`, config, types |
| `features.ts` | the feature table (rows, expectations) and `checkCensus` |
| `parity-page.js` | page-side script: build steps, `census()`, `preamble()`. Inject with `addInitScript` |
| `build-parity-fixture.ts` | builds the file and manifest |
| `fixtures.test.ts` | node test (no browser): file matches manifest, rows covered, cameras sane |

## Use from a gate or golden

```ts
import { resolveFixture } from "./fixtures/index.ts";
const fx = resolveFixture("parity");          // verifies the sha256 against the manifest
fx.path; fx.text(); fx.cameras;               // cameras: k 1/2/4/8 presets, d3 zoom {k, x, y} for a 1280x720 viewport
fx.manifest.coastlineSwitch;                  // frames either side of the k 1.5 / 2.6 filter switches
fx.manifest.layerCensus;                      // per layer {elements, min, tags} for the layer-census assertion
// in the page, before the first frame:
await page.addInitScript(fx.pageScript);      // once, before goto
await page.evaluate(() => __parity.preamble());   // after loading the map; then wait ~2 s for trade animation
const census = await page.evaluate(() => __parity.census());   // compare with checkCensus(census, {withPreamble: true})
```

Load with a **1280x720** viewport so the camera presets line up. DPR is free.

## The preamble

The file deliberately lacks, and `__parity.preamble()` adds:

- **cells layer.** The `#cells` layer is a 0.8 MB raster; leaving it off keeps the file under 3 MB. The preamble calls
  `toggleCells()`.
- **#debug content** (a control point and a highlight), which is runtime-only and never saved (row 23).
- **Options > Rendering = Best quality.** `load.ts` sets the select from the previous map's `#viewbox`, so a fresh page
  reads "Best performance" over a map saved with "Best quality" and `updateZoomStyling` then stops scaling the halo.
  The preamble matches the select to the file, as a user would.

The trade animation needs nothing: `TradeAnimation.sync()` runs on load and the markers appear after about a second.

## Rebuild and verify

```sh
npm run gate -- build                                   # dist/ must be current (CF_BUILD=1 vite build)
node bench/host/fixtures/build-parity-fixture.ts        # writes tests/fixtures/parity/ (--out DIR for elsewhere)
node bench/host/fixtures/build-parity-fixture.ts --verify [--shots DIR]   # load the file, re-check the census, frame every preset
                                                        # and check each covered family has ink in the frame
node bench/host/fixtures/build-parity-fixture.ts --seeds a,b,c            # what other seeds would generate (lakes, land)
node --test bench/host/fixtures/fixtures.test.ts        # no browser
```

The builder drives one headless page through the app's own functions (the MCP bridge for generate and layers,
`parity-page.js` for each feature), saves with `prepareMapData`, reloads the text in a second page and compares
the census before writing anything. It refuses to write a manifest if an expectation fails. The header's date and
map id (the only things that vary between runs) are rewritten, so two builds on one host give the same sha256.

## Camera presets

`parity-v1.json` `cameras` holds, per k in 2/4/8, a `showcase` (regiments, markers, measurers, labels, the coastline
filter, dashed grid, coordinates, halo), and one preset each for `ice`, `lake`, `compass`, `emblem` and two or three
stock `hatch` zones, plus `k1-world`. `coastlineSwitch` frames either side of the k 1.5 and 2.6 filter switches.
`COVERS_BY_FAMILY` in `index.ts` maps the `covers` tags to golden families. The golden frames each family with the
presets that cover it; a family with several covering presets at one k (zones) gets one cell per preset, keyed
`…/k4@<camera id>` after the first. `--verify` isolates each covered family in each preset's frame and requires at
least 100 px of ink (dpr 1), so a preset that slides off its target fails the check, not only the golden.

## What the fixture is, and is not

- Seed `parity10`, template `continents`, density 3 (5,000 grid cells, about 3.7K pack cells), 8 states, 80 burgs,
  1280x720, relief density 0.4. The grid density was chosen for the size budget: at 10,000 grid cells the same
  content is 3.6 MB or more, because the layer rasters and per-cell data grow with the cell count. Override with
  `PARITY_CELLS`, `PARITY_BURGS`, `PARITY_RELIEF` to build a bigger variant (it will not match the committed sha).
- The seed has 7 lakes (needed for the six stock lake groups). It has no glaciers of its own and the ice step grows one.
  Seven icebergs are added with `Ice.addIceberg`, the way the ice editor does it, and three are dragged.
- No network: every non-local request is aborted, so label and legend metrics use the host's fallback fonts. A different
  OS may give a different sha256 for the same inputs.
- Labels at k 8 are hidden by the app's own `hideLabels` rule (size above 60 px). Goldens at k 8 that need labels must
  turn that option off.
- Style filters (pencil, turbulence, paper, crumpled, splotch) belong to the presets, not to this file.
