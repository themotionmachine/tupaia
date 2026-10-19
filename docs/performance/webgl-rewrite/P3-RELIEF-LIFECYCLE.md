# P3 relief lifecycle: materialization readiness, peek/commit guards, protocol v2 hardening

Status: unshipped P3 work in the isolated implementation. SVG remains the default renderer. Nothing was deployed, and
there were no changes to the UI click adapter, backend, format or dependencies. This tranche covers lifecycle
correctness and valid measurement only. It is not a claim that the rewrite is complete.

Artifact prefix: `docs/performance/webgl-rewrite/host-checks/`.

## 1. Diagnosis: materialized relief never became GPU-ready

### Symptom

These runs were preserved as raw failed attempts:

- `picking-1792166825330413000`
- `picking-1792167542975350000`
- `picking-1792168279078159000`

In each, after `prepareReliefIcons()` the GPU stayed in preparing/behind for 30 s with `hadFrame:false` and no prepared
scene.

### Cause

The cause is in the scene build, not in invalidation or the timeout.

1. `prepareReliefIcons` replaces the `#terrain` raster with one `<use href x y width height>` per glyph:
   25,063 in the shared world and 35,494 in the 100k world.
2. `src/gpu/scene.ts` walked those like any other SVG. Every offset `<use>` became a compat element, and so did the
   terrain group.
3. The compat raster job then had to clone, serialize and decode tens of thousands of `<use>` elements.
4. That job never finished inside the readiness window, so the prepared revision never caught up with the source
   revision. Readiness was correctly reporting "not current"; the readiness logic itself was not wrong.

Raising the timeout or relaxing readiness would only have hidden the cost.

### Fix

- **`src/gpu/scene.ts:204-228`**: `materializedIcons(group)` reads materialized glyphs back as the same `ReliefSprite`
  records the compact raster carries.
  - Accepted per `<use>`: `href`/`xlink:href` naming an existing symbol; `x`, `y`, `width`, `height` with
    `width === height`.
  - Inert attributes allowed: the `draggable`/`viewport-culled` classes and `touch-action`/tap-highlight styles. This
    is the same allowance `compactRelief` makes.
  - Anything else returns `null`. That includes another tag, a custom style, a transform, an id, a missing symbol or a
    non-square glyph.
- **`src/gpu/scene.ts:321-327`**: a top-level `#terrain` group with no effects, no mask and opacity 1, whose glyphs pass
  that test, is pushed as one native `{kind:"relief"}` item. It goes through the instanced lane compact relief already
  uses, with the same sprites.
- **Fallback**: any group that fails the test keeps the previous exact compat path. Unsupported content still renders
  through the deterministic fallback; nothing is silently approximated.
- **Prep/cache lifetime**: only the materialized regime is affected. Compact relief already took this lane. There are no
  changes to invalidation, revision, the readiness timeout or the readiness criteria.
- **Tests (`src/gpu/scene.test.ts`)**: canonical and inert-attribute glyphs read back as compact sprites; style,
  transform, id, non-square, missing symbol, non-`<use>` child and an empty group all keep the group exact.

### Result

In both worlds the materialized pilot `picking-1792170421218809000` is GPU-ready, source-current and valid.

| World | Prepared revision = source revision | Compat runs / elements |
|---|---|---|
| shared | 10 = 10 | 12 / 118 |
| 100k | prepared = source | 8 / 1700 |

Compat counts are identical to the compact regime, so the glyphs no longer reach compat at all.

### Selection semantics

These are unchanged, and only partly supported:

- In the materialized regime, SVG `clicked()` selects a `#terrain > use` instance.
- The GPU pick index has one relief entry per symbol href, not per `<use>` instance. Its relief hits therefore cannot
  name the instance the editor opens.
- The report labels these hits `terrain-unsupported` and does not count them as agreement.

## 2. Peek/commit guards (`src/renderers/relief-canvas.ts:215-305`)

### Closed gaps

**Aliasing.** The cache is keyed by raster element, render revision and the `data-relief` string, compared with `===`.

- This is exact for same-length edits.
- It is O(1) on the normal path: an unchanged attribute hands back the same string, and a changed one differs early or
  in length.
- A module `generation` counter is bumped on every reindex or drop.

**Stale commit.** `commitRelief(peek)` returns `null` without materializing when any of these hold:

- the layer is off
- the live raster differs from the peeked one
- the generation moved
- `icons[peek.index]` no longer has the peeked `href@x,y` key

After `prepareReliefIcons()` it also returns `null` unless the `<use>` at that index carries the same key.

### Contract

- `peekRelief` is pure: it makes no DOM writes and does not call `prepareReliefIcons`.
- `commitRelief` is the only path that materializes.
- Legacy synchronous `pickRelief(x, y)` is still `peek && commitRelief(peek)` and returns the same `SVGUseElement` or
  `null` as before.

### Tests (`src/renderers/relief-canvas.test.ts`)

