# P2 — Camera-only hatch defs invalidation and near-pan settle spike

Scope: isolated tree only. Nothing is deployed. Production stays on the frozen P1
`ad4f0bf6-2b07-4142-ac9f-a585a645fb98`. SVG stays the default renderer and GPU
stays opt-in. No budget, harness, tool-config, dependency or file-format changes.

All artifacts are under `docs/performance/webgl-rewrite/host-checks/` with the
prefix `p1-delegated-`.

## Outcome

| Metric | Baseline | After (run 1 / run 2) |
|---|---|---|
| 100k pan-near idle max | 249.9 ms | **41.6 / 10.3 ms** |
| 100k pan-near long tasks during settle | 1 (~245 ms) | 0 / 0 |
| 100k pan-wide idle max | 9.4 ms | 10.3 / 10.1 ms |
| 100k wheel frame p95 | ~10.1 ms | 10.3 / 10.2 ms |
| 100k wheel event→RAF p95 | ~28.9 ms | 29.5 / 29.0 ms |
| Peak / steady memory | caps 268435456 / 167772160 | 204850141 / ≤159381310 |

The near-pan spike is gone. Pan-wide and wheel times are unchanged within noise.
Input is injected through CDP, so these are indicators, not user-perceived latency.

## Items (pattern → evidence → change → test)

### 1. Dense-zoom overlay `replaceChildren` caused a late static revision (verified)
- **Pattern:** relief-viewport rebuilds `<g data-dense-zoom>` inside `#terrain` on
  camera settle. The GPU scene skips dense-zoom subtrees entirely, but the
  classifier treated the childList change as static. That queued a revision
  prepare 120 ms later, and its first chunk was the ~245 ms idle long task.
- **Evidence:** the renderer trace (`jobs` and `longTasks`) showed a
  `childList … in #terrain` revision right before the spike.
- **Change:** in the `neutral()` childList branch of `src/gpu/markers.ts`, a
  target inside `[data-dense-zoom]` is now neutral. Adding or removing a plain
  `<g>` elsewhere is still static.
- **Test:** `markers.test.ts` overlay-swap cases (overlay → none,
  plain `<g>` → static, mixed batch → static).

### 2. Canonical relief-image visibility handoff caused a late static revision (verified)
- **Pattern:** after fix 1, the trace showed `@style <image> in #terrain`. Dense
  `show()`/restore toggles `visibility` and `data-zoom-hidden` /
  `data-zoom-visibility` on `image[data-relief]` / `[data-burg-vectors]`. The GPU
  draws zoom-hidden images either way, so the handoff doesn't change pixels.
- **Change:** `zoomHandoff(record, records)` (with `ZOOM_HANDOFF`,
  `declarations()` and `drawn()`) treats the batch as neutral only when the
  image's drawn state is the same before and after, and its non-visibility style
  declarations are identical. Any real user hide, opacity or fill write, marker
  removal while still hidden, non-relief image, or hidden parent stays static.
  `classify` passes the whole batch to `neutral`.
- **Test:** `markers.test.ts` "handoff" block, which stubs `getComputedStyle`.
  Classified as none: show, restore, and show with a surviving fill. Classified
  as static: user hide without the marker, opacity written alongside, marker
  removed while still hidden, non-relief image, hidden parent, and undefined
  `getComputedStyle`.
- **Evidence after:** smokes at DPR1 zoom 8 and DPR2 zoom 8 recorded 82 neutral
  mutations with dense relief active and no late revision. Navigation pan-near
  ran with 0 long tasks, 0 motion deferrals and 0 prepares during motion.

### 3. Camera-only hatch `patternTransform` (already neutral; rule tightened)
- **Pattern:** a zone-hatch clone's transform is `scale(1/k) <tail>`.
  `hatchUvAtZoom` is exact for any fixed tail, so only the camera scale term may
  be ignored.
- **Change:** the `hatchScale` regex and `hatchTail()` make a patternTransform
  change neutral only when the tail is identical. Angle and spacing edits (tail
  changes) stay static. The code never ignores all patternTransforms or whole
  defs. Camera-derived scale is handled separately from canonical semantic
  attributes.
- **Test:** `markers.test.ts` hatch cases. `raster.test.ts` checks that rotated
  and custom tails (`rotate(45 0 0)`, `rotate(-30 7 9)`,
  `scale(3) translate(4 5)`) rescale exactly like re-rasterizing the rewritten
  transform, at reference 3.5 and zoom 1, 2.25, 8 and 20.
- **Evidence:** the hatch checks at DPR1 and DPR2 report
  `cameraOnlyNoSvgUpdates: true` and `noReprepare: true`, maxDelta ≤ 1 and
  over16 0 at zooms 1/2/4/8 and pan, with 0 prepares while moving.

