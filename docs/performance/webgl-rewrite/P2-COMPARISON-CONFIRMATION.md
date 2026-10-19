# P2 comparison confirmation (PAIR-V3, DPR 2)

Status: **VALID, all 5 blocks / 10 interleaved pairs / 20 slots.** The independent audit of the empty-group skip cleared it (no defect). This is a timing comparison only. Every earlier gate listed under "Still open" stays open.

Rendering code and `dist` were frozen for this job. No source, test, harness, control, config or threshold was edited. The only file written is this one.

## 1. Independent audit: exactness of the empty-group skip

Scope: `src/gpu/framegraph.ts` `emptyOnView()`, `composite()`, the fill/stroke/mask draw guards, and `src/gpu/framegraph.test.ts`. One read-only native child ran it, with no edits, checks or network. The primary spot-checked the cited lines.

Verdict: **EXACT. No correctness defect found.** No repair was assigned.

| Question | Finding |
|---|---|
| Stale or wrong-view emptiness | No cache. `emptyOnView` is evaluated inline from `composite()` (framegraph.ts:457) against `this.visible`, which is recomputed at the top of `render()` (:175). It uses the same bounds/counts/frame buffers as the draw paths and the same `1/k` pad as the existing cull (:209). Opacity does not enter the decision. |
| Masks | Stencil bit 0x80 starts clear (:188, :475). Only white mask fills with `count>0` that are on view set it (:490). Masked children test `LESS 0x80` / `EQUAL 0x80` (:279, :335, :370), and child writes are masked to 0x7f/0x01. A mask with nothing on view therefore hides every child, so skipping is exact. An empty mask `[]` hides children in both renderers, matching SVG. A skip leaves no stencil state behind, because each draw path sets its own func/op/mask. |
| Composite / ghosting | Each non-skipped composite clears the group FBO first (:474–476). A skipped group would only have composited a fully transparent premultiplied layer under src-over, which changes nothing. Blend order and opacity accumulation are unchanged. Nested group opacity/mask is rejected as compat (scene.ts:298), so the shared `this.group` FBO cannot be reused while a composite is still in progress. |
| Fill vs stroke | The emptiness tests mirror the draw guards: fill `!fans\|\|!count` (:104 vs :274), stroke `!segments\|\|!count` (:106 vs :298), and the same for sprites and glyphs. Stroke bounds are padded by `2*width` (prepare.ts:198, geometry.ts:239). |

Residual risk, low and not a defect: hairline strokes extend `0.5/(k·pr)` world units (:315). The `1/k` pad covers this only for `pr ≥ 0.5`. The existing cull (:209) shares the same assumption. Nobody verified that the drawing buffer can never be smaller than the CSS viewport.

Test gaps (framegraph.test.ts:48–113). These are recommendations only; no tests were added.
- No direct test of `composite()` or group emptiness. The GL path is covered only by browser checks.
- No empty→non-empty transition across `render()` calls or camera changes (the test `view` is constant).
- No evenOdd mask item, and no evenOdd child under a mask (`EQUAL 0x81`).
- No group `opacity: 0` case. No glyph/sprite case with a null `frame.atlas` or `frame.sprites`.
- No test that stroke bounds include the width pad. No test of a hairline stroke at the view edge.

## 2. Validity decision

| Item | Result |
|---|---|
| Blocks run | 1 (pilot, inspected first), then 2, 3, 4, 5 serially. No block was repeated or overwritten. Seeds were 7320–7324. Each block scheduled B,A,A,B. |
| `exit_code` | 0 for all five blocks and for the summary |
| Dist fingerprint before/after each block | `f99596d60eaf0b0ab818d14b2d9564559fb42ba7ad7037deec0af734e0b00911`. It was unchanged within every block and identical across all blocks; `paired-summary` reports the same single value. (The root-preserved `p2-composite-cost-code-state.json` lies outside the CWD, so it was not compared here.) |
| Fixture hash | `f5c0d703e4a21dc608981285644ba05618ed01f45d3d45fb34827087b679f5c0` in all 20 slots |
| Host | Apple M1 Max, Chromium, offscreen headful Metal, 120 Hz, 1280×720, DPR 2 (fixed tool config) |
| `comparable` / `problems` | `true` / `[]` for frame, callback, inputDispatch and idleFrame, in every block and in the aggregate |
| GPU actually active | In all 10 GPU slots, the `active:"gpu"` entries I saw were all gpu. In the samples I checked, every post-gesture snapshot showed `sourceCurrent:true`, `coverage:"covered"`, `pending:0` and `gpuPresentedFrames:120` (fraction 1). Each GPU slot has exactly one `coverage:"none"` entry: a snapshot taken before renderer-ready, before measurement starts (e.g. block 1 slot 3, line 119). |
| Absent samples masked as 0 (known latent defect, P2-PAIRED-COMPARISON.md:64) | Checked in the actual data. Block 1 slot 0 has `callback.count` 255 and `idleFrame.count` 119, with real `idleIntervalsMs` arrays. Each slot carries six callback and six idle arrays. The aggregate has n=10 per arm per cell for idleFrame. The only `"count": 0` entries are the legacy SVG-path profiler counters `invokeActiveZooming` and `drawCoordinates`. |
| Idle cadence (global gate: median p95 difference ≤ 2 ms) | Passed. Per-cell idle deltas range from −1.5 to 0 ms (table below). |
| `canvasVisible` | A DOM flag only. It is not evidence of physical presentation. |

