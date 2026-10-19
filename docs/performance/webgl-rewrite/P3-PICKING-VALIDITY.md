# P3 — Picking validity and pure selection

Status: **G-P NOT accepted.** This job made the measurement valid; it did not make GPU picking pass.

- The first valid compact-regime pilot (protocol v2) **fails** in the 100k world: burg 78.95% raw / 87.08% semantic,
  label 92%, against the gate of ≥99.5%.
- The shared world is **insufficient**: every gated kind has a denominator under 50.
- The materialized regime is **unmeasured (unsupported)**. GPU prepare never reaches readiness.
- The 8-call matrix was **not run**, and no new 20-pair run was made.
- No click adapter, default flip or deploy was done or claimed.
- Production P2 version `71dd4740-4b1b-4652-932c-d2855ce07fe8` is unchanged: SVG is the default, GPU is opt-in.
- Gate targets are unchanged: 99.5% per gated kind, 100% for cells.

## 1. The v1 mutation bug

In protocol v1, `bench/picking-parity.ts` built its expected selection from `classifyClick`. For the fallbacks it
called `window.pickRelief(x, y)` **for each sample**. `pickRelief` is the click-time *commit*:

- It calls `prepareReliefIcons`.
- That sets `++revision` and replaces `#terrain.innerHTML` with materialized `<use>` glyphs.

So the first relief-fallback sample changed the scene for the rest of the run. Later samples were measured against a
different DOM, with a stale GPU prepared scene and a different relief regime. v1 had no guard that could detect this.

Evidence:

- The v2 guard (a MutationObserver plus a `#terrain` hash and revision) reports any change of this kind as a run
  rejection. The unit test `picking-protocol.test.ts › rejects a run on any structural change or committing call`
  pins this.
- Read-only audit, confirmed by code: `pickRelief` = `peekRelief` + `commitRelief`, and only the commit mutates.

**Old claims that are now invalid (provisional):** artifacts `picking-1792164908292119000` and
`picking-1792165030831536000`. These are the numbers cited in P3-PRECISE-PICKING.md and P3-PICKING-PARITY.md:

- 100k burg: 559/668 = 83.68% raw, 561/670 semantic
- label 46/50, marker 428/431
- relief extras 125/237, terrain branch 113

Both documents now carry a PROVISIONAL banner and are otherwise unchanged. The raw artifacts are immutable and kept.

## 2. Pure selection (WORK1)

- **`src/renderers/relief-canvas.ts`**
  - `peekRelief(x, y)` is read-only. It returns a `ReliefPeek` `{index, key}` with `key = reliefKey()`, in the form
    `"(id)|href@x,y"`.
  - `commitRelief(peek)` performs the mutation.
  - The `pickRelief` API is preserved as `peek && commitRelief(peek)`.
  - `window.peekRelief` and `window.reliefRevision` are exposed for the bench.
- **`src/gpu/selection.ts` `selectAt` / `window.gpuSelect`** is read-only.
  - It returns a descriptor.
  - A relief result has `target: null` and carries the peek (`relief`).
  - A terrain glyph or `#terrain` hit with no addressable element returns `branch: "terrain-unsupported"`. It is not
    faked.
- **`src/gpu/renderer.ts`** wires `gpuSelect` to `peekRelief` and `pickBurg` and **never** to `pickRelief`. Fallbacks
  are on only when the page has `pickRelief`, mirroring `clicked()`.
- **The CPU fallback is shared by construction.** In this job's measurements, the `pickBurg` and `peekRelief` used by
  the SVG oracle and by `gpuSelect` are the same functions. Agreement on fallback-resolved samples therefore shows
  only that the routing matches. It does not show independent GPU accuracy.

## 3. Protocol v2 (WORK2): schema 2

`bench/picking-parity.ts` (owned file) was changed to fix the invalidation bug:

- **`reliefMode`:** `compact` (the default) or `materialized`. The regime is set up **before** the GPU index is
  prepared, and the bench then waits for readiness: active, visible, source current, covered, not pending, not
  refining.
- **Scene freeze in setup:** the bench counts the `#tradeAnimation > g` caravans, then calls
  `window.TradeAnimation.stop()`. Caravans are added and removed all the time, and they invalidated the first two
  compact attempts (see §5). Freezing is a setup step; the guard was **not** relaxed.