- peek is non-materializing and stable
- commit through legacy `pickRelief` returns the keyed `<use>`
- a replaced or removed raster is reindexed or dropped, and the stale peek does not commit
- normal commit returns the identical `<use>` the legacy caller gets
- a same-length data edit is reindexed and the stale peek is rejected
- same raster node, different world: the commit is rejected
- layer off: no peek and no commit

## 3. Protocol v2 hardening (`bench/picking-parity.ts`, `bench/picking-oracle.ts`)

### Observation

- A `MutationObserver` on `#map` (subtree) records **childList, attributes (with old value) and characterData**.
- Counts are kept per type, with a bounded log.
- `sceneChanges` rejects a run on any non-zero count of any kind.

There is no attribute exception list: no benign churn appeared once trade animation was frozen (below).

### Probe

The probe is taken before and after each pass. There is no per-sample whole-map hashing. It records:

- regime, terrain hash and child count
- relief revision
- prepared-scene identity and prepared revision
- **source revision**
- **pick-index identity**
- **exact camera**: the `#viewbox` transform plus the `scale`/`viewX`/`viewY` globals
- **layout**: the `#map` client rect plus window size and DPR

Any difference rejects the run (`src/gpu/picking-protocol.test.ts`, 6 tests).

### Self-test

Before install, the observer is proven against a detached SVG.

- Each of these must be detected: font-size, circle radius, `display`, `pointer-events`, style, geometry `x`, transform,
  text data and node insert.
- Any blind entry adds `guard self-test missed: …` and invalidates the run.
- In both final pilots every entry was detected: attributes 1 for each of the 7 attribute edits, characterData 1 for the
  text edit, childList 1 for the insert.

### Cleanup

Passes run inside `try { … } finally { teardown() }`. Teardown is idempotent:

- It restores the wrapped `pickRelief`/`prepareReliefIcons` and disconnects the observer.
- It returns the probe, counts, log, committing-call count and target connectivity, even when an exception was thrown.

### Picking discipline

- `elementFromPoint` is used for the expected (SVG) side only.
- The candidate is the GPU index alone.
- The CPU fallbacks (`pickBurg`/`peekRelief`) are queried only where `clicked()` would consult them.
- Agreement that comes through those shared CPU fallbacks is **routing evidence only**. It is not evidence about GPU
  picking.

### TradeAnimation finding

The first compact rerun, `picking-1792170350342969000`, was rejected in the shared world with "TradeAnimation.stop did
not clear the caravans". It is kept as a raw failed attempt.

Diagnosis:

- The shared map has two `#tradeAnimation` containers (`liveContainers: 2`).
- The module's live selection points at one of them. The caravans sit in the other, so `clear()` misses them.
- After `stop()` the module's `activeCount` is 0: the generation was bumped, so these are static orphans, not running
  animations.
- The likely source is an app-side duplicate container, from a `select` at `load.ts:406` versus an insert at
  `auto-update.ts:1155`. It is **not fixed** in this tranche.

SETUP now handles it as follows:

1. Assert that the module is stopped and `activeCount === 0`. If not, throw: an unstopped animation cannot pass as
   stable.
2. Remove `#tradeAnimation > g` orphans and record `orphansRemoved`: 30 in the shared world and 29 in the 100k world, in
   both regimes.
3. The existing "trade caravans resumed during setup" check stays in place.

## 4. Pilot results (dpr 2, zoom 2, settled, headless). These exercise the final gate and guard code.

Gate thresholds are unchanged by this tranche.

- Burg, label and marker each need at least 50 samples; below that the status is `insufficient`.
- Cells are reported separately.
- Raw counts compare GPU index hits only. Semantic counts include `clicked()` routing through the shared CPU fallbacks,
  and are routing evidence for those rows.

### Guard evidence

| Pilot | World | Valid | gpuReady | Mutations (childList/attributes/characterData) | Self-test | pickMs p50/p95 |
|---|---|---|---|---|---|---|
| compact `picking-1792170576861071000` | shared | true | true | 0/0/0 | all detected | 0.2 / 0.3 |
| compact `picking-1792170576861071000` | 100k | true | true | 0/0/0 | all detected | 0.3 / 0.6 |
| materialized `picking-1792170421218809000` | shared | true | true | 0/0/0 | all detected | 0.2 / 0.3 |
| materialized `picking-1792170421218809000` | 100k | true | true | 0/0/0 | all detected | 0.4 / 0.6 |

Prepared revision equals source revision before and after every pass:

- compact shared 9 = 9
- compact 100k 16 = 16
- materialized shared 10 = 10

### Compact regime (`picking-1792170576861071000`)

| World | Count | burg | label | marker | cells | relief |
|---|---|---|---|---|---|---|
| shared | raw | 2/4 (insufficient) | 27/27 (insufficient) | 21/21 (insufficient) | 421/421 | 0/346, 346 missing (no GPU relief index entries) |
| shared | semantic | 3/4 (insufficient) | 27/27 | 21/21 | — | 346/346 via shared `pickRelief`, routing only; 22 wrongInto, 2 extra |
| 100k | raw | 559/708 = 0.790 **fail** | 46/50 = 0.92 **fail** | 428/431 = 0.993 **fail** | 708/708 | 0/203, 201 missing, 2 wrong |
| 100k | semantic | 620/712 = 0.871 | 46/50 = 0.92 | 428/431 = 0.993 | — | 201/203 via shared `pickRelief`, routing only |