Decision: **valid timing comparison for 10 pairs.** It is not a formal performance acceptance: physical input and photon latency are unmeasured, and the gates listed under "Still open" are untouched.

## 3. Results (aggregate, 20 slots, n = 10 per arm)

Values are the median across slots of the per-slot p95, in ms. A = SVG, B = GPU, Δ = B − A. "CI" is a **percentile bootstrap of the unpaired difference of medians**. It ignores the matched-pair design, so these are *not* paired CIs. There are 24 CIs with no multiplicity adjustment, and medians are discrete nearest-rank on a 0.1 ms timer grid.

### Frame interval p95 (rAF)

| World / gesture | SVG | GPU | Δ | 95% CI | Read |
|---|---|---|---|---|---|
| 100k pan-near | 16.8 | 8.5 | −8.3 | [−8.6, −8.0] | GPU better: SVG misses every other 120 Hz vsync |
| 100k pan-wide | 16.9 | 8.5 | −8.4 | [−8.7, −7.8] | GPU better |
| 100k wheel-zoom | 41.7 | 8.4 | −33.3 | [−41.6, −33.2] | GPU much better (SVG p95-of-slots 50) |
| shared pan-near | 8.5 | 8.7 | +0.2 | [−0.7, +0.8] | **Unresolved** (CI includes 0); SVG is already at the vsync floor |
| shared pan-wide | 10.2 | 8.5 | −1.7 | [−8.2, −1.0] | GPU better on median, but SVG is bimodal (16.6–16.7 in blocks 2–4, ~10 otherwise), so the magnitude is unstable |
| shared wheel-zoom | 10.0 | 8.4 | −1.6 | [−1.7, −0.6] | GPU slightly better |

### rAF callback p95 (main-thread work in the instrumented callback)

| World / gesture | SVG | GPU | Δ | 95% CI |
|---|---|---|---|---|
| 100k pan-near | 0.2 | 0.7 | +0.5 | [0.4, 0.5] |
| 100k pan-wide | 1.7 | 0.7 | −1.0 | [−1.1, −0.9] |
| 100k wheel-zoom | 4.3 | 1.0 | −3.3 | [−3.6, −3.2] |
| shared pan-near | 0.1 | 0.7 | +0.6 | [0.5, 0.6] |
| shared pan-wide | 0.5 | 0.6 | +0.1 | [0.1, 0.1] |
| shared wheel-zoom | 2.3 | 0.7 | −1.6 | [−2.1, −0.6] |

In light pans, the GPU callback costs about 0.5 ms more than SVG, because SVG pans by transform only. Every callback stays under 1 ms.

### Input dispatch p95 (synchronous synthetic-event handler time)

| World / gesture | SVG | GPU | Δ | 95% CI |
|---|---|---|---|---|
| 100k pan-near | 0.4 | 0.3 | −0.1 | [−0.1, −0.1] |
| 100k pan-wide | 0.5 | 0.3 | −0.2 | [−0.3, −0.2] |
| 100k wheel-zoom | 10.9 | 0.3 | −10.6 | [−10.8, −10.3] |
| shared pan-near | 0.3 | 0.4 | +0.1 | [0.1, 0.1] |
| shared pan-wide | 0.3 | 0.4 | +0.1 | [0.0, 0.1] |
| shared wheel-zoom | 2.2 | 0.4 | −1.8 | [−1.9, −1.7] |

Lower dispatch time can simply mean the work was moved out of the handler, for example into a deferred GPU draw. It is **not** input-to-photon latency.

### Idle cadence p95 (control window)

