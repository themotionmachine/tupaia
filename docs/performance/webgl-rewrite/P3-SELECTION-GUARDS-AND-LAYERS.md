# P3 selection guards and canonical layers

Status: unshipped P3 work. Production P2 keeps SVG as the default. The legacy SVG `clicked()` path, the UI click adapter,
deploy, the default flip, dependencies and the backend are all untouched. Chrome only.

## Source-proven fixes

1. **Ice and coastline identity for anonymous leaves.** Ice shapes and the `sea_island` coastline paths have no `id`.
   The index used to attribute them to their parent group, so they fell into the wrong branch or were absent.
   - `PickHit.depth` / `HitShape.depth` now record how many levels the leaf sits below its `[id]` ancestor
     (`src/gpu/pick.ts`, `src/gpu/compat-pick.ts` `pickDepth`, `src/gpu/scene.ts` Draw `d`).
   - `classifyElement(element, depth)` (`src/gpu/selection.ts`) and `normalizeGpu(desc, id, depth)`
     (`bench/picking-oracle.ts`) decide the branch from the leaf's position. A leaf with depth > 0 returns `target: null`
     rather than the ancestor element.
   - Result: shared ice went from 0/22 (wrong branch) to 22/22, and coastline from 0/11 to 10/11.
2. **Fine undashed hit geometry.** Undashed strokes and fills now use fine hit rings (`PICK_TOLERANCE` 0.01), not the
   0.2 paint chords. The 0.2 chord error is comparable to a thin route's half width.
3. **Dashed strokes keep the paint chords** (`strokeHitRings`, `src/gpu/compat-pick.ts`; used by `src/gpu/prepare.ts`).
   - An intermediate attempt flattened dashed strokes finely too (`picking-1792177447225470000`). Compact burg fell to
     670/681, with 10 burg→route over-claims.
   - Row i=534: route242 at distance 0.051 from the route end, half width 0.25, dashes 1.4/1.1, butt cap. The GPU said
     route; SVG said ocean.
   - With the exact arc length, the dash gaps at route ends moved. Chrome measures the dash phase along a chordal
     approximation. This is recalled from Skia's `SkContourMeasure` with CHEAP_DIST_LIMIT 0.5/resScale; it is **not
     verified here**.
   - Keeping paint chords for dashed strokes restored 680/685. My earlier code comment claiming that fine flattening
     fixes the dash phase was wrong and has been replaced.
4. **Fail-closed availability guard.** See the next section.

## Availability contract (`src/gpu/renderer.ts`)

`renderer.pick()` used to have no revision check. `pickStatus()` now returns `null` (available) or a reason string.

**Pending mutations.** It first drains `observer.takeRecords()` through `mutated()`, so a same-task DOM mutation whose
MutationObserver callback hasn't run yet still bumps the revision.

It then checks, in order:

| Status | Condition |
|---|---|
| `disposed` | the renderer has been disposed |
| `context lost` | the GPU context is lost |
| `not prepared` | there is no prepared frame |
| `source replaced` | the bound SVG is no longer `#map` (world replace) |
| `stale revision a < b` | the prepared frame's revision is behind the DOM revision (includes in-flight prepare) |
| `suspended: …` | an editor dialog is live (`editorReason`) |
| `overlay refresh pending` | overlay jobs are queued or running |

Behaviour:
- `pick()` and `worldAt()` return nothing when unavailable.
- `selectAt` returns `branch: "unavailable"` with no pick, no `pickBurg` and no `peekRelief` fallback.
- A legitimate empty hit on an **available** index still routes to `pickBurg`, then `peekRelief`, as in `clicked()`.
- A stale DOM target is never routed.

Deliberately **not** guarded:
- **Camera motion.** The index is in world space, and a cached unchanged scene is valid under any world transform,
  because the query is inverse-transformed through the current transform.
- **Bitmap-window coverage.** The windows only crop paint, not the index.

Queries do no whole-SVG scan and no per-frame DOM reads. The only per-query DOM read is the dialog check described
under Timing.

Tests: `selection.test.ts` covers unavailable → no fallback and available-empty → fallback.
`compat-pick.test.ts`, `pick.test.ts` and `picking-oracle.test.ts` cover depth, fine undashed and dashed paint rings.
Lifecycle and context browser checks passed after the guard (see Checks).

## Fresh counts

All runs use the frozen seeds and guard; the code is final.
- **Raw** is the index's top hit alone. By design it has no CPU burg/relief fallback, so raw relief at 0 is expected.
- **Semantic** is `selectAt`. Where its result comes from the fallback, that is same-function evidence only.
- Gates are for burg, label and marker: n ≥ 50 and ≥ 99.5%, with rate = agree / (expected + extra + wrongInto).

