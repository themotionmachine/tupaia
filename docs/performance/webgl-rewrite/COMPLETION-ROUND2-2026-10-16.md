# Completion round 2 (2026-10-16)

Status: **reviewable experimental hybrid candidate, not a full replacement.** WebGL2 paints over the canonical SVG; SVG stays the
source of truth for editing, save and export. SVG is still the default; GPU is opt-in via `?renderer=gpu` (`&gpu-select` for
GPU-routed clicks). Nothing deployed or published, no default flip. `/Users/mgm1/Desktop/code/vespucci` and production P2
`71dd4740-4b1b-4652-932c-d2855ce07fe8` untouched. No backend, share API, save format or production dependency changes. No e2e run.
No automatic next round; the wake loop stays paused.

Machine-readable summary: `completion-round2-status.json`. Per-child record: `delegation-log.md`. Round 1: `COMPLETION-RUN-2026-10-16.md`.

## 1. Headline (fresh, post-freeze results)

| Area | Round 1 (prior) | Round 2 (fresh) |
|---|---|---|
| Burg picking, semantic gate (100k world, 8 cells) | 2/8 pass (98.28–100%) | **8/8 pass** (99.70–100%) |
| Marker picking | 8/8 | 8/8 |
| Cells | exact 8/8 | exact 8/8 (both worlds) |
| Label picking | 2/8 pass, 6 insufficient | 2/8 pass (DPR1 z2), 6 insufficient (unchanged) |
| Context loss → draw | 608–616 ms (goal 500) | **548.7 ms** (still over goal) |
| Lifecycle heap growth, 20 cycles | 38.4 MB | 34.7 MB (warm-up; +2.9 MB cycles 1→20) |
| Integration editors | 5/5 | 5/5, save/export roundtrip equal |
| Integration route cohort | 0 clicks | **FAIL**: GPU did not settle (slow prepare, open defect) |
| Timing artifact | not located | located: `host-checks/timing-1792207153211967000/report.json` |

`READY_KINDS` stays `{"marker"}` (`src/gpu/editor-dispatch.ts:88`). Burg now meets the picking threshold in all 8 cells, but it
was **not** promoted: code was frozen for verification, and burg editor identity/resync evidence covers only one routed edit per
editor in the integration run. Burg promotion is a candidate for the next review, not something this round did.

## 2. Delegation pattern

One persistent Opus 5.5 lead; 15 Haiku 5.5 children (general-purpose type) in five waves. No child spawned agents, used paid
APIs/CLIs, or ran browser/build checks. Children got exclusive files; the lead integrated shared files and ran every
unit/build/browser check serially from the primary. Children had no shell, so their tests were unexecuted at hand-back. The lead
ran them and recorded the results.

| Wave | Children | Pattern |
|---|---|---|
| 1 | A burg selection, B dashed route geometry, C prepare/recovery cost, D fixtures/roundtrips, E editor dispatch, F fidelity | Parallel, exclusive files per workstream |
| 2 | C2 restore scene reuse, G heap audit, H compat dashed strokes | Follow-ups from wave-1 findings |
| 3 | I marker stale-revision source, J stroke caps, K pixel-neutral re-append | Diagnosis-driven |
| 4 | L labeled dense picking row, M high-zoom prepare cost | Harness + read-only diagnosis |
| 5 | N adversarial review of the lead's round-join fix | Read-only review |

Dispositions:
- Integrated: B, C, C2, D (with lead repairs), E, F, H, J, K, L.
- Accepted as diagnosis without code: A, G (its `detachGpuGlobals` fix was integrated), M, N.
- Partially useful: I. The lead found the real source, a tooltip `raise()` in `public/modules/ui/general.js:140-141`.

All child code is integrated or explicitly excluded. Rejected ideas are listed in `delegation-log.md`:
- C: skipping scene/clone on bucket-only changes;
- C: release-before-allocate;
- M: style-payload cache;
- M: dash-resolution clamp.

Cost basis: one $30 CLI budget for the whole tree, and child cost is included in the parent total. The tools do not meter
per-child cost. Spend at report time was about $19 of $30.

## 3. Lead fixes this round

