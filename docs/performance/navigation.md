# Navigation tuning: first slice

Persistent dense overlays and paced zoom decoration replace per-frame glyph reconstruction. At deep zoom, relief and burg nodes retain identity and drawing order. A viewport padded by 20% on each axis permits small pans without spatial queries, metadata reads or DOM reconciliation. Larger movements update membership; substantial zoom-in trims excessive cached content. Returning to overview hides cached overlays and restores the original bitmap visibility. Editing, metadata changes, image replacement and map loads invalidate caches. Save/export clones strip all transient overlays.

Camera, culling and dense visibility still update each animation frame. Styling has a 50 ms / 2% scale threshold during gestures; coordinates, minimap and scale-bar details use 75 ms. Gesture end queues one exact update on the next frame, preserving boot initialization order and the latest camera. Explicit `invokeActiveZooming` retains its original styling/culling contract.

## Paired local measurements

Artifacts: `bench/results/navigation-base.json` and `navigation-head.json`. Both use Apple M1 Max, Node v25.6.1, Chromium 148.0.7778.96, 1280×720, DPR 1, default layers plus heightmap/relief, 120 continuous DOM mouse/wheel input frames, one warmup and three samples per gesture. The shared map is a read-only snapshot of version 8 (47,885 packed cells); the seeded 100K requested-point world has 53,194 packed cells. The original built assets were preserved outside the working tree before source edits.

The table reports median sample p95 values. Callback time measures instrumented scheduled JavaScript callbacks, excluding the gesture driver's own input dispatch. Frame time is the gap between driver rAF timestamps. Neither is a physical-display FPS or input-to-photon measurement. Mutation observation adds instrumentation overhead. Host contention and browser rasterization remain possible sources of variability.

| World | Gesture | Frame gap p95, base → head | Callback p95, base → head | Glyph additions, base → head |
| --- | --- | --- | --- | --- |
| Shared v8 | Short pan | 41.8 → 41.7 ms | 1.7 → 0.1 ms | 26,442 → 0 |
| Shared v8 | Broad pan | 41.7 → 41.7 ms | 1.7 → 0.7 ms | 24,346 → 555 |
| Shared v8 | Wheel zoom | 41.8 → 41.7 ms | 17.9 → 6.3 ms | 36,541 → 0 |
| 100K requested | Short pan | 75.0 → 66.8 ms | 9.5 → 0.2 ms | 217,323 → 0 |
| 100K requested | Broad pan | 75.0 → 75.0 ms | 9.6 → 5.5 ms | 218,542 → 7,484 |
| 100K requested | Wheel zoom | 141.8 → 91.7 ms | 109.4 → 31.4 ms | 355,956 → 0 |

DOM churn and scheduled callback cost fall substantially. Large-world wheel frame gaps improve about 35%; shared-world frame gaps remain essentially unchanged. This slice does not establish smooth 60/120 Hz navigation. The next diagnostic should trace input coordinate conversion, style/layout, SVG paint, filters and compositing, then move the remaining expensive camera work onto cached/composited surfaces as supported by those traces.

## Verification and reproduction

Seven dense-overlay tests cover stable identity, bounds changes, ordering, threshold reuse, metadata invalidation, malformed metadata and cleanup. Five scheduler tests cover event bursts, decoration pacing, exact settling, world cancellation and boot lifecycle. All 243 app tests pass; production build and app/MCP type checks pass. Seven real-browser native-save/hidden-layer/edit/history/fixture checks pass. All 18 measured gesture samples preserve the model digest and settle to the same visual attributes as an explicit exact refresh.

Run a CF build, then use `BENCH_MAP=/path/to/read-only.map node bench/navigation.ts`. The runner uses one local static server/browser and blocks external browser requests. `BENCH_DIST` selects a preserved build, `BENCH_OUTPUT` selects the result path, and `BENCH_SAMPLES`/`BENCH_FRAMES` control exploratory runs. Compare three-sample artifacts with `node bench/navigation-compare.ts BASE HEAD`. Shared-map content is retained only in a temporary local snapshot, not committed into benchmark results. These navigation measurements have not run in CI.

## Production deployment