- **Sampling order:**
  - Pass A (pure) reads only `elementFromPoint`, `gpuPick` and `gpuSelect`.
  - Pass B runs **only** for samples where no DOM branch matched (`needsFallback`). It calls `pickBurg`, then
    `peekRelief`.
  - `pickRelief` is never called while sampling. A wrapper counts any call to it, and one call rejects the run.
- **Guard:** a run is valid only if all of the following hold:
  - the MutationObserver saw 0 structural (childList) mutations (the first 20 are logged with target, added and
    removed);
  - the before/after `SceneProbe` is identical: regime, `#terrain` hash, child count, relief revision, GPU prepared
    identity and camera;
  - there were 0 committing calls;
  - every `<use>`/target in the DOM sample is still connected.
- **Commit test:** optional, and kept separate from the point loop. It was not run in this job.
- **Gate pass flags**, fixed after the audit (§7): a settled verdict now also requires the GPU to be ready and the
  camera aligned, not only the guard. Before the fix, those failures were recorded in `errors` and `failure` but not in
  `gate.*.pass`. No conclusion in this report changes, because no gate passed.
- **Expected counts change on purpose.** v2 expectations come from an unmutated compact scene, so its denominators
  (100k burg 708, not 668) cannot be compared one-to-one with v1. RAW (`gpuPick` id → normalized) and semantic
  (`gpuSelect`) rates are reported separately and never merged.

Tests:

- `src/gpu/picking-protocol.test.ts` (4 tests): fallback gating, branch order, instance descriptor, scene-change
  rejection.
- `selection.test.ts`: peek, null target, terrain-unsupported, no fallback under an index hit.
- `relief-canvas.test.ts`: peek is read-only, pickRelief is preserved.
- `compat-pick.test.ts`.

## 4. Compact raster vs materialized glyph (WORK3)

- **Compact:** the relief layer is `<image data-relief pointer-events=none>`. It is click-through: `clicked()` reaches
  the underlying branch and then the `pickRelief` fallback. Relief appears in the oracle only through the fallback,
  and the GPU raster gets no hit boxes (`compat-pick.ts` `rasterHits` is false). The GPU index therefore has no relief
  entries, so raw relief is 0 by design. Semantic relief comes from the shared `peekRelief`.
- **Materialized:** the glyphs are `<use>` elements with no id. The GPU index does not carry real per-instance shape
  and draw order for them. `gpuSelect` therefore reports `terrain-unsupported` and does not invent an instance.

## 5. Runs (all dpr 2 / zoom 2, the same 500 seeded points plus targeted supplements)

| Artifact (host-checks/) | Regime | Result |
| --- | --- | --- |
| picking-1792166438724496000 | compact | **rejected**: 10 structural mutations (`#tradeAnimation` caravans) |
| picking-1792166642224377000 | compact | **rejected**: 24 structural mutations (`#tradeAnimation` caravans) |
| **picking-1792166760543388000** | compact | **valid** in both worlds: 0 mutations, `changes: []`, hash/revision identical before and after |
| picking-1792166825330413000 | materialized | not ready: GPU prepare did not finish within 30 s |
| picking-1792167542975350000 | materialized | not ready (same) |
| picking-1792168279078159000 | materialized | not ready. Diagnostic: `state: "preparing"`, `lastPrepare {reason: "behind", hadFrame: false, outcome: "running"}`, `prepared: null`, canvas hidden, no coverage |

Rejected and not-ready artifacts are kept immutable.

### Valid compact pilot: picking-1792166760543388000

Both worlds: regime compact, guard valid, `failure: null`.

**Shared world: insufficient** (every gated denominator < 50)

| Kind | RAW | Semantic |
| --- | --- | --- |
| burg | 2/4 (1 missing, 1 wrong) | 3/4 |
| label | 27/27 | 27/27 |
| marker | 21/21 | 21/21 |
| relief (ungated) | 0/346 (missing, by design) | 346/346; plus 22 wrong-into relief where SVG selects ice |
| cells | 421/421 outside the band (113 in band) | — |

Overall raw: 526/534.

**100k world: FAIL**

| Kind | RAW | Semantic |
| --- | --- | --- |
| burg | 559/708 = **78.95%** (67 missing, 54 wrong, 28 wrong-into) | 620/712 = **87.08%** (2 missing, 58 wrong, 32 wrong-into) |
| label | 46/50 = **92.0%** (4 wrong-into label) | 46/50 |
| marker | 428/431 = **99.30%** (2 wrong) | 428/431 |
| relief (ungated) | 0/203 (201 missing, 2 wrong) | 201/203 |
| route / coastline / river (ungated) | 36/42 (30 wrong-into route) / 0/11 / 2/3 | — |
| cells | 708/708 = 100% outside the band (729 in band) | — |

