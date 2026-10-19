# P3 instance-addressed picking

Status: **implemented and unit-tested, NOT browser-verified.** Every picking pilot run after the final relief change was
rejected at setup by the harness's `TradeAnimation.stop` guard (see Blocker). There is no accepted picking result
in this slice. The 8-matrix, 20-pair runs and acceptance were not attempted. All thresholds are unchanged, and the
full rewrite is not complete. P3 is unshipped: SVG is the default and GPU is opt-in. P2 production is untouched.

## Scope

- Frozen pilots: compact `picking-1792170576861071000` and materialized `picking-1792170421218809000` (both dpr 2 / zoom 2).
- 100k raw baseline: burg 559/708, label 46/50, marker 428/431.
- Oracle, seeded points, tolerances and gates are unchanged. Raw and semantic results are still reported separately.

## Mismatch taxonomy

| | Class | Status |
|---|---|---|
| A | Route stroke outline: dashes, caps, and butt ends treated as round | Fixed at the source: `strokeCovers` in `src/gpu/pick.ts` gives open ends the cap only and honours dashes. Unit-tested. |
| C | Screen overlay (scale bar) occluding world hits beneath it | Fixed: overlay items are indexed under layer `screen` and checked first. A screen hit goes to the clicked() fallbacks, never to the label beneath (`selection.test.ts`). |
| R | Materialized relief: id-less `<use>`, so the old pick returned the `#terrain` group or a square box | Per-instance narrowphase plus a live `<use>` target (this report). Not browser-verified. |
| B, D, E | Remaining dense burg/label/marker misses | **Not investigated** in this slice. No source-proven cause yet, so nothing was changed. |
| F | `sea_island` (`#coastline` group filter) | Note only. Not changed. |

## Changes (relief instance identity)

- **`src/gpu/pick.ts`:**
  - `PickHit.instance?` was added.
  - `addInstance(layer, id, corners, instance, narrow)` was added. It keeps the item's box in the 64 px buckets as the broadphase and runs `narrow(x, y, tolerance)` in `hits()`.
  - Topmost order is unchanged: highest index wins, so the `#terrain` child order is preserved.
- **`src/gpu/relief-pick.ts`** (new):
  - `readGlyph(group, href)` runs at prepare time and is cached per href per prepare. It reads the `<symbol>` and turns its leaves into hit primitives.
  - `glyphCovers` maps the world point into symbol user space, using the viewBox and xMidYMid meet. It tests fill area (nonzero/evenodd) and stroke outline (width, dashes, offset, cap), clipped exactly to the `<use>` viewport.
  - `glyphTarget(group, icons, k)` reads the live child on click: `#terrain.children[k]`.
  - `glyphKey` builds editReliefIcon's `(id)|href@x,y` key from the attributes.
- **`src/gpu/prepare.ts`:** materialized relief icons use `addInstance` with `glyphCovers` when the symbol is supported. Otherwise they keep `addBox`. `Prepared.relief = { group, icons }`.
- **`src/gpu/renderer.ts`:** `glyphAt(hit)` resolves a hit only when the prepared revision is current, then calls `glyphTarget`. It is wired into `gpuSelect` as `sources.glyph`.
- **`src/gpu/selection.ts`:** in the terrain branch:
  - An instance hit resolved to a live `<use>` gives `branch: "terrain"`, `target: <use>`, and `id: glyphKey(use)`.
  - Anything else (an unsupported symbol box, a stale index, or no instance) gives `branch: "terrain-unsupported"` with a null target. It never falls through to the fallbacks and is never made transparent.
- Compact relief is unchanged: the raster stays click-through with no boxes and goes to the `pickBurg`/`peekRelief` fallbacks.

No DOM ids were invented, the SVG is not mutated, nothing is read from the DOM every frame, and the candidate side never
calls `elementFromPoint`/`elementsFromPoint`/`getIntersectionList`. The SVG oracle is not reused on the candidate side.

## Identity and stale guards

- **Prepare time:** symbol geometry and style are read once per href.
- **Click time:**
  - The hit's prepared revision must be current (`glyphAt`).
  - `glyphTarget` rejects the hit if any of these hold:
    - The group is detached.
    - The `#terrain` child count differs from the indexed icons.
    - Child k is not a `<use>`.
    - Child k is `viewport-culled` (display:none, which SVG does not hit either).
    - Child k's href, x, y, width or height differ from the indexed sprite.
  - A rejected hit is reported as `terrain-unsupported`, never re-targeted.
- The target is the canonical `SVGUseElement` itself, checked by identity (`toBe`) in the tests.

## Supported vs unsupported semantics