Deployed 2026-10-11 in Worker version `96603d0c-2785-4406-a5cb-432a3550a954`. Previous rollback version: `692b44b5-9740-4f91-9f7a-5d0cdb9fbb10`. The live entry `/index-ByNVIW-T.js` and `main.js` match built SHA-256 hashes. A production browser loads the shared map, retains all 334 cached glyph nodes and eight overlay groups across a small pan, settles the camera exactly to the D3 transform and prepares a binary save without transient overlays. Browser page errors: zero. Shared map remains version 8; API writes were blocked during verification.


## Second slice: Metal GPU navigation, 2026-10-13

This local, undeployed slice adds exact settled scale-bar drawing, batched label culling with `display:none`, and a bounded high-resolution relief viewport tile backed by prerasterized symbols. The earlier deployed measurements above remain a separate dataset. The primary comparison here uses full Chromium with ANGLE Metal on Apple M1 Max; selected CDP GPU metadata confirms hardware compositing and rasterization. Older headless-shell SwiftShader results measure a software renderer and are not numerical baselines for this comparison.

Artifacts are `bench/results/navigation-atlas-metal-{base,head}.json` and `navigation-atlas-metal-paired.jsonl`. Both arms use the same read-only shared version-8 snapshot (SHA-256 `f5c0d703e4a21dc608981285644ba05618ed01f45d3d45fb34827087b679f5c0`), seeded generated world, browser/backend, layers, viewport, tracing, one warmup and three 120-frame samples. Each measured gesture preserves the world digest and matches an explicit exact refresh including the entire scale-bar markup. The runner awaits `waitDenseZoomReady` after gesture timing and records publication wait separately.

| World | Gesture | Median sample frame-gap p95, base → head | Input dispatch p95, base → head | Matched idle p95, base → head |
| --- | --- | --- | --- | --- |
| Shared v8 | Short pan | 18.1 → 16.8 ms | 0.4 → 0.5 ms | 14.9 → 18.7 ms |
| Shared v8 | Broad pan | 25.0 → 33.2 ms | 1.2 → 0.5 ms | 10.1 → 17.5 ms |
| Shared v8 | Wheel zoom | 25.0 → 25.0 ms | 14.0 → 3.9 ms | 22.9 → 16.3 ms |
| 100K requested | Short pan | 25.3 → 25.1 ms | 0.5 → 0.4 ms | 24.7 → 9.0 ms |
| 100K requested | Broad pan | 61.2 → 33.5 ms | 8.9 → 0.8 ms | 25.1 → 9.0 ms |
| 100K requested | Wheel zoom | 141.7 → 41.7 ms | 31.0 → 16.5 ms | 16.7 → 25.1 ms |

The large-world wheel frame-gap p95 improves about 71%, but 60 Hz and 120 Hz targets remain unmet. Its median missed budgets fall from 625 to 90 at 16.7 ms, and from 1293 to 235 at 8.3 ms over 119 measured intervals. Budget counters allow 10% cadence tolerance; strict crossings are also retained. Shared broad-pan frames regress alongside a slower idle control and asynchronous tile drawing. Host load averages vary from 22.4 to 15.1 during baseline and 15.6 to 11.5 during head; serial execution and matching hardware do not remove this contention.

Cold warmup records are preserved separately from the three measured samples. The 100K wheel warmup maximum interval falls from 367 to 75 ms, but head then waits 1274.7 ms after the gesture for the final coalesced crisp tile. A separate native-wheel threshold crossing from scale 3.9 to 4.357 records a 33.3 ms maximum early interval and 99.7 ms to observed tile publication, with the base relief continuously available. That check uses an already prepared sprite atlas; deliberately delayed first sprite decode is still an explicit coverage gap.

The final 100K wheel trace spans 12.651 → 3.496 seconds. Main-thread Layout totals fall 4.613 → 1.587 seconds and Paint 3.774 → 0.783 seconds. Aggregate worker RasterTask duration is 1.456 → 1.373 seconds. Remaining head Layout inside synchronous input is 1.535 seconds over 120 events, with a 55.5 ms maximum, identifying a remaining input-coordinate/layout bottleneck. Trace event totals overlap and cannot be added. Raw traces remain outside the repository under `/tmp/tupaia-butter-traces/navigation-atlas-metal-{base,head}`; compact attribution is in the JSON artifacts.

