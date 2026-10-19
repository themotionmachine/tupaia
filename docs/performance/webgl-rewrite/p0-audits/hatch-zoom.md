# P0 audit: hatch, zoom, URL flags

Scope: read-only source facts. Paths relative to `implementation/`. UNPROVEN = not verified at runtime or not re-read in this pass.

## 1. Hatch patterns

| Item | Value | Evidence |
|---|---|---|
| Pattern defs group | `hatch0`..`hatch41` (42 patterns) | src/index.html:8815-8958 |
| Common tile size | width/height 4 user units | src/index.html:8815-8958 |
| Dot tiles | `hatch6`, `hatch32`-`hatch35`, width/height 5 | src/index.html:8815-8958 |
| Stroke | black, widths 1.5 / 2 / 2.5 | src/index.html:8815-8958 |
| Red stroke in stock defs | none | src/index.html:8815-8958 |
| Test fixture | width 6, dots 5, stroke red 0.8 | src/renderers/zone-hatching.test.ts:104-109 |
| Doc claim "red 6 px" | UNPROVEN doc claim, not found in stock source | docs/performance/hatch-scaling.md:9 |
| Style override of hatch | none in `public/styles/*.json`; no hatch match in `tests/fixtures/demo.map` | Grep, this pass |

### Zone hatch scaling

| Item | Value | Evidence |
|---|---|---|
| Entry point | `updateZoneHatching(k)` | src/renderers/zone-hatching.ts:140-207 |
| Clone originals | clones each source pattern | src/renderers/zone-hatching.ts:174-181 |
| Clone marker attr | `data-zone-hatch-clone` | src/renderers/zone-hatching.ts:180 |
| Transform formula | `` `scale(${1 / k})` + optional existing transform `` | src/renderers/zone-hatching.ts:203 |
| Restore | `restoreZoneHatching` | src/renderers/zone-hatching.ts:66-82 |
| Normalize | `normalizeZoneHatching` | src/renderers/zone-hatching.ts:83-90 |
| Call sites | `window.updateZoneHatching?.(scale)` in `invokeActiveZooming` | public/main.js:543 |
| Other call site | `updateZoneHatching` in `drawZones` | public/main.js:204; public/modules/ui/layers.js:1008 |
| Test assertion | width x (1/k) x k = source width, at k in {1, 2, 8} | src/renderers/zone-hatching.test.ts:149-166 |

Pitch arithmetic (derived from the formula above, UNPROVEN at runtime): the viewbox applies `scale(k)`. A pattern tile of width w user units renders at w*k px. With `patternTransform=scale(1/k)` the on-screen pitch is w px for any k. Without it the pitch grows as w*k. Stock pitch is therefore 4 px (5 px for dots) under the current code path.

## 2. Zoom setup

| Item | Value | Evidence |
|---|---|---|
| d3.zoom init | `d3.zoom().scaleExtent([1, 20]).on("zoom", zoomRaf)` | public/main.js:238 |
| Fit to screen | sets dynamic `zoomMin` and `scaleExtent` (max from input) | public/modules/ui/options.js:208-226 (zoomMin at 213, scaleExtent at 222) |
| Fit call sites | `fitMapToScreen` at load; also on resize | public/main.js:368; resize hook not re-read (UNPROVEN) |
| Translate extent toggle | `toggleTranslateExtent` | public/modules/ui/options.js:228-241 |
| Change extent | `changeZoomExtent`; default restore `[1, 20]` | public/modules/ui/options.js:515-532 (default at 531) |
| Extent inputs | `zoomExtentMin`, `zoomExtentMax` | src/index.html:1963-1982 |

### ZoomUpdateScheduler (src/renderers/zoom-update-scheduler.ts)

| Gate | Rule | Evidence |
|---|---|---|
| Camera | every frame, latest update | zoom-update-scheduler.ts:70 |
| Style | exact (gesture end) OR (scale changed AND log-scale delta >= 0.02 AND >= 50 ms since last style) | zoom-update-scheduler.ts:72-77 |
| Visible | every frame | zoom-update-scheduler.ts:78 |
| Details | exact OR >= 75 ms since last details | zoom-update-scheduler.ts:79-84 |
| Settle | `end()` forces exact paint | zoom-update-scheduler.ts:87-91 |
| Callbacks wiring | ZoomUpdateScheduler callbacks | public/main.js:202-221 |

### Per-frame dispatch

`invokeActiveZooming` (public/main.js:540-546) calls, in order: `updateZoomStyling`, `updateZoneHatching(scale)`, `cullMapLabels(scale, viewX, viewY, svgWidth, svgHeight)`, `refreshDenseZoom(scale, viewX, viewY, svgWidth, svgHeight)`.

### Zoom-dependent formulas (`updateZoomStyling`, public/main.js:548-630)

