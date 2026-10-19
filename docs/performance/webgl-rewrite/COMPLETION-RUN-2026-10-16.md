# Completion run 2026-10-16: reviewable GPU renderer candidate

Status: **reviewable experimental candidate, not a replacement.** The GPU path is a hybrid: a WebGL2 canvas drawn
over the canonical SVG. That SVG stays in the DOM and remains the source of truth for editing, save and export.
SVG stays the default renderer. GPU rendering is explicit opt-in (`?renderer=gpu`) and GPU editor selection is a
second opt-in (`&gpu-select`).

**This run did not deploy, did not publish and did not flip the default.**
- The original repository (`/Users/mgm1/Desktop/code/vespucci`) and production P2
  (`71dd4740-4b1b-4652-932c-d2855ce07fe8`) were not touched.
- There were no backend, share-API or save-format changes.
- No dependencies were added.
- `tests/e2e` was not run.

Machine-readable summary: `completion-run-status.json`. Reviewer entry point: `REVIEWER-README.md`.

## 1. What "complete" means for this run

The run was complete when each of the following was true:

1. The tree builds, and the unit and bench suites pass.
2. Every child's code is integrated or excluded.
3. GPU selection is wired into the existing editors behind a default-off flag:
   - a click is routed by the GPU **only** for kinds that passed the frozen picking gate;
   - everything else falls back to the SVG's own hit test (fail-closed);
   - each editor test asserts the identity of the real canonical element.
4. Save and export output is unchanged with the GPU layer on.
5. Navigation, lifecycle, context recovery and picking were re-measured on the final source.
6. Every gate that is still failing is listed explicitly (section 7).

By this definition the run is complete. By the definition "GPU can replace SVG" it is **not**: see section 7.

## 2. Scope and source changes in this run

All changes are inside the isolated implementation. The final check sequence ran after the source freeze.

