# P2 — Context recovery: phase timing and correctness

Status: **diagnosed, gate still open.** Telemetry only; no recovery behavior, resource ownership, memory caps, quality
or gate changes. The PROOF-PLAN row "Context loss → restored frame ≤500 ms" is missed on this host at both DPRs,
measured either way (loss-total or post-event).

## What changed

- `src/gpu/restore-phases.ts` — `RestoreClock`, a pure time-state helper (injected clock) that splits one recovery
  episode into phases. Each phase is `null` until both boundaries are observed; nothing is inferred.
- `src/gpu/renderer.ts` — new `GpuTelemetry.restore` (`RestoreTiming | null`, null before any loss). Hooks:
  `lost()`, top of `restored()`, after graph/timer/resize in `restored()`, prepare start/end (token per attempt),
  first draw after loss, `dispose()`. **`lastRestoreMs` is unchanged**: still `lostAt` (in `lost()`) → end of the
  first `draw()` after it. `restore.lossToDrawMs` measures the same span (581.5 vs 581.4 below).
- `src/gpu/prepare.ts` — optional `PrepareContext.mark(step)` at six existing checkpoints in `prepareFrame`
  (`scene`, `clone`, `screen`, `windows`, `world`, `buffers`). It is only passed for the recovery prepare; ordinary
  prepares pass `undefined`. No allocation beyond one small record per episode; no GPU query polling.
- `src/gpu/restore-phases.test.ts` — 7 fake-clock tests: null before loss / ordinary prepares untracked; contiguous
  phase split; phases stay null without restore event or committed prepare (draw before commit does not close);
  stale attempts counted and late checkpoints from a superseded job ignored; a second loss supersedes the episode and
  the old context's prepare cannot close it; dispose freezes the episode; later draws do not rewrite a completed one.

Phase boundaries (all `performance.now()`, main thread):

