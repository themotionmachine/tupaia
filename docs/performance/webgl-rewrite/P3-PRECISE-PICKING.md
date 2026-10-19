# P3 — Precise picking corrective tranche

> **PROVISIONAL (2026-10-16): see [P3-PICKING-VALIDITY.md](P3-PICKING-VALIDITY.md).** The protocol v1 runs cited below
> called the committing `pickRelief` for each sample. That rewrote `#terrain` and bumped the relief revision partway
> through sampling. Every rate here was measured on a scene that kept changing, so none of them are valid acceptance
> evidence. The text below is kept unchanged as the historical record.

Status: **G-P NOT accepted.** The dpr 2 / zoom 2 pilot is not strong: burg is 83.7% against the ≥99.5% gate. As the
protocol requires, the 8-call matrix and the motion probe were **not run**. No click adapter exists or was added.
Production is unchanged: P2 version `71dd4740-4b1b-4652-932c-d2855ce07fe8` keeps SVG as the default and GPU as opt-in.
All P3 edits are unshipped working-tree changes.

## 1. Sources and practice

- The SVG2 §15.6 `pointer-events` semantics (`visiblePainted`, `fill`, `stroke`, `none`, `bounding-box`) are already
  implemented by `sensitivity()` in `src/gpu/compat-pick.ts`. P3 reuses that function rather than adding a second
  interpretation.
- The application's selection semantics are `clicked()` in `public/modules/ui/editors.js:15-48`. It checks branches in a
  fixed order. When the target matches no branch, it falls back to the canvas functions `pickBurg` and then `pickRelief`.
- `index.css` sets `pointer-events: none` on these elements, so SVG hit testing falls through them: `t`, `#regions`,
  `#cults`, `#relig`, `#biomes`, `#provincesBody`, `#terrs`, `#tooltip`, `#temperature`, `#texture`, `#landmass`,
  `#vignette`, `#gridOverlay` and `#fogging`. Zones and borders are **not** listed; they remain hit-testable (the oracle
  observed raw id `zone14`).
- Common practice for GPU maps is CPU-side spatial picking: an index of the geometry that was painted, queried at the
  pointer position, with application semantics applied afterwards. The alternative, a GPU colour-id buffer, would need a
  readback per query and was not pursued.

## 2. The rejected glyph-ink hypothesis

The first hypothesis was that the label and burg misses came from text cells that were larger than the glyph ink, and
that ink-tight shapes would fix them. Two findings ruled it out:

- SVG `<text>` hit testing uses glyph cells (the character boxes), not ink.
- The misses traced to different causes: wrong cell clipping and display, no semantic selection layer, and layers that
  SVG never hits but the GPU index did.

Ink-precise text would therefore have made the parity **worse**. It was not implemented.

## 3. Method, one cause at a time

Each cause was run through unit → build → bench → the dpr 2 / zoom 2 pilot before the next one started. The oracle
(`bench/picking-oracle.ts`) and its normalization were **not changed**. The only change to the harness is measurement:
`bench/picking-parity.ts` gained `query` timing and `pickIndexBytes`.

| Cause | Change | Effect on the pilot |
|---|---|---|
| A | Text cells: glyph-cell boxes, clipping and `display` handling in the pick index | Improved the raw label and marker rates (earlier pilots) |
| B | Semantic selection pipeline: `src/gpu/selection.ts` `selectAt()` / `classifyElement()`, mirroring `clicked()` plus the `pickBurg`/`pickRelief` fallbacks at the GPU camera's world point | Introduced the semantic rate alongside the raw rate |
| C | `prepare.ts` cachedPaths branch: one image-rect `addBox` when computed `pointerEvents !== "none"`, replacing per-path fills and strokes | **No pilot effect.** It only touches biomes and heights. It is kept and disclosed here. |
| D | `prepare.ts` shape branch: computed style is read once per element at prepare time, and only the regions `sensitivity()` admits are indexed (`addFill` if `fill`, `addStroke` if `stroke`) | All `layer:"regions"` hits disappeared, but the gates did not change: the GPU raw hit at those points became `terrain`, which exposed cause E |
| E | `selectAt()`: a native relief hit (terrain layer, no DOM element) becomes the terrain branch before `pickBurg`, with the `<use>` taken from `pickRelief` when it is available | Burg semantic moved from 588/705 to 561/670; shared burg moved from 3/4 to 2/4 |

Artifacts, in chronological order, are in `host-checks/`:

- Pilots for A–C: `picking-1792162275470685000`, `…2563467597000`, `…2710965215000`, `…3874959583000`,
  `…4219466505000` and `…4576533560000`.
- Cause D:
  - unit 605/605: `p1-delegated-1792164764882874000.log`
  - build: `…1792164769727501000.log`
  - bench 37/37: `…1792164774571835000.log`
  - pilot: `picking-1792164777526974000.json`
