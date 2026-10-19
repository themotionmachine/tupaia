# Proof plan: gates that decide the rewrite

**Nothing here has been run.** No harness exists in the snapshot: there is no `bench/`, no `tests/` dir, no vitest/playwright config, and `tests/fixtures/demo.map` (referenced by `binary-map.test.ts:32`) is missing. Twenty-one unit test files exist; they stub the DOM and do no pixel readback (audits/verification.md). Building this proof infrastructure is P0 work. Stage caps are in SPENDING-PLAN §4.

## 1. Measurement rules

- **Device matrix.**
  - M1 Max (Chromium/Metal) at DPR 1 and 2.
  - One Windows iGPU (Chromium/D3D11) at DPR 1.25 and 2.
  - Safari is a smoke check only (INFERRED limits).
- **Input.** Use native input (CDP `Input.dispatchMouseEvent` or physical). Any synthetic DOM dispatch run must be labelled as such. The OWNER-BRIEF numbers are synthetic DOM dispatch at DPR 1.
- **Pairing.** Run at least 10 interleaved A/B pairs (flag `svg` vs `gpu`), with idle frame cadence matched within ≤2 ms. Include cold-start and world-replace runs.
- **Metrics.** Report p50/p95 with a bootstrap 95% CI for:
  - event→next-frame;
  - long tasks;
  - GPU time via `EXT_disjoint_timer_query_webgl2` where available;
  - JS heap;
  - estimated GPU memory (sum of allocations tracked by GpuDevice).
- **Fixtures.**
  - "100k" fixture: really 53,194 cells.
  - Shared world: 47,885 cells.
  - A legacy-map corpus covering every `auto-update.ts` migration path.
  - Binary TUPAIA saves.
  - A max-cells world (slider max).
- **Normalization.** Saves normalize the `new Date()` in params (`save.ts:60-63`) before comparison.

## 2. G0: harness gate (end of P0)

- The harness reproduces the brief's SVG numbers within ±10% under synthetic dispatch. Wheel 41.7 ms, input 16.5 ms and pan 33.2/27.9 ms are on the main atlas build, so if the snapshot differs, record the delta.
- The DOM-attribute census (I5) is complete. It lists every attribute and `data-*` written by editors, presets and `auto-update`, along with the writing site.
- The SceneDocument shadow parse passes I1–I6 on the whole corpus with the SVG renderer unchanged.
- Pinned versions are recorded for d3, three and fonts. The d3 build itself is absent from the snapshot and must be sourced before G0.

## 3. G1: GPU proof slice go/no-go (end of P1, hard stop-loss)

The slice covers fills (states, biomes), borders and rivers as strokes, zone hatch, the state-label layer (curved), relief instances, CPU picking and one compat-lane layer, all behind `?renderer=gpu`.

