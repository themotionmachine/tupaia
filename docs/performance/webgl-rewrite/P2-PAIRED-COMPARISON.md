# P2 paired SVG/GPU timing comparison (DPR2): pilot invalid, stopped at block 1

Status: **STOPPED after pilot block 1 of 5.** The fixed comparability gate failed (`comparable:false` on all four
metrics). All four GPU runs fail identically, so blocks 2–5 would repeat the failure. They were not run, and
`paired-summary` was not run. This report contains no pooled 10-pair result and no bootstrap CI that supports
inference.

No source, renderer, harness, threshold, timing config or budget was changed. Frozen P1 is unchanged. Nothing was
deployed and the default was not flipped. The only new file is this report.

## What was run

| Item | Value |
|---|---|
| Check | `tupaia_checks` `paired`, dpr=2, block=1 (repeats=2 → 4 fresh browser slots, 2 pairs) |
| Schedule | slot0 B/gpu, slot1 A/svg, slot2 A/svg, slot3 B/gpu (BA, AB) |
| Seed | report 7320; the fixture generator seed recorded in slots is 7319 |
| Config | 1280×720, DPR 2, samples 1 (+1 cold iteration), frames 120; gestures pan-near / pan-wide / wheel-zoom |
| Fixtures | shared map sha256 `f5c0d703…79f5c0` (4,947,866 B), identical in A and B slots; 100k generated (cells 100000, seed 7319, continents, 1280×720) |
| Hardware | Apple M1 Max, darwin arm64, Chromium 148.0.7778.96, node v25.6.1; load avg 2.72 → 2.90 |
| Dist fingerprint | before = after = `c1813c085b18749c488d9c204d9126f562149c1a6ad4eb5ae9898aef1a3def9a` |
| Artifacts | `docs/performance/webgl-rewrite/host-checks/paired-dpr2-block1/` (`slot-{0..3}-*.json`, `report.json`, `host.log`, `host-receipt.json`) |

## Validity findings from the pilot

**Arm identity (OK).**
- Every GPU slot reports `requested:"gpu"`, `active:"gpu"`, an empty `fallbackReason` and `gpuPresentedFraction: 1` in every cell.
- Every SVG slot reports `active:"svg"` and `gpuPresentedFraction: 0`.
- `modelUnchanged`, `settledExact` and `finalCameraExact` are true throughout.
- No GPU run fell back to SVG, so none was relabeled.
- The only `fallbackReason` strings belong to the experimental relief worker, which is disabled in both arms.

**Cadence gate failure (invalidates the block).**

| 100k / wheel-zoom idle p95 (ms) | iter 0 | iter 1 |
|---|---|---|
| slot0 GPU | 16.7 | 16.7 |
| slot1 SVG | 8.4 | 8.4 |
| slot2 SVG | 9.7 | 8.6 |
| slot3 GPU | 16.7 | 16.7 |

- In slot3 iter 0, GPU idle is p50 8.4, p95 16.7, max 25. The 119 intervals sum to 1167.8 ms, a mean of 9.8 ms against the 8.33 ms display interval.
- The GPU arm intermittently drops frames during the "idle" control window, and only in this cell. It happens after the GPU readiness gate has passed: `bench/navigation.ts:210-218` waits for `canvasVisible && !pending && !refinementPending`, and `rendererReadyWaitMs` was 2826 ms.
- This cell differs from the others because wheel-zoom starts at scale 3.5 instead of 8 (`bench/navigation.ts:199`), so the whole 100k world is in view.
- The gesture window that follows runs mostly at 16.7 ms intervals, which is about 60 Hz.
- The other five cells pass the cadence gate (|Δ idle| ≤ 1.7 ms).

**Cause: measured symptom, cause not determined.**
- The readiness flags report the GPU as ready, but the main thread or compositor is not idle.
- Candidates, none confirmed:
  - post-preparation GC or upload tails;
  - per-frame GPU-path cost near the 8.3 ms budget at full-world view;
  - async work not covered by `pending`/`refinementPending`.
