# P1 gate report — WebGL2 GPU proof slice

**Status: implemented, not executed.** The agent had file tools only. No test, type check, lint, build, browser or
benchmark has run, so no fidelity, performance, memory or restore number below is measured. P1 passes only when the
host checks below are green and the measured items are filled in. P2 has not started.

## 1. Host checks (run in this order)

```sh
npm ci                                            # node_modules is absent in this checkout
npx biome check --write src/gpu bench src/renderers   # formatting only; review the diff
npx tsc --noEmit
npx biome check
npx vitest run                                    # src/**/*.test.ts incl. src/gpu/* and renderer-mode
node --test bench                                 # bench/*.test.ts (renderer-ab etc.)
npm run build
```

Read-only browser benchmarks (host only, after the checks pass):

```sh
BENCH_RENDERER=svg node bench/navigation-quality.ts   # CDP input; SVG arm with captures + hit grid
BENCH_RENDERER=gpu node bench/navigation-quality.ts   # same, GPU arm; writes <output>-gpu.rgba
node bench/navigation.ts                              # unchanged URL when BENCH_RENDERER is unset
BENCH_AB_REPEATS=2 node bench/renderer-ab-run.ts      # ABBA timing, synthetic DOM input
```

Manual smoke: open the app with `?renderer=gpu`, then check `rendererStatus()` in the console (`active`, `gpu.state`,
`gpu.memory`, `gpu.compat`, `gpu.layers`, `fallbackReason`). Without the query string, `rendererStatus().gpu` must be
`undefined` and no `<canvas data-gpu-renderer>` may exist.

## 2. What was built

- **Device** (`src/gpu/device.ts`): raw WebGL2. Handles context loss/restore, DPR capped at 2, backing size clamped to
  MAX_TEXTURE_SIZE, MSAA offscreen targets (≤ 4 samples), and byte accounting for every buffer, texture and target.
- **Camera** (`camera.ts`, `renderer.ts`): the SVG stays the single d3.zoom gesture owner. While moving, `camera(update)`
  only changes uniforms and the `main.js` hooks skip SVG writes. The exact final update writes the canonical
  `#viewbox` transform, and decoration (style/visible/details) syncs then. Hiding the canvas always syncs the SVG
  camera first.
- **Framegraph** (`framegraph.ts`): passes run in DOM order. Fills use stencil-then-cover. Strokes, relief sprites and
  glyphs are instanced. Opacity/mask groups composite from an offscreen target, and compat textures go into their DOM
  slots.
- **Picking** (`pick.ts`): a CPU grid index built at prepare time, queried through `window.gpuPick(x, y, tol)`. There is
  no readPixels anywhere.
- **World replace / stale jobs**: a generation counter. Every await in `prepareFrame` checks `stale()`, and a
  superseded job frees its allocations and returns null. `worldReplaced` drops the frame and the compat clone.
- **Router** (`renderer-mode.ts`): the lazy `import("../gpu/renderer")` runs only when `?renderer=gpu` is set and
  WebGL2 is present. Asynchronous fallback goes through a host that only the active, non-disposed backend can trigger.
  `rendererStatus().gpu` carries telemetry.

## 3. Coverage: native / compat / unsupported

**Native (drawn by GPU passes):**
- `path`, `polygon`, `polyline`, `rect` without rx/ry or % units, and `use` of those without x/y: solid fill
  (nonzero/evenodd), stroke (width, ≤ 8 dash entries + offset), fill-opacity/stroke-opacity, and element opacity over
  fill-only or stroke-only.
- Hatching: `userSpaceOnUse` `<pattern>` fills without viewBox/href/images/filters, rasterized to tiles and sampled
  natively. The raster scale is bucketed to a power of two.
- Relief icons (`image[data-relief]`, opacity 1) as atlas sprites, using the same `drawImage(sprite, x, y, s, s)`
  contract as the 2D relief renderer.
- Cell mesh (`image[data-cell-mesh]`) strokes, and restored `data-path-vectors` markup.
- Curved labels on the `labels` layer (`text > textPath > tspan`, no shadow or letter-spacing, solid paint). Metrics
  come from the loaded font through Canvas2D `measureText` of prefixes, so kerning is kept. Glyphs are instanced quads
  from an alpha atlas.
- Groups (`g`, `a`) with opacity < 1, and/or a binary white/black luminance mask, one level deep.

**Compat lane (`compat.ts`, rasterized from the export clone and composited in DOM order):**
- `circle`, `ellipse`, `line`, rounded or %-unit `rect`, paint-server (`url()`) strokes, %-unit stroke widths;
- filter, clip-path, non-identity transform, nested group opacity/mask, non-binary masks;
- generic `<image>` (external/embedded), `use` with x/y;
- non-curved or shadowed text and labels outside `labels`;
- non-native patterns and patternTransform failures, dash arrays > 8, vector-effect;
- opacity over fill+stroke or over a pattern, relief sprite decode failures, label layout failures (atlas full,
  tspan structure, letter-spacing, paint-server text);
- screen overlays outside `#viewbox`.

The clone comes from `prepareMapClone("gpu")`, so styles, fonts and images are inlined exactly as export does it. That
avoids taint, and it means fonts and external images resolve the same way as in saved files. The clone is cached per
DOM revision and invalidated by every mutation and world replace. World runs get one resolution, chosen to fit a
256 MiB budget (`compatResolution`). At settle, the visible region is refined at backing resolution if it still fits
the budget; otherwise the coarse texture stays. Per-layer native/compat counts and the first reasons appear in
`rendererStatus().gpu.layers` / `.compat`.

