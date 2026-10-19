# Route state after the full-suite preamble: $10 tranche (2026-10-17)

Verdict: **PARTIAL.** I found the cause: emblem COAs left by the preamble. A paint-exact fix landed and cuts about 14% of
prepare time and 13-17% of resume time. The dominant cost is still unresolved: about 10 s of native CPU per prepare
with the emblem state on. Nothing was deployed. Production candidate 89902648-220c-40b8-8462-dce2bfed06d6 is unchanged,
SVG is still the default, and the working tree is unshipped.

## Minimal prefix and cause

The route-focus case, with no preamble, recovers in about 2.6 s. It slows only when the preamble runs first. The
`fixture` preamble reproduces the slowdown on its own (`check:'integration', focus:'route', cohort:'short',
preamble:'fixture'`), so the full-suite run isn't needed to show it.

1. **The roundtrip load turns emblems on.** The fixture's saved text has `toggleEmblems` on. The fresh page has emblems
   off. At stage `roundtrip`: coas 42, styles 46.
2. **The setting survives the 100k world replacement.**
3. **Route zoom (k=8) shows about 400 emblems.** `renderGroupCOAs` (src/renderers/draw-emblems.ts:165) makes the COA
   renderer (src/renderers/emblems/renderer.ts:295-301) append one `<svg id=…COA…>` per emblem into `#coas`
   (src/index.html:8765, outside `#map`). Each one carries its own global `<style>` for `.secondary/.tertiary`.
   Route-camera snapshot: **coas 403, 5,068 KB, document `<style>`s 407**, defs descendants 24,835, CDP Nodes 1.95 M.
4. **Every prepare then copies all of them.** With emblems on, `prepareMapClone` (src/io/export.ts:333-345) deep-clones
   the referenced COA for every `#emblems use` into the clone's defs. Before the fix, `isolate()` in src/gpu/compat.ts
   kept all of `defs`, so every compat run serialized and decoded all 403 COAs (5 MB) again.
5. **The time is CPU, not waiting.** In the reprepare profile, wall 16,163 ms = task 16,159 ms + wait 5 ms, and
   `(program)` (native, outside JS) is 11.8 s. Style recalc is about 1 s and script about 0.35 s.

Rejected explanations:

- **Background-loop contention.** Idle-second CDP deltas show one timeout per second, with no rAF, interval or
  MessageChannel loop.
- **Renderer recreation.** The renderer stays at id 1, seq 1 throughout.

## Fix (product code)

- `src/gpu/compat.ts` `isolate()`: after the existing subtree isolation, defs-level `<svg id>` documents directly in the
  root are pruned for the duration of a run unless a kept `<use>` reaches them, directly or through another kept
  document. The existing undo reinserts them in reverse order, so the shared per-revision clone is restored before the
  run yields. The cache lifetime is unchanged: still one `prepareMapClone("gpu",{debug:true})` per revision, `#debug`
  kept, no clears.
- `src/gpu/compat.ts` `unreachable(refs, roots)` is a pure reachability helper. It is exact: a defs `<svg>` paints only
  through a `<use>`, and the COA `<style>` rules match only charges inside COAs.
- Regression test: `src/gpu/compat.test.ts` "compat run defs pruning" covers transitive references, duplicate roots,
  foreign and empty hrefs, and the all-unreached and only-the-referrer-unreached cases.

The fix doesn't change visible editing content, canonical targets, revision freshness, the clone/style cache or the
legacy fallback. It doesn't remove any layer or animation and doesn't touch any timeout or threshold.

## Before / after: same prefix (`preamble:'fixture'`, route focus, short cohort)

| metric | control (no preamble, coas 0) | before fix | after fix |
|---|---|---|---|
| reprepare resume | ~2,600 ms (prepare 2,739) | 15,701 ms | 13,673 ms |
| prepare total (scene / clone / screen / world) | ~1.2 s | 9,816 (2,349 / 4,810 / 6,353 / 9,815) | 8,436 (2,374 / 5,036 / 6,144 / 8,434) |
| refine | — | 4,162 ms | 3,494 ms |
| first committed frame | ~1.6 s | = prepare commit ≈ 9.8 s | ≈ 8.4 s |
| full settle (reprepare totalMs) | — | — | 14,152 ms |
| click resume / totalMs | — | 16,191 / 19,776 ms | 13,400 / 17,212 ms |
| cellsOn / cellsOff resume | — | 21,375 / 15,662 ms | 15,958 / 13,060 ms |
| CPU vs wait (reprepare) | — | task 16,159 / wait 5 ms; (program) 11,843 | task 14,153 / wait 3 ms; (program) 10,010; style 942; script 347 |
| CDP Nodes at route camera | — | 1,953,792 | 1,180,563 |

Unchanged correctness signals in the after run: editors 5/5 agree, save/export deterministic, worldReplacement PASS,
label resync 9/9, pageErrors 0, routeFocus PASS (diagnostic).

## Verification (after code freeze)

| check | result | artifact (docs/performance/webgl-rewrite/host-checks/) |
|---|---|---|
| unit | 69 files / 756 tests pass | p1-delegated-1792293245491216000.log |
| build | pass | p1-delegated-1792292661183726000 |
| bench | 38 / 38 pass | p1-delegated-1792293167113264000.log |
| smoke dpr 1 | pass; over16 0.0061686, identical to the pre-fix 0.0061686 (p1-delegated-1792279800005796000); markers (33 compat `<svg>`) paint | p1-delegated-1792293251426382000.json, -gpu.png, -svg.png |
| focused prefix, before | see table | integration-1792291937687067000.{json,log,diagnostics.json,reprepare.cpuprofile,click-resume.cpuprofile} |
| focused prefix, after | see table | integration-1792292667542867000.{json,log,reprepare.cpuprofile,click-resume.cpuprofile} |
| control (no preamble) | ~2.6 s resume | integration-1792279586716482000 |

The only build input changed after the build run is a comment in compat.test.ts.

Skipped checks, with reasons:

- **Short full integration.** The brief gates it on the prefix being fast, and it is still slow.
- **Context and lifecycle.** No refs or scheduling changed.
- **Picking.** Hit geometry is unchanged.

Smoke runs with emblems off, so it doesn't paint emblems through the pruned path. That path relies on the exactness
argument above, not on a pixel check.

## Remaining issues (unverified suspects, in order)

1. **403 global COA `<style>` sheets in the live document.** Each COA brings an identical document-level stylesheet.
   Style matching and invalidation then scale with sheets × elements for the whole page, including the appended
   2M-node clone. This fits the scene phase being slow (2.4 s, untouched by compat) and `(program)` staying around
   10 s. Next experiment, to discriminate: one prepare with the `#coas` `<style>`s deduplicated (or scoped) against
   unchanged. A real fix would emit the shared rule once, not once per COA.
2. **Per-revision COA deep copies in `prepareMapClone`.** One copy per `use`, every revision; the clone phase takes
   about 2.6 s. Copying once per distinct href would be exact.
3. **Harness issue.** In the route-focus probe, the second key's `camera()` settle times out after 30 s
   (bench/renderer-integration.ts:1103), so only the first click is measured. It doesn't affect the numbers above.

## Reason for stopping

Budget. About $4.7 of the $7 CLI limit was spent when work stopped. The rest is held as the brief's verification and
report reserve, so the global-style experiment wasn't started. Rejected experiments are recorded above. Delegation:
route-state-delegation.md.