- This is a real GPU-arm behavior, not noise. It reproduced in 4/4 GPU runs. Under the fixed rule it makes the run non-comparable, and it must not be averaged away.

## Native audit (one read-only child, bench/navigation.ts + bench/renderer-ab.ts)

| Finding | Class |
|---|---|
| A/B differ only by `renderer` URL param; same seed, viewport, DPR, 120 inputs / 120 rAF per gesture | OK |
| GPU-only readiness wait (`navigation.ts:210-218`); SVG gets the fixed 350 ms sleep only | CAVEAT (asymmetric start state; relevant to the failure above) |
| `gpuAfterSettle.pending/refinementPending/sourceCurrent` recorded but not gated; analyzeAb gates only `modelUnchanged/settledExact/finalCameraExact` (`renderer-ab.ts:263-264`). The pilot has `refinementPending:true` at settle end in most GPU cells | CAVEAT |
| "Presented" = `canvas.style.display === "block"` at tick (`navigation.ts:373-374`), not a draw-count diff; renderer `stats.frames` exists but is unused | CAVEAT |
| Cadence gate compares median of per-run idle p95 with absolute 2 ms (`renderer-ab.ts:288-291`); passes silently if one arm lacks idle data (`:290`) | CAVEAT |
| Input is in-page synthetic `dispatchEvent` (`navigation.ts:273-282`), not CDP. `inputDispatch` = synchronous handler time only; it favors an arm that defers work to rAF | CAVEAT |
| Unit of analysis is the per-run p95 (no frame pseudo-replication) | OK |
| Median is nearest-rank `sorted[floor(n/2)]` (`renderer-ab.ts:93-97`); bootstrap is **unpaired** despite the ABBA design, 2000 iterations, one fixed seed reused per cell (`:106-115, :299`); 24 uncorrected intervals | CAVEAT |
| `summary()` returns `|| 0` for empty input (`navigation.ts:435-440`), so an empty sample enters the pool as a valid 0 ms value | DEFECT (latent; not observed in pilot, all callback samples non-zero) |
| Sign convention B−A for both delta and CI (`renderer-ab.ts:298-299`) | OK |

## Pilot numbers (descriptive only, n=2 per arm; CIs at n=2 are degenerate and not reported as evidence)

Median of per-run p95, ms. A = SVG, B = GPU, Δ = B−A (negative favors GPU).

| world / gesture | frame A | frame B | Δ | callback A | callback B | inputDispatch A | inputDispatch B | idle A | idle B |
|---|---|---|---|---|---|---|---|---|---|
| shared / pan-near | 8.6 | 16.9 | +8.3 | 0.1 | 0.8 | 0.3 | 0.5 | 10.8 | 9.2 |
| shared / pan-wide | 10.4 | 16.8 | +6.4 | 0.5 | 0.8 | 0.4 | 0.5 | 10.2 | 8.5 |
| shared / wheel-zoom | 10.2 | 17.5 | +7.3 | 2.0 | 0.8 | 2.2 | 0.5 | 9.8 | 8.5 |
| 100k / pan-near | 17.0 | 25.0 | +8.0 | 0.2 | 10.8 | 0.4 | 0.5 | 9.6 | 9.1 |
| 100k / pan-wide | 18.2 | 25.0 | +6.8 | 1.7 | 12.2 | 0.6 | 0.5 | 10.0 | 8.6 |
| 100k / wheel-zoom ✗ | 41.7 | 25.0 | −16.7 | 4.4 | 14.1 | 10.9 | 0.5 | 8.6 | 16.7 |

✗ = cadence-mismatched cell; its deltas are not comparable.