**Unsupported → safe SVG (canvas hidden, never blank):**
- No WebGL2, module load failure, prepare exception, or restore failure: router fallback to SVG, with `fallbackReason`.
- Context lost: the canvas is hidden and the SVG shown with the synced camera until restore and re-prepare.
- Editor open (`customization` truthy or a visible `.ui-dialog`): suspended. The SVG is shown and edited live
  (experimental, disclosed in `gpu.suspendedReason`).
- Before the first frame (`waiting`/`preparing`): the SVG is shown, and camera updates write the SVG normally.

## 4. Save/export, styles, flags, schedulers

- The canonical SVG is never replaced or hidden. `#viewbox` keeps its exact transform after every settle, and GPU
  dispose writes the camera back. Save/export read the same DOM as before. `src/io/export.ts` only exposes the
  existing clone preparation, so its output is unchanged in intent but **not host-verified**.
- Custom styles show up through computed styles (native) or the export clone (compat). Flags and schedulers are
  untouched. The ZoomUpdateScheduler still drives every hook, and only non-exact updates are deferred under an active
  GPU frame.
- `get("reliefWorker") === "1"` semantics are fixed in the navigation-quality worker check.

## 5. Memory: estimated vs measured

| Item | Estimate (design) | Measured |
|------|-------------------|----------|
| GPU buffers/textures/targets | Tracked exactly by device accounting; expected to be dominated by compat textures | **not measured** — read `rendererStatus().gpu.memory.gpu.total` |
| Compat world textures | ≤ 256 MiB by construction (resolution chosen to fit) | **not measured** |
| Settle refinement | Skipped when device total + detail > 256 MiB | **not measured** |
| CPU retained | Pick index + glyph atlas canvas (vertex arrays dropped after upload) | **not measured** — `gpu.memory.cpu` (estimate, not heap) |

`gpu.memory.cpu` is computed from retained typed arrays and the atlas size, not from a heap snapshot.

## 6. Benchmark readiness

- `bench/gpu-capture.ts` is a registered capture adapter (`playwright-composited`). It reports `activeRenderer: "gpu"`
  only when the router is on GPU, `gpu.state === "active"` and the canvas is displayed. A GPU arm that isn't presenting
  returns `supported: false` with the reason, and is never relabeled. Pixels are composited page screenshots: they
  are what the user sees, not a GPU readback.
- `navigation-quality.ts` with `BENCH_RENDERER` records the hit grid (GPU pick vs topmost SVG `[id]`, every 80 px), the
  final camera vs the expected transform, the capture with `captureProblems`, and the full status. SVG vs GPU fidelity
  is compared offline with `compareRgba` on the two `.rgba` files.
- `navigation.ts` records `finalCameraExact` and `gpuAfterSettle`, and `analyzeAb` treats `finalCameraExact === false`
  as not comparable. It is recorded, not thrown, so existing SVG baselines stay valid.
- Input labels stay honest: `navigation.ts` = synthetic DOM, `navigation-quality.ts` = CDP. Neither is OS input.
- Not wired: automatic cold/stale-world scripted scenarios beyond what `navigation-quality` already loads, and a
  scripted context-loss/restore timing run. `gpu.lastRestoreMs` is exposed for a host run with `WEBGL_lose_context`.

## 7. Known limits and disclosures

- **Fidelity:** paint-order is ignored. Joins come from overlapping segment quads, not true miter/round joins. MSAA
  antialiasing differs from Skia's analytic AA. Label glyph rasterization is bucketed. None of this is pixel-verified.
- **Deferred decoration:** under an active GPU frame, label culling, dense zoom, scale bar, coordinates and minimap
  update only at settle.
- **Re-prepare churn:** every zoom end re-prepares (~120 ms debounce), because `updateZoomStyling` mutates the DOM.
  Prepare cost on large worlds is unmeasured.
- **Layout:** the canvas is `position: fixed` at the SVG's client rect. Page scroll is not handled (the app has none
  today).
- **Restore:** the 500 ms context-restore target is **unproved**.
- **Editors:** suspension is experimental. While suspended the user sees and edits the SVG. No parity claim is made
  for editor overlays.
- **Hit testing:** the agreement metric compares against the topmost SVG `[id]` ancestor, so it is approximate (layer
  ids vs element ids can differ legitimately).
- **Tests:** unit tests cover pure helpers (camera, path, geometry, pick, device, scene parsing, raster transforms,
  text metrics, router). Compat has no unit test, because it imports `io/export`. Nothing touching WebGL, the DOM or
  fonts is exercised outside a browser.
- **Unverified:** draw-borders markup assumptions, Biome formatting, and TypeScript strictness of the new files.

## 8. Gate verdict

The architecture is viable on paper, and no blocker was found that would force a stop. The safe SVG default holds: no
GPU code loads, allocates or probes without `?renderer=gpu`. **P1 is not passed** until the host checks are green and
these are measured: GPU vs SVG capture mismatch, hit-grid agreement, final-camera exactness, frame timings from the A/B
run, `gpu.memory` totals on the 40-section fixture, and context-restore time. Do not describe the GPU path as
fidelity-proven or smooth before those runs.