**Supported:**
- A `<symbol>` with a viewBox and no x/y/width/height, and preserveAspectRatio absent or `xMidYMid [meet]`.
- Direct `path/polygon/polyline/rect/circle/ellipse/line` leaves.
- Inherited fill, fill-rule, stroke, stroke-width, stroke-dasharray, stroke-dashoffset, stroke-linecap, pointer-events and visibility, resolved as in the `<use>` shadow tree: the leaf's own attribute or inline value, else the symbol's, else `#terrain`'s.
- `display:none` leaves are skipped.
- A hit ends at the exact `<use>` viewport clip.

**Unsupported** (the href is boxed and reported `terrain-unsupported`; nothing is accepted falsely):
- transform, marker, clip-path, mask or filter on a leaf
- vector-effect
- currentColor or inherit paint
- `pointer-events` values that need the bounding box
- unparsable dasharrays
- nested groups
- symbol x/y/width/height
- other preserveAspectRatio values
- stylesheet rules aimed at symbol content (not modelled)

**Approximation:** joins are round, a subset of the default miter outline, as in the rest of the index. Points near sharp
miter corners can therefore miss where SVG hits.

W3C text cells, other layers' transforms, and pointer-events/visibility handling are unchanged from the previous slice.

## Results

| Run | Mode | Outcome |
|---|---|---|
| `picking-1792172132460686000` | materialized | **Shared world valid; relief agreed 0/102 with 236 extra.** Every terrain hit was unsupported because `readGlyph` returned null for every href: the old guard required each leaf's inherited computed style to equal `#terrain`'s, which the defs ancestry breaks. Other results: label 27/27, marker 21/21, burg 2/4 (gate status "insufficient"), cells 421/421. The 100k world failed with the TradeAnimation guard. |
| `picking-1792172217997012000` | materialized | After the shadow-tree inheritance fix: both worlds rejected (TradeAnimation guard). |
| `picking-1792172280858860000` | materialized | Retry after rebuild: both worlds rejected (TradeAnimation guard). |
| `picking-1792172305433892000` | compact | Both worlds rejected (TradeAnimation guard). |

So the inheritance fix is unit-tested but unmeasured. The relief statistics and claims in this report were unit-only and
unverified in a browser until [P3-TRADE-AND-PICKING-VERIFICATION.md](P3-TRADE-AND-PICKING-VERIFICATION.md), which
fixes the blocker below and reports valid pilots. **No raw or semantic picking numbers from this slice replace the
frozen pilots.** Labeled supplements and the guard/self-test/sourceCurrent/alignment inspection could not run because
setup never completed.

Other checks:
- `unit`: 63 files / 637 tests pass.
- `build`: OK.
- `context` (`p1-delegated-1792172323126134000`): passed. Injected loss and restore drawn in 591 ms; sourceCurrent true.
- `lifecycle` (`p1-delegated-1792172331285576000`): `failure: null`, heap growth 34.7 MB. That is *below* the 38–42 MB of earlier lifecycle runs (e.g. `p1-delegated-1792170631509474000`: 42.4 MB), not within it. It is not a regression, but one run is not a trend.
- `smoke`: not run, because drawing did not change (picking only).
- `bench` (`p1-delegated-1792172437768622000`): 37/37 pass.

## Blocker: harness setup guard

`bench/picking-parity.ts` calls `TradeAnimation.stop()` and rejects the run if any `#tradeAnimation > g` remains.
Residue was `{"groups":29–30,"activeCount":0,"liveContainers":2,"selectionIsLive":true}` in both worlds and both relief
modes. It occurred in 4 of 4 runs after the first, and in the 100k world of the first run too.

There are two `#tradeAnimation` containers. `clear()` in `src/renderers/draw-trade-animation.ts` removes groups only
from the current selection and from `liveGroups`, so the groups in the second container survive. `keepSingleContainer`
exists but evidently is not applied on this path.

This code (`trade-animation.ts`, `draw-trade-animation.ts`, `io/load.ts`, `io/auto-update.ts`) was already modified in
the working tree before this slice, and the picking change does not touch it. Fixing it is load-path work outside this
slice, so it was recorded rather than patched. Weakening the guard was not considered.

## Next work

1. Find where the second `#tradeAnimation` container comes from (generation as well as load, because the 100k world is generated) and fix it at the source with a test. Then rerun the compact and materialized pilots at dpr 2 / zoom 2 on the unchanged seeded points.
2. With a valid materialized run, confirm that relief resolves to `terrain` with matching `(id)|href@x,y` ids. Inspect any `terrain-unsupported` counts by href.
3. Investigate classes B, D and E (dense burg/label/marker) from first-mismatch records, and only fix where the source proves the cause.
4. If miter-corner relief misses show up, consider a bounded miter-join outline.