| Element | Formula | Line |
|---|---|---|
| Coastline filter | `scale > 1.5 && scale <= 2.6` -> none; `> 2.6` -> `url(#blurFilter)`; else `url(#dropShadow)` | 557 |
| Label font size | `relative = max(rn((desired + desired/scale) / 2, 2), 1)` | 566 |
| Label hide | hidden if `relative*scale < minSize` (default 6) or `> maxSize` (default 60) | 575-580 |
| Emblem hide | `size = font-size * scale`; hidden if `< 25` or `> 300` (defaults) | 589-596 |
| States halo width | `rn(desired / scale^0.8, 2)`; display none if `<= 0.1` | 606-608 |
| Marker size | `max(rn(size/5 + 24/scale, 2), 1)` | 618 |
| Ruler font size | `rn((10 / scale^0.3) * 2, 2)` | 627 |

### Dense zoom (src/renderers/dense-zoom.ts:386-436)

| Rule | Value | Line |
|---|---|---|
| Hide all at or below | `k <= 4` | 391 |
| Viewport | `[-x/k, -y/k, (w-x)/k, (h-y)/k]` | 395 |
| Oversized reconcile | raster bounds > viewport x 2.5 | 422-425 |
| Hysteresis | reconcile if `k > rasterScale * 1.2` or `k < rasterScale / 1.5` | 431 |

### Label culling (src/renderers/label-culling.ts)

| Item | Value | Line |
|---|---|---|
| Default extent | 200 (also reset in `rebuild`) | 17, 38 |
| Default half sizes | halfWidth 200, halfHeight 30 | 49-50 |
| Padding per label | +20 on half sizes | 60-61 |
| Font margin | `desired / font` when desired > font, else 1 | 57-59 |
| Viewport padding | 20 world units | 163-167 |
| Visit prune | skip node if outside viewport +/- extent | 169-170 |
| Hidden class | `viewport-culled` (display none) | 103, 182-183 |
| Transient nodes ignored | `[data-dense-zoom]`, `[data-zone-hatch-clone]` | 24-33, 107, 111 |

## 3. URL query flags

| Flag | Meaning (from code) | Evidence |
|---|---|---|
| `reliefWorker=1` | opt-in to experimental relief worker; value must equal `"1"` | src/renderers/relief-raster-worker.ts:38-41 |
| `maplink` | load map from link | public/main.js:316-318 |
| `seed` | seed; MFCG seeds of length 13 are split (last 4 = burg seed) | public/main.js:330, 380-382, 786-787 |
| `local` | presence check, skips something at load (UNPROVEN which branch) | public/main.js:338 |
| `from=MFCG` | cross-link from MFCG; uses `document.referrer` | public/main.js:378, 787; referrer params at 503 |
| `scale` | initial scale | public/main.js:391 |
| `cell`, `burg` | focus targets | public/main.js:392-393, 399 |
| `x`, `y` | focus coordinates (default graph center) | public/main.js:414-415 |
| `size`, `coast`, `port`, `river` | parsed in a burg-related block (context UNPROVEN) | public/main.js:474-477 |
| `name` | burg name override | public/main.js:510 |
| `width`, `height` | canvas size | public/modules/ui/options.js:584-585 |
| `options=default` | ignore stored options | public/modules/ui/options.js:599; public/main.js:904 |
| `code`, `error`, `error_description` | Dropbox OAuth callback | public/dropbox.html:16-20 |
| `focusOn` source | `searchParams` (load.ts) | src/io/load.ts:800 |

Not found: any `?renderer` flag (Grep over public/ and src/ for `URLSearchParams`, `location.search`, `location.hash`, `searchParams`). `location.hash` parsing not verified (UNPROVEN, not searched for in this pass).

Test/bench mismatch: bench/navigation-quality.ts:382 expects `worker` when `reliefWorker` is merely present (`.has`). Source at relief-raster-worker.ts:38 requires the value `"1"` (`.get(...) !== "1"`). A `reliefWorker=0` URL would pass the bench check as `worker` but the source keeps `main`.

## 4. Contradiction checks

1. **Hatch pitch "red 6 px"**: not supported by stock source. Stock defs are 4 (5 for dots) black strokes (src/index.html:8815-8958). "Red 6 px" appears only in the test fixture (src/renderers/zone-hatching.test.ts:104-109) and a doc (docs/performance/hatch-scaling.md:9, UNPROVEN). No override in `public/styles/*.json`.
2. **scaleExtent**: public/main.js:238 sets `[1, 20]`, but `fitMapToScreen` (public/modules/ui/options.js:208-226, called from public/main.js:368) replaces it with a dynamic min and input-driven max. `[1, 20]` holds only until the first fit or extent change. Effective extent is the options.js value at runtime.
3. **`?renderer` flag**: does not exist. The only renderer-related flag is `reliefWorker=1` (src/renderers/relief-raster-worker.ts:38).

## 5. Open items (UNPROVEN)

- `location.hash` parsing not checked.
- Context of public/main.js:474-477 (`size/coast/port/river`) not fully read.
- src/renderers/relief-settings.ts:168 and src/renderers/draw-relief-icons.ts:65 not re-read in this pass.
- Resize hook that re-invokes `fitMapToScreen` not re-read.
- Hatch pitch values are derived from code, not measured in a browser.