- `src/gpu/pick.ts` **round-join outer wedge** (`joinCovers`): a point past a segment end counts only inside the join's outer wedge.
  - This corrects A's diagnosis. The 8 burg steals were not a mask or missing-layer issue (every preset has route `mask: null`).
  - The cause was interior vertices tested with the full `reach` disc. Where a flattened curve's last step is shorter than the
    half-width, that disc overhangs the butt end; route88 over burg 873 overhung by 0.127 units.
- `src/gpu/pick.ts` **`END_SLACK = 1e-3`** user units on butt end lines. Burg centres sit exactly on route endpoints, and a
  float32 screen click lands about 4e-6 units past the end; Blink hits it. Tests: 10.050004 hits, 10.06 misses
  (`src/gpu/pick.test.ts`).
- `src/gpu/renderer.ts`:
  - The dialogs observer wakes a suspended renderer.
  - `lastPrepare.phases` is always recorded (telemetry).
  - `detachGpuGlobals` on teardown.
- `bench/renderer-integration.ts` harness repairs (route aiming/zoom escalation, `lateSettle`, stale-click re-prepare). See
  `delegation-log.md`. Pass criteria are unchanged.

## 4. Fresh results (all after the final code freeze)

Final unit run: 745/745 (`host-checks/p1-delegated-1792206076990276000`).
Final build: pass (`host-checks/p1-delegated-1792206083317859000.log`).
Bench: 38/38 (`p1-delegated-1792207036513513000`).

### 4.1 Picking matrix

The 100k world is gated. Acceptance uses the semantic gate (`window.gpuSelect`); raw `gpuPick` is diagnostic only. Thresholds
are frozen: ≥50 samples and ≥99.5%, cells exact.

| DPR | Zoom | Relief | Burg semantic | Burg raw (diag.) | Label | Marker | Cells | Artifact |
|---|---|---|---|---|---|---|---|---|
| 2 | 2 | compact | 679/680 99.85% pass | 86.3% | 46 insufficient | 430/430 | 708 exact | `picking-1792206086824105000` |
| 2 | 2 | materialized | 637/638 99.84% pass | 92.0% | 46 insufficient | 430/430 | 708 exact | `picking-1792206137487876000` |
| 1 | 2 | compact | 698/700 99.71% pass | 87.1% | 57/57 pass | 418/418 | 723 exact | `picking-1792206239058443000` |
| 1 | 2 | materialized | 660/662 99.70% pass | 92.1% | 57/57 pass | 418/418 | 723 exact | `picking-1792207370848380000` |
| 2 | 4 | compact | 508/508 100% pass | 82.1% | 37 insufficient | 95/95 | 724 exact | `picking-1792207249422426000` |
| 2 | 4 | materialized | 465/465 100% pass | 89.7% | 37 insufficient | 95/95 | 724 exact | `picking-1792207309942146000` |
| 1 | 4 | compact | 522/523 99.81% pass | 84.3% | 41 insufficient | 99/99 | 714 exact | `picking-1792207498290800000` |
| 1 | 4 | materialized | 479/480 99.79% pass | 91.9% | 41 insufficient | 99/99 | 714 exact | `picking-1792207530592532000` |

Shared world, same artifacts:
- Every kind is below 50 samples in every cell (burg 4–14, label 17–28, marker 9–21) with 100% agreement, so all are
  insufficient, not passes.
- Cells are exact (409–468).
- The `picking` check pins worlds `["shared","100k"]`, so L's separate `100k-labels` row was not exercised by a fresh run.

Prior → fresh semantic burg, DPR2 z2 compact: 671/680 98.68% (`picking-1792205451012084000`) → 679/680 99.85%. Materialized went
from 99.37% to 99.84%. Route-class semantic wrongs at that cell went 13 → 4 (route702/447/286/466, all present before).

Raw burg stays 82–92% in all cells (0/8 at 99.5%). The gap is where the raw index and Blink's stacking/hit rules differ, and the
semantic layer (`gpuSelect`) resolves it.

### 4.2 Visual fidelity (smoke `over16`, fresh capture, shared world)

| DPR \ Zoom | 1 | 2 (default) | 4 | 8 |
|---|---|---|---|---|
| 1 | 1.285% **fail** | 0.617% | 1.110% **fail** | 0.247% |
| 2 | 1.569% **fail** | 0.810% | 0.697% | 0.183% |