Overall raw: 1358/1437.

Coverage is under 50 for every gated kind in the shared world, so it is reported as insufficient. In the 100k world,
burg, label and marker all reach a denominator of at least 50. Cells pass in both worlds. The pilot is not strong, so
the 8-call matrix was not run.

### Smokes (one per DPR, against the baselines)

| DPR | Artifact | Mean / over-threshold | Baseline |
| --- | --- | --- | --- |
| 1 | p1-delegated-1792168976974117000 | 0.13608 / 0.007592 | 0.136 / 0.0076 |
| 2 | p1-delegated-1792168987189432000 | 0.16556 / 0.009939 | 0.166 / 0.0099 |

The visual result is unchanged. Unit tests: 61 files / 614 tests pass. Build passes. Bench: 37/37, rerun after the gate
fix.

## 6. Remaining failures and next cause

1. **Burg (100k): 87% semantic, 79% raw.** This is the main gated failure.
   - The semantic misses are mostly *wrong* (58) plus wrong-into (32). The GPU index returns a nearby or overlapping
     burg icon/label, or a route, where SVG's top element is another burg.
   - The next cause to investigate is hit-shape and z-order fidelity for dense burg icons and labels: what the index
     stores versus the painted SVG geometry.
   - That is precise-geometry work, so it was deliberately not started here.
2. **Label: 92%.** 4 samples are wrong-into label, where the GPU label box covers a point that SVG gives to something
   else. Same category: box versus glyph geometry.
3. **Kinds with no GPU index entries: ice, coastline, lake.** `gpuSelect` falls through to the fallbacks where
   `clicked()` takes a DOM branch. This explains the 22 shared-world ice → relief wrong-intos and coastline 0/11. The
   index needs entries, or explicit unsupported markers, for these branches.
4. **The materialized regime is unsupported.** GPU prepare of the materialized terrain never completes. It stays
   `preparing` with reason `behind`, and the canvas never shows. This blocks any materialized parity measurement and
   is the next cause for that regime. It was not fixed in this job.

## 7. Read-only audit (native Haiku, Explore agent)

**Confirmed:**

- Oracle purity: pass A is pure, pass B is `needsFallback`-gated, and `pickRelief` is never called.
- `peekRelief` is read-only, and `pickRelief` = peek + commit.
- `selectAt` is read-only and returns a null relief target and terrain-unsupported.
- The renderer wires `peekRelief`, never `pickRelief`.

**Major findings:**

- **Attribute mutations:** the observer is childList-only, so attribute changes are caught only by the `#terrain` hash
  and the camera probe. Disclosed, not changed. A wider observer would also see benign style churn.
- **Gate pass flags:** the gate did not require ready/aligned. **Fixed** (§3).

**Minor findings (disclosed, not changed):**

- `gpuSelect` calls `pickBurg`/`peekRelief` internally without the `needsFallback` gate. They are read-only, so the
  scene stays pure.
- `mapOffset` is not rechecked after sampling.
- `TradeAnimation` being stopped is not itself a validity condition. The mutation count covers it.
- The `prepareReliefIcons` wrapper misses internal calls. The hash and revision cover them.
- `prepared` is tracked by identity only.
- The guard is not torn down if a pass throws.
- `commitRelief` checks raster identity only.
- A `#terrain` child that has an id would be returned as an element. This is latent; no such children exist today.

## 8. Source and file changes in this job

- `src/renderers/relief-canvas.ts`: peek/commit split and the `pickRelief` compat wrapper.
- `src/gpu/selection.ts`, `src/gpu/renderer.ts`, `src/gpu/compat-pick.ts`, `src/gpu/prepare.ts`: pure `gpuSelect`,
  plus the raster hit-box rule.
- Targeted tests: `src/gpu/picking-protocol.test.ts`, `selection.test.ts`, `relief-canvas.test.ts`,
  `compat-pick.test.ts`.
- `bench/picking-oracle.ts`, `bench/picking-parity.ts` (protocol v2), plus the bench tests.
- Docs: this report and the provisional banners.

No changes were made to deploy, the default, the original repo, the backend, formats, dependencies, credentials,
network, control or harness config, e2e, or the budget. No UI click adapter, SceneDoc or navigation micro-optimization
work was done.