| World / gesture | SVG | GPU | Δ | 95% CI |
|---|---|---|---|---|
| 100k pan-near | 8.4 | 8.4 | 0.0 | [−0.9, 0.0] |
| 100k pan-wide | 8.5 | 8.4 | −0.1 | [−1.1, +0.1] |
| 100k wheel-zoom | 8.5 | 8.5 | 0.0 | [−0.1, +0.4] |
| shared pan-near | 9.9 | 8.5 | −1.4 | [−1.5, −0.7] |
| shared pan-wide | 10.1 | 8.6 | −1.5 | [−1.8, −1.0] |
| shared wheel-zoom | 10.0 | 8.5 | −1.5 | [−1.7, −0.7] |

Idle cadence matches within 1.5 ms. The earlier v1/v2 failure mode (GPU dropping frames during idle) did not recur in any of the 20 slots.

### Interpretation

- GPU frame p95 sits at the 120 Hz floor (8.4–8.7 ms medians, ≤ 10.2 ms p95-of-slots) in all six cells.
- The 100k world is a clear win for GPU in all three gestures. SVG runs at about half rate (~16.8 ms) on pans and 42–50 ms on wheel-zoom.
- In the shared world, SVG is often already at or near the floor. Shared pan-near is **not resolved**. Shared pan-wide and wheel-zoom favour GPU by about 1.6–1.7 ms on the median, but the shared pan-wide CI is wide. **This run does not support a claim that GPU wins everywhere.**
- Settle-time refinements on the GPU arm were reported as `pending:false/0` after each gesture. Empty refinements at settle are still a known ungated item for source audit; this run did not gate them.

### Limitations (inherent to the fixed protocol; not changed)

- Input is synthetic DOM dispatch on offscreen headful Chromium. Physical input and photon latency are not measured.
- n = 10 per arm per cell, with one measured iteration per slot per workload (plus a cold run).
- The bootstrap is unpaired even though the design is interleaved and matched-pair. The 24 CIs are unadjusted, and medians are discrete nearest-rank.
- Single host (M1 Max / Metal). Windows hardware is untested.
- Timing only. Pixel fidelity, hit testing and final camera come from `bench/navigation-quality.ts`; this run did not re-run them (rendering frozen and already tested).

## 4. Raw paths and configuration

- Blocks: `docs/performance/webgl-rewrite/host-checks/paired-v3-dpr2-block{1..5}/`, each containing `slot-{0..3}-{A-svg,B-gpu}.json`, `report.json`, `host.log` and `host-receipt.json`.
- Summary: `docs/performance/webgl-rewrite/host-checks/paired-v3-dpr2-summary.json`. The summary step emitted only a Node `MODULE_TYPELESS_PACKAGE_JSON` warning on stderr for the control script; exit was 0.
- Config (fixed tool v7): `paired` with dpr 2, blocks 1–5, 4 fresh arms per block, 2 pairs, repeats 2; shared and deterministic 100k worlds; pan-near, pan-wide and wheel-zoom; 120 frames; samples 1 (+cold); same fonts.

## 5. Still open (unchanged by this job)

- G-C5 / G-C8 pixel gates and SSIM: unmeasured.
- WebGL context count about 600, above the 500 limit.

> **Correction note (2026-10-16, P2-FIDELITY-MEASUREMENT job).** The two bullets above were wrong as written; the timing tables in this report are unaffected.
> - The "~600" figure is the context **restore time** (about 600 ms against a 500 ms target), not a count of WebGL contexts.
> - over16 was **already measured** before this report, at 5 of 8 smoke cells passing (3 failing). Only SSIM was unmeasured at the time. SSIM has now been measured; see `P2-FIDELITY-MEASUREMENT.md`.
> - The same correction applies to "context-count reduction (~600 → ≤ 500)" in §6, which should read "context restore time (~600 ms → ≤ 500 ms)".
- Heap 38.7 MB.
- Tracked GPU memory: **steady 160 MiB** budget versus **peak 256 MiB** budget. The last measured peak was about 201 MiB, under the peak budget.
- Windows hardware, SceneDoc, editor and picking: not done.
- No deploy, no default flip, no production change.

## 6. Next spending recommendation

1. **Stop spending on navigation timing.** In this configuration the question is answered: GPU reaches the vsync floor everywhere, wins clearly on 100k, and is neutral to slightly better on shared. More blind performance work or repeat blocks would not change any decision.
2. Spend next on the open acceptance gates, in this order: G-C5/G-C8 SSIM fidelity measurement, then context-count reduction (~600 → ≤ 500), then SceneDoc/editor/picking parity.
3. Cheap, optional, root-assigned: add the unit tests listed in §1 (empty→non-empty transition, mask-empty, evenOdd under mask, stroke width pad, hairline at edge). This is coverage only; no defect is implied.
4. If an input-latency claim is ever required, it needs a physical input-to-photon rig. This protocol cannot produce that claim.