- Fresh over16 is ≤1% in 5/8 cells and fails in 3. DPR2 z1 improved from 1.831% to 1.569% after F's analytic stroke-edge coverage.
- Artifacts, in table order:
  - DPR1: `p1-delegated-1792207128371744000`, `…7017851193000`, `…7136522599000`, `…7142686875000`.
  - DPR2: `…7056617299000`, `…7025576342000`, `…7067460720000`, `…7077144583000`.
- `metrics` check (`fidelity-metrics-1792207039872143000`): SSIM 8/8, over16 5/8, **conservative/strict reference 0/8**, self-test
  11/11. This check recomputes from the round-1 image manifest (renderDist `f99596d6…0911`); it is not a fresh capture.

### 4.3 Timing, memory, recovery

**Timing** (`host-checks/timing-1792207153211967000/report.json`):
- Setup: DPR2, headful Chromium 148, ANGLE Metal on an M1 Max, synthetic DOM, seed 7319, shared + 100k worlds, pan-near/pan-wide/wheel-zoom.
- App frames: p50 8.3 ms, p95 8.4–9.2 ms, max ≤10.2 ms. The one 50 ms max is in the idle control frame, not the app.
- 100k `rendererReadyWaitMs` up to 2,753 ms.
- 100k settle prepare: 2,246.6 ms. Cumulative phase checkpoints: scene 886, clone 1,410, screen 1,603, world 2,245, buffers 2,247 ms.

**GPU memory** (tracked allocations; budget 167,772,160 B = 160 MiB):
- Steady: shared 135.5–137.1 MB, 100k 110.8–115.3 MB, smoke cells 123.2–159.4 MB. All below budget.
- **Transient prepare peak: 210,967,094 B (201.19 MiB)** on the 100k wheel-zoom run. That is above the 160 MiB steady target and
  below the 256 MiB transient ceiling. It is a new high versus the 204,850,141 B recorded in round 1.

**Context** (`p1-delegated-1792206936571279000`):
- Pass.
- Loss → draw 548.7 ms (restore prepare 473.6 ms), down from 608–616 ms. Still over the 500 ms goal.
- Steady 159,372,253 B; after restore 113,712,433 B.

**Lifecycle** (`p1-delegated-1792206949215702000`):
- Pass, 20 cycles, GPU memory flat at 159,377,081 B.
- Heap went 89.46 MB at cycle 0 → 121.25 MB at cycle 1 (warm-up), then rose only 2.9 MB more and plateaued at ~124.15 MB.
- `heapGrowthBytes` 34,693,592.

### 4.4 Integration (`host-checks/integration-1792206351287622000`, exit 1)

Passed:
- Editors burg/label/route/marker/relief: each agree 1/1 and persisted.
- Save is deterministic (masked sha `939caf5d…`, 7,782,113 B).
- Export is equal (`dea21729…`, 11,614,578 B).
- staleFallback, worldReplacement and the fixture checks.
- pageErrors 0. Blocked requests: 2 (gtag, watabou), as intended.

Not passing:
- **Route cohort: FAIL.** "GPU did not settle" at k=8.57. Prepare took 89,462 ms (cumulative checkpoints: scene 30.6 s, clone
  16.6 s, screen 14 s, world 28.4 s); a second prepare took 25,084 ms and refine 36,874 ms. This is M's slow-prepare defect, which
  is open.
- **Undo: UNTESTED.**
- **Label resync: UNDERCOVERED** (9/9 eligible clicks resynced correctly, but below the coverage floor).
- **Marker cohort: not run** in this final integration run. The previous run passed it, with `revisionDuringWheel` 0
  (`host-checks/integration-1792199628138883000`).

## 5. Gaps (open, honest)

1. **Route cohort fails** because high-zoom prepare in the route editor (forced `#cells`) takes 25–95 s.
   - M's ranked causes: per-run full-world canvas serialize/crop; the `inlineStyle` clone payload; element-count convert cost at
     the 16-bucket cap.
   - Not fixed.
2. Undo/redo through routed clicks: untested.
3. Labels are insufficient in 6/8 cells. There is still no fresh run of a labeled dense fixture, because `picking` pins its worlds.
4. Shared world: every kind is below 50 samples.
5. Burg passes the gate but is not in `READY_KINDS`. Promoting it needs editor identity/resync coverage beyond one edit.
6. Visual fidelity:
   - Strict/conservative reference 0/8.
   - Fresh over16 fails 3/8 (DPR1 z1, DPR1 z4, DPR2 z1).
   - The `metrics` check reuses round-1 images.
