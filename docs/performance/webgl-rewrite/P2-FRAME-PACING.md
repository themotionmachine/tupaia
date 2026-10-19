# P2 frame pacing: 100k full-world GPU frame interval

Status: one runtime fix landed in the isolated tree (uncommitted, on top of `1c5ab2b`). It fixes 100k pan-wide in the
timing harness. **100k wheel-zoom is still at 16.7 ms frame p95.** This report makes no 120 Hz claim, and the rewrite
is not done.

Environment: M1 Max, ANGLE Metal, Chromium 148, headless, DPR2. All artifacts are under `host-checks/`. The
`p1-delegated-` prefix is written as `…`.

## 1. Code state

| File | Change |
|---|---|
| `src/gpu/framegraph.ts` | **Fix.** The group-composite mask loop now uses the same conservative view cull (`outsideView(bounds, visible, 1/k)`) as fill batches. It also adds `passes` counters (`composites`, `stencilClears`, `maskFills`, `maskCulled`), which are zeroed in `render()`. |
| `src/gpu/gpu-timer.ts` | New, opt-in only. Async `EXT_disjoint_timer_query_webgl2` frame timer. |
| `src/gpu/renderer.ts` | Exposes `passes` and the optional `timing` telemetry. The timer is constructed only when `globalThis.__tupaiaGpuTiming === true`. |
| `src/gpu/mesh.test.ts` | New test: every stencil vertex (meshed and fan fallback) lies inside the `pathBounds` used for culling. This is the invariant that makes the mask cull exact. |

Nothing else changed. Production P1, harnesses, the control, budgets, thresholds and AA are unchanged.

## 2. Counter correction (root review)

`P2-DRAW-COST.md` reported "~15169 issued / ~7376 skipped per frame".

- **Those figures are per-frame.** `render()` zeroes `state.counts` at the start of every frame, so the numbers were not cumulative. `reset()` (context restore) does not clear them, but `render()` does.
- **The explanation of where they came from was wrong.** Draw batches at 100k wide were only ~160 submitted, which cannot account for ~15k state calls. The new `passes` counters show the real source.
  - The group mask loop drew **1432 mask fills per frame**, and 1144–1304 of them were entirely off-view.
  - Each fill costs about 9 state setters plus a draw.
  - That loop was not culled and not counted anywhere.

The timer also records `stateIssued` as a delta around `render()`, so it does not depend on the reset semantics.

## 3. Cause: measured vs inferred

**Measured** (instrumented runs `timing-1792121242870030000` before, `timing-1792121376037757000` after):

- Before the fix:
  - 100k pan-wide: `maskFills` 1432/frame, `stateIssued` p50 15139, render CPU p95 8.8 ms.
  - Shared world: 32 mask fills per frame, 24 of them off-view.
- After the fix:
  - 100k pan-wide: `maskFills` ~128–136 (`maskCulled` ~1296), `stateIssued` p50 1921, render CPU p95 0.5 ms.
  - 100k pan-near: `stateIssued` 15146 → 2031.
  - 100k wheel-zoom: `stateIssued` 15696 → 3452.
- **Cause:** pan-wide's frame p95 went from 16.7 to 9–10 ms with no other code change. That makes the unculled mask loop the measured cause of the pan-wide frame-pacing miss.
- **Mechanism (inferred):** ~13k state calls plus ~1.3k draws per frame caused client-side GL backpressure. This showed up as callback CPU time and a missed vsync.

**Inferred, not proven: the wheel-zoom remainder.**

- After the fix, the wheel-zoom callback p95 is 0.9 ms, but the frame p95 is still 16.7.
- Its timer-query values are about 42/60 ms p95, against ~17 ms for every other cell.
- So the remaining cost is most likely GPU-side: 30 full-viewport group composites, FBO clears, and the pixel cost of mask fills and fills at zoomed-in coverage.
- This is not proven. Timer values are a relative indicator only (see §5).

## 4. Before/after, untraced and uninstrumented timing (DPR2, 2 iterations, same harness)

Before: `timing-1792118637772165000` (the P2-DRAW-COST after-state). After: `timing-1792121697734753000`. Both runs
have `tracing: false` and `timing: null`, meaning no timer queries.

| Cell | frame p95 before → after (ms) | callback p95 before → after (ms) | idle frame p95 before → after (ms) |
|---|---|---|---|
| 100k pan-wide | 16.7 / 16.7 → **10.0 / 10.3** | 7.3 / 7.9 → **0.7 / 0.7** | 8.4 / 8.5 → 9.5 / 8.4 |
| 100k wheel-zoom | 16.7 / 16.7 → **16.7 / 16.7** | 5.2 / 5.3 → **0.9 / 0.9** | 16.4 / 16.6 → **8.4 / 8.4** |
| 100k pan-near | 8.4 / 8.4 → 8.4 / 9.7 | 1.1 / 1.1 → 0.7 / 0.7 | 8.4 / 8.4 → 8.4 / 8.5 |
| shared pan-near | 8.5 / 8.4 → 9.7 / 9.5 | 0.6 / 0.6 → 0.6 / 0.6 | 8.5 / 8.6 → 8.7 / 9.3 |
| shared pan-wide | 8.4 / 8.4 → 9.8 / 9.7 | 0.6 / 0.6 → 0.6 / 0.6 | 8.4 / 8.4 → 9.9 / 9.6 |
| shared wheel-zoom | 9.0 / 8.4 → 9.8 / 9.6 | 0.7 / 0.7 → 0.7 / 0.7 | 8.6 / 8.4 → 9.3 / 9.7 |

