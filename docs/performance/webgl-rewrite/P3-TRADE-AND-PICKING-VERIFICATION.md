# P3 trade-animation lifetime fix and picking verification

Status: **the `TradeAnimation.stop` blocker is fixed at the app source. The compact and materialized picking pilots
(dpr 2 / zoom 2) are valid again in both worlds.** No gate was passed that had failed before. The 8-matrix and
20-pair runs were not attempted. Thresholds, seeded points and the strict harness guard are unchanged, and orphan
removal was not added to the harness. Production remains P2 with SVG as the default.

## 1. Duplicate-container source

The guard residue was `{"groups":29–30,"activeCount":0,"liveContainers":2,"selectionIsLive":true}`. `clear()` already
removed groups in the selected container and in `liveGroups`, so the surviving groups had to be in a
`#tradeAnimation` that the live map did not own.

That container is the deep clone of `#map` made by `prepareMapClone` (`src/io/export.ts`). The GPU compat lane
(`compatClone` → `prepareMapClone("gpu")`, `src/gpu/compat.ts`) attaches the clone to `document.body` across awaits.
The clone therefore carried a copy of every in-flight caravan group into a second, document-visible
`#tradeAnimation`. Neither `stop()` nor the transitions could reach that copy.

- `generate()` does not create a second container.
- `load.ts` already de-duplicates old saves (`keepSingleContainer`).
- Both worlds were affected because both run the compat lane (labels and markers are compat layers).

## 2. Fix (app source only)

- **`src/renderers/draw-trade-animation.ts`:**
  - `stripTradeCaravans(root)` removes `#tradeAnimation > g` from a copy of the map.
  - `bindCanonicalContainer()` is idempotent. It keeps the live map's first `#tradeAnimation`, removes duplicates, and
    rebinds the global `tradeAnimation` selection when it is detached or points at a duplicate. It rebinds through
    `viewbox.select(() => node)`, which keeps the legacy d3 copy that owns the transitions.
  - `animateSegment` binds before appending, so a resumed caravan always lands in the canonical container.
  - `clear()` interrupts and removes, in this order:
    1. the selection's groups
    2. every tracked `liveGroups` node
    3. the direct `g` children of *every* live-map `#tradeAnimation`

    It then rebinds. Highlights (`path.highlight`) and other layers are never touched.
- **`src/io/export.ts`:** `prepareMapClone` calls `stripTradeCaravans(cloneEl)` before attaching the clone. Caravans
  are transient (`save.ts` drops them too), and the GPU lane mirrors live markers itself (`scene.ts` skips
  `#tradeAnimation > g`).
  - Side effect: user SVG/PNG exports no longer include mid-flight caravan glyphs. A route highlight is still exported.
- `load.ts`, `auto-update.ts` and `trade-animation.ts`: not changed in this slice.

## 3. Corrected lifetime behaviour

- **Start:** the first segment binds the selection to the single canonical container. Each group is tracked in `liveGroups` until its `end` handler removes it.
- **Stop** (`generation++`, `activeCount = 0`, `clear()`): no caravan group remains in any live container, including detached groups from a replaced world. Export and GPU clones never contain any, so the document-wide `#tradeAnimation > g` count is 0.
- **Restart:** after a load or migration, including an old save with a duplicate container and a selection still pointing at the previous world, new caravans draw only into the canonical container. Repeated `keepSingleContainer` / `clear()` calls are no-ops.
- **Paint:** live paint is unchanged. Only the transient groups inside a *copy* of the map are dropped, and the GPU scene already ignored those. Smoke was therefore not rerun.

## 4. Tests (`src/renderers/draw-trade-animation.test.ts`, node env, fake DOM)

