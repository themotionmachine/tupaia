# P1 navigation reliability tranche

Status: **partial**. The motion-time prepare stall is fixed in 2 of 3 final navigation runs and in the pure scheduling
model. The third run still reported `preparesDuringMotion 1`, and the cause is unresolved. It had no visible stall
(longTasks 0, gpuPresentedFraction 1). Context restore is still over the 500 ms target. Heap creep is characterized but
not fixed. Default renderer is still SVG; GPU is opt-in. No pixel parity is claimed.

## Metric corrections (supersede earlier docs)

- Original pilot, 100k wheel: **RAF p95 16.8 ms**; **event→RAF p95 42.9 ms**.
- State B (P1-GATE-NEXT), 100k wheel: RAF p50/p95/max 8.3 / 10.2 / 18.2 ms; event→RAF p50/p95 23.4 / 32.5 ms.
- Compare like with like:
  - RAF p95: 16.8 → 10.2.
  - event→RAF p95: 42.9 → 32.5.
  - The earlier "42.9 → 8.3" mixed two metrics and two percentiles, so it is withdrawn.
- All of these figures are CDP-dispatched input, not photon latency. The 10 interleaved A/B pair gate has **not** been
  run.
- Previous tranche spend was **$3.72464861** (actual receipt), not "about $3.2". P1-GATE-NEXT.md is corrected.

## Root cause

During a gesture, d3.zoom sends only inexact camera updates, which change GPU uniforms only. Map decoration code still
writes the SVG DOM on zoom:
- `public/main.js` `updateZoomStyling` (lines 555–637): `#town` / `#states` label `@class`
- `label-culling.ts:182`
- `zone-hatching.ts:204`: `zone-hatch` `@patternTransform`
- `dense-zoom.ts:172–188`
- `draw-scalebar.ts:31–103, 143`: scale bar childList
- `options.js:211`

The renderer's MutationObserver classified these writes as "static", which started a **full prepare** (about
2.1–2.3 s on 100k) **while the camera was moving**. Its synchronous chunks can't be interrupted, so the 100k pan-near
run showed a 100 ms long task, preparesDuringMotion 1 and gpuPresentedFraction 0.9958.

## Fix (code state D)

- `src/gpu/motion.ts` (new): pure decisions.
  - `prepareStart`: skip / defer / run.
  - `prepareStale`: superseded / motion / "".
  - `settleAction`: prepare / refine / none.
  - `describeMutation`: telemetry string.
- `src/gpu/renderer.ts`:
  - Inexact camera updates set `moving`. Exact updates, or a `MOTION_IDLE` = 1000 ms watchdog, clear it and settle.
  - An invalidation during motion is recorded as `prepareWanted` (deferred, not dropped). It runs at settle.
  - An in-flight prepare that motion overtakes stops at its next await checkpoint.
  - The renderer now **re-checks `stale()` just before commit**. Motion can start during the last synchronous chunk,
    after the final checkpoint. Without this re-check the frame swap happened mid-gesture: the state-C run-3
    regression.
  - A world with no frame (replaced or restored) still prepares during motion, because nothing else could draw.
  - `worldReplaced` and dispose reset `moving` and `prepareWanted`.
  - `pending` includes `prepareWanted`.
  - New telemetry: `moving`, `motionDeferrals`, and `invalidations {count, last}`.
- `src/gpu/markers.ts`: `classify(records, found?)` reports the record that forced "static".
- `src/gpu/motion.test.ts` (new, 14 tests): unit tests for the helpers, plus a `Model` that replays the renderer's
  composition over these event sequences:
  - mid-gesture deferral
  - abort after the last checkpoint (the commit re-check)
  - replaced world during motion
  - lost-context recovery
  - superseded restart

  The tests check that every interrupted or deferred invalidation ends in a settled frame with no prepare committed
  during motion.

## Artifacts and code states

All checks ran serially through `tupaia_checks`. Artifact prefix: `host-checks/p1-delegated-<id>`.

