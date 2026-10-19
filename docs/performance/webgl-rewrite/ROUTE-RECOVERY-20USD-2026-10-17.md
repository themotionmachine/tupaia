# Route-editor recovery ($20 chunk, 2026-10-17)

Scope: the route-editor stall at high zoom (100k world, k≈8.57) in the opt-in hybrid GPU renderer
(`?renderer=gpu&gpu-select`).
- Nothing was deployed.
- The SVG default and the live build are unchanged.
- Production remains candidate 89902648-220c-40b8-8462-dce2bfed06d6.
- Every change below is local and undeployed.

## 1. Verdict: partial

- **Route focus (fixed).** The route editor no longer makes the GPU renderer fall back to SVG. The first committed
  GPU frame after closing the editor arrives in about 1.6 s. Before, the renderer fell back to SVG and the route
  focus run lost GPU rendering.
- **Full suite (not fixed).** The route cohort still stalls. The post-close prepare took 90.5 s, against 89.5–94.8 s
  in the earlier full-suite runs. The route focus harness does not reproduce the full-suite state.
- **The 2 s goal is met only for the first frame.** Time to fully settled (prepare plus refine) is 2.6–2.8 s in route
  focus, and about 90 s in the full suite.
- **Route focus is a diagnostic only.** It is never a full-suite pass.

## 2. Root causes found and fixed

1. **Prepares ran under an open editor.** A frame-holding renderer re-prepared while the editor dialog was open,
   against DOM that the editor kept changing.
   - Fix: while an editor suspends the renderer, prepares are deferred and the live SVG is shown (canvas hidden).
   - Changes that arrive meanwhile are recorded as "wanted", and one prepare runs on resume.
   - Files: `src/gpu/motion.ts`, `src/gpu/renderer.ts`, `src/gpu/motion.test.ts`.
   - The previous frame is never released before its replacement is committed.