### Compact, DPR2 zoom2 — `picking-1792177673377074000.json` (failure null)

Shared world, semantic (all gated kinds insufficient, n < 50):

| Kind | Agree | Note |
|---|---|---|
| ice | 22/22 | |
| label | 27/27 | |
| marker | 21/21 | |
| burg | 4/4 | |
| relief | 346/346 | extra 2 |

100k world:

| Kind | Raw | Semantic |
|---|---|---|
| marker | 430/430 **pass** | 430/430 **pass** |
| burg | 587/680 (missing 93), fail | 680/685 = 99.27%, **fail** (wrongInto 5) |
| label | 46/46, insufficient | 46/46, insufficient |
| coastline | 10/11 (missing 1) | 10/11 (wrong 1) |
| route | 36/42 (missing 5, wrong 1, wrongInto 1) | 36/42 (wrong 6, wrongInto 1) |
| relief | 0/203 (by design) | 203/203 (wrongInto 1) |

The five burg wrongInto rows are burg-centre samples exactly on the terminal vertices of dashed routes (route931,
route134, route989; distance 0, butt cap). SVG says route; the GPU misses the dash and falls back to `pickBurg`.
One further route row is route69 → route45.

### Materialized, DPR2 zoom2 — `picking-1792177805387374000.json` (failure null)

Shared world, semantic: relief 102/102 (extra 1), label 27/27, marker 21/21, burg 4/4, ice 1/1.

100k world:

| Kind | Raw | Semantic |
|---|---|---|
| marker | 430/430 **pass** | 430/430 **pass** |
| burg | 587/638, fail | 638/639 = 99.84% **pass** (wrongInto 1) |
| label | 46/46, insufficient | 46/46, insufficient |
| relief | — | 113/114 (missing 1, wrongInto 5) |
| coastline | — | 10/11 (wrong 1) |
| route | — | 36/42 (wrong 6, wrongInto 1) |

### Scale spot-checks (diagnostic only, not the acceptance matrix)

**DPR1 zoom2 compact** — `picking-1792177906419594000.json` (failure null)

Shared world, semantic: label 28/28, marker 19/19, burg 6/6, ice 26/26, relief 351/351 (extra 1); all insufficient.

100k world:

| Kind | Raw | Semantic |
|---|---|---|
| label | 57/57 **pass** | 57/57 **pass** |
| marker | 418/418 pass | 418/418 **pass** |
| burg | 610/701, fail | 698/705 = 99.01% **fail** (wrong 1, extra 1, wrongInto 5) |
| relief | — | 179/179 (extra 1) |
| coastline | 10/10 | 10/10 |
| ice | 4/4 | 4/4 |
| river | 11/11 | — |
| route | 23/28 (missing 4, wrong 1) | 23/28 (wrong 5, wrongInto 1) |

The semantic burg failures are the same dashed-route-end class (route931, route608, route709, route989,
route690 → route687) plus one burg 279 → 72.

**DPR2 zoom4 compact** — `picking-1792177960873780000.json` (failure null)

Shared world, semantic (all insufficient):

| Kind | Agree | Note |
|---|---|---|
| label | 17/17 | |
| marker | 9/9 | |
| burg | 14/14 | |
| ice | 15/15 | |
| river | 11/11 | |
| relief | 406/406 | extra 3, wrongInto 1 |
| route | 2/3 | wrong 1 |

100k world:

| Kind | Raw | Semantic |
|---|---|---|
| label | 37/37, insufficient | 37/37, insufficient |
| marker | 95/97 = 97.9%, **fail** (extra 2) | 95/97 = 97.9%, **fail** (extra 2) |
| burg | 417/508, fail | 508/512 = 99.22%, **fail** (wrongInto 4) |
| coastline | 25/25 | 25/25 |
| river | 10/10 | 10/10 |
| route | 27/33 (missing 4, wrong 2, wrongInto 3) | 27/33 (wrong 6, wrongInto 3) |
| relief | — | 243/244 (wrong 1) |

### Scale reading

**The text square holds** in every run that measured it, with no wrong or extra label:
- DPR1 zoom2: 57/57, which passes its gate.
- DPR2 zoom2: 46/46.
- DPR2 zoom4: 37/37.

The support is still restricted to **unrotated text** with a 1 CSS px pointer square and 1/64 local snap. Zoom4 and
DPR1 do not prove it for rotated or curved labels beyond those sampled. Labels below n = 50 stay insufficient.

**Markers regress at zoom4:** there are 2 marker extras, where the GPU claims a marker and SVG does not. They are not
diagnosed in this job. Treat marker as **unqualified at zoom4** until they are root-caused; thresholds were not retuned.

