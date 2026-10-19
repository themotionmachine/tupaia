# P3 dense selection: relief subset, diagnostics and the remaining dense burg/label/marker classes

Status: P3 is unshipped. SVG is still the default and production P2 is untouched. This doc does not change any gate, threshold, oracle, seed or sample set. Both pilots below still **fail** the dense burg and marker gates.

## 1. Corrections to earlier docs

- **Frozen count.** 620/712 was the frozen **compact** semantic burg figure, not the materialized one. The previous materialized figure was 561/668. `P3-TRADE-AND-PICKING-VERIFICATION.md` §6 has been corrected.
- **Export policy.** This supersedes §2 of the verification doc. `src/io/export.ts` calls `stripCloneCaravans(cloneEl, type)`, which removes caravans only when `type === 'gpu'` (the GPU renderer's clone). User svg/png/jpeg/mesh exports keep their caravans. Tests are in `draw-trade-animation.test.ts`.

## 2. Failure classes and source evidence

Source: the semantic mismatch listings in the materialized 100k pilot (`picking-1792174540906675000.json`). The compact pilot shows the same classes.

| Class | Example rows (SVG expected → GPU) | Evidence | Status |
|---|---|---|---|
| A. Raw burg "missing" via canvas fallback | 56 raw missing (materialized) / 99 (compact) → 4 / 2 semantic missing | The SVG expectation is reached through `pickBurg`, so it has no index element; raw `gpuPick` cannot produce it by design (`selection.ts` fallback leg). | Routing difference. Fully explained, not a defect. |
| B. Burg label → a *later* burg label | burgLabel729→786, 574→265, 633→25, 1256→717, 1244→1199 (twice), 1124→843, … (most of the 24 wrong) | Every GPU hit is a labels-layer entry with a higher index order than the label Chrome reports. `compatShapes` inserts in DOM order, so the topmost GPU cell is the later label. In those cases Chrome's text hit area for the later label does **not** cover the point, but our `textCells` box (advance × ascent/descent, `compat-pick.ts:143-199`) does. | **Unresolved.** It is consistent with our character cells being larger than, or offset from, Chrome's text hit geometry. No line of source proves it, so no change was made. |
| C. Burg label → nothing / below | burgLabel817, 1155, 10, 722 → `oceanPattern` (missing); 659→stateLabel11, 275→stateLabel3; 460→route37, 1047→route1, 202→route705; 362→relief deciduous-2 | The burg label is absent from the GPU stack at a point Chrome attributes to it. This is the same geometry gap as B, but in the other direction. | **Unresolved**, same hypothesis as B. |
| D. Burg label → pickBurg neighbour | burgLabel459 → zone7 raw → `pickBurg` 1157 | The GPU index has no label cell there, so the fallback runs and finds a different burg. | A consequence of C. |
| E. Marker | marker281 → burgLabel3; marker256 → marker141 | 2 wrong, 1 wrongInto. Markers sit above labels in index order (marker141 at 39881 > burgLabel3 at 39159), so marker281's GPU hit area must be missing at that point. | **Unresolved.** Marker geometry versus Chrome's has not been inspected. |

**No B/C/D/E change was made.** None of these classes has a source-level cause yet, and the constraints rule out tolerance inflation, expected-matching and jittered duplicates. The next step is measurement, not more pilots (§7).

## 3. Changes in this phase

- **`src/gpu/relief-pick.ts`.** `readGlyphReport` flattens a symbol's subtree into hit primitives:
  - **Nested plain `<g>`.** Inherited paint and pointer properties resolve through the first of `[node, ...ancestors, symbol]` that sets them. Otherwise they come from the computed style of `#terrain` (the `<use>` shadow-tree inheritance).
  - **Affine transforms.** `parseTransform` handles matrix, translate, scale, rotate (with cx/cy), skewX and skewY on leaves and groups, composed left to right (`multiplyAffine`). Anything it can't parse is rejected, never ignored.
  - **Strokes.** A stroke is accepted only under a similarity transform, with half-width scaled by the uniform factor.
  - **Viewport.** `<use>` viewBox / xMidYMid-meet placement, clipped exactly at the viewport.
- **Pointer semantics.** `visiblePainted`-style pointer-events, visibility and display are honoured per leaf. Bounding-box pointer-events is unsupported (§4).
- **`src/gpu/prepare.ts`.** `Prepared.relief.support: Map<href, {reason, instances}>`. Materialized instances are indexed with `addInstance(..., glyph ? narrow : null)`, so the instance index k is kept even when the href is unsupported. Topmost order is DOM order.
- **`src/gpu/renderer.ts`.**
  - `glyphAt` returns null for unsupported hrefs.
  - `glyphInfo(hit)` returns `{index, href, reason}`.
  - `reliefSupport()` returns `[href, reason, instances][]`.
  - `gpuSelect` passes `glyphInfo` through.
  - **Fix after the pilots:** `glyphInfo` used `reason ?? "unread"`, which reported *supported* hrefs (reason null) as `"unread"`. It now returns `"unread"` only when the href has no support entry. The materialized pilot artifact predates the fix, so its burgLabel362 row shows `reason:"unread"` for deciduous-2, which `reliefSupport` lists as supported (null). This was diagnostic only: that row's selection resolved through the `terrain` branch to the live `<use>`.
- **`src/gpu/selection.ts`.** `GpuSelection.glyph` (diagnostic only; it never decides the selection) is attached to both the `terrain` and `terrain-unsupported` returns.
- **`bench/picking-parity.ts`.** Semantic rows carry `glyph`, and each world's `query` carries `reliefSupport`.
- **Tests:**
  - `relief-pick.test.ts`: parseTransform composition and rejection; mirrored-matrix rect; nested groups with translate/scale and fill inheritance, including a sibling that inherits `fill:none` and is not hit; stroke under `scale(2)`; unsupported reasons.
  - `selection.test.ts`: glyph diagnostics leave the outcome unchanged.

## 4. Unsupported fallbacks (exact)

Any href whose symbol hits one of the reasons below is indexed as its box with a null narrowphase. A hit on it returns `branch: "terrain-unsupported"` with `target: null` and `glyph: {index, href, reason}`. It is never a transparent passthrough and never handed the group as target.

- **Per element:**
  - `element <tag>`: any tag other than `g`, path/rect/circle/ellipse/line/polyline/polygon, including a nested `<use>`
  - `${attr} on <tag>`: marker-start/mid/end, marker, clip-path, mask, filter
  - `currentColor/inherit on <tag>`
  - `css transform on <tag>`
  - `unparsed transform on <tag>`
  - `vector-effect on <tag>`
  - `bounding-box pointer-events on <tag>`
  - `unparsed stroke-dasharray on <tag>`
  - `stroke under non-uniform transform on <tag>`
- **Per symbol:** `no-view`, `no-symbol`, `symbol-viewport-attributes`, `preserveAspectRatio`, `viewBox`, `currentColor/inherit on <symbol>`.

**Support in the pilot map.** All 29 hrefs present in the shared world, and all 28 in the 100k world, report reason `null`, so every instance in both worlds is narrowphased. Instance counts per href are in `query.reliefSupport`. Two examples:
- shared: grass-2 7379, acacia-2 5898, swamp-2 1051
- 100k: grass-2 11987, deciduous-2 7210, swamp-2 770

swamp-2/3 (matrix transforms) and deciduous-2 (nested groups) were the previously unsupported families.

## 5. Fresh counts (seed 7319, map sha256 `f5c0d703e4a2…`, dpr 2, zoom 2, settled)

Gate: rate = agree / (expected + extra + wrongInto). A pass needs n ≥ 50 and rate ≥ 99.5%. Relief is not gated.

**Compact relief caveat.** Compact relief agreement goes through the `pickRelief`/`peekRelief` CPU fallback. It is **routing evidence only**, not GPU geometry parity.

### Materialized (`picking-1792174540906675000.json`)

| World | Kind | Raw agree/denom (exp, miss, wrong, extra, wrongInto) | Semantic agree/denom (exp, miss, wrong, extra, wrongInto) |
|---|---|---|---|
| shared | burg | 2/4 insufficient (4, 2, 0, 0, 0) | 4/4 insufficient (4, 0, 0, 0, 0) |
| shared | label | 27/27 insufficient | 27/27 insufficient |
| shared | marker | 21/21 insufficient | 21/21 insufficient |
| shared | relief | 0/102 (raw ids cannot express glyph keys) | 102/102, extra 1, wrongInto 0 |
| shared | cells | 421/421 pass | — |
| 100k | burg | 559/656 **fail** (638, 56, 23, 0, 18) | 610/658 = 92.7% **fail** (638, 4, 24, 0, 20) |
| 100k | label | 46/48 insufficient (46, 0, 0, 0, 2) | 46/48 insufficient (46, 0, 0, 0, 2) |
| 100k | marker | 428/431 = 99.30% **fail** (430, 0, 2, 0, 1) | 428/431 **fail** (430, 0, 2, 0, 1) |
| 100k | relief | 0/114 | 113/114 materialized geometry: miss 1, wrongInto 6 |

Semantic via (100k): index 1223, none 162, pickBurg 53. Shared: none 377, index 157, pickBurg 2.

### Compact (`picking-1792174619878292000.json`)

| World | Kind | Raw | Semantic |
|---|---|---|---|
| shared | burg / label / marker | 2/4, 27/27, 21/21, all insufficient | 4/4, 27/27, 21/21, all insufficient |
| shared | relief (CPU fallback) | 0/346 missing | 346/346, extra 2, wrongInto 22 |
| 100k | burg | 559/698 = 80.1% **fail** (680, 99, 22, 0, 18) | 652/705 = 92.5% **fail** (680, 2, 26, 0, 25) |
| 100k | label | 46/48 insufficient | 46/48 insufficient |
| 100k | marker | 428/431 **fail** | 428/431 **fail** |
| 100k | relief (CPU fallback) | 0/203 missing | 203/203, wrongInto 4 |
| both | cells | shared 421/421, 100k 708/708 pass | — |

## 6. Query cost (ms, in-page, settled)

| Run | World | pickMs p50 / p95 / max | selectMs p50 / p95 / max | pickIndexBytes |
|---|---|---|---|---|
| materialized | shared | 0.4 / 0.6 / 2.2 | 1.1 / 1.5 / 2.2 | 2,983,116 |
| materialized | 100k | 1.0 / 1.5 / 2.3 | 1.0 / 2.8 / 4.8 | 6,166,776 |
| compact | shared | 0.3 / 0.4 / 1.5 | 0.3 / 0.5 / 9.7 | 1,218,372 |
| compact | 100k | 0.7 / 1.0 / 2.6 | 0.7 / 1.0 / 12.9 | 3,655,368 |

The compact selectMs max values come from the CPU fallback legs.

## 7. Check artifacts (`docs/performance/webgl-rewrite/host-checks/`)

| Check | Artifact | Result |
|---|---|---|
| unit, before the pilots | `p1-delegated-1792174514882654000` | 63 files / 649 tests pass |
| build | `p1-delegated-1792174530869202000` | OK |
| bench | `p1-delegated-1792174536742076000` | 37/37 |
| smoke dpr 1 | `p1-delegated-1792174664638285000` | failure null, errors [], over16 0.76%, markers 30 |
| smoke dpr 2 | `p1-delegated-1792174674577258000` | failure null, over16 0.99%, peak memory 159 MB of the 168 MB budget |
| picking, materialized | `picking-1792174540906675000.json` (+ partial `.summary.md`) | failure null, both worlds valid |
| picking, compact | `picking-1792174619878292000.json` (+ partial `.summary.md`) | failure null, both worlds valid |
| unit, after the `glyphInfo` fix | `p1-delegated-1792174816736977000` | 649/649 pass |
| build, after the `glyphInfo` fix | `p1-delegated-1792174827186178000` | OK |

The pilots were not rerun after the `glyphInfo` fix, which only affects a diagnostic field. Context/lifecycle checks were not run, since resource lifetime is unchanged.

The `.summary.md` files were written without jq or a shell and are partial. The tables in §5 come from targeted Grep over the JSON.

## 8. Remaining work

1. **Classes B/C (burg label text geometry).** For a handful of the listed rows, dump our `textCells` boxes next to Chrome's per-character extents in the same page. Candidates to look at:
   - letter-spacing and font-size inheritance from `#burgLabels > g`
   - `dy`/baseline handling
   - tspan offsets

   Fix only a demonstrated geometry difference, then rerun **one** pilot. Burg is far from 99.5% (≈92.5–92.7% semantic). The 20–25 wrongInto entries come mostly from label-on-label overlap.
2. **Class E (markers).** Two rows need inspection of the marker hit shape against Chrome's. The marker gate is 3 samples short of passing.
3. **Materialized relief.** There are 6 wrongInto and 1 missing in 100k. Those rows have not been listed yet (one is burgLabel362 → deciduous-2, class C). Inspect them with the `glyph` diagnostics on a fresh run, where the reason field is now correct.
4. **Deferred until the gates are strong:** the 8-matrix runs and the 20 timing pairs.