| State | Check | Artifact id | Result |
|---|---|---|---|
| baseline (B) | navigation dpr2 | 1792101445210794000 | 100k pan-near: prepares-in-motion 1, frame max 100, 1 long task |
| C (deferral, no commit re-check) | navigation run 1 | 1792101870301236000 | wheel RAF p95 16.3 |
| C | navigation run 2 | 1792101983100719000 | clean |
| C | navigation run 3 | 1792102044499300000 | **regressed**: prepares-in-motion 1, gpuPresented 0.9959 |
| D (final) | unit | 1792102217395849000 | 528 pass |
| D | build | 1792102224611668000 | ok |
| D | bench | 1792102229804251000 | 20/20 |
| D | navigation dpr2 run 4 | 1792102233415145000 | see table |
| D | navigation dpr2 run 5 | 1792102297220158000 | see table |
| D | navigation dpr2 run 6 | 1792102356940176000 | see table |
| D | hatch dpr2 | 1792102479758619000 | noReprepare; maxDelta ≤ 1; over16 0 |
| D | context | 1792102488441090000 | covered; lastRestoreMs 596.6 |
| D | lifecycle | 1792102500878735000 | covered; heap below |
| D | smoke dpr2 z8 | 1792102574437125000 | covered; over16 0.0029, maxDelta 158 |
| D | hatch dpr1 | 1792102585017795000 | noReprepare; maxDelta ≤ 1; over16 0 |

**Pass criteria:** every D check had `report.errors` = [] and `failure` = null, and the GPU was active with
canvasVisible true. All navigation runs also reported covered, finalCameraExact true and longTasks 0. The hatch
fixture is synthetic, so window coverage "none" is expected there.

## Same-metric comparisons (100k world, dpr2, CDP input)

| Metric | Baseline | D run 4 | D run 5 | D run 6 |
|---|---|---|---|---|
| pan-near preparesDuringMotion | 1 | 0 | 0 | **1** |
| pan-near gpuPresentedFraction | 0.9958 | 1 | 1 | 1 |
| pan-near motionDeferrals | — | 1 | 1 | 0 |
| pan-near frame max (ms) | 100 | 41.6 | 33.1 | 25.1 |
| pan-near long tasks | 1 × 100 ms | 0 | 0 | 0 |
| pan-near idle frame max (ms) | 449.9 | 458.2 | 458.3 | 458.2 |
| wheel RAF p50/p95/max (ms) | 8.3 / 9.9 / 25.2 | 8.3 / 16.6 / 18.1 | 8.3 / 10.2 / 18.4 | 8.3 / 10.0 / 24.9 |
| wheel event→RAF p50/p95 (ms) | 23.3 / 30.2 | 23.5 / 33.0 | 23.5 / 29.0 | 23.1 / 29.2 |
| shared wheel RAF p50/p95/max | 8.3 / 8.4 / 10.1 | 8.3 / 8.4 / 10.2 | 8.3 / 8.4 / 10.2 | 8.3 / 8.4 / 9.8 |
| shared wheel event→RAF p50/p95 | 22.5 / 24.9 | 22.6 / 24.6 | 22.6 / 24.6 | 22.6 / 24.6 |

- Across the C and D runs, the 100k wheel RAF p95 was 16.3, 15.1, 9.8, 16.6, 10.2 and 10.0 ms, against a single
  9.9 ms baseline. That is **possible regression or variance**, not an improvement. Settling it needs interleaved pairs.
- **The pan-near stall is gone in all three D runs:** frame max 100 → 25–42 ms, no long tasks, gpuPresented 1.
- **The idle max did not improve:** about 458 ms in every D run. It is the post-gesture re-prepare. It now runs after
  motion rather than during it, but the user still pays for it at rest.

## Run 6: unresolved `preparesDuringMotion 1`

Run 6 reported `motionDeferrals 0` and still counted one prepare during motion. The harness computes
`preparesDuringMotion` outside the repo, so I could not check how it defines the motion window. Hypotheses, none
verified:
- (a) The harness window opens at input dispatch, before the first inexact camera update sets `moving`. A settle-time
  prepare from the previous phase can overlap it.