**Burg at every scale** has the same residual class: the dash phase on dashed-route terminal vertices.

## Timing

`pickMs` and `selectMs` are **still recorded**, in the timed pass A of `bench/picking-parity.ts`. The previous report's
claim that the harness doesn't record them was wrong. The diagnostics pass runs separately and is untimed.

| Run | World | pickMs p50 / p95 / max | selectMs p50 / p95 / max |
|---|---|---|---|
| Compact DPR2 zoom2 | shared | 1.1 / 2.9 / 3.3 | 1.1 / 1.3 / 10.7 |
| | 100k | 2.1 / 2.9 / 5.4 | 2.1 / 3.0 / 14.2 |
| Materialized DPR2 zoom2 | shared | 2.0 / 3.8 / 6.0 | 2.7 / 3.3 / 5.3 |
| | 100k | 2.6 / 3.8 / 4.2 | 2.7 / 5.2 / 7.0 |
| Compact DPR1 zoom2 | 100k | 2.1 / 3.0 / 5.8 | 2.1 / 3.0 / 14.2 |
| Compact DPR2 zoom4 | shared | 1.1 / 2.9 / 5.6 | 1.1 / 1.3 / 10.2 |
| | 100k | 2.1 / 2.9 / 5.6 | 2.1 / 3.0 / 13.5 |

**Latency regressed** after the guard. Before it (`picking-1792176243757081000`), pick p50 was about 0.4 ms shared and
0.7 ms at 100k.
- Likely cause (unproven): the live `editorReason` check runs `.ui-dialog` `querySelectorAll` plus `checkVisibility` on
  every query, and that can force a style recalc.
- It is kept because it fails closed. Making the suspension state event-driven is the next bounded fix.

## Limitations

- **Dashed-route terminal dash phase.** It blocks the semantic burg gate in compact DPR2 zoom2 (99.27%), DPR1 zoom2
  (99.01%) and DPR2 zoom4 (99.22%); materialized DPR2 zoom2 passes at 99.84%. The Skia measure explanation is recalled,
  not source-verified in this repo.
- **Zoom4 marker extras** (2) are not diagnosed.
- **Anonymous leaves** (ice, `sea_island`) give the correct kind and branch, but no element target (`target: null`).
- **Remaining wrong rows:** coastline has 1, and route has 6 wrong rows and 1 wrongInto per DPR2 zoom2 run.
- **Empty-href image hit area:** no failing row implicated it, so it was not changed.
- **No globally native hit API candidate**, by instruction.
- **Smoke was not run:** paint is unchanged, because only the pick geometry changed and the Draw gained a `d` field.

## Checks run on the final code

- unit: 63 files, 661 tests, pass
- build: OK
- bench: 38/38
- lifecycle: `p1-delegated-1792177368546224000`, failure null
- context: `p1-delegated-1792177435222071000`, failure null

The lifecycle and context checks ran after the `pickStatus` change; `renderer.ts` is unchanged since.

## Raw attempts (all retained in `host-checks/`)

| Artifact | What it is |
|---|---|
| `picking-1792176243757081000` | pre-guard baseline for timing |
| `picking-1792177447225470000` | fine dashed geometry; regression, burg 670/681 |
| `picking-1792177673377074000` | compact DPR2 zoom2, final |
| `picking-1792177805387374000` | materialized DPR2 zoom2, final |
| `picking-1792177906419594000` | DPR1 zoom2 spot-check |
| `picking-1792177960873780000` | DPR2 zoom4 spot-check |

Each artifact has a sibling `.diagnostics.json`.

## Correction: Explore vs Haiku

My earlier report conflated the agent type with the model. "Explore" is an agent **type**, not a model. The parent
receipt's `modelUsage` includes `claude-haiku-5-5`, and root billing verified that Haiku 5.5 was used. No further paid
agent tree was started in this job.

## Next bounded work

1. Implement the dash phase only with a Skia-style contour measure: chordal subdivision at 0.5/resScale, plus
   distance-0 terminal-vertex handling. Verify it against the roughly 15 diagnostic dashed-route-end rows across the
   three runs before any gate rerun.
2. Make the suspension state event-driven (dialog open/close) to remove the per-query DOM read, then remeasure
   `pickMs`/`selectMs` against the pre-guard baseline.
3. Diagnose the two zoom4 marker extras from `picking-1792177960873780000.diagnostics.json`.
4. Run the full eight-cell matrix and timing pairs only after compact DPR2 zoom2 qualifies the burg gate and label
   coverage reaches n ≥ 50.