1. Duplicate containers: `keepSingleContainer` keeps the first and is idempotent.
2. Replaced world: `clear()` removes caravans from a replaced world's container exactly once.
3. Old-map duplicate container: `draw` rebinds the selection to the first container and drops the duplicate (including a static caravan inside it). `clear()` then leaves 0.
4. Stop cleanup: stopping interrupts and removes caravans in every live container. The highlight, the `#routes` group and the canonical binding are kept.
5. Generated world: 30 caravans are in flight, and an attached export/GPU clone has been passed through `stripTradeCaravans`. Stop leaves 0 groups document-wide, and the clone's highlight and routes survive.
6. Repeated load/migration:
   - Stale groups are interrupted through `liveGroups`.
   - A second load with a duplicate container and a stale selection resumes into the canonical container with exactly one caravan.
   - The `end` handler removes that caravan, and `clear()` stays bound.

`trade-animation.test.ts` (stop/generation) is unchanged and still passes.

## 5. Checks (sequential, strict guard unchanged)

| Check | Artifact | Result |
|---|---|---|
| unit | `p1-delegated-1792173166415821000` | 63 files / 641 tests pass (run before a type-only cast in the new test) |
| build | `p1-delegated-1792173177241061000` | OK (after that cast) |
| bench | `p1-delegated-1792173469409271000` | 37/37 pass |
| context | `p1-delegated-1792173472438569000` | `failure: null`; injected loss and restore drawn in 604 ms; sourceCurrent true; 30 markers before and after |
| lifecycle | `p1-delegated-1792173482857323000` | `failure: null`, `errors: []`, forced GC; heap growth 34.6 MB (the previous run was 34.7 MB; both are below the 38–42 MB of earlier runs) |
| smoke | not run | live drawing unchanged (see §3) |
| picking, compact | `picking-1792173183007594000` | valid, `failure: null`, `errors: []` in both worlds |
| picking, materialized | `picking-1792173262307610000` | valid, `failure: null`, `errors: []` in both worlds |

## 6. Pilot evidence (dpr 2 / zoom 2; rate = agree / (expected + extra + wrongInto))

**Compact:**

| World | Measure | Cells | Burg | Label | Marker | Relief |
|---|---|---|---|---|---|---|
| shared | raw | 421/421 | 2/4 (insufficient) | 27/27 (insufficient) | 21/21 (insufficient) | 0/346 |
| shared | semantic | – | 4/4 | 27/27 | 21/21 | 346/346 (extra 2, wrongInto 22) via the `pickRelief` CPU fallback |
| 100k | raw | 708/708 pass | 559/698 **fail** | 46/48 insufficient | 428/431 **fail** | 0/203 |
| 100k | semantic | – | 652/705 | 46/48 | 428/431 | 203/203 (wrongInto 4) |

**Materialized:**

| World | Measure | Cells | Burg | Label | Marker | Relief |
|---|---|---|---|---|---|---|
| shared | raw | 421/421 | 2/4 | 27/27 | 21/21 | 0/102 (wrong 102, extra 47) |
| shared | semantic | – | 4/4 | 27/27 | 21/21 | 102/102 (extra 47, wrongInto 0) |
| 100k | raw | 708/708 | 559/656 **fail** | 46/48 | 428/431 | 0/114 (wrong 113, extra 32) |
| 100k | semantic | – | 599/658 **fail** | 46/48 | 428/431 | 102/114 (wrong 11, missing 1, extra 32, wrongInto 28) |

Every count under 50 stays "insufficient". No jitter or extra points were added to reach 50.

### Frozen-seed comparability

- **What is the same:** both reruns use the same seed (7319), the same map SHA-256 (`f5c0d703e4a2…`, identical to the frozen compact pilot `picking-1792170576861071000`), the same camera and the same seeded points.
- **Numerators:** the 100k raw numerators equal the frozen baseline (burg 559, label 46, marker 428).
- **Denominators changed:** burg 708 → 698 (compact) / 656 (materialized), and label 50 → 48. This follows from the A/C fixes: fewer route and scale-bar hits are now drawn *into* burg/label, so wrongInto falls.
- **Materialized 100k semantic burg:** 599/658 now vs 561/668 in the previous materialized pilot
  (`P3-RELIEF-LIFECYCLE.md`). *Correction (P3-DENSE-SELECTION):* an earlier version of this line cited 620/712 for
  `picking-1792170421218809000`; that figure is the frozen *compact* semantic burg count, not materialized. Relief instance hits now claim points that previously fell back. This is a real behaviour change, not noise. It should be read through the relief taxonomy below, not as a burg regression or improvement.