Semantic routing totals:

- shared: none 110, pickRelief 370, index 55, pickBurg 1
- 100k: index 1144, pickRelief 205, pickBurg 65, none 24

### Materialized regime (`picking-1792170421218809000`)

| World | Count | burg | label | marker | cells | relief |
|---|---|---|---|---|---|---|
| shared | raw | 2/4 (insufficient) | 27/27 (insufficient) | 21/21 (insufficient) | 421/421 | 0/102, 102 missing |
| shared | semantic | 2/4 (insufficient) | 27/27 | 21/21 | — | 0/102: **terrain-unsupported** (101 wrong, 237 extra) |
| 100k | raw | 559/666 = 0.839 **fail** | 46/50 = 0.92 **fail** | 428/431 = 0.993 **fail** | — | 0/114 (103 missing, 11 wrong) |
| 100k | semantic | 561/668 = 0.840 | 46/50 | 428/431 | — | 0/114: **terrain-unsupported** (112 wrong, 2 missing, 125 extra) |

Semantic routing totals:

- shared: index 395, none 141
- 100k: index 1400, none 34, pickBurg 4

The burg denominator is smaller here than in compact because materialized `<use>` glyphs sit above burg hits in SVG.

### Interpretation

- Every gate still fails or is under-covered, so the full 8-call picking matrix was **not** run.
- The shared world is under-covered: burg 4, label 27 and marker 21 samples, all below 50.
- Relief is not GPU-gated in either regime. Compact relief has no GPU index entries. Materialized relief is
  terrain-unsupported per instance.
- The label and burg errors are mismatches against SVG pointer semantics, which hit-test text by character cells. They
  were not diagnosed in this tranche.

## 5. Regression checks after the final changes

| Check | Artifact (`p1-delegated-…`) | Result | Baseline |
|---|---|---|---|
| unit | `1792170740529992000` | 622/622 pass, 61 files | — |
| build | `1792170767612424000` | pass. An earlier attempt, `1792170337118703000`, failed with TS2345 in `scene.test.ts`; fixed by typing the extras array | — |
| bench | `1792170738961616000` | 37/37 pass | — |
| context loss/restore (dpr 2) | `1792170620100245000` | failure null; restore drawn, lossToDraw 588 ms, failedPrepares 0; restored GPU 113,712,433 B; diff 0.16556 changed / 0.00994 over16 | about 597 ms restore; same restored total |
| lifecycle (forced GC, 21 cycles) | `1792170631509474000` | failure null; GPU total stable at 159,377,081 B; heapGrowth 42,398,696 B (about 36 MB at cycle 0→1, then about 0.29 MB/cycle) | 42,263,332 to 42,320,240 B; pre-existing and unresolved |
| smoke dpr 1 | `1792170715643700000` | 0.13608 changed / 0.00759 over16; compat 12/118 | 0.136 / 0.0076 |
| smoke dpr 2 | `1792170726547812000` | 0.16556 / 0.00994 | 0.166 / 0.0099 |

No 20-pair timing runs were made.

## 6. Raw attempt ledger

| Artifact | Outcome |
|---|---|
| `picking-1792166438724496000`, `picking-1792166642224377000` | compact, rejected by the earlier guard (pre-tranche) |
| `picking-1792166760543388000` | compact, valid, but predates the final gate flag fix |
| `picking-1792166825330413000`, `picking-1792167542975350000`, `picking-1792168279078159000` | materialized, never GPU-ready (diagnosed above) |
| `picking-1792170350342969000` | compact: 100k valid; shared rejected by the trade-orphan assertion |
| `picking-1792170421218809000` | materialized, both worlds valid and ready |
| `picking-1792170576861071000` | compact, both worlds valid (final code) |

## 7. Limitations

- The fix makes canonical materialized relief GPU-native. Non-canonical glyph sets still use the exact compat path, so a
  very large custom-styled `#terrain` could still be too slow to prepare. That case is not measured here.
- Selection of a materialized relief glyph is unsupported per instance: the GPU index is keyed by href.
- The duplicate `#tradeAnimation` container is an app bug. The bench works around it by freezing the orphans in SETUP;
  the app is not fixed.
- Burg, label and marker gates fail at 100k, and the shared world is under-covered. No rate in this report is an
  acceptance result.
- Lifecycle heap growth of about 42 MB is pre-existing and unchanged.

## 8. Next bounded work

1. Fix the duplicate `#tradeAnimation` container: have `load.ts` and `auto-update.ts` agree on a single container. Then
   drop the SETUP orphan removal, keeping the assertion.
2. Give the GPU pick index per-instance relief entries, keyed `href@x,y`, so materialized relief can be compared rather
   than reported as unsupported.
3. Diagnose the 100k burg mismatches (about 150 raw) and the 4 label mismatches against character-cell semantics.
4. Add a shared-world sampling plan that reaches 50 or more burg, label and marker samples before any matrix run.
