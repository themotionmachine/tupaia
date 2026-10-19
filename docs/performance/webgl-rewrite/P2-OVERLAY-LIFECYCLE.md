# P2 — Screen-overlay refresh lane (`#scaleBar`)

Status: **implemented in the implementation working tree only. Not deployed.** Production remains the frozen P1
deployment `ad4f0bf6-2b07-4142-ac9f-a585a645fb98`. SVG is still the default renderer and GPU stays opt-in. This
slice does not change any dependencies, file formats, harness, config or budget.

This is one slice of the rewrite, not the whole rewrite. SceneDocument, the editor bridge, GPU picking and native
labels are still future work.

## Problem

`drawScaleBar` redraws `#scaleBar` (a root `svg#map` child that the prepared frame draws as a compat *screen* run)
on pan and zoom. Before this slice, any childList, attribute or style mutation under it was classified as **static**.
That bumped the revision and ran a full settle-revision `prepareFrame`. At 100k this was the main source of the
458 ms idle max on pan.

## Code states and artifacts

| State | Description | Key artifact(s) |
|---|---|---|
| Before | P1 tree + earlier P2 bridge, scaleBar → static → full prepare | navigation `p1-delegated-1792108707018176000`; lifecycle baseline `p1-delegated-108829060846000` (heapGrowth 42320240) |
| Lane v1 | Overlay lane, before the review fix | unit `…1008208833000`, build `…1013985392000`, bench `…1116687999000`, nav DPR2 `…1020295055000` / `…1120178154000`, smokes/hatch/context/lifecycle below |
| Lane v2 (final) | v1 + review fix: clone swaps deferred until every copy resolves, and the raster loop frees held canvases on every exit, including throws | unit `p1-delegated-1792111636134149000` (546/546), build `p1-delegated-1792111640835374000` (renderer chunk 101.13 kB), smoke DPR2 z1 `p1-delegated-1792111647367202000` |

Artifacts live in `docs/performance/webgl-rewrite/host-checks/`. The v1→v2 change only touches the exit and
cleanup paths and the order of clone edits. The v2 smoke matches v1 on every reported number (over16 0.026714,
maxDelta 221, memory 159378721, overlays refreshes 1 committed, fulls 0, stale 0), so the browser-check rows below
were not repeated for v2.

## Files and ownership

| File | Change | Owns |
|---|---|---|
| `src/gpu/markers.ts` | `overlayRoot(node)` returns the `svg#map` child holding a node, or null for `#viewbox`/`defs`. The classifier adds an `overlay` class with precedence static > overlay > dynamic > none | Mutation routing |
| `src/gpu/overlays.ts` (new, DOM-free) | `releaseRuns`, `uploadAll`, `swapOverlays` | Texture ownership. A screen-run texture is **slot-owned** and is not in the frame's `textures` list. World-run textures belong to the frame list. Detail textures are slot-owned |
| `src/gpu/prepare.ts` | `overlayCopy`, `refreshOverlays(prepared, ctx, roots)` → `"committed" \| "stale" \| "full"`. `release()` calls `releaseRuns` | Re-rasterizes one prepared compat screen batch in place |
| `src/gpu/renderer.ts` | `pendingOverlays` set. A setTimeout(0) job with a `stale()` guard. `"full"`/throw → `invalidate()`. World change clears pending. Telemetry `gpu.overlays {refreshes, fulls, stale, lastMs, last, pending}` | Scheduling, cancellation, fallback |

Exactly-once free: `releaseRuns` nulls each slot texture after releasing it, so a second release or a later swap
frees nothing twice. `swapOverlays` releases each old texture once, and only after every new texture uploaded.
`uploadAll` frees partial uploads and rethrows if an upload fails, leaving the slots untouched.

## Principles (pattern → evidence → change → test)

Format follows `RENDERER-READING-GUIDE.md`.

1. **Stable layer identity.**
   - **Pattern:** a screen overlay is a long-lived batch keyed by its root element.
   - **Evidence:** before this slice, nav DPR2 showed 2 prepares per shared pan, one of which was the scaleBar settle-revision.
   - **Change:** the lane finds the existing run by `run.elements[0] === root` and keeps its slot, painter position, opacity and blend. A missing, hidden or new overlay returns `"full"`.
   - **Test:** `markers.test.ts` covers overlay classification and precedence. Nav DPR2 shows shared pan prepares going 2 → 1.
2. **Persistent resources.**
   - **Pattern:** replace only the texture of the affected batch. Geometry, the other textures and the window cache are unchanged.
   - **Evidence:** smoke memory totals match P1, and lifecycle shows a flat 159379573 over 21 cycles.
   - **Change:** `swapOverlays` uses upload-then-release. The rect updates only when the new texture is non-null.
   - **Test:** `overlays.test.ts` ("swaps an overlay texture…", "keeps the rect for a fully transparent replacement").
3. **Selective invalidation.**
   - **Pattern:** an overlay mutation does not bump the revision.
   - **Evidence:** nav DPR2 shows overlay refreshes going from 1 to 7 with 0 fulls. The 100k pan-wide idle max drops 458 → about 9 ms.
   - **Change:** the classifier routes overlay mutations to `pendingOverlays`. The cached compat clone is patched (`overlayCopy`) so later rasters at the same revision agree. If anything can't be handled (unsupported content, over budget, raster/upload throw), it falls back to `invalidate()`, so a mutation is never ignored.
   - **Test:** `markers.test.ts`, plus `fulls` and `stale` counters in the smokes and nav runs.