- Cause E:
  - unit 606/606: `p1-delegated-1792164896281156000.log`
  - build: `…1792164900637037000.log`
  - bench 37/37: `…1792164905104396000.log`
  - pilot: `picking-1792164908292119000.json` (failure null)
- Measurement run (same code plus timing): `picking-1792165030831536000.json` (failure null; gates identical to E).

### DOM dependencies (candidate side)

The candidate never uses `elementFromPoint`, `elementsFromPoint` or `getIntersectionList`. Those calls appear only in the
oracle. The candidate does depend on the DOM in these ways:

- `getComputedStyle` per shape element, at **prepare time only**. Style changes after prepare are only seen on the next
  prepare, which every `@style`/`@class` revision triggers.
- `getElementById` at select time, to resolve the id of the index hit to an element for classification.
- The page functions `pickBurg` and `pickRelief`, which are the same canvas fallbacks `clicked()` uses.

## 4. Raw vs semantic rates (final code, cause E / measurement run)

**Raw** compares the index hit with the oracle's SVG target. **Semantic** compares the `selectAt()` result with the
selection the oracle derives from `clicked()`.

| Fixture | Gate | burg | label | marker | cells (outside the 1 px band) |
|---|---|---|---|---|---|
| 100k | raw | 559/668 = 83.68% | 46/50 = 92.0% | 428/431 = 99.30% | 708/708 = 100% |
| 100k | semantic | 561/670 = 83.73% | 46/50 = 92.0% | 428/431 = 99.30% | — |
| shared | raw | 2/4 | 27/27 | 21/21 | 421/421 = 100% |
| shared | semantic | 2/4 | 27/27 | 21/21 | — |

Against the gates (≥99.5% with n ≥ 50 for each kind):

- 100k burg **fails**.
- 100k label **fails** (n = 50, 92%).
- 100k marker **fails** (99.30%).
- Every shared kind has n < 50, so none of them can pass.
- Cells pass on both fixtures.

### Relief (not gated)

Relief is outside COMPARABLE/GATED (`picking-oracle.ts:103-106`). Agreement is kind-level only: the oracle's relief id
is `""`, so matching ids are vacuous.

| Fixture | agree | missing | wrong | extra | wrongInto |
|---|---|---|---|---|---|
| 100k | 100/113 | 2 | 11 | 125 | 33 |
| shared | 101/103 | — | — | 237 | — |

**New false positives:** the 125 (100k) and 237 (shared) relief "extras" come from causes D and E. The GPU indexes each
relief sprite as its full square (`addBox`), while SVG only hits the painted symbol pixels.

## 5. All mismatches (preserved, 100k burg unless stated)

- **Dominant: relief over pickBurg.** SVG falls through a transparent part of a relief sprite to `pickBurg`, but the GPU
  hits the sprite's full box and selects relief. This is cause F, precise relief symbol geometry, which is **not done**.
- **burgLabel stacking or overlap.** Expected → got: 729 → burgLabel786, 574 → 265, 633 → 25, 572 → 164, 1256 → 717,
  937 → 1224, 460 → 290.
- **stateLabel over burgLabel:** 659 → stateLabel11, 275 → stateLabel3, 581 → stateLabel12.
- **Routes over burg:** 694 → route47, 460 → route37, 1063 → route242, 828 → route697.
- **Missing GPU label cells:** `oceanPattern` was returned at burgLabel points (10, 722).
- **Label and marker:** the 4 label and 3 marker misses on 100k carry over from the earlier pilots and remain
  unattributed beyond overlap.
- **Shared burg:** 2 of 4 missed, from the same relief-box mechanism. Cause E cost one (3/4 → 2/4).

Branch counts from the measurement run:

| Fixture | gpuUnresolvedIds | SVG branches |
|---|---|---|
| shared | 340 | none 374, terrain 102, labels 27, markers 21, burgLabels 2, pickBurg 2, rivers 2, routes 2, outside-map 2, pickRelief 1, ice 1 |
| 100k | 258 | burgLabels 587, markers 430, none 156, terrain 113, pickBurg 53, labels 46, routes 41, coastline 11, outside-map 1 |

## 6. Source state, tests and audits

Source changes, all unshipped:

- `src/gpu/compat-pick.ts`: `sensitivity` is exported.
- `src/gpu/prepare.ts`: causes C and D.
- `src/gpu/selection.ts`: causes B and E. Its header says it is not wired to clicks.
- `src/gpu/selection.test.ts`: 7 tests, including the terrain-branch test (with a bare case) and the pickRelief bridge.
- `bench/picking-parity.ts`: measurement only.

Final checks: unit 606/606, build OK, bench 37/37.

**Correction:** `P3-PICKING-PARITY.md` says the picking bench is "not wired". That is outdated; the bench runs 37 tests,
including the picking oracle tests.

