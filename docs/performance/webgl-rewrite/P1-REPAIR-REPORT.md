# P1 Repair Report

Scope: fixes for the host-check failures recorded in `host-checks/` (3 failing unit tests, 11 TypeScript errors,
24 Biome errors / 9 warnings), plus the requested GPU integration review. Nothing was executed while making these
changes: no tests, tsc, Biome, build or bench. Every claim below comes from reading the code. The host must run tsc,
scoped `biome --write`, vitest, node bench tests, build, and the read-only Metal bench and pixel checks to verify.
No deployment, no P2 work, no paid API calls, no new dependencies, no global flag flips. SVG remains the default
renderer.

## Unit test failures

| Test | Cause | Fix |
| --- | --- | --- |
| `geometry.test.ts` F32 "grows beyond capacity" | Test artifact: `push2(i, -i)` stores `-0` at i=0, and `toEqual` treats `-0` and `0` as different. | Test pushes `(i, -i - 1)`. |
| (found during review) | Real bug: `F32.ensure` doubled `data.length`, so a capacity of 0 never grew and the loop ran forever. | `ensure` starts from `max(length * 2, 16)`. The constructor rejects negative or non-integer capacity. New test: "grows from zero capacity and rejects invalid capacities". |
| `pick.test.ts` "spanning many buckets" | The test expected `big` at (10,10), but `tiny` is added later, so it is topmost there. | Test now asserts topmost semantics (`tiny` at the corner, `pickAll` order `[tiny, big]`). It keeps the bucket-boundary probes (20/30/100/890/899.9 resolve to `big`) and adds tolerance-edge probes at (10.6,10.6). |
| `pick.test.ts` "matches brute force" | Real bug in `PickIndex.addFill`: the tolerance band skipped each fill ring's implicit closing edge. The brute-force oracle (`polylineDistance(..., true)`) was right. | `addFill` marks fill rings as closed. The oracle is unchanged. New test: "includes the implicit closing edge of a fill in the tolerance band". |

## TypeScript errors

- **`device.test.ts` TS2352:** the fake event was an invalid cast. Replaced with a real `new Event(type, { cancelable: true })`. `fire()` returns `defaultPrevented`, so the test still checks that context loss calls `preventDefault`.
- **`framegraph.ts` TS2769:** `quad()` took `rect`/`uv` as `ArrayLike<number>`. They are now typed `Float32List`, which matches `uniform4fv`.
- **`prepare.ts` TS6133:** removed the unused `scaleBucket` import.
- **`renderer.ts` TS2300:** the private `camera` field collided with the public `camera(update)` method that main.js calls. Renamed the field to `view`; the method name is unchanged.
- **`scene.ts` TS2339:** added optional `display`/`visibility` to `Styles`. The code that reads them is unchanged.
- **`renderer-mode.ts` TS2554:** `svgBackend` was typed as a one-argument factory but called with none. It is now a plain `(): RendererBackend`.

## Biome errors (lint)

- **`framegraph.ts`:** removed the namespace import with dynamic access (`noDynamicNamespaceImportAccess`). It now uses named shader imports and a local `shaders` record; `Kind` is `keyof typeof shaders`.
- **`renderer-mode.ts`:** `release` is typed `(renderer: GpuRenderer) => void` (`noConfusingVoidType`).
- **`compat.ts`, `raster.ts`:** removed assignments inside expressions. The `parseTransform` loop now returns `null` when the sticky regex fails, which is the same result as the old final `lastIndex` check.
- **`raster.test.ts`, `scene.test.ts`, `text.test.ts`:** `forEach` callbacks use block bodies (`useIterableCallbackReturn`).
- **`prepare.ts`, `geometry.test.ts`:** imports sorted. The framegraph import is now type-only.
- **`renderer.ts`:** the duplicate class member is resolved by the rename above.
- **Format-only findings** in camera, compat, framegraph, geometry, pick and raster (and their tests) are left for the host's scoped `biome --write`.

## Integration review

