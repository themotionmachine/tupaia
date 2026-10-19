# Delegation log: completion round 2 (2026-10-16)

One native tree. Lead: Opus 5.5. Children: Haiku 5.5 only (general-purpose type); no child spawns agents, no child runs browser/build checks.
Cost basis: one CLI budget of $30 for the whole tree (lead + all children, no double count); children's cost is included in the
parent total. The per-child cost is not separately metered by the tools available here. Children have no shell, so every child test
was unexecuted at hand-back; the lead runs `unit`/`build`/browser checks serially and records the result in the Disposition column.

## Wave 1 (launched together, exclusive file ownership)

| Child | Workstream | Owned files | Deliverable | Disposition |
|---|---|---|---|---|
| A | Burg selection | selection.ts, compat-pick.ts, new burg-pick.ts (+tests) | Diagnosis only, no edits. 9 semantic burg wrongs at DPR2 z2 compact = 8 route strokes indexed where SVG paints no route (route88/667/612/926/704/242/632/928 over burgs 873/864/742/896/302/1063/465/916) + 1 label-over-label (burgLabels279 vs burgLabel72). 1 wrongInto = harness point with `elementFromPoint` null. Side finding: `compatShapes` indexes dashed strokes solid. | Accepted as diagnosis; routed the 8 route steals to the route/dash owner (B's changes, then picking pilot). No code to integrate. |
| B | Dashed route geometry | dash-measure.ts, pick.ts, new route-pick.ts (+tests) | `dashPieces`: zero-length on-dash kept at phase 0; closed-contour seam merge (Skia `skipFirstSegment`, recalled not source-checked). `pick.ts`: degenerate open subpath = dot (round disc / square box / butt nothing); `n===1` square cap box. Tests in dash-measure.test.ts, pick.test.ts. | Integrated. Unit pass (721/721, `host-checks/p1-delegated-1792194052621708000.log`). Picking effect: see final verification. |
| C | Prepare/recovery cost | prepare.ts, restore-phases/bitmap-window/budget/device.ts, renderer.ts scheduling | New `src/gpu/slice.ts` (`createSlicer`, 12 ms MessageChannel yield) + 6 tests; convert loop ticks before each `ctx.stale()` check; `peaks.lifetime` / `peaks.lastPrepare` split with `device.resetPeak()` before prepare. Rejected: skip scene/clone on bucket-only change (convert mutates scene.layers); release-before-allocate (blanks canvas in motion). | Integrated. Unit pass. Timing/context effect: see final verification. |
| D | Integration fixture/roundtrips | bench/renderer-integration.ts, new bench/integration-fixture.ts | `integration-fixture.ts` pure helpers (`cohortMode/cohortSize/attemptBudget`, `compareIds`, `strideSample`, `distinctCount`, `coverage`, `cohortVerdict` that never passes UNTESTED/UNDERCOVERED) + `integration-fixture.test.ts`; harness: fixture census per kind (natural vs fixture coverage), route cohort, undo probe, world-replacement held-element check, cohort verdicts. | Integrated with lead repairs (see "Lead harness repairs" below). Unit pass. Run outcomes: see final verification. |
| E | Editor dispatch | editor-dispatch.ts(+test), public/modules/ui/editors.js | `ClickCounts.errors`, `dropReasons{outside-viewbox,error}`; `recoverClick` miss counts unrecovered+drop reason, throw counts error; `routeClick` nested try around select. Tests: markets fall-through, throw, world replacement, dialog suspension, HTML overlay keeps its click, unrecovered drop. 30.8 ms outlier hypothesis (first `sync()` layout flush) unconfirmed. | Integrated after lead review of `routeClick` drop semantics (consistent with prior behaviour). Unit pass. |
| F | Fidelity | scene/shaders/text/raster/tessellate/mesh/geometry/svg-path/framegraph/overlays.ts | Opaque-stroke analytic edge coverage: quad widened by `u_aaPad` (1 device px), `cov = clamp((halfWidth-|y|)*pxPerWorld+0.5,0,1)`; translucent/thin strokes unchanged. `strokeEdgeCoverage` helper + tests. Per-layer over16 ranking at DPR2 z1: labels 0.509%, routes 0.508%, borders 0.225%, markers 0.193%, icons 0.044%, fills ~0.001%. | Integrated after lead check that blending is premultiplied ONE/ONE_MINUS_SRC_ALPHA (so `color*cov` is correct). Unit pass. Fidelity: see final verification. |

## Wave 2

| Child | Workstream | Owned files | Deliverable | Disposition |
|---|---|---|---|---|
| C2 | Restore scene reuse | prepare.ts, restore-phases.ts, renderer.ts prepare/restore section (scene.ts read-only) | New `src/gpu/scene-cache.ts`: one-entry `SceneCache` keyed by DOM revision + world epoch + curve tolerance + #viewbox identity; `sceneFor` in prepare.ts reuses the built scene (draws shared, layer reports copied because prepare mutates them) so a context restore skips the DOM walk; `worldEpoch` bumped on #map replacement and dispose. Heap trade-off: the last scene stays alive (one per renderer). | Integrated. Unit pass. Memory cost (one retained scene) measured in steady vs peak: see final verification. |
| G | Heap retention audit (+38 MB) | read-only; may create src/gpu/cache-audit.test.ts | No unbounded retainer found; the +35.4 MB is one-time warm-up (atlases/glyph caches/first scene). One hygiene defect: debug globals kept after renderer teardown, fixed by `detachGpuGlobals`. | Accepted; `detachGpuGlobals` integrated in renderer.ts. Unit pass. |
| H | Compat dashed strokes (A's side finding) | compat-pick.ts, compat-pick.test.ts | `compatShapes` path branch: dashed computed `strokeDasharray` → open dash rings via `strokeHitRings(() => dashHitRings(d, dashes, offset, resolution))`, resolution = sqrt\|det(leaf screen CTM)\|; fill unchanged. 3 tests (dash hit / gap miss / undashed / "none"). Caveats: caps round (no cap field), all-gap pattern → empty rings, prepare.ts passes viewScale for user-space `d`. | Integrated. Unit pass 737/737 (`host-checks/p1-delegated-1792197808722460000.log`). Cap caveat handed to J. |

## Wave 3 (diagnosis-driven)

| Child | Workstream | Owned files | Deliverable | Disposition |
|---|---|---|---|---|
| I | marker7 stale-revision source | read-only | Listed every `g#stateEmblems` childList site (draw-emblems `.html()` rebuild, `COArenderer.add`, editor/tool removals); no zoom-driven childList; suggested a delayed external call. Did not find the hover handler. | Partially useful: lead located the actual source by bracketing revisions (`aimRevisions` 127→127, then 128 before the wheel) to the harness's own `page.mouse.move(640,360)`: `public/modules/ui/general.js:140-141` tooltip handler `raise()`s the hovered emblem `<use>` and its group. |
| J | Stroke cap on hit shapes (H caveat) | pick.ts, pick.test.ts, compat-pick.ts, compat-pick.test.ts | `StrokeCap`, `HitShape.stroke.cap?`, `polylineCovers` (butt: nothing past open ends; square: half-width box; round/undefined/closed: unchanged), compat lane reads computed `strokeLinecap`. Tests in both files. Native lane already capped via `strokeCovers` outline. Risk: browsers compute `butt` by default, so all compat open strokes lose round ends (spec-correct). | Integrated after lead review. Unit pass (744/744, `host-checks/p1-delegated-1792199617439503000.log`). Picking effect: see final verification. |
| K | Pixel-neutral re-append (`raise()` of a last child) | markers.ts (+test) | `raised(records)`: a batch whose childList records on one target are exactly one single-node removal + re-insertion of the same node with identical previous/next siblings is "none" (skipped ×2); cached per batch in a WeakMap. 5 tests (no-op pair none; reorder, remove-only, different node, pair+attribute stay static). Risks: exactly-two-records rule is conservative (a raise batched with another childList on the same parent stays static); fakes without sibling fields would pair `undefined===undefined`. | Integrated after lead review (appendChild of the last child yields removal/insertion with prev=P, next=null on both; a non-last child has next≠null on removal, stays static). Unit 744/744 (`p1-delegated-1792199617439503000.log`); integration marker cohort PASS, `revisionDuringWheel` 0 (`host-checks/integration-1792199628138883000`). |

## Wave 4

| Child | Workstream | Owned files | Deliverable | Disposition |
|---|---|---|---|---|
| L | Labeled dense picking row | bench/picking-parity.ts | `100k-labels` world row reported separately: own `fixtureFailure` / `fixtureVerdicts` so the labeled dense fixture never folds into the shared-world verdict; thresholds untouched. | Integrated after lead review. Run outcome: see final verification. |
| M | High-zoom prepare cost diagnosis | read-only | See "Slow prepare finding" below. | See below. |

## Wave 5 (review)

| Child | Workstream | Owned files | Deliverable | Disposition |
|---|---|---|---|---|
| N | Adversarial review of the lead's round-join fix | read-only | One defect: for a point accepted by `joinCovers` on a ring with in-ring dashes and round caps, `dashCovered` gets `along` clamped to the vertex and drops the overhang, so a gap next to a vertex can count as covered (`[0,0,1,0,1,1]`, reach 0.25, dashes [0.5,0.5], offset 0.7, P (1.2,0)). Checked bounds of `joinCovers`/`live`, interior start vertices, the new tests. U-turns with very short first segments not numerically checked. | Accepted as a latent defect, not fixed: unreachable in production (`prepare.ts:304-338` pre-cuts every real dash pattern into pieces with `dashes: []`; undashed strokes normalise to `[]`; compat strokes carry no outline) and pre-existing (the old full-disc join clamped the same way). Recorded in the round report gaps. |

## Slow prepare finding (child M, read-only, inferred from code, not measured)

Symptom: route editor (forces `#cells` on) at high zoom, prepare 25–95 s and refine up to 34 s; the route cohort is settle-limited, but every eligible route click resynced to `editRoute` correctly. Ranked causes: (1) per-run serialize/decode/crop of the full-world canvas (`compat.ts:84-113`, `133-150`; `prepare.ts:578-600`); (2) `inlineStyle` clone payload (`export.ts:558-589`); (3) element-count convert cost plus the 16-bucket cap at k=8.57 DPR2 (`raster.ts:50-52`) and dash sample growth. Rejected fixes: style-payload cache (stale theme risk), dash-resolution clamp (changes fidelity). Disposition: open defect, no code change this round.

## Lead product fixes

- `src/gpu/renderer.ts` dialogs `MutationObserver`: calls `requestDraw()` when `suspendedReason` is set, so closing a dialog wakes a suspended renderer (before: stale suspension after the last dialog closed). Verified `host-checks/integration-1792202433585403000`.
- `src/gpu/renderer.ts` `prepare()`: `lastPrepare.phases` always records the prepareFrame checkpoints (scene/clone/screen/windows/world/buffers, ms since start); recovery step timing still forwarded when recovering. Telemetry only. Unit 744/744 (`host-checks/p1-delegated-1792204779980171000.log`), build pass.

- `src/gpu/pick.ts` round-join outer wedge (`joinCovers`, used by `strokeCovers` and the butt/square branch of `polylineCovers`). Correction to A's diagnosis: the 8 route steals were not "routes indexed where SVG paints none" in the sense of a mask or missing layer (every preset has route `mask: null`, and Blink ignores masks in hit testing anyway). They came from interior vertices tested with the whole `reach` disc: when a flattened curve's last step is shorter than the half-width, that disc overhangs the butt end (route88 over burg 873: 0.127 units past the end). Now a point past a segment's end counts only inside the join's outer wedge. Unit 745/745 (`p1-delegated-1792205802876369000`), build pass. Picking DPR2 z2 compact `picking-1792205878603341000`: semantic burg 680/682 (99.71%), but two new misses (route931/route134 over burg centres), traced to the next fix.
- `src/gpu/pick.ts` `END_SLACK = 1e-3` user units on butt end lines: burg centres sit exactly on route endpoints, and the float32 screen click lands about 4e-6 units past the end line (route931: P (584.19999146, 455.20000061) vs end (584.2, 455.2)); Blink hits it, and inspect at the exact point hits it. Before the wedge fix the overhanging disc masked this. The slack is 1/127 of route88's true miss. Unit 745/745 (`p1-delegated-1792206076990276000`), build pass (`p1-delegated-1792206083317859000`).
  - Fresh picking, semantic burg: DPR2 z2 compact 679/680 = 99.85% (`picking-1792206086824105000`, was 671/680 = 98.68% in `picking-1792205451012084000`); DPR2 z2 materialized 637/638 = 99.84% (`picking-1792206137487876000`, was 99.37%); DPR1 z2 compact 698/700 = 99.71% (`picking-1792206239058443000`). Route-class semantic wrongs at DPR2 z2 compact 13 → 4 (route702/447/286/466, all present before). Marker 430/430, cells exact. Label 46/46 in the 100k world is below the 50-sample floor (insufficient, not a pass).

## Final verification (lead, serial, after code freeze)

Full tables are in `COMPLETION-ROUND2-2026-10-16.md` §4. No code changed after these runs.

| Check | Artifact | Result |
|---|---|---|
| unit | `p1-delegated-1792206076990276000` | 745/745 |
| build | `p1-delegated-1792206083317859000.log` | pass (`dist/renderer-Djcp8cMT.js`, `dist/index-DR_E4S5m.js`) |
| bench | `p1-delegated-1792207036513513000` | 38/38 |
| picking ×8 (100k gated) | `picking-17922060868…`, `…6137487876…`, `…6239058443…`, `…7370848380…`, `…7249422426…`, `…7309942146…`, `…7498290800…`, `…7530592532…` | burg semantic 8/8, marker 8/8, cells 8/8, label 2/8 (6 insufficient); shared world insufficient |
| smoke over16 ×8 | see report §4.2 | 5/8 ≤1% |
| metrics | `fidelity-metrics-1792207039872143000` | SSIM 8/8, over16 5/8, conservative 0/8 (round-1 images) |
| timing | `timing-1792207153211967000/report.json` | app p95 8.4–9.2 ms; 100k settle 2,246.6 ms; transient peak 210,967,094 B |
| context | `p1-delegated-1792206936571279000` | pass, 548.7 ms (goal 500) |
| lifecycle | `p1-delegated-1792206949215702000` | pass, heap +34.7 MB (warm-up), GPU flat |
| integration | `integration-1792206351287622000` | exit 1: editors 5/5 and roundtrip pass; route cohort FAIL (slow prepare), undo UNTESTED, label resync UNDERCOVERED, marker cohort not run |

Spend at report time: about $19.5 of the $30 ceiling. This is the whole tree; children are included and not metered per child.

## Lead harness repairs (bench/renderer-integration.ts, recorded as harness changes)

- Route cohort: aim at the route's mid-length point and escalate through `ROUTE_ZOOMS` until the ±2 px robust probe holds (strokes are 0.5–1.6 CSS px at z2); zoom recorded per row; `ix.prepare()` + `centerCamera` between rows. Pass criteria unchanged.
- Synthetic labels kept ≥16 px inside the map edge; `closeAll`; `ix.shownDialogs` + `lateDialogs` loop (dialogs that open after the click).
- `settled()` failure message lists the newest 6 background jobs first (`ms` null = still running) with ages; `lateSettle` measures whether a failed settle completes later (slow) or never (stuck). This turned a suspected hang into a measured slow prepare.

- `.ts` import extension (ERR_MODULE_NOT_FOUND); per-key camera aiming replaced by a 3×3 tile-camera census (timeout).
- `ix.cameraState`, `ix.harvest`, telemetry `unavailableReasons`/`dropReasons`, static-revision diagnostics on stale clicks.
- Marker aim: `ix.prepare()` (settled + 400 ms DOM quiet) instead of `settled()`, plus post-probe re-prepare with `aimRevisions`.
- `staleClick`: re-prepare after the wheel-position `mouse.move` (its hover raise()s emblems → static revision → pick index stale at click). Before this fix marker7 resynced (correct editor, 21–24 ms) in 3 consecutive runs with reason `stale revision N < N+1`; that is a correct fallback, not a wrong selection, and is reported as such.