- **Fixed:** the 100k callback p95 is now well below budget in every cell, and the 100k wheel-zoom idle p95 went from 16.5 to 8.4.
- **Not fixed:** the 100k wheel-zoom frame p95 is unchanged at 16.7 ms. **8.3 ms is not reached there, so there is no 120 Hz claim.**
- **Shared cells: higher frame p95, not explained.** Frame p95 rose ~1 ms in the after run, but the callback is flat and the shared world now does *less* work (8 mask fills instead of 32). Idle frames, which render nothing new, rose by a similar amount. That points to run-level cadence noise, but it has not been shown.
  - In the instrumented after run (`…1376037757000`) the shared cells were 8.4–8.5.
  - In navigation DPR2 (below) they were 8.4 / 9.8 / 9.7.
  - Each is a single run. This needs the paired comparison before anything is concluded.

Instrumented runs, for reference only (timer queries active, so not the acceptance numbers):

- 100k pan-wide frame p95: 16.7/16.7 → 10.2/9.2.
- 100k pan-wide GPU timer p95: 47.1 → 42.6.

## 5. Timer instrumentation and extension availability

- **Extension available:** `EXT_disjoint_timer_query_webgl2` is available on this host (status `active`, disjoint 0, in every instrumented cell).
- **Design:**
  - At most 4 queries in flight. If more are needed, the frame is counted in `dropped` and not timed.
  - Rings hold 128 samples. Results are polled without blocking: no wait, `finish` or `readPixels`.
  - When a disjoint event occurs, every in-flight result is discarded.
  - On loss, the queries are forgotten. On restore, the timer reattaches. On dispose, the queries are deleted.
  - Without the extension the status is `"unsupported"` and `gpuMs` is `null`, never 0.
  - CPU (`render()` wall time) and GPU are reported separately as sum/n/p50/p95/max.
- **Limitation:** the values exceed the frame interval (17–60 ms p95), so they are **not** GPU busy time per frame.
  - On ANGLE Metal a TIME_ELAPSED span very likely includes queueing and pipelined work from other frames.
  - Use them only as a relative indicator between cells or builds on the same host.
  - They do not measure the compositor or presentation.
- Off by default. No acceptance run constructs a timer.

## 6. Acceptance gates (serial; `report.failure` checked on each)

| Check | Artifact | Result |
|---|---|---|
| Unit | `…121366575806000` | 573 pass (572 before, plus the new bounds test) |
| Build | `…121371345441000` | pass |
| Smoke DPR2 z1/z2/z4/z8 | `…121518187303000`, `…121505753978000`, `…121525446572000`, `…121532900096000` | failure null, GPU active; over16 1.8311 / 0.9938 / 0.7908 / 0.2084 %, identical to the P2-DRAW-COST baseline |
| Smoke DPR1 z1/z2/z4/z8 | `…121542533986000`, `…121548427648000`, `…121554442032000`, `…121560586295000` | failure null; over16 1.3214 / 0.7592 / 1.1817 / 0.2746 %, identical to baseline |
| Hatch DPR2 / DPR1 | `…121568412516000` / `…121573990928000` | failure null; over16 0 at all zooms and pan, maxDelta ≤ 1, noReprepare true |
| Navigation DPR2 (CDP) | `…121581176670000` | failure null, finalCameraExact 6/6, gpuPresentedFraction 1, 0 prepares or long tasks in motion. Frame p95: 100k 8.9 / 8.5 / 8.5, shared 8.4 / 9.8 / 9.7 |
| Context loss/restore | `…121667217767000` | failure null; restore 600.8 ms (still > 500 ms target); maskFills 8 / maskCulled 24 both before and after restore |
| Lifecycle | not rerun | Resource ownership did not change: the mask cull allocates nothing, and the timer is opt-in and absent in acceptance runs. |

The 3 of 8 smoke over16 failures are pre-existing and unchanged, and the over16 values match baseline exactly. That is
the expected result: the culled mask items cover no on-screen pixel, and the order of the remaining fills is preserved.

The memory peak of 204.85 MB in the 100k timing run is above the 160 MiB budget. It is identical before and after the
fix, so it is pre-existing and still open.

## 7. Unchanged gates and open items

- G-C remains **5/8** smoke over16 passes. SSIM is **unmeasured**.
- Context restore is **605 ms** in the baseline (600.8 ms here), above the 500 ms target.
- Heap growth of **38.7 MB** is still open (lifecycle).
- **Windows is not done.** Only macOS/ANGLE Metal was measured.
- **SceneDoc, editor and picking are incomplete.**
- This is **not a universal GPU win**, and **the rewrite is not done.**
- The global 2 ms gate, budgets, thresholds and AA are unchanged. No paired blocks were run in this tranche, and no formal comparison is claimed.
- 100k wheel-zoom misses 8.3 ms (16.7 ms frame p95), so **no 120 Hz claim**.

## 8. Next recommendation

Make the 100k wheel-zoom GPU cost measurable, then cut it. This is the only cell left at 16.7 ms, and its callback is
already 0.9 ms, so more JS work will not move it.

Concretely:

1. Use the opt-in timer to split the frame into a few coarse spans. Keep MAX_IN_FLIGHT bounded; this means more queries per frame, not more frames.
   - group composites with their FBO clears
   - mask fills
   - main fills and strokes
2. If the composites dominate, scissor each group's FBO clear and composite to the group's on-screen bounds. Most of the 30 groups cover far less than the full viewport.
   - This is exact: pixels outside a group's bounds are transparent in its FBO anyway.

This is worth the budget because wheel-zoom is the main remaining 100k frame-pacing miss, and the evidence points to a
bounded GPU cost. Order and fidelity rules stay the same.

Before any 120 Hz or "faster than SVG" claim, the shared-cell frame p95 drift in §4 also needs the paired comparison.