| Item | Finding / change |
| --- | --- |
| Native D3 wheel/drag calls the camera once; default SVG unchanged | main.js calls `window.gpuRenderer?.camera(update)` once per scheduler frame. Without `?renderer=gpu` the GPU module is never imported, `gpuRenderer` is undefined, and every hook falls through to the existing SVG code. Not changed. |
| No per-frame paint/layout writes to the SVG under GPU | Inexact updates return true from `camera()`/`defers()`, so main.js skips the transform write and the style/visibility/detail work. `draw()` only writes the canvas `display`. Exact updates write the canonical SVG as before. |
| SVG stays canonical and owns gestures; stale hit-targeting | Documented in the `renderer.ts` header. During motion, native SVG handlers hit-test against the last exact transform. `gpuPick` uses the GPU camera. Editors cannot run on stale coordinates: an open editor suspends the GPU, and `hide()` writes the GPU camera to `#viewbox` before the SVG is shown. |
| Editor fallback uses real visibility | **Bug fixed:** `customization` is a top-level `let` in classic main.js, so it is not a `window` property. `page.customization` was always undefined and editor mode was never detected. Now read as a bare global with a `typeof` guard. **Bug fixed:** dialog detection read inline `style.display`, so CSS-hidden or never-opened `.ui-dialog` elements counted as open. It now uses `checkVisibility({ checkVisibilityCSS: true })`, falling back to computed `display`/`visibility`. |
| Same `customization` bug in prepare | **Fixed** in `prepare.ts` `cellRings()`: it always picked `pack` and never `grid`. `grid`/`pack` are `var`s, so they are still read from `globalThis`. |
| Fallback restores the SVG camera | Router fallback → `dispose()` → `syncSvgCamera()`. `hide()` also syncs. Not changed. |
| Stale async work after world replace/dispose | `generation` is bumped on replace, dispose and loss. `prepare()`'s `stale()` checks generation, lost and disposed, and a stale result is dropped before it is assigned. The `refineCompat` context checks generation and `prepared` identity. **Added:** `worldReplaced` adopts the new `#viewbox` transform and clears `moving` before `drop()`, so `hide()` cannot write the previous world's camera over the replaced map. |
| Device creation failure leaves nothing behind | **Fixed:** the constructor removes the canvas if `GpuDevice` throws. If `FrameGraph` throws (shader compile/link), it disposes the device and removes the canvas. Observers and the window listener are attached only after both succeed. |
| Context restore rebuilds resources | `restored()` builds a new `FrameGraph`, resizes and re-prepares. The old graph is not disposed on purpose: its handles died with the lost context and the device already cleared its tracking (comment added). A restore failure falls back to SVG. |
| No self-triggered MutationObserver loop | The only GPU write to the live SVG is the `#viewbox` transform in `syncSvgCamera`, and the observer ignores exactly that. Compat rasterization mutates only the detached export clone (`prepareMapClone`), never the live document. |
| Honest telemetry | **Added** `canvasVisible` to `GpuTelemetry`. `state: "active"` means a frame is prepared; `canvasVisible` means the GPU canvas is on screen now. |
| GLSL 300 ES validity | Read-only review: every program starts with `#version 300 es` and declares precision. The glyph shader multiplies the premultiplied color by atlas alpha. The stroke shader indexes `u_dashes[8]` with a constant bound, and prepare sends patterns with more than 8 dashes to compat. No issues found. Not compiled here; the host's Metal run is the real check. |
| Capture adapter cannot fake parity | `bench/gpu-capture.ts` reports `gpu` only when the router is active on gpu, telemetry state is `active` and the canvas is displayed. Otherwise the GPU arm is rejected or reported as svg. Not changed. |

## Remaining risks

- None of these changes has been compiled or run. TypeScript should accept the try/catch definite assignment in the `GpuRenderer` constructor (each catch rethrows), but the host must confirm.
- `checkVisibility` options: older TypeScript DOM libs may not type `checkVisibilityCSS`. If tsc objects, use the computed-style branch alone.
- Stale SVG hit-targeting during motion is documented, not removed. Hover tooltips and click handlers on SVG elements can resolve against the pre-gesture transform until the exact frame.
- Editor detection still uses heuristics (`customization` plus visible `.ui-dialog`). Tools that edit the SVG without either signal are not detected, so the GPU path stays experimental.
- The 500 ms context-restore target and the visual parity of the compat lane remain unmeasured until the host's Metal bench and pixel checks run.
- `renderer.ts` has no unit tests. The constructor cleanup, editor detection and world-replace camera adoption are covered only by reading.
