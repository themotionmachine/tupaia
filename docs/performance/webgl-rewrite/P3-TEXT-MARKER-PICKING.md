# P3 — TEXT and MARKER picking narrowphase

Status: **unshipped**. Production is unchanged; SVG remains the default and GPU stays opt-in. No deploy, UI adapter,
backend, format, dependency or network change. All of this measurement is Chrome only at dpr2 zoom2 in compact relief mode.

## Result in one line

Two geometric rules measured from Chrome are now applied in the GPU pick narrowphase. Marker semantic agreement on the
100k world went from 428/431 to **430/430 (pass)**. Burg semantic agreement went from 652/705 (92.5%) to
**680/685 (99.27%)**. That is still **below** the 99.5% gate. Every remaining burg miss is a `wrongInto` row whose expected
side is coastline, route or ice, which this task did not cover. Label agreement is 46/46, but n<50 makes it **insufficient**.

## Artifacts (`docs/performance/webgl-rewrite/host-checks/`)

| Step | Artifact |
|---|---|
| Baseline picking pilot | `picking-1792175410977475000.{json,log,diagnostics.json}` |
| Chrome band scan (diagnostics only, expected side) | `picking-1792175656404425000.*` |
| Fix A: pointer square on all text (rejected) | `picking-1792175924572570000.*` |
| Fix B: pointer square on axis-aligned text only | `picking-1792176064208006000.*` |
| **Fix C: Fix B plus 1/64 LayoutUnit snapping (final)** | `picking-1792176243757081000.*` |
| Unit: 653/653 pass (the earlier run with a bad test expectation is kept) | `p1-delegated-1792176183749355000.log` (failed: `p1-delegated-1792176176932231000.log`) |
| Build | `p1-delegated-1792176238935401000.log` |
| Bench: 38/38 pass | `p1-delegated-1792176292387433000.log` |

Each picking pilot used the same seeds and fixture (`mapSha256 f5c0d703…79f5c0`), with dpr 2, zoom 2, settled phase and
compact relief. Every final report has `failure: null`. The `.diagnostics.json` files are small (5 rows or fewer per
class) and are never used by any gate. The final one has **no** burg, marker or label mismatch rows.

## Root causes (measured in Chrome)

| Rule | Evidence | What was wrong before |
|---|---|---|
| **(a) Pointer square.** Chrome hit-tests an axis-aligned SVG glyph cell against a 1×1 CSS-px square whose top-left corner is the pointer. In practice, cells are hit up to 1 CSS px (`1/view.k` world units) to the **left and above** the pointer, with no inflation to the right or below. | Band scan `…5656404425000` stepped elementsFromPoint (expected side only) at 1/16 px. Hits extend exactly one CSS px to the left/top, and there are none to the right/bottom. burgLabel729 is the unit regression case. | The pick tested the point alone. Text and marker cells just right of or below the pointer were missed, or fell through to the burg or icon beneath. |
| **(b) Rotated glyphs hit by point only.** For textPath glyphs the hit is point containment only. | stateLabel4, row i=28 at world (702.994, 348.565), lies in the 0.2-unit gap between rotated cells 5 and 6. Chrome returns the ocean. | Fix A applied the square to every text cell. That produced 2 label `wrong` rows (stateLabel4/14) and 2 extra label `wrongInto`. |
| **(c) LayoutUnit snapping.** Chrome grows axis-aligned glyph boxes **outward** to the 1/64 grid in the text's local user space. | Row 326: burgLabel572, bottom 362.66 → 362.671875, which is ≥ the point y 362.67175. Expected 572; we returned 164. Row 1090: burgLabel1124, bottom 496.99 → 497.0, which is ≥ 496.99998. Expected 1124; we returned 843. | The reported `getExtentOfChar` cell ended about 0.01 units short, so the pick fell through to the label underneath. |

The *effects* are measured. The *mechanism* is inferred from Blink's `HitTestLocation`/`LayoutUnit` behaviour and was
not read from Chrome source in this task.

## Fix

- `src/gpu/pick.ts`
  - `HitShape.square` and `squareMeetsConvex` (a separating-axis test of the square against convex rings).
  - `pick`/`pickAll`/`inspect` take a `pixel` argument. For shapes with `square` set, the broadphase box is extended
    right/down by `pixel` only, and the narrowphase is the SAT test.
  - `renderer.pick()` passes `1 / view.k`.
- `src/gpu/compat-pick.ts`
  - `axisAligned(q)` and `layoutSnap(q)`. At prepare time, axis-aligned text cells are snapped outward to 1/64 in local
    user space *before* the element transform is applied.
  - `shape.square = cells.every(axisAligned)`, so textPath labels keep point hits.
- Unit regressions:
  - `src/gpu/pick.test.ts`: burgLabel729 square, and a rotated diamond with SAT.
  - `src/gpu/compat-pick.test.ts`:
    - text square on/off
    - 1/64 snapping, including the burgLabel572 row 326 point and a point 0.008 past the snapped edge that still misses
    - a 45° cell that is not inflated

