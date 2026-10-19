# P3 — G-P picking parity (pilot)

> **PROVISIONAL (2026-10-16): see [P3-PICKING-VALIDITY.md](P3-PICKING-VALIDITY.md).** These were protocol v1
> measurements. The oracle committed relief selections while sampling, and nothing guarded against the scene changing.
> The rates below are historical only and are not acceptance evidence. The text is unchanged.

**Verdict: G-P is NOT accepted.** The dpr 2 / zoom 2 pilot fails the burg, label and marker gates in both worlds.
Cells pass in both worlds. One coherent cause was fixed: compat-rasterized elements had no pick entries. That
moved 100k marker parity from 0% to 86% and burg from 59.5% to 81%, but every gated kind is still far below
99.5%. Per the tranche rule ("stop with baseline if far off"), I did not attempt further fixes, the
dpr × zoom matrix or the motion probe. The adapter is deferred. Nothing is shipped: deployment stays at
71dd4740-4b1b-4652-932c-d2855ce07fe8 (SVG by default, GPU opt-in). SceneDoc stays shadow and SVG stays canonical.

## Oracle

- **Expected selection:** `elementFromPoint` on the canonical SVG, run through the `clicked()` branch rules in
  branch order (labels, burgLabels/burgIcons, markers, rivers, routes, …). When no DOM branch matches, the
  `pickBurg` and then `pickRelief` fallback is evaluated at the viewbox CTM world point.
  Source: `bench/picking-oracle.ts` (`classifyClick`).
- **Actual selection:** `window.gpuPick(x, y, 0)` (SVG-local CSS px, tolerance 0). The hit id is resolved to its
  DOM element and normalised with the same branch rules (`normalizeGpu`). Hits on layers with no `clicked()`
  branch (regions, borders, zones, …) are reported as `non-selectable`. Ids that resolve to no DOM element (for
  example terrain `#relief-*` hrefs) are reported as `unresolved-id`.
- **Cells:** these use an independent CPU oracle. `findCell` at the GPU camera world point is compared with a
  brute-force nearest `pack.cells.p` at the SVG CTM world point. Samples within 1 px of a Voronoi bisector are
  "in band" and reported separately. The gate is 100% outside the band.
- **Gates:** burg, label and marker each need at least 50 meaningful samples and at least 99.5%, where
  rate = agree / (expected + extra + wrongInto). River and route are comparable but not gated. Relief, coastline
  and ice are reported only.

## Config

| | |
|---|---|
| Runner | `bench/picking-parity.ts` via `tupaia_checks check=picking` |
| dpr / zoom / phase | 2 / 2 / settled |
| Worlds | shared (`/tmp/tupaia-navigation-shared-v8.map`, sha256 f5c0d703…f5c0) and generated 100k (seed 7319, continents, 1280×720) |
| Sampling | 500 seeded uniform points (mulberry32; seeds 1022 / 2022) plus up to 150 targeted points per kind with ±2 px jitter |
| Network | local GET and fonts.gstatic GET only; service workers blocked; autosave 0; only blocked request was googletagmanager |
| Preconditions (both worlds, both runs) | GPU active, canvas visible, sourceCurrent, windows covered, not pending, not moving; oracle camera aligned with the exact SVG transform |

**Denominators (post-fix run):**
- shared: 536 samples (500 uniform + 36 targeted; the shared map has only 1 burg, 7 labels, 1 burg label and 9 markers to target), 2 outside the map.
- 100k: 1438 samples (500 uniform + 938 targeted), 1 outside the map.

The full JSON (schema 1) keeps every sample and every mismatch.

## Results

### Baseline (before any fix): `host-checks/picking-1792162275470685000.json`

| world | burg | label | marker | cells (out of band) |
|---|---|---|---|---|
| shared | 0/4 | 5/27 | 0/21 | 421/421 ✅ |
| 100k | 0/640 | 0/46 | 0/430 | 708/708 ✅ |

### Intermediate (fix #1 using `getCTM`): `host-checks/picking-1792162563467597000.json`

This run had markers at 0% because of the bug described under Cause 1. 100k results: burg 528/887, label 40/111,
marker 0/525.

### After fix #1: `host-checks/picking-1792162710965215000.json` (and `.log`)

| world | burg | label | marker | cells (out of band / in band) |
|---|---|---|---|---|
| shared | 2/4 = 50% ❌ (n<50) | 24/27 = 88.9% ❌ (n<50) | 21/22 = 95.5% ❌ (n<50) | 421/421 ✅ / 113/113 |
| 100k | 540/668 = 80.8% ❌ | 46/70 = 65.7% ❌ | 416/482 = 86.3% ❌ | 708/708 ✅ / 729/729 |

100k breakdown:

| kind | expected | agree | missing | wrong | extra | wrongInto |
|---|---|---|---|---|---|---|
| burg | 640 | 540 | 31 | 69 | 2 | 26 |
| label | 46 | 46 | 0 | 0 | 7 | 17 |
| marker | 430 | 416 | 1 | 13 | 6 | 46 |
| route | 41 | 33 | 2 | 6 | 0 | 26 |
| relief | 113 | 0 | 88 | 25 | 0 | 0 |
| coastline | 11 | 0 | 1 | 10 | 0 | 8 |

Raw-id agreement: 1048/1437 (100k) and 95/534 (shared). Mismatches: 261 (100k) and 110 (shared).

## Cause fixed (one)

**Cause 1: compat-rasterized world elements had no pick entries.** Markers (`<svg>`), text labels that fell back
from glyph layout, and restored burg vectors were all painted through the compat raster. None of them added
anything to `PickIndex`, so the GPU pick fell through to whatever native layer was underneath.