7. GPU transient prepare peak of 201.19 MiB exceeds the 160 MiB steady target (within the 256 MiB transient ceiling).
8. Context restore is 548.7 ms against the 500 ms goal.
9. 100k settle prepare is about 2.2 s; ready-wait is up to 2.75 s.
10. N's latent dash defect: `dashCovered` clamps `along` at a join vertex. It is unreachable in production (`prepare.ts:304-338`
    pre-cuts dashes) and pre-existing, so it was not fixed.
11. Heap grows +34.7 MB on the first regeneration (warm-up; G found no unbounded retainer).
12. Windows/iGPU untested. Navigation was not rerun as 10 interleaved pairs; only the timing check ran.
13. Unsupported interactions use the legacy SVG path (inventory in `COMPLETION-RUN-2026-10-16.md` §3).

## 6. Corrections to earlier statements

- The GPU peak of 204,850,141 B (~195.36 MiB) recorded in round 1 is a **transient prepare peak**, not steady memory. Steady
  memory was measured separately this round, and all cells are below 160 MiB. The fresh transient peak is higher, at 210,967,094 B.
- Round 1's "final timing-check artifact not located" is resolved: `host-checks/timing-1792207153211967000/report.json`.
- Round 1 used only 4 children, which under-used the available leverage. This round used 15.
- The matrix is DPR1/2 × zoom 2/4 × compact/materialized.
- No cherry-picking: before this round, compact DPR2 z2 burg was 98.68% and materialized 99.37%.
- A's "routes indexed where SVG paints none" was a misdiagnosis; the real cause was the join-disc overhang (§3).
- The lead's own interim notes swapped the world labels for the picking blocks. The artifacts list `shared` first; the gated
  680-burg block is `100k`. The tables above use the artifact labels.

## 7. Code fingerprint

- git HEAD `1c5ab2b` plus uncommitted working-tree changes; there is no commit for this round.
- **No source content hash was computed.** The lead had no shell, and no check artifact records a source fingerprint.
- Final build output names include Vite content hashes (`host-checks/p1-delegated-1792206083317859000.log`, vite 8.0.16,
  tupaia@1.130.0): `dist/renderer-Djcp8cMT.js` and `dist/index-DR_E4S5m.js`.
- Picking and integration artifacts record only the fixture `mapSha256 f5c0d703…`.
- Files changed this round, by owner:
  - Lead: `src/gpu/pick.ts`, `src/gpu/pick.test.ts`, `src/gpu/renderer.ts`.
  - B: `dash-measure.ts` (+test).
  - C: new `slice.ts` (+test), `prepare.ts`, `device.ts`/budget peaks.
  - C2: new `scene-cache.ts`.
  - D + lead: new `bench/integration-fixture.ts` (+test), `bench/renderer-integration.ts`.
  - E: `editor-dispatch.ts` (+test), `public/modules/ui/editors.js`.
  - F: stroke shader/tessellation within F's owned set.
  - H/J: `compat-pick.ts` (+test).
  - K: `markers.ts` (+test).
  - L: `bench/picking-parity.ts`.

## 8. How to review

1. Read this file, then `completion-round2-status.json`, then `delegation-log.md`.
2. Code first: `src/gpu/pick.ts` (`joinCovers`, `END_SLACK`, `polylineCovers` caps), `src/gpu/compat-pick.ts`,
   `src/gpu/markers.ts` (`raised`), `src/gpu/scene-cache.ts`, `src/gpu/slice.ts`, `src/gpu/editor-dispatch.ts`.
3. Spot-check one picking artifact: in the JSON, the `100k` block's semantic burg gate (`denominator`/`agree`/`rate`).
4. Try it: `npm run dev`, open `?renderer=gpu&gpu-select`, then in the console use `gpuClickTelemetry`, `gpuSelect(x, y)` and
   `gpuRenderer.telemetry().lastPrepare.phases`.
5. Decisions for the reviewer, none of them automatic:
   - whether to promote burg to `READY_KINDS` after adding editor identity/resync tests;
   - whether to fund the slow-prepare fix (M's cause 1 first).