| field | from → to |
|---|---|
| `lossToRestoredMs` | `webglcontextlost` handler → `webglcontextrestored` handler (contains the harness's 50 ms window) |
| `restoredToGraphMs` | restored handler → `FrameGraph` + timer restore + `resize()` done |
| `graphToPrepareMs` | → start of the prepare that later commits (timer scheduling gap) |
| `prepareMs` | committed prepare start → commit (`steps` break it down, each ms since the previous step) |
| `prepareToDrawMs` | commit → end of first `draw()` (rAF wait + command issue; **not** physical presentation) |
| `lossToDrawMs` | loss → first draw = `lastRestoreMs` |
| `failedPrepares` | stale/failed/swap-dropped attempts inside the episode |

`outcome`: `restoring` | `drawn` | `superseded` (another loss first) | `disposed`.

## Results (host-checks, bigmap fixture, `context` check)

| run | DPR | `lastRestoreMs` | loss→event | event→graph | gap | prepare | scene | clone | screen | windows | world | buffers | →draw |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `p1-delegated-1792151014465676000` (before telemetry) | 2 | 584.4 | — | — | — | 504.6 (trace) | — | — | — | — | — | — | — |
| `p1-delegated-1792151134198135000` | 2 | 581.4 | 56.6 | 7.9 | 0.9 | 505.0 | 229.8 | 0 | 53.7 | 9.6 | 210.7 | 0.5 | 11.1 |
| `p1-delegated-1792151150581563000` | 1 | 661.0 | 58.6 | 7.9 | 0.9 | 581.3 | 222.3 | 0 | 26.7 | 0.3 | 330.9 | 0.9 | 12.3 |

All three: exit 0, `failure: null`, `failedPrepares: 0`, one `restore committed` prepare, canvas visible, state
`active`, `heapGrowthBytes: 0`. For reference the initial (cold) prepares in the same runs were 761 ms (DPR2) and
843 ms (DPR1). The two DPR2 runs agree within 3 ms, so no third DPR2 repeat was spent.

Gate reading, kept separate:

- **Loss-total (the PROOF-PLAN metric, unchanged):** 581 ms DPR2, 661 ms DPR1 → **miss**.
- **Post-event cost** (restored event → first draw, excludes the injected 50 ms window and driver dispatch):
  7.9 + 0.9 + 505.0 + 11.1 = **525 ms** DPR2; 7.9 + 0.9 + 581.3 + 12.3 = **602 ms** DPR1 → **also a miss**.
  Excluding the deliberate loss window does not make the gate pass, and the metric was not redefined.

## Why ~600 ms

1. **~57 ms before the restore event** — the harness's deliberate `waitForTimeout(50)` plus dispatch of
   `restoreContext()`. Real-world loss windows are driver-dependent and can be much longer; this is not renderer work.
2. **Shader/graph rebuild is not the cost** — 7.9 ms for `new FrameGraph` (programs/VAOs), timer restore and resize.
3. **The recovery is a full re-prepare from the canonical SVG** (~88–90 % of the total). The CPU scene, vertex arrays
   and compat canvases are not retained after a frame is committed (by design, under the memory caps), so restore
   rebuilds them:
   - `scene` ~225 ms: `buildScene` + `convert` (tessellation, pattern tiles, relief cache lookups and their texture
     uploads). Not split further in this job.
   - `world` 211 ms (DPR2) / 331 ms (DPR1): rasterizing the world compat runs (labels, markers, icons, masks) from the
     cloned SVG, plus upload. DPR1 is slower because `compatResolution` resolves to 0.921 there vs 0.636 at DPR2 —
     larger world rasters, under the same budget policy as an ordinary prepare.
   - `screen` 27–54 ms: screen-overlay rasters at the screen DPR.
4. ~11–12 ms commit → first draw (rAF wait + issue).

Duplicate/lazy-work audit (source + artifacts): one prepare per recovery (`failedPrepares: 0`, a single
`restore committed` trace entry); `clone` 0 ms (the compat clone for the unchanged revision is reused, not rebuilt);
`restored()` → `resize()` → `requestDraw()` is a no-op without a frame and does not schedule a second prepare (the
`resize` prepare requires an existing frame); no settle/refine overlaps the restore prepare (refine starts after
commit, shown as `refinementPending: true`). No harmless duplicate or cold lazy cache was found to remove.

## Correctness audit (primary, read-only; no child agent spent)

- `lost()` increments `generation`, drops/releases the frame (no-ops on a lost device), forgets markers, loses the
  timer and clears `prepareWanted`. Every async job re-checks before committing: prepare (`prepareStale`: generation,
  revision, motion, `device.lost`, `disposed`), refine (`ctx().stale`: generation, revision, frame identity, refine
  token, `device.lost`), window refresh (generation, frame identity, lost, disposed), overlay refresh (generation,
  lost, revision). `draw()` also guards `gl.isContextLost()` for the window before the event fires.
- A pending prepare timer that fires while lost is skipped by `prepareStart`; `restored()` clears and reschedules it.
- `restored()` failures (graph construction) fall back to SVG; the episode then stays `restoring` with
  `restoredToGraphMs: null` — telemetry does not fabricate a duration.
- The new telemetry cannot be closed by a job from a previous context (per-attempt tokens; second loss supersedes),
  and does not change any generation/revision/root binding, context-object lifetime, memory cap, font, style,
  context attribute or DPR policy.

## No optimization this job — why

No small, proven cause exists. The options that would cut the dominant ~430–550 ms are all out of this job's bounds:

- **Retain CPU vertex arrays / compat canvases across a loss for re-upload** — would save most of `scene`+`world`
  but is the large CPU scene-retention architecture (tens of MB held permanently for a rare event, against the CPU
  memory cap). Not started; recommended only as a separate, budgeted decision.
- **Progressive restore** (draw native batches first, compat later) — changes what a "restored frame" means
  (partial frame on screen); needs a plan-owner decision, not a tweak.
- **Lower restore raster resolution** — a quality reduction; excluded.

## Checks run (this job)

| check | artifact | result |
|---|---|---|
| context DPR2 (baseline) | `p1-delegated-1792151014465676000` | exit 0, 584.4 ms |
| unit | p1-delegated-1792151121121775000 | 58 files / 586 tests pass (incl. 7 new) |
| build | p1-delegated-1792151125701942000 | exit 0 |
| context DPR2 | `p1-delegated-1792151134198135000` | exit 0, phases above |
| context DPR1 | `p1-delegated-1792151150581563000` | exit 0, phases above |
| bench (fixed list) | (see check report) | 31/31 tests pass, incl. the fidelity-metrics SSIM unit hooks (tests, not comparison runs) |

Not run (not needed for telemetry-only changes): smokes, hatch, navigation, lifecycle, paired runs, metrics. The
ordinary rendering path changed only by an optional, undefined-by-default callback, so the frozen SSIM/fidelity
baselines (f995 manifest) are not re-claimed and stay valid for unchanged paths. `build` is a Vite bundle; a separate
`tsc --noEmit` was not available through the fixed checks.

## Limitations

- Single host (darwin), single fixture, injected loss via `WEBGL_lose_context`; real driver resets were not exercised.
- `prepareToDrawMs` ends at `draw()` returning — command issue, not presentation.
- Steps are main-thread wall time and include awaited image decode/raster inside each step; they are not CPU
  profiles.
- Open items unchanged: strict conservative full-frame fidelity 0/8 (wording awaits plan-owner interpretation; no
  gate retuned), SceneDoc/editor/picking/Windows parity, heap 38.7 MB item.

## Recommended next tranche (parity over speed)

1. **Native text/labels** (feature parity + a large compat cost): labels are part of the world compat rasters, which
   weigh on every full prepare — initial, revision, and restore. Moving them native should shrink restore time as a
   side effect without CPU retention (to be measured). Too large for the remaining quiet budget; plan against the
   200 cap.
2. **Picking/hit-testing parity under GPU** and the **editor/SceneDoc** path, then
   the **Windows host** check — these are what block a default flip, more than another 100 ms.
3. Only after those: decide on CPU-retention or progressive restore for the 500 ms gate as a deliberate memory/semantic
   trade-off.

Budget fit: prior usage $91.81 plus this job leaves roughly $7 under the $100 quiet checkpoint. That fits one bounded,
read-mostly item — e.g. a picking-parity audit with targeted unit tests and a design note for native labels — not an
implementation of native text or SceneDoc. Nothing further needs to be spent just to reach the checkpoint.

Orchestrator verification: package.json build script is tsc && vite build; successful build already includes TypeScript checking. The separate-tsc limitation above is unnecessary. Check IDs were recovered from native tool-result receipts.