- (b) A world-switch prepare (`hadFrame=false`) is deliberately allowed during motion.

There was no visible effect: longTasks 0, gpuPresented 1, frame max 25.1. Closing this needs either the harness's
motion-window definition or a renderer-side `preparesWhileMoving` counter compared against the harness.

## Candidate and rejected causes

- **Accepted:** decoration DOM writes cause a static invalidation, which starts a full prepare during motion. The
  `invalidations.last` telemetry confirms the source, e.g. `@class <text#stateLabel28> in #states`.
- **Accepted (secondary):** a prepare's final synchronous chunk could finish after motion began, then commit
  mid-gesture. Fixed by the commit-time re-check (state C run 3 → D).
- **Rejected:** dropping invalidations during motion. That would be a correctness loss: the edit would never be painted.
- **Rejected:** a timer delay before prepare. It hides the problem.
- **Rejected for this tranche:** classifying decoration mutations as non-static. That is the right next step but needs
  per-layer prepare (P2 scope).
- **Not isolated:** the run-6 count (above).

## Memory

**Navigation:**
- 100k wheel steady was 151,167,398 B in runs 4–5 and 171,340,142 B in run 6. The budget is 167,772,160, so run 6
  was over (as was the baseline). Steady memory is bimodal, not reliably under budget.
- Peak was 222.4 MB in every run.

**Lifecycle, 20 world switches:**
- Cycle 0: 93,309,908 B.
- Cycle 1: 128,847,152 B, a one-time +35.5 MB.
- About +0.35 MB per cycle after that, reaching 135,587,604 B at cycle 20.
- heapGrowthBytes 42,277,696.

**Findings:**
- The read-only memory audit found no unbounded retention in `src/gpu`. Releases cover world replace, dispose and
  loss.
- Remaining suspects: the export `prepareMapClone` path in `src/io/export`, and GC timing. The trusted lifecycle harness explicitly forces GC with HeapProfiler.collectGarbage before each snapshot (host review correction).
- No fix was made, because there was no well-evidenced bounded bug. Profiling was kept bounded.

## Context recovery

Injected loss and restore work, and the restored frame is covered. `lastRestoreMs` is **596.6 ms against the 500 ms
target**: still over, and essentially unchanged from 597.9. Restore is a full prepare. Meeting the target needs either
a cheaper restore path (keeping CPU-side tessellation for re-upload) or a smaller first frame.

## Limitations

- **Input:** CDP input, not photon latency. One run per state. No 10 interleaved pairs.
- **Unabortable chunks:** synchronous prepare chunks still can't be aborted. Motion starting inside one waits for the
  chunk to finish; only the commit is prevented.
- **Harness coverage:** the gesture harness lacks rapid reversal, resize/DPR change mid-gesture, world switch during
  motion, and context loss during motion. The trusted harness can't be edited here. The `Model` tests cover the
  scheduling logic for world switch and loss, but not in a browser.
- **External metric:** `preparesDuringMotion` is computed by the harness, outside the repo.
- **Smoke coverage:** only dpr2 z8 was re-run. Other smoke cells were not run on state D.
- **No pixel parity:** the smoke diff at z8 has changedFraction 0.13 and maxDelta 158 (cause not isolated; the trusted harness interrupts trade-marker animation before fidelity captures).
- **Agent model:** the two audit children were launched without a model parameter (the tool exposes none). Host receipt modelUsage confirms claude-haiku-5-5 usage for the two-child tree.

## Next bounded chunk

Stop decoration DOM writes from forcing a full prepare. Options:
- Classify the label `@class`, `zone-hatch` `@patternTransform` and scale-bar records as overlay or dynamic, or
  re-raster only the affected compat layer.
- Move the scale bar out of the observed subtree.

This removes the ~458 ms post-gesture idle frame and the root of the motion-time stall. Then:
- add a renderer-side motion-prepare counter to settle run 6
- run the 10 interleaved wheel pairs

## Spend

This tranche was about $4.2 at the time of writing (CLI meter, including the children), under the $6 cap. The final
figure is the CLI receipt. No outside paid APIs were used.