The fix is `src/gpu/compat-pick.ts` (`compatHits`), called from every world-space `compat()` path in
`src/gpu/prepare.ts`. The screen overlay is excluded. Each painted leaf adds a world-space box via
`PickIndex.addBox`, in DOM order so the last-inserted box stays topmost:
- Leaves are path, circle, ellipse, rect, line, polyline, polygon, text, use and image. Text covers its tspans.
- Leaves inside defs, clipPath, mask, pattern, symbol or marker are skipped.
- Leaves with pointer-events none, hidden visibility or display none are skipped.
- The box is the leaf's `getBBox()` mapped through viewbox screen CTM⁻¹ · leaf screen CTM.

`getScreenCTM` is required on both sides. The first attempt used `getCTM`, which stops at the nearest viewport
(the nested marker `<svg>`). That misplaced every marker box (markers at 0%, plus spurious marker hits over
burg labels).

`pickId` moved from prepare.ts to compat-pick.ts unchanged. This is picking-only; paint is unchanged.

Targeted tests are in `src/gpu/compat-pick.test.ts` (vitest, fake DOM):
- the camera cancels and a rotated camera inverts
- corner order
- marker `<svg>` leaves take the nearest id; text covers tspans
- a leaf element is its own hit; defs, empty and detached leaves are skipped
- the last box stays topmost in `PickIndex`
- no viewbox transform returns nothing
- `pickId` parent fallback

## Remaining causes (not fixed; each is a separate chunk)

1. **Bbox over-coverage.** A box hits where the SVG glyph or shape is transparent. Examples:
   - marker boxes over relief `<use>` or ocean
   - wide `stateLabel*` boxes over terrain
   - marker boxes over adjacent burg labels

   This accounts for most of the marker wrongInto (46), label extra/wrongInto (7/17) and burg wrong.
   The fix is real geometry instead of boxes: glyph quads from the text layout, and tessellated marker
   paths/circles.
2. **The GPU side does not apply the `clicked()` fallback.** When the GPU hit is non-selectable (regions,
   borders, zones) or unresolved, the SVG side may still resolve `pickBurg`/`pickRelief`. Many burg "missing"
   cases are `pickBurg` expectations under `stateBorders` or `regions`. An adapter that forwards to
   `clicked()` would apply this naturally. Changing the bench's GPU normalisation to model it must be done and
   disclosed as an oracle change, not a parity gain.
3. **Relief and terrain ids.** The native terrain layer reports `#relief-*` href ids, not elements, and the
   raster-cache terrain also loses per-`<use>` identity. Relief therefore scores 0/113 (reported only, but it
   also produces the "wrong" cases under labels and markers). This needs a per-`<use>` pick entry carrying the
   element identity.
4. **Paint order versus pick order across compat and native layers.** Examples: provinceBorders over marker
   circles; markers over burg labels at 0.1–0.2 px from edges. Some of these are in band and inherent to
   rasterization. Others need the pick order to match SVG document order exactly.
5. **Coastline and route `wrongInto`.** These come from stroke tolerance and width differences (route 26,
   coastline 8). They are not gated.

## Validation

- `check=unit`: 594/594 tests in 59 files pass, including `src/gpu/compat-pick.test.ts`.
- `check=build`: pass (`host-checks/p1-delegated-1792162666171104000.log`).
- Picking pilot, dpr 2 / zoom 2: ran with exit 0 and no failure; the gates fail as shown above.
- One GPU smoke per DPR, both exit 0, active, visible, current and covered. SVG-vs-GPU diff: changedFraction 0.136 /
  over16 0.0076 at dpr 1 and 0.166 / 0.0099 at dpr 2. I did not compare these against earlier smoke runs; the
  change does not touch paint code.
  - dpr 1: `host-checks/p1-delegated-1792162797652683000.json`
  - dpr 2: `host-checks/p1-delegated-1792162807452047000.json`
- **Not run:**
  - the dpr 1/2 × zoom 1/2/4/8 matrix and the dpr 2 / zoom 4 motion probe (the pilot is far off)
  - hatch, context and lifecycle (not required: the change is picking-only, no paint or resource changes)
- **Test wiring:** `bench/picking-oracle.test.ts` (node:test) is **not wired** into `check=bench`, which still
  runs the original 31 tests. Wiring it needs a test-config edit, which this tranche forbids. The 31 do not cover
  the oracle module.

## Limits

- Boxes are an approximation by design (see the header of `compat-pick.ts`). They cannot reach 99.5% for
  markers or labels.
- Prepare now calls `getBBox`/`getScreenCTM` per compat leaf. For the 100k world that is about 1,700 compat
  elements. I did not measure the cost separately; smoke prepare times stayed around 0.8–0.9 s.
- The shared world has too few burgs, markers and labels to reach n≥50. Its gates can only pass on 100k-style
  density or with more targeted sources.
- Tolerance is 0 on both sides. `elementFromPoint` hit-testing (including stroke hit areas) is compared with
  index geometry, not with pixels.

## Remaining SVG dependencies

Selection is still entirely SVG `elementFromPoint` plus `clicked()`. The GPU pick is not used by the editor; the
adapter is deferred and default OFF. The relief and burg fallbacks (`pickRelief`/`pickBurg`) are CPU and
data-based. Markers, text labels and restored burg vectors still render through the compat raster of SVG DOM.

## Next chunk

1. Glyph-quad and marker-geometry pick entries to replace boxes (remaining cause 1).
2. A disclosed oracle decision on modelling the GPU-side `clicked()` fallback (remaining cause 2), followed by a
   re-run of the pilot.
3. Per-`<use>` relief pick identity (remaining cause 3).
4. Only after the pilot passes: the full matrix, the motion probe, and then a query-flagged, default-OFF adapter.