What this suggests, without inferential weight:
- On shared-map navigation, SVG is already at or near the 120 Hz cadence floor: frame p95 8.6–10.4 ms against an 8.33 ms interval. GPU frame p95 is about 17 ms, roughly one extra vsync. No GPU advantage is visible there.
- On 100k pan, GPU frame p95 is about 7–8 ms worse. GPU rAF callback p95 is 10.8–12.2 ms, which exceeds the 8.33 ms budget by itself.
- The only cell where GPU looks better is 100k wheel-zoom (25 vs 41.7 ms; PROOF-PLAN go ≤ 20, no-go > 25). That is exactly the cell that fails comparability.
- The low GPU `inputDispatch` is expected because GPU work is deferred to rAF. It is not a latency win.

## Limits: measured vs inferred

- Measured: rAF interval p95, synchronous dispatch time, instrumented rAF callback time and idle cadence under compositor-scheduled 120 Hz rAF, all with synthetic DOM input.
- Not measured: input-to-photon latency, physical display responsiveness, and pixel fidelity, which is not part of this check. The earlier CDP pilot's event-to-rAF figure of about 29 ms is a different quantity and is not synthetic dispatch cost.
- Inferred only: the cause of the GPU idle drops, and whether the GPU's 100k wheel-zoom advantage survives a fair start state.

## The rewrite is not done (unchanged by this comparison)

- G-C over16 still fails 3 of 8 cells: DPR2 z1 1.831%, DPR1 z1 1.321%, DPR1 z4 1.182% (`P2-VISUAL-FIDELITY.md`).
- SSIM ≥ .95 and the universal whole-frame pixel gate are UNMEASURED.
- Ownership, editor integration and picking are incomplete.
- Context restore is about 600 ms (`lastRestoreMs` 597.5, prepare 517 ms), which misses the 500 ms target (`P2-INVALIDATION-BRIDGE.md`).
- Lifecycle heap growth of 42.3 MB over about 20 regenerations is unresolved (`P2-INVALIDATION-BRIDGE.md`, `P1-GATE-NEXT.md`).
- The Windows iGPU no-go column is untested.

## Exact repair needed before blocks 2–5 (orchestrator; requires edits I was not authorized to make)

1. **Make the start state symmetric and observable** (`bench/navigation.ts` around lines 208–226).
   - After the existing readiness wait, run the same quiescence wait in both arms: up to N s for K consecutive rAF intervals ≤ 1.5× the display interval.
   - Record `quiescenceWaitMs` per arm and per cell as a reported metric, so a GPU post-preparation cost is surfaced rather than hidden.
   - On timeout, record a problem; do not throw silently.
2. **Report comparability per cell** (`bench/renderer-ab.ts:288-291`). A mismatched cell should be flagged and excluded from that cell's verdict only, not from all six cells. This is a protocol change, so it needs explicit approval and a new test.
3. Close the audit gaps:
   - Gate `gpuAfterSettle.pending/refinementPending/sourceCurrent`.
   - Confirm presentation with a `stats.frames` diff.
   - Raise a problem instead of returning `|| 0` for empty samples (`navigation.ts:435-440`).
   - Pair the bootstrap by ABBA pair.
   - Fail when idle data is missing.
4. Re-run the pilot as a new block. Existing block directories refuse overwrite, so the tool needs new block ids or a protocol version.

## Recommendation for the next spending slice

Do not run blocks 2–5 or `paired-summary` on the current harness, and do not fund broader migration on this evidence.

The pilot does not show a GPU navigation advantage:
- SVG is at or near cadence on the shared map.
- GPU is about one vsync slower on pan.
- The single favorable cell (100k wheel-zoom) is the one the harness cannot compare fairly.

Next, fund one narrow slice that answers that single question:
- (a) Run one traced GPU run of 100k/wheel-zoom at scale 3.5 to attribute the idle drops and the ~11–14 ms GPU rAF callback.
- (b) Apply the harness repair above.
- (c) Rerun the 10-pair DPR2 comparison.

Defer fidelity (G-C), heap, context-restore and native-scene work until (c) shows a supported GPU advantage. Do not fund input-latency work: `inputDispatch` cannot measure latency, and no measurement here shows an input-latency problem.