2. **The compat clone had no `#debug`.** The scene walks the live `#viewbox`, and editors draw their overlays there
   (the route editor's `#controlPoints`). The export clone had no `#debug`, so those elements could not be resolved.
   - Effect: "GPU prepare failed: compat: missing #debug for <g> #controlPoints", then fallback to SVG.
   - Fix: `compatClone` calls `prepareMapClone("gpu", {debug: true})` (`src/gpu/compat.ts:21`).
   - Test: `src/gpu/compat.test.ts`.
3. **The legacy cell-mesh redraw was slow.** The route editor turns `#cells` on. Each redraw issued about 800k
   `moveTo`/`lineTo` calls on a Canvas2D context.
   - Measured cost: path 10632 ms, stroke 1 ms. The stroke was not the bottleneck, as child G had guessed.
   - Fix in `src/renderers/cell-mesh-canvas.ts`, part 1: an exact-geometry raster cache. The key covers every vertex
     index and coordinate bit, the size, the resolution and the computed stroke style. Unchanged inputs re-attach the
     same raster.
   - Fix, part 2: on a miss, the path is built as one SVG path string and passed to `new Path2D(d)`, with a single
     `stroke`. The subpaths and their order are the same, so overlapping edges blend exactly as before.
   - Measured after: key 14 ms, path 37 ms, stroke 1 ms, encode 60 ms.
   - Test: `src/renderers/cell-mesh-canvas.test.ts` covers the exact key, raster reuse, redraw on in-place geometry
     edits and on style changes, and the full-precision path string.

No invalidation is suppressed. No pixel path changed (smoke results are identical to the earlier baseline). No cache
outlives its exact inputs.

## 3. Before and after (route focus, 100k world, k≈8.57, `check:'integration', focus:'route'`)

| Run | Renderer after clicks | Click resumeMs (settled) | Click totalMs | First committed frame after close | cellsOn control |
| --- | --- | --- | --- | --- | --- |
| BEFORE `integration-1792278899989224000` | **fell back to SVG** (missing `#debug`) | 2517 / 0 | 15240 / 15057 | n/a | 8179 ms resume, total 19048 |
| Cache only `integration-1792279306124668000` | GPU | 2713 / 2812 / 2583 | 4086 / 7651 / 4132 | — | 7908 ms resume (first draw: path 10632 ms) |
| **AFTER, frozen source** `integration-1792279586716482000` | **GPU, no fallback** | 2575 / 2783 / 2663 | 3971 / 7557 (3 s dwell) / 4022 | 1592 / 1599 / 1604 ms | 7816 ms (mesh path 37 ms) |

- In the AFTER run, telemetry resynced and agreed 3/3. The editor target, element selection and editor are correct.
  The cells layer state is restored, no `#controlPoints` or `#controlCells` are left, and picking is available after
  resume.
- What remains in the cellsOn control: a 2281 ms refine plus three ~2 s long tasks while the compat lane rasterizes the
  large cells `<image>`. This only matters when a user leaves cells on outside an editor.

**Full suite** (`check:'integration', cohort:'short', focus:'all'`), route cohort, post-close prepare:

| Run | Last prepare | Phases (cumulative ms) |
| --- | --- | --- |
| `integration-1792203893051794000` (earlier) | 94722 ms | — |
| `integration-1792204791979432000` (earlier) | 94807 ms | — |
| `integration-1792206351287622000` (earlier) | 89462 ms | — |
| **`integration-1792279954598297000` (frozen source)** | **90504 ms** | scene 27564, clone 46943, screen 60999, windows 61001, world 90504, buffers 90505 |

Other results from the same full-suite run:
- Its first route click (route0) resynced. The second (route5) timed out on settle.
- Editors 5/5 agree. Save and export round trip deterministic. World replacement PASS. Fixture PASS. Page errors 0.
- Verdicts: routeCohort FAIL, resyncLabel UNDERCOVERED, markerCohort and undo UNTESTED.

## 4. Verification on the frozen source

All checks were run one at a time by the primary on the same frozen source. Paths are in `host-checks/`.

| Check | Result | Artifact |
| --- | --- | --- |
| unit | 69 files, 755 tests pass | — |
| build | OK | — |
| integration, route focus | PASS (diagnostic only) | `integration-1792279586716482000.json` (+ `.diagnostics.json`) |
| bench | 38/38 | `p1-delegated-1792279710366005000.log` |
| context | pass; lossToDraw 571.9 ms (**the 500 ms goal is still open**); steady GPU 159.37 MB vs budget 167.77 MB | `p1-delegated-1792279713363432000.json` |
| lifecycle | failure null; 20+ cycles; 0 context losses; GPU flat at 159.38 MB | `p1-delegated-1792279725195346000.json` |
| smoke DPR1 | over16 0.0061686, maxDelta 111; identical to `p1-delegated-1792207017851193000` | `p1-delegated-1792279800005796000` |
| smoke DPR2 | over16 0.0081003; identical to the earlier result | `p1-delegated-1792279808477718000` |
| picking (pilot, not dense) | failure null; 536 samples; wrong 0, extra 0 in every row; same per-kind shape as `picking-1792207309942146000` | `picking-1792279821460984000.json` |
| integration, full suite | **FAIL: routeCohort** (90.5 s prepare) | `integration-1792279954598297000.json` (+ `.diagnostics.json`, `.log`) |

Notes on these results:
- **Lifecycle heap growth** was 38.4 MB: a warm-up from cycle 0 to 1 (85.7 → 122.1 MB), then a plateau of about
  124 MB. Earlier runs measured 34.6–42.4 MB.
- **Memory** is read as steady GPU against the 160 MiB steady budget, not against the 256 MiB transient ceiling.
- **Dense-label picking** (`denseLabels:true`) was not rerun in this chunk.
- **Picking "missing" counts** are elements whose GPU pick returned nothing where SVG had a target. Their per-kind
  shape matches the earlier run. Burg still reports 2 agree and 2 missing out of 4.
- **Burg editor routing** is not promoted. Only `READY_KINDS = ["marker"]` is routed.

## 5. Capability status

- **Supported in the GPU path:**
  - opening the route editor by click, with resync of a stale camera;
  - editing, then save and export (round trip verified);
  - closing the editor and resuming GPU rendering without fallback.
- **Legacy, not provided:** route undo and redo. `#undo` and `#redo` are heightmap tools. There is no document-level
  undo for route edits, and none is faked; the integration undo verdict is UNTESTED with that reason.
- **Not yet acceptable:**
  - the full-suite route cohort, where prepare takes about 90 s after accumulated full-suite state;
  - settled resume under 2 s;
  - context restore under 500 ms;
  - cellsOn compat raster cost outside editors.

## 6. Open blocker: full-suite prepare is ~10× slower

The failing prepare is uniformly slow:
- every phase is roughly 10× its route-focus cost, where a whole prepare takes about 1.2–1.3 s;
- the next prepare outside an editor was still slow (scene 3.9 s, total 25.7 s).

So the cause is in state that the full suite builds up before the route cohort and that route focus deliberately
skips: editor edits, save and export, 60 synthetic labels, the tile harvest and the label resync cohort. It is not
the editor or cell-mesh path fixed above.

The cause has not been identified. Hypotheses from a read-only review (child H) are below. None was verified in a
browser.

Per-phase deltas in the failing prepare: scene 27.6 s, clone 19.4 s, screen 14.1 s, world 29.5 s, and windows and
buffers about 0. So the cost is spread across phases, not concentrated in one.

1. **Page state carried over from earlier cohorts.** Before the route cohort, the full run edits the shared world,
   reloads `100k` and calls `install()` again (`bench/renderer-integration.ts:1253`). That call adds a window click
   listener at `:272`, and nobody has checked whether it is guarded. *Test:* run route focus on a fresh page with the
   preamble enabled. *Partial evidence:* route0 in the same run resynced and recorded no `lateSettle`; only route5
   failed.
2. **Main-thread contention that only exists in the full suite.** Prepare yields every 12 ms (`src/gpu/slice.ts`),
   and the phase marks are wall-clock. Any other queued macrotask therefore stretches every phase by a similar
   factor, which matches the uniform slowdown. Candidates:
   - dense-zoom polling (`dense-zoom.ts:437-447`);
   - the trade-animation chain (`draw-trade-animation.ts:163`); whether it stops is unverified;
   - the autosave interval, which is probably inert.

   *Test:* record a `longtask` observer and event-loop drift across the click.
3. **Revision churn and DOM growth.** Each revision forces a new compat clone and a new scene (`compat.ts:19-22`,
   `prepare.ts:72-85`). The cost of `isolate()` and of serialization grows with the size of `#map`, and the full-suite
   page carries extra labels, markers and routes. The artifact records 38 prepares in route5's settle window and the
   revision moving 170 → 173 during it.
   *Test:* log the revision count and the number of `#map` descendants before and after the click.

H verified three points in code: clones are removed after use, the compat clone is rebuilt per revision, and only one
renderer exists. Which hypothesis dominates is unknown.

Next step (not run here, to avoid repeating a known 15-minute failure without new information): add `longTasks` and the
`cells-mesh:*` measures to the route cohort's `lateSettle` capture (`bench/renderer-integration.ts:1380`). Then run
route focus once with the full-suite preamble enabled step by step.

## 7. Team and budget

- Lead: Opus 5.5. Children: native Haiku 5.5 only, never more than 6 at once, no recursion, no checks. Record:
  `route-recovery-delegation.md`.
- No other paid APIs, agents or CLIs.
- The CLI spend for this chunk is recorded in `route-recovery-20usd-status.json`.
