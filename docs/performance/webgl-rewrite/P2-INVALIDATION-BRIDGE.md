# P2 — Incremental invalidation bridge

Scope: isolated `src/gpu/`, `src/renderers/`, tests and docs. SVG is still the default and GPU is still opt-in
(`?renderer=gpu`). Nothing was deployed or released. The frozen deployment (`control/tupaia-deployment.tar.gz`) is
unchanged, and none of this work affects it. The trusted harness was not edited.

All latency numbers are **CDP-injected input → next RAF**, not photon latency. The harness lifecycle check **does**
force GC (`HeapProfiler.collectGarbage`, `forcedGc: true` in the report).

## Changes

### 1. Neutral viewport decoration (classifier)
`classify()` in `src/gpu/markers.ts` now marks three record kinds as pixel-neutral for the GPU frame. They count in
`neutralMutations` and do not bump the revision or start a prepare:
- `viewport-culled` class toggles. A toggle that touches `hidden` is still static.
- zone-hatch clone `patternTransform` changes that are a pure `scale(...)`. Any other transform is still static.
- `data-dense-zoom` subtrees.

Canonical changes still bump the revision and run a full prepare. If a batch mixes neutral and real records, the real
record wins. Coverage is in `src/gpu/markers.test.ts`, suite "classify: pixel-neutral viewport decoration".

**Not yet neutral:** `#scaleBar` childList. It is still classified static, so every gesture ends with one
`settle-revision` prepare (see next slice).

### 2. Memory gating and the window reserve (`src/gpu/prepare.ts`)
- Caps are unchanged: 160 MiB steady and 256 MiB peak (TARGET 80 MiB, MIN_COMPAT 16 MiB). `compatAllowance` is
  unchanged.
- **Root cause of the DPR2 wheel-zoom readiness timeout.** Viewport window crops were refreshed with only
  `MIN_COMPAT` reserved for *all* remaining compat runs. The screen overlays (~5.6 MiB) were rasterized afterwards
  out of that same reserve, which left the world rasters 10.4 MiB (< 16 MiB). That threw
  `world rasters need 64.0 MiB, 10.4 MiB fits`, and the renderer fell back to SVG, so the harness never saw a ready
  GPU frame.
- **Earlier wrong hypothesis.** I first blamed the transient peak while the held frame and the new prepare both
  existed (swap peak). The telemetry ruled this out: peak stayed far below 256 MiB and `swapDrops` stayed 0.
- **Fix.** Screen overlays are now rasterized first. Window crops reserve `sum(screen) + MIN_COMPAT` (when there are
  world runs). The world runs then fit into the real remainder, scaled by `fitScale`. A `BudgetError` is still thrown
  if the remainder is below `MIN_COMPAT` or below the screen-overlay sum. No cap was loosened and no byte counter was
  changed.
- `BudgetError` is now an exported class, so the renderer can tell budget refusals apart from other failures.

### 3. Swap-drop path (`src/gpu/renderer.ts`)
This is for a `BudgetError` raised while a committed frame is held (`job.hadFrame && prepared`). The renderer drops
the held frame and reschedules the prepare once with reason `swap` (outcome `swap-dropped`, counter `swapDrops`).
Every other failure, including a `BudgetError` with no held frame, still falls back to SVG honestly. **This path has
not been exercised:** `swapDrops` is 0 in every check below. It is not a permanent SVG fallback and does not
contribute to any memory pass.

### 4. Telemetry (explicit definitions)
- `neutralMutations`: count of mutation records that `classify()` returned as neutral. Each record counts once, not
  each batch.
- `preparesWhileMoving.starts` / `.commits`: prepares that started, and prepares that committed, while
  `moving === true` at that moment.
- `lastPrepare {reason, hadFrame, moving, outcome}`:
  - `reason` is one of `revision | settle-revision | settle-wanted | swap | restore | …`.
  - `hadFrame` means a committed GPU frame was being shown when the prepare started.
  - `outcome` is one of `running | committed | swap-dropped | failed`.
- `swapDrops`: see §3.
- `windows {coverage, bytes, margin, refreshes, misses, detailReleases}`: viewport window crop state. A miss means the
  camera left the cropped window before a refresh landed. Misses are logged with `console.info`.
- Edge retry for window refresh is now limited to the non-edge case (`!edge`), so a crop that is already clamped at
  the world edge does not loop.
- Every router fallback now logs `console.warn("Renderer fallback: <reason>")`
  (`src/renderers/renderer-mode.ts:191`), so a fallback shows up in harness warnings. None appeared in any run below.

### 5. Test fixture
I fixed the unit fixture DOM mock so the classifier and prepare tests exercise real attribute and record shapes.
Unit: 537/537.

## Results

Artifacts are under `docs/performance/webgl-rewrite/host-checks/`. Every run had exit 0, `errors: []`,
`failure: null`, no `Renderer fallback` warning, and `swapDrops 0`. Checks ran one at a time.