Quality artifacts `navigation-atlas-quality-{base,head}.json/png` and `navigation-atlas-quality-head-diff.png` cover shared-map scale 8. Both arms preserve exact canonical save text across a pan roundtrip, zones, visible label hit targets, relief picker geometry, and 14 zone hatch pitches. Saved SVG contains no viewport overlays, culling classes, hidden-base attributes or blob URLs. The head additionally rejects a held old-world encode callback after map replacement. The screenshot comparison changes 0.486% of pixels by more than 16 channel levels (mean absolute channel delta 0.171, maximum 44); visual inspection shows differences along relief glyph edges, with label, route, river and hatch geometry retained. This is a sampled camera check, not a complete visual equivalence proof.

Reproduce timing with `BENCH_CHANNEL=chromium BENCH_ANGLE=metal BENCH_GPU=1 BENCH_MAP=/path/to/snapshot.map BENCH_TRACE=1 BENCH_DIST=/path/to/dist BENCH_OUTPUT=/path/to/result.json node bench/navigation.ts`. Run each arm serially. The driver uses synthetic DOM dispatch and rAF timestamps, so these values are not physical-display FPS, native hover latency or input-to-photon measurements. The supplemental quality wheel uses Playwright native input. Four pure frame-budget/trace-attribution tests and harness type checks pass.


## Experimental worker follow-up, not deployed

The worker follow-up remains opt-in (`?reliefWorker=1`); the default uses the main-thread atlas. Three-sample Metal results are retained in `bench/results/navigation-worker-metal-head.json`, with comparisons to production and the atlas in `navigation-worker-vs-production.jsonl` and `navigation-worker-vs-atlas.jsonl`. This run preceded the final opt-in gate and used the worker directly; runtime telemetry confirms completed worker jobs, no fallback and no pending work after each settled gesture.

Relative to the atlas, shared broad-pan callback p95 falls 27.9 → 0.7 ms and frame-gap p95 33.2 → 25.0 ms. However, 100K wheel frame-gap p95 regresses 41.7 → 74.9 ms and input dispatch 16.5 → 57.5 ms, while median idle p95 remains approximately 25 ms. Its final trace increases from 3.496 to 5.172 seconds, with input-nested Layout 1.535 → 2.251 seconds, Paint 0.783 → 1.190 seconds and aggregate RasterTask 1.373 → 2.163 seconds. These broader increases do not prove a worker-specific cause, but the regression is a stopping signal and does not justify enabling the worker by default. All 18 measured gestures retain exact settled UI and unchanged model digests.

The worker head adds per-frame pending-state telemetry to the existing driver; input events, camera paths, sample counts, browser/backend and world fixtures remain unchanged. The prior production and atlas datasets are reused rather than rerun, so host variation remains a limitation. Both 16.7 ms and 8.3 ms targets remain unmet. Raw worker traces are retained under `/tmp/tupaia-butter-traces/navigation-worker-metal-head`.


Final frozen-source quality checks pass for both explicit worker opt-in and capability-disabled fallback. Results and screenshots are `bench/results/navigation-worker-quality-{head,fallback}.json/png`, with corresponding `-diff.png` heatmaps. The worker reports 11 completed jobs, 22 atlas entries, zero pending jobs and no fallback; disabling Worker and createImageBitmap reports the main backend, zero worker jobs/atlas entries, and the expected unavailable-capabilities reason.

Both paths pass exact canonical save roundtrips, zones, label hits, relief symbol identity/geometry, 14 screen-space hatch pitches, transient/blob cleanup and stale PNG decode rejection across world replacement. A fresh identical symbol alias delays the first uncached viewport-sprite decode for 120 ms: pending bookkeeping remains set, the overview stays visible, and releasing the decode publishes the tile and hands off visibility. This closes the earlier explicit initial-sprite coverage gap for the viewport lifecycle; it is a controlled cache-miss probe rather than a whole application boot measurement.

The worker screenshot differs from the atlas at 71 pixels by more than 16 channel levels (0.0077%; mean absolute channel delta 0.0066). The fallback differs from the worker at two such pixels (mean 0.0035). Native threshold-crossing checks retain the base fallback throughout: worker/fallback crisp tile times are 100.0/116.3 ms, with observed maximum intervals 18.2/25.0 ms. These sampled quality checks do not overturn the three-sample wheel regression or establish physical display latency. Final app verification reports 268 tests across 36 files, type checks and the CF build passing. No deployment occurred.

The final build also includes a regression test for live source-image attribute invalidation (position, dimensions, opacity and paint styles). The default remains the main-thread atlas; only explicit `?reliefWorker=1` selects the experimental worker, which was not deployed.