| Metric | Go | No-go (stop) | Basis |
|---|---|---|---|
| Wheel p95, 100k fixture | ≤20 ms | >25 ms | 41.7 ms best SVG |
| Input→frame p95 | ≤16.5 ms | >20 ms | 16.5 ms best SVG (no regression; the baseline's ≤4 ms was unsupported) |
| Shared pan callback | ≤1 ms | >5 ms | 0.8/27.9 ms |
| Shared pan frame p95 | ≤25 ms | >33 ms | 25 / 33.2 ms |
| Hover `readPixels` | 0 | any | design |
| CPU pick | ≤1 ms p95 | >3 ms | design |
| Compat lane added input | ≤5 ms | >10 ms | worker lane regressed input to 57.5 ms |
| GPU memory | ≤160 MB target | >256 MB | followup-camera-lod §5 |
| JS heap growth over 20 world replaces | ≤100 MB, no monotone growth | leak | |
| Context loss → restored frame | ≤500 ms | no restore | none in source today |
| Lazy GPU chunk | ≤300 KB gzip (INFERRED target) | >600 KB | |

All rows must pass on M1 Max DPR 1 and 2. The Windows iGPU must pass the "no-go" column at least. Failing any no-go row at the P1 cap stops the GPU track (SPENDING-PLAN §7).

## 4. G-C: correctness and fidelity (per matrix row, REWRITE-PLAN §5)

- **Goldens.** One per layer family at k ∈ {1, 2, 4, 8}, plus the k-switch points 1.5 and 2.6 for the coastline filter. Use dynamic zoomMin (not 0.8) at DPR 1 and 2. All built-in style presets.
  - Pass: SSIM ≥0.95, fraction of pixels with delta >16 at most 1%, and a whole-frame diff of ≤0.5% of pixels at delta ≤44. The last reference is the brief's relief-tile diff: 0.486%, max 44.
  - Goldens are per GPU family, not cross-device.
- **Hatch.** Pitch within 1 device px of SVG at k 1/2/4/8. Canonical 4/5 px, red hatch 6 px. The phase stays world-anchored across pan.
- **Strokes.** Width within 1 device px. Dash phase continuous.
- **Group opacity.** A synthetic overlap fixture (states halo, regions, zones, label groups) matches the SVG offscreen composite.
- **Labels.** Same visible label set as `cullMapLabels` within ±0.01 k of thresholds. Size formula `(d + d/k)/2`. Curved label glyph positions within 1 px of SVG `getStartPositionOfChar` on a 200-label sample. measureText vs SVG advance parity is checked per pinned font.
- **Fonts.** Built-in plus Google/web/local font switches re-atlas correctly. This is UNVERIFIED because the loader definitions are absent.
- **Hit parity.** 500 random points per fixture:
  - 100% cell agreement away from edges (more than 1 px from a border);
  - at least 99.5% agreement for burgs, labels and markers;
  - click disambiguation through the GPU ID pass matches the SVG topmost element.
- **Compat lane.** Captured textures equal the source renderer's output at capture resolution, with a pixel diff of 0 when not resampled.
- **Memory and resize.** DPR change and window resize. No growth over 20 world-replace cycles. Stale-world token rejection (`relief-viewport.ts:50-54` pattern).

## 5. G-E: editor bridge parity

For every editor in REWRITE-PLAN §5 row 29, run a scripted gesture script recorded on the SVG renderer and replayed with the flag on. Each step asserts that the resulting `pack`/`grid` deltas and the model DOM attribute deltas are identical.

The scripts cover:
- click-select;
- drag a node (burg, label, relief, marker, regiment, ruler);
- brush paint (relief, heightmap, provinces, zones, biomes);
- creator modes (routes, rivers, diplomacy, ice, states/religions manual assign);
- undo/redo for each undo system, including cultures markup undo and the templates undo.

Each script also asserts:
- no double dispatch of click handlers;
- no camera pan during a brush stroke;
- `d3.mouse` shim coordinates within 0.5 world units of the SVG CTM result for the element-scoped sites;
- frame p95 with an editor open stays within the G1 Go thresholds +2 ms.

## 6. G-S: save, load, export and consumers

- **Text `.map`.** save→load→save byte-identical after declared normalizations. 46 CRLF sections. The SVG at `mapData[5]` passes I1–I15.
- **Binary TUPAIA.** Round-trip parity with text at the model level. Cloud version history load. ldb lastMap.
- **Legacy corpus.** Every `auto-update` path loads on the hidden model, and the migrated model then renders on GPU.
- **Export.**
  - SVG/PNG/JPEG export and tiles are pixel/structure-equal to the current renderer, with computed styles inlined.
  - The minimap click-to-pan target matches.
  - The 3D mesh texture golden excludes overlays; satellite mode is unchanged.
  - The transform-tool 4× preview golden.
- **Customization.** Save stays blocked during customization. Trade `data-layer-off` is preserved. `#ruler`/`#tradeAnimation` are cleared.

## 7. G3/G4: flag flip and release

- **G3:**
  - all matrix rows green;
  - the DOM census shows zero unhandled attributes;
  - there is a rollback flip test.
- **G4:**
  - second GPU family green;
  - the owner runs a manual session with native input on their own hardware;
  - SVG display path deprecation window agreed.

## 8. Existing tests to keep green and extend

- `zoom-update-scheduler.test.ts:148`
- `relief-raster-worker.test.ts:65`
- `zone-hatching.test.ts:149,189`
- `dense-zoom.test.ts:278,300`
- `binary-map.test.ts` (needs the missing fixture)
- every other existing unit file

Playwright is not auto-run by agents (source/CONTEXT.md). Owner-run only.

## 9. What the current numbers do NOT prove

- **Not covered:** physical FPS, input-to-photon latency, DPR >1, any non-Apple GPU, cold start, a real hand on a mouse.
- **Weak sampling:** there are too few samples for a credible p95, and idle cadence is a confound.
- **Not reproducible yet:** the bench harness is not in the snapshot, so the numbers cannot be reproduced from it.