## 7. Relief-pick semantics, reviewed against the artifacts

- **How identity is scored:** the oracle's expected id for a materialized glyph is editReliefIcon's key `(id)|href@x,y`, read from the real `<use>` that SVG hit-testing returned (`bench/picking-parity.ts:514`). It is never empty. `compareSelections` matches on `kind:id`. The candidate id is `glyphKey(use)` of the live canonical `<use>` (`target` checked by identity in the unit tests).
- **Unsupported is never correct:** a `terrain-unsupported` result has id `""`, so it can only score *wrong* or *extra*. Across both worlds' materialized sample records it scored 0 agree, 23 wrong and 78 extra. The sampled extras sit over `oceanPattern`, where SVG hits nothing.
- **Supported hrefs seen as `terrain` hits with matching keys:** hill, mount, mountSnow, cactus, acacia-2, deciduous-2, grass-2.
- **Unsupported instances overlapping supported ones:** every 100k relief "wrong" expected a supported href (acacia-2 ×7, palm-2 ×2, swamp-2, deciduous-2) but hit a `terrain-unsupported` instance on top. For example, index 20642 covers both an acacia-2 point and a deciduous-2 point about 9 units apart. That index is a *boxed* unsupported symbol: its whole square counts as hit area.
- **Source-proven reasons for unsupported symbols in `src/index.html`:**
  - `relief-swamp-2`: a `transform` on a leaf `<rect>`.
  - `relief-deciduous-3`: a nested `<g fill>`.

  Which concrete index maps to which href is not recorded in the artifact. This gap is listed as the first next fix.
- **The one `missing`** (grass-2 @534.13,267.13) resolved to `oceanPattern`. It is a narrowphase miss, consistent with the documented round-join/miter approximation or the tolerance edge. It was not investigated further.
- **Raw vs semantic:** raw relief is 0 by construction, because the raw id is the `#terrain` group and SVG gives an id-less `<use>`. Only the semantic layer is meaningful for relief, and it is reported separately.
- **Compact relief** passes semantically only through the `pickRelief` CPU fallback. That fallback is the *same function* `clicked()` uses, so it is routing evidence only, not independent hit-geometry evidence.
- **Modelling limits:**
  - Stylesheet rules aimed at symbol content are not modelled; inheritance is attribute or inline → symbol → `#terrain`.
  - currentColor and inherit paint, nested groups, leaf transforms, markers, clip/mask/filter and vector-effect make an href unsupported (boxed).
  - Joins are round, a subset of the miter outline, so points near sharp miter corners can miss.
- **Read-only, no hit-test APIs:** instance keys are read from attributes and never cause DOM mutations. The candidate side never calls `elementFromPoint`, `elementsFromPoint` or `getIntersectionList`.

No small source-proven bug was found in the relief pick itself. The box behaviour for unsupported hrefs is by design, and
it is honestly scored against the GPU. So nothing in the pick was changed in this slice.

## 8. Next fix (highest value first)

1. **Narrow the boxed unsupported relief hrefs.** Support leaf `transform` (affine matrix applied to the flattened rings) and plain nested `<g>` (inherit and flatten). This would remove most of the 100k relief wrong/extra and the 28 wrongInto. Add a per-href unsupported tally to the picking report so the mapping from index to href is recorded rather than inferred.
2. Investigate dense burg/marker misses (classes B/D/E: burg 559/698, marker 428/431) from first-mismatch records. Fix them only where the source proves the cause.
3. Then rerun the same two pilots on the frozen points. Only after that, consider the 8-matrix.