| Check | Artifact | Result |
|---|---|---|
| unit | p1-delegated-1792108696051903000 | 537/537 |
| build | p1-delegated-1792108701511772000 | OK |
| bench | p1-delegated-1792108077517656000 | pass |
| navigation DPR2 | p1-delegated-1792108707018176000 | 6/6 runs active gpu, see below |
| smoke DPR1 z1 | p1-delegated-1792108807746702000 | covered; steady/peak 132.2 MB; diff changed 0.138, over16 0.0133, maxDelta 124; prepare 759 ms |
| smoke DPR2 z8 | p1-delegated-1792108819474913000 | covered; steady/peak 137.2 MB; diff changed 0.131, over16 0.0029, maxDelta 158 |
| smoke DPR2 z4 | (earlier run this tranche) | pass, steady 155.1 MB |
| hatch DPR2 | p1-delegated-1792108914648610000 | z1/2/4/8/pan maxDelta ≤ 1, over16 0; noReprepare true; cameraOnlyNoSvgUpdates true; prepares 1; neutralMutations 77 |
| hatch DPR1 | p1-delegated-1792109007970065000 | z1/2/4/8/pan maxDelta ≤ 1, over16 0; noReprepare true; cameraOnlyNoSvgUpdates true; prepares 1; neutralMutations 77; memory 4.1 MB |
| lifecycle | p1-delegated-1792108829060846000 | forcedGc; ~20 regenerations; heapGrowth 42.3 MB; context restore supported |
| context | p1-delegated-1792108922748697000 | injected loss + restore OK; restore prepare 517 ms (lastRestoreMs 597.5); peak 159.4 MB (152.0 MiB); post-restore total 113.7 MB |

### Navigation DPR2 (CDP input)
In all 6 runs: active gpu, coverage `covered`, `finalCameraExact` true, longTasks 0, `gpuPresentedFraction` 1,
`preparesWhileMoving {0,0}`, window misses 0. Each run's final `lastPrepare` was the post-gesture
`settle-revision`/`settle-wanted`, still `running`, with `hadFrame: true`.

| World | Gesture | frame p95 | event→RAF p95 | steady total | peak | notes |
|---|---|---|---|---|---|---|
| shared | pan-near | 8.4 ms | 8.1 ms | 144.8 MB | 144.8 MB | |
| shared | pan-wide | 8.4 ms | 8.1 ms | — | 197.6 MB | |
| shared | wheel-zoom | 8.4 ms | 24.3 ms | 145.7 MB | 204.9 MB | neutralMutations 150 |
| 100k | pan-near | 8.4 ms | 8.1 ms | — | — | idle p95 43 ms, **idle max 458 ms** |
| 100k | pan-wide | 8.5 ms | 8.5 ms | — | — | |
| 100k | wheel-zoom | 10.1 ms | 28.9 ms | 143.0 MB | 214.2 MB (204.3 MiB) | neutralMutations 2400; settle prepare 2284 ms; readyWait 3.3 s |

Memory: the maximum peak was 204.3 MiB (≤ 256), and steady was at most ~139 MiB (≤ 160). Budget field 167772160.

### Against baselines (CDP input, not photon latency)
| Metric | Baseline | P2 |
|---|---|---|
| wheel frame (RAF) p95 | 16.8 ms | 8.4 ms shared / 10.1 ms 100k |
| wheel event→RAF p95 | 42.9 ms | 24.3 ms shared / 28.9 ms 100k |
| single pilot | 9.9 ms | not re-measured separately; pan event→RAF p95 8.1–8.5 ms |

The wheel improvement comes from removing the prepares that ran during the gesture: decoration no longer bumps the
revision, so `preparesWhileMoving` is 0. Before the reserve fix, DPR2 wheel-zoom did not reach readiness at all.

### Not run (budget)
- Smoke cells DPR1 z2/z4/z8 and DPR2 z1/z2. Only DPR1 z1, DPR2 z4 and DPR2 z8 ran in this tranche.
- The optional second Haiku review was skipped. One disjoint Haiku audit ran earlier in the tranche.

## Next slice
1. **ScaleBar overlay lane.** Move `#scaleBar` into a screen-space overlay lane, or classify its childList as neutral
   with a targeted overlay refresh. This removes the `settle-revision` full prepare after every gesture.
2. **Settle prepare cost.** 2.3 s on 100k (and ~0.8–0.9 s shared) is the cost behind readyWait. Even after (1),
   canonical edits pay it. Look at incremental per-layer rebuilds.
3. **100k pan-near idle spike.** Idle frame max is 458 ms (p95 43 ms), probably the settle prepare's main-thread
   rasterization landing in the idle window. Chunk it, or move it to a worker or OffscreenCanvas.
4. **Dense-zoom image style.** Neutral `data-dense-zoom` is currently safe only because the GPU frame ignores that
   decoration. If it ever needs to show, give it its own lane rather than a revision.
5. **Wheel event→RAF still 24–29 ms p95** against 8 ms for pan. Profile the wheel handler and the D3 zoom transition
   path. The remaining cost is not prepare (preparesWhileMoving is 0).
6. **Exercise the swap-drop path** with a forced-budget unit or bench case. It is currently untested in the browser.