The query path is purely geometric. It makes **no DOM reads** at pick time, and there is no hybrid DOM dependency. The
candidate never calls `elementFromPoint`, `elementsFromPoint` or `getIntersectionList`; global hit testing appears only on
the expected side and in the diagnostics band scan. Hidden, pointer-insensitive and clip semantics are unchanged.
Stale-target rejection, the source guard and the no-DOM-mutation/revision/layout guards are unchanged, and cleanup
still runs in `finally`. Paint and the DOM-ref cache lifetime were not touched, so smoke and lifecycle/context checks
were not rerun.

## Counts (100k world; raw and semantic are reported separately)

Semantic rows are `expected / agree / missing / wrong / extra / wrongInto`. The gate denominator is
agree / (expected + extra + wrongInto).

| Run | Burg (semantic) | Marker (semantic) | Label (semantic) | Burg (raw) | Raw total |
|---|---|---|---|---|---|
| Baseline | 652 agree; missing 2, wrong 26, wrongInto 25 → 652/705 = 92.5% fail | 428/431 (wrong 2, wrongInto 1) fail | wrongInto 2, n<50 | 559/698; missing 99, wrong 22, wrongInto 18 | — |
| Fix A | 678/687 = 98.69%; wrong 2, wrongInto 7 | 430/430 pass | wrong 2, wrongInto 2 (regression) | 585/682 | 1423/1437 |
| Fix B | 678/687 = 98.69%; wrong 2, wrongInto 7 | 430/430 pass | 46/46, n<50 | 585/682 | 1425/1437 |
| **Fix C** | **680/685 = 99.27%**; missing 0, wrong 0, extra 0, wrongInto 5 → **fail** | **430/430 pass** | 46/46, n<50 **insufficient** | 587/680; missing 93, wrong 0, wrongInto 0 | **1427/1437** |

Other classes in the Fix C semantic results were not in scope and were not changed by this work:

- coastline: 0/11, wrong 11, wrongInto 10
- route: 36/42, wrong 6, wrongInto 1
- ice: 0/1, wrong 1
- relief: 203/203, wrongInto 2

The raw relief rows are 0/203 missing in every run. This is expected, because relief is only resolved on the semantic
path.

On the shared world, raw agreement is 534/534. Burg (n=4), label (27/27) and marker (21/21) are all insufficient
(n<50). That world's semantic rows for ice (22 wrong) and relief (wrongInto 22) are pre-existing and unaffected.

The materialized-relief pilot was **not** run. The change only touches text/marker shape preparation and the shared
narrowphase, and the relief primitives are unchanged, so a materialized run would add no evidence about this fix.

## Latency

The picking harness does not record pick latency, so **nothing was measured**. By analysis:

- The query-time cost is one 4-axis SAT test per broadphase candidate that has `square` set, instead of a point-in-ring
  test.
- The broadphase box grows by one CSS px, so slightly more grid cells are visited.
- `layoutSnap` is a one-off cost per text cell at prepare time.
- The band scan and the native geometry reads in diagnostics run only in the diagnostics pass.

## Limitations

- Chrome only, at dpr2 zoom2. Other browsers, DPRs and zooms are untested; the square size should follow CSS px, but
  this has not been measured.
- The mechanism is inferred. Snapping of rotated cells to the 1/64 grid is unknown. Rotated cells are left unsnapped
  because no evidence row required snapping them.
- `renderer.pick()` still has **no revision check** (found in an earlier audit; not addressed here).
- The empty-href image box is suspected of being wrong but is unresolved.
- Burg semantic is still below the gate. The 5 remaining rows are coastline, route or ice points that the GPU index
  assigns to a burg.
- Label n<50 is insufficient evidence on both worlds.
- The earlier code audit ran as an `Explore` subagent, not natively on Haiku 5.5.

## Rejected / failed attempts (kept, not retried)

1. **Narrowphase with native `getCharNumAtPosition`.** It returns −1 at the disputed points, so it does not reproduce
   Chrome's hit test. It would also add a DOM read at query time.
2. **Pointer square on all text (Fix A).** It regressed textPath labels: stateLabel4/14 went wrong and label
   `wrongInto` rose by 2. Superseded by Fix B.
3. **Glyph cells from the bounding box instead of `getExtentOfChar`.** These are guessed extents, so they were rejected
   under the "correct narrowphase over inflated tolerance" rule.
4. In the first draft of the snapping unit test the expected value was wrong (`floor(0.02·64)/64 = 1/64`, not 0). The
   code was correct, and the test was fixed.

## Tradeoff

The two rules are small and purely geometric, and they close every source-proven text and marker mismatch the
harness found. The cost is that the GPU picker now copies one undocumented Chrome rendering detail: the 1/64 grid and
the left/top bias of the pointer square. If Chrome changes it, or if another engine handles it differently, these rows
will move. SVG mode is unaffected because it still uses native hit testing.