4. **Clear ownership.**
   - **Pattern:** a resource has exactly one owner and is freed exactly once.
   - **Evidence:** a review found a missing cleanup on the raster-throw path, now fixed in v2.
   - **Change:** slot-owned screen textures are handled in `overlays.ts`. Held canvases are zeroed in a single `finally`.
   - **Test:** `overlays.test.ts` (4 tests: double release, swap, transparent, failed upload). The context-loss and lifecycle checks show memory going to 0 on loss/dispose.

## Correctness guarantees

- **Painter order, opacity, filter, blend:** unchanged, because the slot is mutated in place.
- **Transform, bounds, camera, DPR:** the overlay is rasterized against `ctx.screen` (width, height, dpr) and cropped to its bounds. Transform and style changes on the root are copied into the clone.
- **Staleness and cancellation:** `ctx.stale()` is checked after the clone await, after every raster, and before upload. Stale results are discarded and freed. A world change clears pending work.
- **Budget:** new bytes must fit `windowAllowance(total, old)` (old+new swap peak). Otherwise the lane returns `"full"`. The 160 MiB steady (167772160) and 256 MiB peak caps are unchanged.

## Metrics

| Metric | Before | After |
|---|---|---|
| Shared pan prepares (nav DPR2) | 2 | 1 |
| 100k pan-wide idle max | 458 ms | ~9 ms |
| 100k pan-near idle max | 458 ms | ~250 ms (remaining settle-wanted prepare) |
| Overlay refreshes / fulls / stale (nav) | n/a | 7 / 0 / 1 (stale at 100k, recovered) |
| Single overlay refresh cost (DPR2 smoke) | full prepare (for scale: the same run's initial prepare took 823 ms) | 53.4 ms (v1), 51.2 ms (v2) |
| Nav steady max / peak | — | 159378898 / 204850141 (caps 167772160 / 268435456) |
| Lifecycle heapGrowthBytes | 42320240 | 42263332 |

## Pass/fail cells

All of these runs had exit 0, failure null, errors [], active gpu, fallbackReason "", canvasVisible and
sourceCurrent true, temporaryExportClones 0, swapDrops 0, overlay fulls 0 and stale 0. Coverage was covered for
all of them.

| Check | Artifact | over16 | maxDelta | GPU total | Overlay refreshes | Result |
|---|---|---|---|---|---|---|
| unit v1 / v2 | `…1008208833000` / `…1792111636134149000` | | | | | PASS 546/546 |
| build v1 / v2 | `…1013985392000` / `…1792111640835374000` | | | | | PASS |
| bench | `…1116687999000` | | | | | PASS 20/20 |
| nav DPR2 ×2 | `…1020295055000`, `…1120178154000` | | | 159378898 / peak 204850141 | 7 | PASS |
| smoke DPR1 z1 | `…1182903974000` | 0.01326 | 124 | 132196081 | 1 | PASS |
| smoke DPR1 z2 | `…1192544911000` | 0.00766 | 125 | 130441389 | 0 | PASS |
| smoke DPR1 z4 | `…1200837505000` | 0.012128 | 125 | 127756549 | 0 | PASS |
| smoke DPR1 z8 | `…1254727771000` | 0.003509 | 158 | 123240757 | 0 | PASS |
| smoke DPR2 z1 v1 / v2 | `…1263910121000` / `…1792111647367202000` | 0.026714 | 221 | 159378721 | 1 | PASS |
| smoke DPR2 z2 | `…1273883073000` | 0.012646 | 243 | 159380293 | 0 | PASS |
| smoke DPR2 z4 | `…1283317788000` | 0.008265 | 237 | 155087005 | 0 | PASS |
| smoke DPR2 z8 | `…1294185363000` | 0.002935 | 158 | 137195593 | 0 | PASS |
| hatch DPR1 | `…1343410611000` | 0 | ≤1 | 4089781 | | PASS (noReprepare, cameraOnlyNoSvgUpdates) |
| hatch DPR2 | `…1352249976000` | 0 | ≤1 | 15307493 | | PASS (noReprepare) |
| context loss/restore | `…1360094307000` | 0.012646 | 243 | 113712433 (peak 159380293) | | PASS (lost → 0, restore 597.5 ms, heapGrowth 0) |
| lifecycle 21 cycles | `…1370740056000` | | | 159379573 stable | | PASS (heapGrowth 42263332 vs baseline 42320240) |

Fidelity tolerances were not changed.

## Review

An independent review found no high-severity defects.

- **Partial clone mutation on a `"full"` return.** Benign: `invalidate()` bumps the revision, so the full prepare
  rebuilds the compat clone, and the copies mirrored the live DOM anyway. v2 now resolves every copy before swapping
  any in.
- **Held canvases not zeroed if `rasterizeRun` throws.** Valid and fixed in v2: the raster, budget, upload and
  swap steps share one `try/finally` that zeroes every held canvas.

## Limitations

- The harness has no case for rapid scaleBar reversal (several mutations queued during one refresh), for a DPR or
  viewport resize between scheduling and commit, or for world loss mid-motion while a refresh is pending. These
  paths are covered by the `stale()` guard and pending-clear logic, but no browser check exercises them.
- The old overlay pixels stay on screen for about one raster/decode (~50 ms at DPR2) until the swap. The lane does
  not leave pixels stale indefinitely, but it does not update them in the same frame either.
- Overlays that are unsupported or over budget fall back to a full prepare. This is correct but costs the same as
  before.

## Next slice

On wheel-zoom, zone hatching rewrites the canonical `<defs>` pattern `patternTransform`. That edit is classified
as static and still causes one settle-revision prepare per zoom gesture. The remaining ~250 ms 100k pan-near idle
max comes from the settle-wanted prepare. The next slice should route the hatch `patternTransform` edit to a
camera-derived uniform or defs-local refresh instead of a full revision. The hatch checks already show
`noReprepare` for camera-only motion, so the change is limited to classifying that defs mutation.