### 4. Telemetry (`src/gpu/renderer.ts`)
- A bounded `trace` (`jobs` and `longTasks`) was added to the status, plus a
  `PerformanceObserver` for long tasks. Both are released in `dispose()`.
  Lifecycle heap growth is 42273940 bytes, the same as earlier runs
  (42.26–42.32 MB), so the `dispose()` changes don't add a leak.
- After review, `observeLongTasks()` checks `typeof PerformanceObserver !== "function"`
  before calling the constructor. Without that check, an environment with no
  `PerformanceObserver` would throw after the MutationObserver was already
  attached, and the MutationObserver would leak.

## Review (one Haiku child, read-only, depth 1)
No bugs were found in the classifier. Each finding and what was done about it:
- **Risk 1:** a user visibility edit made while `data-zoom-hidden` is present is
  classified as neutral. **No change.** This matches `scene.ts:261`: the GPU
  draws zoom-hidden images either way, so pixels can't change. When the marker
  is later removed, the restore batch is classified as static if the drawn state
  differs.
- **Risk 2:** the constructor could leak when `PerformanceObserver` is missing.
  **Fixed** as described in item 4.
- **Nits (deferred):** `zoomHandoff` uses `records.find`, which is O(n²) per
  batch; batches are small in practice. A change to `data-zoom-visibility` alone
  is classified as neutral.
- **Verified:** the hatch tail rule, the dense-zoom logic, passing the batch to
  `neutral`, `hatchUvAtZoom` exactness, bounded traces, and `dispose()` cleanup.

## Rejected root causes
- **Overlay refresh:** 46–61.6 ms, committed, and not the spike.
- **Hatch patternTransform:** already neutral before this slice, so it didn't
  cause the spike.

## Check matrix (serialized; the primary agent ran all GPU checks)

| Check | Artifact | Result |
|---|---|---|
| unit | `1792113101266706000` | exit 0, 554/554 tests |
| build | `1792113160862906000` | exit 0, renderer chunk 103.69 kB |
| navigation DPR2, run 1 | `1792113178594461000` | exit 0. Every case GPU active, canvasVisible, finalCameraExact |
| navigation DPR2, run 2 | `1792113249992632000` | exit 0. Every case GPU active, canvasVisible, finalCameraExact |
| bench | `1792113312468697000` | exit 0, 20/20 |
| smoke DPR1 zoom 1/2/4/8 | `1792113316911986000`, `…326672150000`, `…337370697000`, `…346516682000` | exit 0, covered, peak ≤ 132196081 |
| smoke DPR2 zoom 1/2/4/8 | `1792113390688265000`, `…401309906000`, `…411624608000`, `…421541181000` | exit 0, covered, peak ≤ 159380293 |
| hatch DPR1 | `1792113430810584000` | exit 0, maxDelta ≤ 1, over16 0, noReprepare |
| hatch DPR2 | `1792113476695069000` | exit 0, maxDelta ≤ 1, over16 0, noReprepare |
| context | `1792113484867857000` | exit 0, loss then restore (615.6 ms), covered, peak 159380293 |
| lifecycle | `1792113495640470000` | exit 0, failure null, GPU active, heap growth 42.27 MB (unchanged) |
| unit (after guard fix) | `1792113688822371000` | exit 0, 554/554 tests |
| build (after guard fix) | `1792113694689753000` | exit 0, renderer chunk 103.73 kB |
| context (after guard fix) | `1792113731243625000` | exit 0, failure null, loss then restore (607.3 ms), covered, peak 159380293, long-task trace populated |

Every run had failure null, GPU active, fallbackReason empty and 0 context
losses, except the deliberately injected loss in the context check. No SVG
fallback was used.

## Blockers and limitations
- Navigation input is injected through CDP, so latency confidence is limited.
- 100k pan-near frame max varies between runs (24.9 / 41.6 ms). Idle max stays
  well under the old spike in both.
- The lifecycle heap's one-time ~35 MB warm-up jump (cycle 0 → 1) predates this
  slice.

## Next slice
- Reduce the first-chunk cost of prepares that legitimately follow a real
  canonical edit, which still costs 245–300 ms, by splitting prepare chunks
  further.
- Move markers' `<svg>` compat (33 elements) and text labels to native paths.
- Add the tests the review proposed: burg-vectors handoff, `<g data-relief>`
  classified as static, `getComputedStyle` throwing, duplicate style records,
  parent collapse, and constructing the renderer with `PerformanceObserver`
  undefined.
- Index `zoomHandoff` records by target instead of using `records.find`.