| Area | Files | Change |
|---|---|---|
| Editor click routing | `src/gpu/editor-dispatch.ts`, `src/gpu/editor-dispatch.test.ts` (new) | `clickedBranch` (a replica of `clicked()`'s fixed-depth tests), `dispatchTarget`, `routeClick` (decides between legacy, shadow compare, routed, resynced and dropped), `recoverClick` (stale-view clicks on the bare `#map`), and `READY_KINDS = ["marker"]`. |
| Editors hook | `public/modules/ui/editors.js` | `clicked()` first asks `window.gpuClickRoute?.(d3.event)`. A `false` result drops the click; an event result goes to `d3.customEvent(route, dispatchClick)`; otherwise the original dispatch runs. Without the flag the hook is `undefined`, so this is a no-op. |
| Renderer wiring | `src/gpu/renderer.ts` | The `gpu-select` block installs `gpuClickRoute`, `gpuClickTelemetry`, `gpuSelect` and `gpuRenderer`. A document capture-phase `recover` listener uses a live `#map` lookup, because world loads replace `#map`; it is removed by `detachGpuGlobals`. `pickStatus` now reports "suspended: editor dialog open" before the stale-revision check. The editor-dialog scan is cached behind a MutationObserver drained with `takeRecords()` per query (`dialogScans` telemetry). |
| Pick performance | `src/gpu/pick.ts`, `src/gpu/markers.ts`, `src/gpu/compat-pick.ts`, `src/gpu/dash-measure.ts` (+ tests) | Child A: a Skia-style dash contour measure for route hit tests. Child C: zoom-4 marker extras and wrong-row fixes. Lead: a cheaper per-query index path. |
| Harnesses | `bench/renderer-integration.ts`, `bench/picking-parity.ts` | The integration harness runs the editors, a save/export roundtrip, a stale-camera resync cohort and a marker cohort, and classifies intercepted and recovered clicks. Picking parity: occlusion eligibility now uses the text cell of labels (not their ink); this is disclosed in section 6. |

Children: A (dash measure) and C (marker/pick rows) are **integrated**. B was a read-only exploration with no code.
Nothing was excluded.

## 3. Inventory

| Capability | State |
|---|---|
| Rendering of all layers (ocean, landmass, texture, terrain, biomes, terrs/provs/regions/cults, borders, routes, zones, markers, icons, labels, coastline) | **Supported (GPU)**, with SVG kept underneath. Strict fidelity is 0/8 cells (see section 7). |
| Camera pan and zoom during motion | **Supported (GPU)**. The SVG transform write is deferred until the camera settles. |
| Settle prepare / re-tessellation | **Supported**. It is slow on large worlds (about 2 s on 100k). |
| WebGL context loss and restore | **Supported**. The redraw takes 608–616 ms against a 500 ms goal. |
| Editor selection: marker | **GPU-routed** while the camera is stale; it passed the picking gate. |
| Editor selection: burg, label, route, relief, rivers, other branches | **Legacy fallback.** After a camera sync the SVG hit test is re-run; GPU selection runs only in shadow. |
| Burg / relief CPU fallbacks (`pickBurg` / `pickRelief`) | **Legacy (CPU)**. They are counted separately as raw (`gpuPick`) vs semantic (`gpuSelect`) gates. |
| Undo/redo through GPU-routed clicks | **Not exercised.** |
| Save / export with GPU on | **Unchanged.** It always serializes the canonical SVG and never the canvas. |
| SVG-only renderer removal | **Unimplemented / not planned in this run.** |

**Round 2 update** (fresh results; details in `COMPLETION-ROUND2-2026-10-16.md`). The rows above are kept as the round-1 record.

| Capability | Round 2 state |
|---|---|
| Rendering of all layers | Still GPU over SVG. Analytic stroke-edge coverage was added. Fresh over16 ≤1% in 5/8 cells; strict reference still 0/8. |
| Settle prepare | Still slow: 100k settle 2.25 s. In the route editor at high zoom with `#cells` forced on, 25–95 s (open defect, route cohort FAIL). |
| Context loss and restore | 548.7 ms against the 500 ms goal; the restore reuses the cached scene. |
| Editor selection: marker | GPU-routed, 8/8 cells pass. |
| Editor selection: burg | Semantic gate passes 8/8 cells, but the editor stays on **legacy fallback** (not in `READY_KINDS`). Editor identity/resync coverage is incomplete. |
| Editor selection: label | Legacy fallback. Passes 2/8 cells (DPR1 z2); the other 6 have too few samples. |
| Editor selection: route, relief, rivers, other | Legacy fallback. Route hit shapes now honour dashes, caps and round joins; GPU selection runs in shadow only. |
| Undo/redo through GPU-routed clicks | **Untested** (the harness probe reports UNTESTED). |
| Save / export with GPU on | Unchanged. Masked save is deterministic and export is equal. |
| SVG-only renderer removal | Unimplemented. |

## 4. Tests, artifacts and results (final source)

All artifacts are under `docs/performance/webgl-rewrite/host-checks/`.

| Check | Artifact | Result |
|---|---|---|
| unit | `p1-delegated-1792188952464726000.log` | exit 0. 65 files, 697 tests pass. |
| bench | `p1-delegated-1792188957854588000.log` | exit 0. 38/38 pass. |
| build + unit (after the final comment-only edit to `editor-dispatch.ts`) | `p1-delegated-1792189996514221000.log`, `p1-delegated-1792190000535916000.log` | both exit 0; 697/697 tests pass. |
| lifecycle (DPR2) | `p1-delegated-1792188960969978000.json` | `failure: null`, no page errors. Over 20 regenerations with forced GC, heap went 85.6 → 124.0 MB (+38.4 MB). It plateaued at about 123.7–124.0 MB from cycle 5. Context restore was drawn in 608.2 ms (restored 61.7, prepare 524). |
| context (DPR2) | `p1-delegated-1792189044890056000.json` | `failure: null`. Loss to draw 615.7 ms. Restored tracked memory was 113.7 MB vs a 159.4 MB peak, under the 167.8 MB budget. |
| timing (gpu, DPR2) | **not located** | The check ran, but its oversized output could not be read and no artifact matching it was found. **The exit status of this run is unknown.** The navigation check below stands in. |
| navigation (gpu, DPR2) | `p1-delegated-1792189141227808000.json` | `failure: null`. Details below. |
| integration (DPR2 z2) | `integration-1792188131997300000.*` | `failure: null`. Details below. |
| picking DPR2 z2 compact | `picking-1792189196480911000.json` | Table in section 4.2. |
| picking DPR2 z2 materialized | `picking-1792189265076766000.json` | Table in section 4.2. |
| picking DPR1 z2 compact | `picking-1792189357148983000.json` | Table in section 4.2. |
| picking DPR2 z4 compact | `picking-1792189459003388000.json` | Table in section 4.2. |
| picking DPR1 z4 compact | `picking-1792189612983075000.json` | Table in section 4.2. |
| picking DPR1 z2 materialized | `picking-1792189648032474000.json` | Table in section 4.2. |
| picking DPR1 z4 materialized | `picking-1792189768995491000.json` | Table in section 4.2. |
| picking DPR2 z4 materialized | `picking-1792189869363643000.json` | Table in section 4.2. |

### 4.1 Navigation (pilot: injected CDP input, single arm, not 10 interleaved pairs)

| World | Gesture | Frame p95 | eventToNextRaf p95 |
|---|---|---|---|
| shared | pan-near | 8.6 ms | 7.7 ms |
| shared | pan-wide | 8.5 ms | 7.9 ms |
| shared | wheel-zoom | 8.5 ms | 23.7 ms |
| 100k | pan-near | 8.4 ms (max 24.9) | 7.8 ms |
| 100k | pan-wide | 8.4 ms | 8.0 ms |
| 100k | wheel-zoom | 8.4 ms | 24.2 ms |

These held across all gestures:
- 0 long tasks during motion
- gpuPresentedFraction 1
- 0 prepares during motion
- the final camera matched exactly

Two problems:
- **Risk:** tracked GPU memory peaked at 204.9 MB during the shared-world wheel-zoom settle prepare, which is **over the 167.8 MB budget**.
- The 100k settle prepare takes about 2.0 s, with long tasks of up to 484 ms after motion stops.

### 4.2 Picking matrix (frozen oracle, frozen thresholds; SVG side uses `elementFromPoint` only)

The gate requires burg, label and marker to each have ≥ 50 meaningful samples and a rate ≥ 99.5%, where
rate = agree / (expected + extra + wrongInto). Cells must match exactly. "Raw" is the GPU index (`gpuPick`).
"Semantic" is `gpuSelect`, which includes the CPU `pickBurg` fallback.

**100k world**

| Cell | burg raw | burg semantic | label | marker | cells |
|---|---|---|---|---|---|
| DPR2 z2 compact | 587/680 = 86.3% fail | 671/680 = 98.68% fail | 46/46 insufficient | 430/430 pass | 708/708 pass |
| DPR2 z2 materialized | 587/638 = 92.0% fail | 634/638 = 99.37% fail | 46/46 insufficient | 430/430 pass | 708/708 pass |
| DPR1 z2 compact | 610/700 = 87.1% fail | 690/700 = 98.57% fail | 57/57 **pass** | 418/418 pass | 723/723 pass |
| DPR2 z4 compact | 417/508 = 82.1% fail | 502/508 = 98.82% fail | 37/37 insufficient | 95/95 pass | 724/724 pass |
| DPR1 z4 compact | 441/523 = 84.3% fail | 514/523 = 98.28% fail | 41/41 insufficient | 99/99 pass | 714/714 pass |
| DPR1 z2 materialized | 610/662 = 92.1% fail | 656/662 = 99.09% fail | 57/57 **pass** | 418/418 pass | 723/723 pass |
| DPR1 z4 materialized | 441/480 = 91.9% fail | 479/480 = 99.79% **pass** | 41/41 insufficient | 99/99 pass | 714/714 pass |
| DPR2 z4 materialized | 417/465 = 89.7% fail | 465/465 = 100% **pass** | 37/37 insufficient | 95/95 pass | 724/724 pass |

**Summary across the 8 cells on the 100k world:**
- marker passes 8/8, with zero mismatches;
- semantic burg passes 2/8, both of them z4 materialized;
- raw burg passes 0/8;
- label passes 2/8 (DPR1 z2) and is insufficient in the other 6, with zero mismatches;
- cells pass 8/8.

**Shared world.** Every kind is under 50 samples in every cell, so every kind is insufficient there. There were
zero GPU-index *wrong* or *extra* results for label and marker, but raw burg misses a third to a half of its 4–14
samples. The semantic burg rate was 100% in each shared cell. Cells pass.

Burg failures are mostly `missing` results (no hit in the GPU index where the SVG oracle has a burg icon), plus
9 `wrong` and 1 `wrongInto` on 100k at DPR1 z2 compact. The CPU fallback recovers most misses, but in compact
relief mode it does not reach 99.5%.

**Pick latency** (p95): select 1.4–2.1 ms (compact) and 2.4–4.4 ms (materialized), with a select max of up to
13.7 ms.

**Coverage not done:** the labeled deterministic fixture with ≥ 50 objects per kind was not built. All coverage
above comes from natural worlds. Labels reach 50 samples in only 2 cells, and routes are not gated by the picking
harness.

### 4.3 Editor integration and save/export (DPR2 z2, `?renderer=gpu&gpu-select`)

**Editors.** Each of the five editors opened with 0 problems, and each test asserted the identity of the real
canonical element:
- burg: `burgLabel694`, renamed to Ixburg694
- label: label12
- route: route47
- marker: marker2, resized to 25
- relief: hill-3, resized

While each editor was open, a pick reported `suspended: editor dialog open`.

**Stale fallback.** A label clicked while the camera was stale was resynced to the correct element.

**Roundtrip.**
- 5 edits persisted.
- The masked save SHA `939caf5d…` was equal (7,782,113 bytes). The raw saves differ **only** in the `savedAt`
  timestamp, which is the last `|` field of the header.
- The export SHA `dea21729…` was identical (11,614,578 bytes). There was no `<canvas>` in the export and no downloads.

**Resync cohort (labels).**
- 10 clicks; 8 were stale and eligible, and all 8 were resynced correctly.
- 1 click was intercepted by the HTML `DIV#notesHeader` overlay.
- 1 target was not in view.
- Routes: 0 clicks. **This is under-coverage.**

**Marker cohort (100k world, 373 markers).**
- 50 clicks, all stale and eligible.
- 44 were GPU-routed and all were correct; 6 were recovered through `recoverClick` and all were correct;
  0 were unrecovered.
- Routing latency was 0.1–0.5 ms, with one 30.8 ms outlier.

**Telemetry.** routed 44, resynced 9, legacy 11, shadow agree 20, disagree 0, recovered 6.

**Network.** Only gtag and watabou requests were blocked, and there were no page errors.

## 5. Before and after performance

| Metric | Before this run | After |
|---|---|---|
| Pick index cost per query | 1.91 ms | 0.61–0.66 ms (100k), about 1.10 ms (shared) |
| gpuSelect p95 | 3 ms | 1.4–2.1 ms (compact); 2.4–4.4 ms (materialized) |
| Query guard (dialog scan) | a scan per camera frame and per query | about 0.001 ms; scans are cached behind a MutationObserver |
| Navigation frame p95 | no paired measurement in this run | 8.4–8.6 ms (pilot) |

Earlier phase reports hold the earlier SVG vs GPU navigation baselines: `P2-PAIRED-COMPARISON.md` and
`P2-COMPARISON-CONFIRMATION.md`. This run did **not** repeat the 10-pair paired comparison.

## 6. Disclosures

- **Picking-parity occlusion eligibility** (`bench/picking-parity.ts`): labels are hit-tested by text cell, not
  ink. Tolerances, thresholds and the oracle are unchanged. The 500 uniform seeds remain separate from the
  targeted cohorts, and raw attempts are immutable.
- **The `pickStatus` reorder** means an open editor dialog is reported before staleness. Routing therefore
  fails closed while a dialog is open.
- **The document-level recovery listener** stops the native event only for a stale-view hit on the bare `#map`
  whose re-run SVG hit lies inside `#viewbox`, and then dispatches the click once to that hit, with no recursion.
  It leaves these alone:
  - legend and rulers (outside `#viewbox`, not camera-transformed);
  - HTML overlays such as the notes box.
- **Independence of the resync oracle.** A resynced click uses the same `elementFromPoint` the oracle uses, so
  "resynced correct" shows that the camera sync works. It is not independent GPU evidence.
- **The save comparison masks only the header `savedAt` timestamp.**

## 7. What still prevents full replacement (explicit unfinished list)

**Selection**
1. **Burg fails the picking gate in 6 of 8 cells.** Semantic burg ranges from 98.28% to 100% and passes only in
   the two z4-materialized cells. Raw burg ranges from 82% to 92% and fails in all 8 cells. Most failures are
   GPU-index misses, so burg clicks stay on the legacy path.
2. **Label is under-covered.** It reaches ≥ 50 samples in 2 of 8 cells (both DPR1 z2), with zero mismatches.
3. **Routes are not gated** by the picking harness, and the route resync cohort got 0 clicks.
4. **The shared world is under-covered.** Every kind is under 50 samples per cell.
5. **No labeled deterministic fixture** with ≥ 50 objects per kind was built.
6. **Relief fallback agreement was not measured separately**; only the relief editor test covers it.

**Editor dispatch**

7. Undo/redo through routed clicks was not exercised.
8. HTML overlays (the notes box) intercept stale-view clicks, and these are not recovered.
9. The real-world rate of stale-view clicks is unknown.
10. There is one 30.8 ms routing-latency outlier.

**Rendering and platform**

11. Context restore takes 608–616 ms against the 500 ms goal.
12. Tracked GPU memory peaked at 204.9 MB during a settle prepare, over the 167.8 MB budget.
13. The 100k settle prepare takes about 2 s, with long tasks of up to 484 ms after motion.
14. Heap grew by about 38 MB over 20 regenerations; it plateaus, but the cause is not explained.
15. Strict visual fidelity is 0/8 cells (`P2-FIDELITY-MEASUREMENT.md`).
16. Only macOS was tested; Windows and integrated GPUs are untested.

**Evidence**

17. The timing-check artifact from the final source could not be located.
18. Navigation is a single-arm pilot with injected input, not 10 interleaved pairs.

## 8. Handoff

The local experimental flag works only in a local dev or preview build of this implementation. Nothing is deployed.

```
npm run dev          # or: npm run build && npm run preview
# then open:
http://localhost:<port>/?renderer=gpu              # GPU layer over the canonical SVG
http://localhost:<port>/?renderer=gpu&gpu-select   # + experimental editor click routing (marker only while stale)
```

In the console with `gpu-select`, these are available:
- `gpuClickTelemetry`: per-kind routed / resynced / dropped / legacy / agree / disagree counts, plus
  recovered / unrecovered;
- `gpuSelect(x, y)`;
- `gpuRenderer`.

Without either flag the app behaves exactly as before.

**To widen routing:** add a kind to `READY_KINDS` in `src/gpu/editor-dispatch.ts` only after it passes the frozen
gate in every matrix cell.