**Second Haiku audit** (native Haiku 5.5, read-only):

- **Independence.** `selection.ts` imports only the `PickHit` type. There are no shared bench imports. The oracle uses
  `elementFromPoint`; the candidate uses `getElementById` on the index hit.
- **Shared by construction.** The `pickBurg`/`pickRelief` legs are the same page functions on both sides, so agreement
  that comes from a fallback proves little.
- **Branch-order divergence.** `classifyElement` checks ancestry with `within()`, in an order that differs from
  `clicked()`. It has **no markets/goods branches**, while the oracle emits market/goods.
- **Terrain rule.** It returns relief even when `pickRelief` is absent, and it skips `pickBurg`. The audit calls this "a
  rule of the harness". My assessment: it models `clicked()`'s terrain branch. `clicked()` opens `editReliefIcon` on the
  target and does not call `pickRelief`, so the bridge is an approximation of the target `<use>`.
- **Gating gaps.** Gating happens at prepare time only. `bounding-box` (`box: true`) is not consumed on the shape path,
  so those elements are dropped. The cachedPaths branch checks only `pointerEvents !== "none"` and ignores visibility and
  bounding-box. Inherited visibility is handled through computed style.

## 7. Measurements

**Query latency** (harness `performance.now()` around `gpuPick` / `gpuSelect`; the browser coarsens timer resolution,
so sub-ms figures are quantized):

| Fixture | samples | pick p50 / p95 / max (ms) | select p50 / p95 / max (ms) | PickIndex bytes |
|---|---|---|---|---|
| shared | 536 | 0.2 / 0.3 / 1 | 0.5 / 0.7 / 2 | 2,983,116 (≈2.85 MiB) |
| 100k | 1438 | 0.4 / 0.6 / 7 | 0.5 / 1.5 / 2 | 6,166,776 (≈5.88 MiB) |

**Smoke** (painting is unchanged; one run per DPR, compared with the baseline over16):

| DPR | changed | over16 | baseline | Artifact |
|---|---|---|---|---|
| 1 | 0.1361 | 0.00759 | 0.136 / 0.0076 | `p1-delegated-1792165104548654000` |
| 2 | 0.1656 | 0.00994 | 0.166 / 0.0099 | `p1-delegated-1792165158803386000` |

Both runs match the baseline. Tracked GPU memory was 124.4 MiB at dpr 1 and 152.0 MiB at dpr 2, against the 160 MiB
budget. Tracked CPU was 18.8 MiB. These figures cover painting resources, which P3 did not change.

**Heap:** no new heap run was made. The PickIndex itself is 2.85 MiB on shared and 5.88 MiB on 100k. Cause D indexes
less geometry than before (filled regions are no longer indexed), so it should not grow the 38.7 MB heap, but this is
**unverified**.

**Lifecycle/context:** not run, because no resource lifetimes changed.

## 8. Pass/fail and gaps

| Item | Result |
|---|---|
| burg ≥99.5% (n ≥ 50) | **FAIL** (83.7%) |
| label ≥99.5% (n ≥ 50) | **FAIL** (92.0%) |
| marker ≥99.5% (n ≥ 50) | **FAIL** (99.30%) |
| cells 100% outside the 1 px band | PASS (both fixtures) |
| shared fixture coverage n ≥ 50 per kind | **FAIL** (burg 4, label 27, marker 21) |
| 8-call matrix and motion probe | not run (pilot not strong) |
| G-P | **not accepted** |

Gaps:

1. Relief hit shapes are full sprite boxes instead of painted symbol pixels. This drives most burg misses and all
   relief extras.
2. Stacking order among burg labels, and state labels and routes drawn over burgs.
3. Missing GPU cells for some burg labels (`oceanPattern` was returned instead).
4. No markets/goods branches in `classifyElement`.
5. `bounding-box` pointer-events is not consumed on the shape path. The cachedPaths gating is partial.
6. The shared fixture has too few burg, label and marker samples for any gate (n < 50).
7. Fallback-derived agreement is shared by construction and is weak evidence.

## 9. Next bounded chunk

1. **Precise relief hit shapes (cause F).** Index each relief `<use>` by its symbol's painted geometry (or an alpha
   mask of the rasterized symbol) instead of `addBox`. Then rerun unit → build → bench → pilot, expecting most burg
   misses and the relief extras to clear.
2. **Label stacking.** Make PickIndex insertion order follow the document order of burg labels, state labels and
   routes, and find out why the GPU has no cells for some burg labels.
3. Add markets/goods branches, and handle `bounding-box`.
4. Densify the shared fixture so that each gated kind reaches n ≥ 50.

The 8-call matrix and motion probe should only be considered after those steps. The click adapter stays out of scope
until G-P is accepted, and must be default-off when it comes.
