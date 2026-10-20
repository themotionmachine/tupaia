# Host gate for the GPU renderer

`bench/gate/gate.ts` is the single entry point for every check that proves the opt-in WebGL renderer
(`?renderer=gpu`). It replaces the harness Codex ran from outside git
(`tupaia-webgl-rewrite-2026-10-13/control/tupaia-checks-v15.py` and `opt-in-run-check.py`). It keeps the same
check names and argument rules, and adds tiers, a blocking host lock with shared and exclusive tiers, and evidence
that lives outside the repo.

```sh
npm run gate -- quick                    # typecheck + vitest + build, no browser
npm run gate -- canonical                # one browser check (takes the host lock itself)
node bench/gate/gate.ts picking dpr=1 zoom=8 phase=motion
node bench/gate/gate.ts golden layers=ocean,borders k=1,4 fixture=shared   # per-layer SVG-vs-GPU golden
node bench/gate/gate.ts browser skip=palette
node bench/gate/gate.ts help             # every check and its arguments
```

Node runs the `.ts` file directly (type stripping), as the rest of `bench/` does. The gate needs `python3` for the
lock helper, plus `node_modules` and the Playwright Chromium that `npm install` provides.

## Output

- **stdout:** exactly one JSON line. For a check it holds `check`, `exit_code`, `failure`, `seconds`, `args`, `metrics`
  (a few key numbers), `dir`, `log` and `report`, and also `images` and `log_tail` when there are any. For a tier
  it holds `tier`, `pass`, `failed_at` and one row per step.
- **stderr:** progress lines, and for a tier a table of the steps.
- **Exit code:** 0 pass, 1 a check failed, 2 a usage or environment error (bad argument, missing `dist/`, missing
  fixture).
- **Evidence:** `${TUPAIA_GATE_OUT:-~/.tupaia-gates}/<worktree-basename>/<check>-<UTC timestamp>/`. Each directory
  holds `run.log`, the check's own report (`report.json` or `<check>.json`), any PNGs, and `summary.json`. The
  summary is the stdout result plus git HEAD, a dirty-file count, the dist fingerprint, the fixture hash and lock
  timing. A tier also writes `<tier>-<timestamp>/summary.json`. Nothing is ever written into the repository.

A check fails on a non-zero exit, on a timeout (exit 124, process group killed), or on the check's own verdict in
its report. Several of the harness scripts exit 0 and record `failure` in their JSON, and the gate reads that field
the way the python harness expected an agent to.

## Host lock

Browser/GPU checks hold a **blocking** `fcntl.flock` lock in one of two tiers (PHASE1-PLAN.md D7). The code is
`bench/gate/host-lock.ts`, which drives a small python3 helper.

- **Shared** (correctness checks): at most `TUPAIA_GATE_SLOTS` (default 2) run at once, across every worktree.
  Correctness does not need a quiet host, so these checks no longer queue behind each other one at a time.
- **Exclusive** (timing checks): nothing else runs in a browser. The check waits for every shared holder to drain.
  While an exclusive request is waiting, new shared requests queue behind it, so a stream of shared runs cannot
  starve it.

The files involved:
- `/tmp/tupaia-host-gates.lock` (`TUPAIA_HOST_LOCK`) is the main lock. Shared holders take `LOCK_SH` on it and
  exclusive holders take `LOCK_EX`. This is the same file and the same `LOCK_EX` that the scratchpad `hostlock.py`
  takes, so a job wrapped in `hostlock.py` is exclusive: it waits for shared gates to drain, and gates wait for it.
  `hostlock.py` does not use the turnstile below, so it can still be overtaken by later shared runs, but it never
  runs at the same time as one.
- `<lock>.intent` is a turnstile. A gate takes it before it asks for the main lock and drops it once it holds that
  lock. A waiting exclusive request therefore holds the turnstile, and that is what blocks new shared requests.
- `<lock>.slot0 … slotN-1` cap the shared tier. A shared holder also holds one slot file.

| Lock | Checks |
|---|---|
| none | `typecheck`, `unit`, `build`, `bench`, `boundary-before`, `boundary-after`, `paired-summary`, `lock-probe` (it takes the lock itself, in its `mode`) |
| shared | `smoke`, `fidelity`, `context`, `lifecycle`, `hatch`, `canonical`, `palette`, `package-smoke`, `paint`, `picking`, `integration`, `replay`, `replay-selftest`, `metrics`, `golden`, `golden-selftest`, `consumers`, `consumers-selftest`, `toggles`, `resize-print`, `customization`, `memory-cycles`, `presets`, `census-selftest`, `corpus`, `corpus-selftest`, `labels`, `labels-selftest`, `reuse-fidelity`, `reuse-fidelity-selftest`, `stroke-probe` |
| exclusive | `navigation`, `native-recovery`, `restore`, `trade-live`, `timing`, `profile`, `gpu-timing`, `paired`, `replay-resume` |

Two classifications are judgement calls. `integration` is shared because it gates on correctness cohorts; when a
route-resume latency criterion (D4) lands, that measurement belongs in its own exclusive check. `native-recovery`
is exclusive because its recovery CPU profile is a timing.

- A tier takes one lock at its first browser step and holds it until the tier ends, so nothing slips in between its
  steps. It takes the strongest mode any of its steps (minus `skip=`) needs: `browser` and `nightly` take a shared
  slot, and `full` takes the exclusive lock. The build runs before any lock is taken.
- `nightly` is the exception: it releases its shared slot after every golden step and takes it again for the next.
  A timing run queued during the 3–4 h matrix holds the turnstile, so it gets the host at the next step boundary
  instead of freezing every job until morning. **Open for Ryan:** PHASE1-PLAN's T2 table lists the nightly golden
  as exclusive; it is shared here because it is correctness work. Change `DEFS.golden.lock` or give `nightly` its
  own mode if you want it exclusive.
- A fixture problem (such as a missing parity map) is reported before any wait for the lock.
- If the gate is itself running under `hostlock.py` (detected from the process ancestry) or under another gate
  (`TUPAIA_GATE_LOCK_HELD` set), it does not lock again, because locking again would deadlock against the parent.
- The lock dies with the gate: the helper exits as soon as the gate's pipe closes, so there is no stale lock to
  clean up. Browser children run under `nice -n 5`.
- `gate lock-probe mode=shared|exclusive` takes and releases the lock in that mode and reports the wait and the slot.
  `bench/gate/host-lock.test.ts`, part of `gate bench`, proves the semantics against a private lock file: the slot
  cap, exclusive draining, no starvation, `hostlock.py` interop, and release when a gate dies.

Do **not** wrap the gate in `hostlock.py`. It is harmless, but it turns every shared check into an exclusive one.

## Building dist

`dist/` is what every browser check serves, so a rebuild must not change it under a running check (a check once loaded a
half-written bundle, page error `debounce is not defined`, while a build rewrote `dist/` in place). Two rules:

- **The build is atomic.** `gate build` runs `vite build --outDir .dist-build-<pid>` (a fresh directory next to `dist/`,
  git-ignored) and, only when that succeeded, swaps it in with two renames (`dist` to `.dist-old-<pid>`, the new one to
  `dist`) and deletes the old one. A failed build leaves `dist/` as it was. Old hashed files no longer accumulate in
  `dist/` (vite does not empty an out dir outside its root).
- **A per-worktree dist lock** (`<TUPAIA_HOST_LOCK>.dist-<hash of the worktree path>`, same helper as the host lock with
  no slot cap) keeps a swap from landing mid-check. Every browser check holds it SHARED while it reads `dist/` (a tier:
  from its first browser step to its last; `nightly`, which lasts hours, gives it back between steps), so checks in one
  worktree still run side by side. `gate build` takes it EXCLUSIVE for the swap, so a rebuild **waits for the checks
  reading that worktree to finish** (and checks that start while it waits queue behind it). It logs when it waits. A tier
  also fingerprints `dist/` after its build step (or at its first browser step) and refuses to continue, exit 2, if the
  fingerprint changed before a later step. Other worktrees have their own `dist/` and their own lock.
- Not covered: a build run outside the gate (`npm run build`, `vite build`) writes `dist/` in place and ignores the lock.
  Use `gate build` while checks may be running in the worktree.

## Fixture

The browser checks load the shared-map snapshot `shared-v8` (sha256 `f5c0d703…79f5c0`, 4.9 MB). The gate looks for
it in this order:
1. `TUPAIA_GATE_MAP`, if set (a different map triggers a warning).
2. `~/.tupaia-gates/fixtures/shared-v8-f5c0d703.map`.
3. `/tmp/tupaia-navigation-shared-v8.map`, which is copied into the cache on first use so a `/tmp` purge cannot
   lose it.

A pristine copy is also kept at `tupaia-webgl-rewrite-2026-10-13/control/fixtures/shared-v8-f5c0d703.map`. The
snapshot is live shared-map content, so it stays out of git.

## Checks

The runtimes are typical M1 Max wall times, without lock wait.

| Check | Lock | What it proves | Runtime |
|---|---|---|---|
| `typecheck` | no | `tsc` over `src/` (the tsconfig scope) is clean. | ~3 s |
| `typecheck-bench` | no | `tsc -p tsconfig.bench.json` over `bench/host/**` and `bench/gate/*` under the same strict settings as `src/` (`noUnusedLocals`/`noUnusedParameters` off: the bench scripts are written for node type stripping). `bench/host/labels.ts` is excluded (eight pre-existing errors, owned by the label packet; remove the exclusion once they are fixed). Before this step a type error in the harness (a result field missing from its declared type) surfaced only when someone ran `tsc` by hand. | ~2 s |
| `unit` | no | `vitest run` is green. | ~6 s |
| `build` | no | `tsc` then `CF_BUILD=1 vite build` (= `npm run build`). `typecheck=false` skips the tsc step. Browser checks serve the resulting `dist/`. Atomic and dist-locked: see "Building dist". | ~5 s |
| `bench` | no | Node unit tests for the bench math: A/B stats, compare, frame budget, trace, fidelity metrics, golden metrics and PNG codec, picking oracle, and the host-lock tiers. | ~15 s |
| `canonical` | shared | `bench/direct-integration-metal-local-init.ts`, rendering-only, dpr 2, zoom 2, short cohort, under the Metal ANGLE backend. The GPU path initialises locally, resyncs labels and routes, round-trips save/export, and falls back cleanly to SVG on teardown. This is the opt-in acceptance smoke. | ~105 s |
| `palette` | shared | `bench/host/palette.ts`: command-palette and keyboard creation flows across the svg, gpu and gpu-select arms, with exact settled-paint parity between rendering-only GPU and GPU-select. **Known failing on gpu/rewrite (2026-10-19)**: `#commandPaletteResults` never shows an option in the svg arm. Being fixed separately. | ~45 s |
| `picking` | shared | `bench/picking-parity.ts` (protocol v3): the semantic outcome of `window.gpuSelect` against the SVG `clicked()` oracle (`elementFromPoint`, cache-busted, plus the canvas fallbacks) on the parity fixture, the shared map and the 100k world, at up to four planned views per world. D3 gate: every cohort with n≥50 at ≥99.5%; burg, label, marker, river, ice and regiment must reach n≥50 on parity and shared. Samples whose SVG outcome changes within 0.25 CSS px (the disclosed edge band, `PICK_EDGE_BAND`; 0 = strict) leave the 99.5% cohort gate but are gated at their own floor: the world's band samples and every band cohort with n≥50 must agree at ≥97%, so a hit-shape regression smaller than the band still fails. A strict all-samples tally is reported beside the gate. `phase=motion` reports every cohort and gates none (it exits 0 unless the run errors); only `phase=settled` gates. Raw `gpuPick` agreement is reported only. Arguments are `dpr`, `zoom`, `phase=settled\|motion`, `reliefMode`, `denseLabels` and `launcher` (default metal). | 2–4 min |
| `integration` | shared | `bench/renderer-integration.ts`: editors, stale-fallback, save/export round trip, resync, marker and route cohorts under the GPU renderer. Arguments are `cohort=short\|full`, `focus=all\|route`, `preamble` and `launcher=metal\|swiftshader`. The gate fails unless **every** verdict is PASS: UNTESTED and UNDERCOVERED fail. The default `metal` launcher (new-headless Chromium, ANGLE on Metal) is checked against the WebGL adapter string; `swiftshader` (Playwright's headless shell, CPU WebGL) only reproduces the pre-W1 runs, whose slow frames let d3's zoom "end" land before the stale clicks and left the route and marker cohorts UNTESTED. The report's `staleWindow` gives each cohort's eligible count and wheel-to-click time. The route-undo cohort is retired (it timed the undo of a route the editor had not changed). | ~4–5 min (short) |
| `replay` | shared | `bench/host/editor-replay.ts`: each script in `bench/host/editor-scripts/` (one file per editor: the W1 five burg, label, marker, relief and route; the regions, terrain and statistics editors biomes, charts, cultures, diplomacy, heightmap, heightmap-keep, namesbase, provinces, religions, states, world, zones; and the features, overlays and object editors) is recorded on the svg arm of the parity fixture, then replayed under `gpu` and `gpu-select` at the same frozen camera and client points. Each step must match the recording: pack/grid hashes (plus `biomesData`, `options`, `mapCoordinates`, `nameBases`, `notes`, `rulers` and the units settings, top-level lets of main.js), the model-DOM hashes (with the pixels of every 2d canvas inside svg#map: the manual-assignment paint overlay, the heightmap editor's `#heights`) and net attribute/child deltas (dense-zoom overlays, culling classes and blob: URLs normalised away), dispatchClick and editor call counts (double or missing dispatch), dialogs, and no camera move mid-step or mid-brush. A GPU arm must also be suspended with its canvas hidden while the editor is open, and must resume after the close, to a current and then a refined frame. A GPU arm must also have reached a current frame (`settledMs` not null) after every step that leaves no editor open except `display`. Scripts open an editor from the Tools panel (`open`), drive form controls by id or selector, and may end through another button (`close via`, the heightmap editor's Exit customization). Every script runs in its own browser context and page (a fresh boot, then the fixture), so no state leaks between scripts and the `editors` order does not matter: on one shared page, `loadMap` left main.js's camera globals and the editors' own DOM (the relief editor's pressed bulk-add button) behind, and `relief` before `relief-icons` failed. **Stale resume (D13).** After a session in which an editor dialog was open closes, no GPU frame older than the latest DOM revision may be on screen — judged only when the session changed what the SVG shows, net: the model-DOM hashes (2d canvases included) or the coat-of-arms model differ between the step before the first dialog opened (the *base*) and the close. A session that ends where it began (burg icons swapped and restored; apply, restore defaults, apply) is exempt, **but only when the base step's GPU frame was settled** (`gpu.pending === false`): from a frame already behind at the base, a stale frame would pass any net-unchanged session, so an unsettled or unknown base gets no exemption. Limit: the base is the last step before the *first* dialog opens, so a script that edits in a customization mode before any dialog opens (the heightmap editor, then the template editor) has those edits folded into the base; they are not part of the judged session. Arguments are `editors=all\|a,b`, `arms`, `dpr`, `launcher` and `fixture` (default parity: the scripts name its entities). | ~2.5 min for five editors, longer for all |
| `replay-resume` | exclusive | `replay` with the arms run one after another, so the `resume` rows (close to current frame, close to refined frame) are timings. | ~3.5 min |
| `replay-selftest` | shared | `replay` of the label script with pack, the model DOM and the dispatch count corrupted on the gpu arm. It passes only if all three are caught. | ~25 s |
| `smoke` | shared | `bench/host/gpu-smoke.ts`: the GPU path activates without fallback, trade animation advances, and the GPU frame is compared with the SVG frame (`diff`). `layer=` isolates one layer (the golden's isolation, `golden-isolation.ts`) for diagnosis only. Unlike `golden`, smoke and fidelity switch on only heightmap and relief: any other family whose app toggle is off (biomes, for one) captures a blank frame, and smoke has no emptiness check, so it does not fail. Use `golden layers=<family>` for a judged single-layer run. | ~40 s |
| `fidelity` | shared | `bench/host/gpu-fidelity.ts`: smoke plus a diff heatmap PNG and the top 20 error hotspots. Diagnostic only. | ~40 s |
| `context` | shared | Smoke plus an injected WebGL context loss, then restore. | ~45 s |
| `lifecycle` | shared | Smoke plus 20 map reloads with forced GC. Reports JS heap growth and context loss/restore. | ~3 min |
| `hatch` | shared | `bench/host/hatch-motion.ts`: hatch pitch and phase stay stable across camera-only zoom and pan, with no re-prepare. | ~30 s |
| `navigation` | exclusive | `bench/host/native-navigation-pilot.ts`: CDP-injected pan-near, pan-wide and wheel-zoom on shared and 100k. Reports frame p95, event-to-rAF p95 and the GPU-presented fraction. Fails only on errors; timings are descriptive. | ~2–3 min |
| `native-recovery` | exclusive | `bench/host/native-recovery.ts`: moving-pick proof, recovery CPU profile and context loss while moving (defaults to world 100k, gesture wheel-zoom). | ~1–2 min |
| `restore` | exclusive | `bench/host/restore-timing.ts`: WebGL context loss **at rest** on a settled camera (world `100k` generated, or `shared`), restored `reps` times per arm. Reads the renderer's restore clock (`lossToDrawMs`, `prepareMs`, prepare steps) and hover event-to-rAF while restoring, and diffs the settled frame before the loss against the one after (over16 count). `arms` is a comma list of URL-parameter sets applied with `history.replaceState` and interleaved ABBA, e.g. `arms=gpu-restore-retain=0,base` or `arms=gpu-slice-ms=12,gpu-slice-ms=50`; `cold=1` bumps the DOM revision right before each loss. Timings are descriptive; it fails only on errors or a restore that does not draw. | ~4–8 min |
| `trade-live` | exclusive | `bench/host/trade-live.ts` (W3b PAINT): the parity fixture with its preamble (every layer on) at `dpr` (default 2), two arms alternated `reps` times (default 3): trade caravans **live** (`TradeAnimation.restart()`, 30 concurrent) and **frozen** (`__cons.freezeTrade()`). Per arm: 2 s idle (fps, frame p95, main-thread Layerize/Paint from a Chrome trace, GPU frames, caravans moved as the GPU mirrors them, caravan transform attributes written to the SVG) and a forced re-prepare (`gpuRenderer.invalidate()`) timed to the new revision on screen (`currentMs`) and to the end of its refinement (`refinedMs`). **Fails** when the live median `currentMs` exceeds 2x the frozen median, when the live arm has no moving caravans, on page errors or a fallback to SVG. Evidence: `trade-live.json`. | ~3 min |
| `metrics` | shared | G-C fidelity (PROOF-PLAN §4). By default (`manifest=fresh`) it captures the 8 dpr×zoom cells from the current `dist/` with the smoke harness, then runs `bench/fidelity-metrics-run.ts`. It **fails if any pair misses SSIM ≥ 0.95**. over16 and the conservative reference gate are reported but do not fail it (the P2 baseline is 5/8 over16). `manifest=<path>` re-measures existing captures. | ~6–9 min |
| `paired` | exclusive | One immutable ABBA block (2 SVG + 2 GPU slots) of `bench/renderer-ab-run.ts`, headful Chromium Metal, for `block=1..5`. Records the dist fingerprint before and after; a block fails if dist changed. | ~3.5 min |
| `paired-summary` | no | `bench/host/paired-summary.ts` over five passing blocks from one dist, either the newest set or `dirs=a,b,c,d,e`. Fails if any metric is not comparable. Timing deltas are descriptive. | ~1 s |
| `timing` / `profile` / `gpu-timing` | exclusive | `bench/navigation.ts`, `profile-navigation.ts` or `timer-navigation.ts` on the shared and 100k worlds at dpr 2 (`arm`, `headless`, `trace`). `profile` adds the top self-time CPU frames. | 2–10 min |
| `paint` | shared | `bench/direct-emblem-culling-contract.ts`: synthetic emblem-culling paint and lifecycle contract. | ~5 s |
| `package-smoke` | shared | `bench/host/package-smoke.ts`: the packaged `dist/` boots in default SVG with no WebGL request, and lazy save/export imports resolve. | ~20 s |
| `boundary-after` | no | `bench/renderer-bundle-boundary.ts`: the static module graph for default boot and save/export contains no GPU presentation code (the GPU stays lazy). | ~1 s |
| `boundary-before` | no | The same analysis, but expects GPU code to be **present**. Run it only against a pre-split baseline build; it fails on current builds by design. | ~1 s |
| `golden` | shared | `bench/host/layer-golden.ts`: the per-layer golden (D1, D5). See "Per-layer golden" below. | ~3–4 min for all families at k {1,4}, dpr 2 |
| `golden-selftest` | shared | Proves the golden can still fail and pass, on the shared fixture at k 1: ocean, rulers and goods pass with `gpu_arm=probe` (no SVG shows through the canvas); ocean with `break=drop-batch` fails on a whole-frame gate; rulers with `break=thin-stroke` fails only the D11 coverage gate; goods with `break=drop-icon` fails it too; and (arm `dense-ref`, parity fixture, burgs k 2) the burg icons pass against the vector form of the SVG while the bitmap as shown fails coverage, so the golden still separates the app's blur from a real gap. A harness error or a no-op break fails the check. `reading=` as for golden. | ~3 min |
| `coa-race` | shared | `gate golden` with `coa=late` on emblems at k 2, 4, 8 (parity fixture). The app inserts each emblem's COA symbol into `#coas` (in `svg#defElements`, outside `svg#map`) only after fetching its charges, and the renderer observes `svg#map` alone, so a prepare that precedes a symbol keeps a frame without emblems. The golden pre-renders the symbols (`coa=pre`) and cannot see this. Per cell, `#coas` is emptied, a revision inside `svg#map` makes the GPU build a current, refined frame without emblems, and the symbols are returned (what a late fetch does); the cell must then follow them. The renderer observes `svg#defElements` since W3 LIFE3 (definitions.ts), so it passes: GPU re-prepares after the symbols return (`coaLate.reprepared` true) and draws the emblems. The failure is labelled `lazy-COA race` only when a failing cell has `coaLate.reprepared === false` (the renderer did not follow the symbols); any other failure (GPU not active, a harness error, a metric gap although it did re-prepare) is reported as a plain golden failure. This is its own check, not an arm of `golden-selftest`. It sits in the `browser` tier after `golden`. | ~40 s |
| `labels` | shared | `bench/host/labels.ts`: label fidelity (rows 15, 16, 41), SVG against GPU of one page, on `worlds=parity,shared`. `steps=` any of: `thresholds` (visible label set at ±0.01 k around every visibility threshold of every label group, one group shown at a time), `glyphs` (glyph positions on a 200-label sample: pixel registration per character for every label is the gate; the analytic position of native curved labels from the GPU's own glyph instances is info), `advance` (measureText character positions against SVG per pinned font, text-rendering auto and optimizeSpeed, judged on the cases text.ts draws natively; shaping it routes to compat is reported), `fonts` (built-in, Google, font-URL, local and broken-URL font switches through the Style panel and its add-font dialog, with routing, re-atlas and a labels golden), `zoom` (frames carried within their raster bucket between powers of two: a text-shadow golden on a harness probe layer, and pixel registration of native curved labels). See "Labels" below. | ~6-10 min |
| `labels-selftest` | shared | Proves the label harness can still fail, on the parity fixture: a clean run, `break=freeze` (the renderer stops seeing DOM changes) that must trip the visible-set and re-atlas checks, `break=measure` (measureText ×1.04, and the page's `getStart/EndPositionOfChar` moved 1.5 user units, which text.ts anchors laid-out glyphs on; the harness's reference reads are exempt) whose raw advance model must exceed 1 device px and whose pinned-font strings text.ts's shaping check must route to compat (none routed when clean), `break=shift` (GPU canvas moved 1 CSS px) that must trip pixel registration, and `break=drop` (the GPU arm's right half blanked) that must trip the presence check. Each of those detectors must pass in the clean run. | ~2-4 min |
| `reuse-fidelity` | shared | `bench/host/reuse-fidelity.ts`: compat raster reuse (`src/gpu/compat-reuse.ts`) against the SVG on the parity fixture, page booted with `?gpu-compat-reuse=1` whatever the build default. For each `edits=` (`zoom` k 1.5 to 1.9 in one raster bucket, `move` every marker by (25, 15), `toggle` rulers off, `definition` every pattern, symbol, gradient, marker, mask, filter, clip path or coat of arms that the isolated family (or a group above it) paints through changed with inline `!important` styles: magenta paint, a mask's shapes black, a filter's `flood-color` magenta, a clip path's shapes moved by (40, 40). Families that paint through none are INFO at once; the frame after the edit must show it, kept or re-cut, and the edit must change at least 100 SVG pixels or the cell is INFO. In the default family list on the parity fixture fog, states, goods and compass are exercised (4 of 21; measured 2026-10-20); ocean, texture, coastline, ice and lakes change no pixel and are INFO, and emblems is visible when it runs alone but INFO (1-3 px) when it runs after the `zoom` edit in the same page (cause not investigated). A definition inside svg#map goes through the closure logic of `compat-reuse.ts`; one outside it (coats of arms, goods, compass) is also dirtied globally by the renderer's definition watch) and each layer family (`families=`, default the 21 families with compat runs), the family is isolated, the edit applied, and the frame that reused rasters across it is captured twice, current (settle refinement held, so the base rasters show) and refined; a forced fresh prepare of the same state is captured the same way. Each is measured GPU against SVG and the reused one must be as close as the fresh one (`judgeOnStateFidelity` margins); a cell that reused no raster of the family is INFO, an edit that no family exercised fails as vacuous, and a fresh control that reused anything fails. A capture where the canvas redrew while its screenshot was taken is retried up to 3 times; one that still raced is a FAIL, never an INFO. The settle refinement is held through the renderer's own test hook (`GpuRenderer.holdRefinement`), not a copy of its refine condition. Evidence: `reuse-fidelity.json` (per cell: kept layers, dirty reasons, base and edited runs, metrics) and diff PNGs of failing cells. | ~15-25 min |
| `reuse-fidelity-selftest` | shared | Proves the reuse check can still fail, twice. (1) `edits=move families=markers,emblems break=stale`: `?gpu-compat-reuse-break=stale` makes the tracker ignore every edit, so the moved markers keep their old raster; `reuse.move.markers` must FAIL and `reuse.move.emblems` must PASS. (2) `edits=move,definition families=markers,fog break=definitions`: `?gpu-compat-reuse-break=definitions` blinds only the definition path (the ids a changed definition reaches, matched against each run's reference closure); the fog layer's mask and filter (inside svg#map) edited under the fog family must make `reuse.definition.fog` FAIL while `reuse.move.markers` does not fail, which proves the blindness is confined to the closure logic. (Definitions outside svg#map, such as coats of arms, are also dirtied globally by the renderer's definition watch, `definitions.ts`, so they cannot show the blindness.) | ~3-5 min |
| `consumers` | shared | `bench/host/consumers.ts`: the document's consumers (REWRITE-PLAN rows 31-38 and 40), `?renderer=svg` against `?renderer=gpu` on the same world and build, on the parity fixture and the shared fixture (`worlds=parity,shared`). Text save (46 sections, SVG at index 5, identical between arms at a non-identity camera, I8 I9 I11 I12 I15), binary save and `ldb` lastMap and reload round trips (I14), cloud save/load/conflict/versions/restore against a mocked Worker (no network), SVG/PNG/JPEG/tiles exports, the `mesh` texture and the 3D view (mesh and satellite), the transform tool's 4x preview, the minimap (viewport rectangle, click target, and that the gpu canvas resumes on close; whether opening it suspends the canvas is recorded as INFO and varies by build: not suspended at W1 CONS, suspended with "editor dialog open" at the wave 1 merge), the elevation profile, charts and emblem dialogs, the heightmap preview, and a hash of `window.pack`/`grid` that the renderer must not change (row 40). JPEG outputs (export and emblem) are decoded by the browser and compared as pixels, not by size. The satellite noise floor comes from the svg arm only. Row 33 (load + migrations) is reported as `SKIP` with the note UNTESTED here: both fixtures are 1.130.1, so no migration runs; `corpus` covers it. Raster output is compared exactly; a tiny difference counts as rasterizer noise only when the SVG handed to the rasterizer is byte-identical between arms (the bound is `RASTER_NOISE` in `consumers.ts`; `control=1` runs a second svg page instead of the gpu arm to measure it). The gpu arm must stay on the gpu path through every probe. `break=save-tamper\|export-tamper\|tamper` perturbs the gpu arm's save and/or PNG export; see `consumers-selftest`. Evidence: `consumers.json` (every check with its status and file) plus the saves, exports and screenshots of both arms under `<world>/{svg,gpu}/`. | ~15-25 min |
| `consumers-selftest` | shared | Proves the consumers harness can still fail: runs the `save` and `export` steps on the parity fixture with `break=tamper` (the gpu arm's text save and PNG export are perturbed) and requires `save.arms-equal`, `save.svg-section-identical` and `export.png` to FAIL, with no harness error and no other unexpected failure. | ~6 min |
| `stroke-probe` | shared | `bench/host/stroke-probe.ts`: a synthetic `#strokeProbe` layer on a generated map, SVG arm against GPU arm at `dpr` (default `1,2`) × `k` (default `1,4`). **Lines:** horizontal probe lines (solid widths 0.25–2.5 and the default style's dash styles: `2` butt, `0 2` round dots, `.8 1.6`, `1 2` round, `5`, square-capped `2`); per line, in device px, mean ink width (column coverage), dash duty, pitch (autocorrelation), phase (GPU against SVG cross-correlation) and the along/across aspect of round dots. A line fails when width differs by more than 1 px, pitch by more than 1 px, phase by more than 1 px, a dot's aspect by more than 0.25, or an arm is empty (PROOF-PLAN §4 strokes). A line is `not comparable` (counted apart, never as a pass) for sub-pixel dots SVG drops while GPU stays below 0.1 px of mass, and for the aspect of dots under 2 device px or with no measurable mass. **Joins:** zigzag polylines with 60–135° turns (miter, round, bevel), a dashed borders-style zigzag, crossing subpaths in one path and a translucent self-crossing path; each fails on any notch (a pixel SVG covers ≥ 0.9 that GPU leaves ≥ 0.35 lighter), any spur (the reverse) or an ink mass more than 10% from SVG's. Evidence: `stroke-probe.json` and `probe-d<dpr>-k<k>-{svg,gpu}.png`. | ~1 min |
| `toggles` | shared | `bench/host/toggle-census.ts` (REWRITE-PLAN rows 26 and 27, gate gap 11): every `toggle*` layer function, through the real `#mapLayers` button on the parity fixture (`only=` narrows to bridge layer names). Passes (`passes=`, default `isolated,trade,reorder`): **isolated** isolates each layer (golden-isolation), then toggles it off and on and, after each, compares the button class, the SVG display, the layer report (`rendererStatus().gpu.layers`), the GPU state and a pixel capture of both arms; off: the SVG and the GPU paint no ink and the layer report shrinks (a root overlay reports none), on: the GPU paints at least `onInkRatioMin` (0.3) of the SVG's ink (a coherence floor), and each toggle commits at most `maxPreparesPerToggle` (1, the measured cost: one full prepare per click, 31 layers off and on) prepares (row 26 "prepares per toggle"). **On-state fidelity** (`toggle.<layer>.on-fidelity`): the GPU against the SVG for the isolated layer is captured before the off click, and after the round trip it must look the same (`judgeOnStateFidelity`: D1 when the baseline is inside it, otherwise no worse, plus margins of 0.01 SSIM, 0.2 points of whole-frame over16, 3 points of over16-of-ink and 0.05 of the ink ratio), so a frame left mid-fade or redrawn with stale fills fails while its footprint still matches. Both sides are GPU against SVG, never GPU against GPU. The golden verdict of the on-state cell is reported as info (the golden's open gaps are `golden`'s business; `strict=1` gates on it). **trade** is the `data-layer-off` round trip: markers off, save, attribute set, load, honoured, markers on. **reorder** moves a layer with `moveLayer` above and below its neighbour (cultures/biomes, heightmap/biomes, religions/cultures) and requires the SVG frame to change and the GPU frame to follow within D1 of the SVG. A coverage check compares the buttons, the census rows and the defined `toggle*` functions, so a new layer toggle cannot slip past. `cost=` is not a pass of the default run: `passes=...,cost` adds whole-scene timings (a timing, run it alone). `break=freeze-gpu` stops the GPU following DOM changes and `break=perturb-on` draws the GPU canvas alone hue-rotated (white and grey untouched) after the layer is turned back on; each run must FAIL (`census-selftest`, the second on `on-fidelity` only). Measured `passes=cost` (whole scene, all 31 layers on, `metal`, dpr 2, exclusive lock; the gate takes it automatically when `passes` contains `cost`): every toggle commits exactly one full prepare (62 prepares for 64 clicks; Trade commits none), a prepare costs 13-16 s and a click reaches a current frame in 34-39 s; `markets` off is an outlier (a 74-93 s prepare, 127 s to a current frame, reproduced alone, so the cost check fails it on the 120 s wait): the whole-scene toggle cost is the row 26 perf finding, not a flag flip. Evidence: `toggles.json` (rows per layer and step with prepares and telemetry) and pixel diffs of failing steps. | ~11 min (668 s measured) |
| `resize-print` | shared | `bench/host/resize-print.ts` (row 39, PROOF-PLAN "DPR change and window resize"): one page driven through viewport changes (shrink, grow, tiny, restore: the canvas covers the svg exactly, the backing store is css size x min(dpr, 2), the frame is current and within D1 of the SVG on a light scene), a DPR change (CDP `setDeviceMetricsOverride` to 1 and back), a pan and a wheel zoom with a window resize in flight, the print events (`beforeprint` syncs the svg camera and hides the canvas with hiddenReason "printing"; `afterprint` brings the frame back; a real `page.pdf()` runs both) and the 12 built-in layers presets through `#layersPreset` (class, select, svg display, layer report coherent; a whole-frame SSIM smoke floor of 0.80 for political, biomes and heightmap, not D1). KNOWN GAP `dpr-change-backing`: the backing store does not follow a DPR change (`resize()` runs on an svg size change or a window `resize` event only), reported as INFO, a failure with `strict=1`. Both directions are exercised: `dpr=2` (default) goes 2 to 1 (a wasted but sharp backing store), `dpr=1 steps=dpr` goes 1 to 2 (the harmful direction: the frame stays at the 1x backing store, 1280x720 where 2560x1440 is expected; measured, the follow-up belongs to the owner of `src/gpu/renderer.ts`). The `@media print` css rule alone does not hide the canvas (its inline display wins); printing relies on `beforeprint` and that is what is asserted. `steps=` selects steps; `break=no-resize\|no-print\|all` stops the renderer's resize and print handling and the run must FAIL. Evidence: `resize-print.json`. | ~3 min |
| `customization` | shared | `bench/host/customization.ts` (row 25): the editor suspension against real editor entry points, with the GPU canvas hidden while an editor owns the SVG. States manual assignment (customization 2) and heightmap edit (customization 1): entering hides the canvas within 1.5 s with hiddenReason "editor customization N"; wheel, drag and wheel keep the svg transform equal to the d3 camera; `saveMap` is refused ("cannot be saved in EDIT mode") and starts no download; leaving brings the canvas back, current, and not worse than its pre-entry frame against the SVG. The heightmap image-converter overlay (`#canvas`, redrawn from main.js `camera()` when the GPU declines the camera) is redrawn on camera updates in both arms, with its final transform equal to the camera and the GPU canvas hidden. A save outside customization carries an empty `#ruler` and `#tradeAnimation`. `modes=` selects modes; `break=no-watch` blinds the renderer's editor watch and the run must FAIL. Evidence: `customization.json` and pixel diffs of failing exits. | ~3 min |
| `memory-cycles` | shared | `bench/host/memory-cycles.ts` (gate gap 16): `cycles=` (default 20) world replaces of the parity fixture in one page, then `resizes=` (default 12) viewport resizes, each snapshot after the frame is current and refined and two forced GCs: JS heap, DOM counters (CDP), the renderer's tracked GPU bytes and CPU payload, GPU canvases, and that the same `GpuRenderer` is still the one. Judged between the warm-up cycle (3) and the last: heap +2 MB / 5 %, DOM nodes +NODES / 0.3 %, listeners +60, no extra document or canvas, tracked bytes within 2 %. The limits are calibrated from the measured series (heap +0.5 MB and DOM nodes +204 over 17 judged cycles; NODESNOTE); tighten them as nightly history accumulates. `renderer=svg` runs the same cycles on an SVG-only page to attribute growth to the app rather than the GPU renderer. `steps=world,resize` selects steps; `break=leak` retains about 20 MB of heap objects and 800 nodes per cycle and the run must FAIL. Evidence: `memory.json` (every snapshot). | ~20 min |
| `presets` | shared | REWRITE-PLAN row 28: the layer golden for each built-in style preset (`preset=all` or a list; `default` is always run as the baseline) at gate scale (`k=1,4`, dpr 2, `fixture=parity`), summarised by preset: cells, failures, failures INDUCED by the preset (counted per D11 gate: ssim, over16, populated, the reading's changed-pixel gate (over44 by default) and per-layer coverage; a cell is induced when at least one of them passes under `default` and fails under the preset, and `inducedFromPass` counts the strictest subset, cells that pass every gate under `default` and fail under the preset, so a layer that already fails another gate under `default` cannot hide a regression, e.g. texture at k1 under `ancient`), the native/compat share of its routed elements, hard failures (the golden's own phrases: "GPU not active", "GPU frame did not settle", "harness:"; anchored, so a metric message that mentions a fallback is not one) and the worst cell. Hard failures fail the check; induced metric failures fail past `allow=` (default 0) per preset. Failures under `default` itself are the golden's open gaps and are listed, not charged to the preset. No census expectations are applied (they are for `default`). Evidence: `presets.json` (rows and compat share by family and preset), `golden.json`, PNGs of failing cells. The nightly golden steps already compute these cells at more zooms; this check is the per-preset view at gate scale and runs on demand. | ~37 min (13 presets x 74 cells, measured 2248 s) |
| `census-selftest` | shared | Proves each census check can still fail: for `toggles` (rivers, borders: `freeze-gpu`, and `perturb-on` which must fail `on-fidelity` alone), `customization` (states), `resize-print` (resize, print) and `memory-cycles` (5 world replaces) a clean arm must pass and the same arm with its `break` switch must FAIL on a real check of the expected family, not on a harness error. `only=` runs a subset of the arms (`toggles`, `toggles-on-state`, `customization`, `resize-print`, `memory-cycles`). | ~15 min (measured 809 s for the four original arms, 54 s for `toggles-on-state`) |
| `corpus` | shared | `bench/host/corpus-load.ts`: REWRITE-PLAN row 33. The maps in `tests/fixtures/corpus/` (CORPUS.md: real saves written by old versions of this app, 0.9b to 1.123, plus `demo.map`) are loaded through `uploadMap` under `?renderer=svg` and `?renderer=gpu`. Per map: it loads and migrates (or, for the 0.9b file, is refused as ancient), no page error, one `#tradeAnimation`, the gpu arm stays on the gpu path through the load and two reloads, pack/grid hashes and the document census (elements, drawables, visibility per layer) are equal between the arms, the gpu scene routes every visible layer, the text save is equal between the arms (date and map id masked), saving and reloading twice is a fixed point, and a per-map layer golden at k 1 (the file's own style, over44 reading, layers with nothing to paint reported as empty) passes. It also checks that every `isOlderThan` gate in `auto-update.ts` is triggered by some map that must load, except the gates the manifest lists as unreachable (`1.0.0`). `control=1` runs a second svg page instead of the gpu arm; `golden=0` skips the golden children; `maps=id,id` picks maps. Evidence: `corpus.json` plus saves and golden cells under `<map>/`. | ~12-20 min |
| `corpus-selftest` | shared | Proves the corpus harness can still fail: `legacy-v1.123` with `break=tamper` (the gpu arm's first save and census are perturbed) must fail `save.arms-equal-1` and `census.arms-equal`, with no harness error and no other unexpected failure. | ~2 min |
| `lock-probe` | (takes it) | Acquires and releases the host lock in `mode=shared\|exclusive` (default exclusive) and launches nothing. Shows whether another job holds the lock, which slot you got, and how long you waited. | 0 s + wait |

The scripts in `bench/host/` are ports of the Codex `control/*.ts` checks. They resolve the repo root from
`import.meta.dirname`, write into `GATE_OUT_DIR` and read `GATE_MAP`, so they run from any worktree. The dated
originals were renamed: `overnight-palette-check-20261019.ts` became `palette.ts`,
`overnight-native-recovery-20261019.ts` became `native-recovery.ts`, and `opt-in-package-smoke.ts` became
`package-smoke.ts`.

## Tiers

Each tier runs its steps serially and stops at the first failure. Pass `keep_going=1` to run the rest anyway, or
`skip=a,b` to leave steps out; skipped steps are shown as SKIP in the table.

| Tier | Steps | Runtime |
|---|---|---|
| `quick` | typecheck → typecheck-bench → unit → build | ~25 s |
| `browser` | build → *shared lock* → canonical → palette → picking → integration (short cohort) → golden-selftest → golden (D5 gate scale: all families, k 1,4, dpr 2, default preset, `fixture=parity`) → coa-race → reuse-fidelity-selftest → reuse-fidelity → replay-selftest → replay → consumers-selftest → consumers → **toggles → customization → resize-print** (wave 2 census) | the earlier steps' time (replay and consumers were added after the ~15–17 min first measured) plus ~16 min for the census steps (11, 3, 3) plus ~11 min for the two reuse-fidelity steps (measured 109 s and 566 s on a shared host, 2026-10-20; the bar for putting them in this tier was 25 min together) |
| `nightly` | golden × 24, each under its own *shared slot* (released between steps): dpr {1,2} × the 12 built-in presets, each step all families at k {1,2,4,8} plus the coastline switch points 1.4/1.6/2.5/2.7 (`coastk`), `fixture=parity`, `keep=fail`; then `picking` at zoom 1 and at zoom 4 (`picking[k1]`, `picking[k4]`; the browser tier runs zoom 2; `phase=motion` gates nothing, so no tier runs it); then `memory-cycles`, `census-selftest`, `corpus-selftest` and `corpus`. Always runs every step (`keep_going` is implied), so a failing picking step is recorded without stopping the matrix. | ~3.5–4.5 h (the two census steps add ~35 min, the two picking steps ~5 min) |
| `full` | *exclusive lock* → browser → fidelity → navigation → trade-live → metrics (fresh) → paired blocks 1–5 at dpr 2 → paired-summary | ~50–55 min |

**`reuse-fidelity` and its self-test** (W3 COST, compat raster reuse now on by default) are in `browser`: a stale reused raster is a fidelity bug that default-on reuse makes reachable, they cost about 11 minutes together, and the self-test keeps the check from passing vacuously (it did once, on the merged head, until the page ran with first details off).

**Where the census checks run, and why.** `toggles`, `customization` and `resize-print` are in `browser`: together
they are about 16 minutes (measured 668 s, 166 s and 154 s on a loaded host, `metal`), they cover rows 25, 26, 27 and
39 that nothing else gates, and they found real defects while they were written (the burg toggle leaving its icon
rasters, a prepared frame retaining every frame before it, the DPR change not reaching the backing store). `memory-cycles` (1201 s) and `census-selftest`
(about 15 min: it runs each census check twice) are in `nightly`: 20 world replaces and 12 refined resizes cannot be
shortened without weakening the claim, and a self-test that re-runs four scripts twice is the wrong cost for every
merge. The nightly `golden` steps already compute the cells that `presets` summarises, at more zooms. `presets` (the
per-preset view of row 28 at gate scale: 12 presets plus the `default` baseline, k 1,4, dpr 2) therefore runs on
demand rather than in a tier: `gate presets` (`preset=ancient,monochrome` for a subset). Run `census-selftest` when
`bench/host/census-*.ts`, `toggle-census.ts`, `resize-print.ts`, `customization.ts` or `memory-cycles.ts` change.

The `golden` step of `browser` and the whole of `nightly` need the parity fixture from the FIX packet. Until it
exists, the step fails with a usage message. Run `gate browser skip=golden` and report the skip.
(`golden-selftest` uses the shared fixture and does not wait for it.)

Inside a tier, a usage error that belongs to one step (a missing parity fixture) is recorded as that step's FAIL and
the tier goes on as configured. An environment error that every later step would hit too (`dist/` missing) stops
the tier with exit 2.

## Which tier a stage runs

- **Every child stage or commit** that touches `src/`: `quick`. It needs no lock and is cheap. A child stage also
  runs the one browser check that proves its own change (for example `picking` for a picking fix, `palette` for
  the palette fix, `hatch` for hatch shaders), never the whole browser tier "to be safe".
- **A parent stage merging children** onto the integration branch: `browser`. The parent owns this tier. Children
  can carry less than full confidence because this tier must pass before the merge lands.
- **Before any deploy candidate** or a change to what the plan claims about performance or fidelity: `full`. Its
  evidence directory is what a deploy review cites.
- **Bench-only changes** (`bench/` code, not `src/`): `bench`, plus the browser check the change affects.

While the palette failure is open, a parent can run `gate browser skip=palette` and must report the skip.

## Per-layer golden

`gate golden` is the G-C golden of PROOF-PLAN §4, read per layer family as decided in D1. For each
(preset, dpr, family, k) cell it renders **one** build with only that family visible. From that single DOM state it
captures the GPU arm (canvas shown) and then the SVG arm (canvas hidden), both at device resolution. SVG is the
reference and GPU the candidate. **No cell ever compares GPU against GPU.**

Arguments:

| Argument | Values | Default |
|---|---|---|
| `layers` | `all`, or a comma list of families (`gate help` lists them; an element id such as `gridOverlay` also works) | `all` |
| `k` | comma list of zoom factors | `1,4` |
| `coastk` | extra zooms for landmass, lakes and coastline only | none |
| `dpr` | `1`, `2` or `1,2` | `2` |
| `preset` | a built-in style preset, a comma list, `all`, or `map` (keep the fixture's own style) | `default` |
| `fixture` | `shared` (shared-v8), `parity` (`TUPAIA_GATE_PARITY_MAP`, `tests/fixtures/parity/parity.map` or `~/.tupaia-gates/fixtures/parity.map`), or a path to a `.map` | `shared` |
| `census` | path to a census expectations JSON | none |
| `reading` | `over44` or `conservative` (see the verdict) | `over44` |
| `keep` | `all`, or `fail` to keep PNGs for failing cells only | `all` |
| `bg` | backdrop `#rrggbb` | `#ffffff` |
| `break` | `none`, `drop-batch`, `thin-stroke` or `drop-icon` (self-test only, see below) | `none` |
| `gpu_arm` | `canvas`, `composite` or `probe` (how the GPU arm is captured, see below) | `canvas` |
| `params` | extra `gpu-*` page URL flags for the run, `+`-joined, e.g. `params=gpu-native-shapes=1` or `params=gpu-fill-aa=0` | none |
| `svg_ref` | `auto`, `vector` or `seen`: the SVG reference of a family the app shows as a bitmap of its vectors (see "SVG reference for dense bitmap layers") | `auto` |
| `settle_ms` | ms between SVG-arm shots that must agree (within 16 px per dpr², 64 px at dpr 2) before the reference counts as settled; `0` = one shot | `400` |
| `coa` | `pre` (every COA symbol rendered before the first capture), `lazy` (left to the app) or `late` (held back until the GPU frame is built, then returned: the lazy-COA race, see `coa-race`) | `pre` |

- **Families.** These are defined in `bench/host/golden-families.ts`. A family is a direct child of `#viewbox`, or
  one of the root overlays `#scaleBar`, `#vignette` and `#legend`. Each carries the REWRITE-PLAN §5 rows it serves.
  A family with an app toggle is switched on through the bridge `display` call before the run.
  `#tradeAnimation` is covered by the animation smoke, and `#debug` is not a family.
- **Isolation** (`bench/host/golden-isolation.ts`, now also used by `smoke`/`fidelity` `layer=`).
  - It hides the other `#viewbox` layers **and** the root overlays. The old `SMOKE_ONLY_LAYER` code left those
    overlays in both arms, so their differences leaked into every layer's numbers.
  - It never forces the target visible. A layer the app hides stays hidden, and the cell then fails as empty.
  - It paints the backdrop on `svg#map`'s parent and makes `svg#map` transparent. Putting the colour on `svg#map`
    itself was asymmetric: the compat lane rasterizes an export clone that keeps the root's inline style, so every
    compat raster became an opaque sheet over the native draws (the ocean pattern hid the native ocean fill).
- **GPU arm.** With `gpu_arm=canvas` (the default) the GPU arm is the canvas alone: an opaque cover of the backdrop
  colour is slipped between `svg#map` and the canvas for that shot, so the SVG underneath can never count as GPU
  output. The cover is outside `svg#map`, so nothing is re-prepared; a re-prepare between the two arms' shots fails
  the cell. `gpu_arm=probe` also captures the composite (canvas over the live SVG, the pre-W2 capture) and the canvas
  over a magenta cover, and fails any cell where either differs from the canvas-only shot. On 2026-10-20 it found
  no pixel of show-through on any parity cell at gate scale (the compat-only lakes that score SSIM 1.0000 are the
  canvas). `gpu_arm=composite` is the old capture, for diagnosis.
- **Page chrome.** The tip bar (`#tooltip`) and the Navigate/Edit indicator are hidden for the whole run: both change
  on their own timers and showed up as "ink" (77K px from a load toast in one blank; 2.5K px of a lagging "Updating").
- **Zoom styling.** The app's zoom styling (label sizes, emblem groups, ruler sizes) only touches layers that are
  visible when the camera moves, and isolation had the family hidden then. Each cell re-runs it with the family
  shown. Every emblem's COA symbol is rendered once at load (`coa=pre`), because the renderer does not observe
  `#coas` (outside `svg#map`): a prepare that races the lazy COA fetches keeps a raster with emblems missing. That
  pre-render hides the race from the golden, so `gate coa-race` (below) tests it on its own.
- **SVG reference for dense bitmap layers (W3 REF).** Since commit 9a5021eb the app shows two layers as one raster
  of their own vectors: the burg icons (`burg-canvas.ts`) and the cell mesh (`cell-mesh-canvas.ts`). The raster is
  cut once at `min(dpr, 2)` px per map unit (the burg SVG is first decoded at 1 px per unit) and shown upscaled by k,
  so in SVG mode it is blurry at every zoom up to 4 (burgs above k 4 swap in crisp vector `<use>`s, `dense-zoom.ts`).
  It never sharpens: the SVG arm held still for 4 s at k 1, 2, 4, 5 and 8, so it is not a transient. What the GPU is
  built to reproduce differs by layer, and `svg_ref=auto` follows that: **burgs** are judged against the *vector form*
  (the same SVG with the bitmap swapped back for its vectors: what saves, exports and editors use; the GPU draws the
  restored vectors on purpose), **cells** against the bitmap as shown (the GPU keeps the displayed asset on purpose,
  `scene.ts` "cell mesh bitmap"). The swap happens after the GPU arm is shot, and the app and GPU settle again before
  the next cell. The other reference is always measured against the same GPU frame and reported (`otherRef`), together
  with how far the bitmap is from its vectors (`bitmapVsVector`). Against the bitmap as shown, burgs measured the
  bitmap's blur (ink ratio 0.21-0.63, every cell k 1-4), not the icons; against the vectors every burgs cell passes
  (SSIM 1.0000, over16 0.000 %). `golden-selftest` keeps this honest (arm `dense-ref`).
- **Settled SVG arm.** Each SVG shot is repeated `settle_ms` later until two agree within `SETTLE_NOISE_PX` (16 px per dpr²: 64 px at
  dpr 2, 16 px at dpr 1, so the allowed share of the frame is the same at both; Chromium's own raster flickers about 9 px
  between identical-DOM shots at dpr 2), at most 10 shots, the last five 1.5 s apart; a reference that keeps changing fails
  the cell as a harness error with the bounding box of the change. **Limit:** a reference that drifts by no more than that
  count per interval is judged settled, so a slow drift under it (about 0.007 % of a dpr 2 frame per interval) is not seen.
- **Verdict per cell (D1, D11).**
  - SSIM ≥ 0.95, over16 ≤ 1 %, and "≤ 0.5 % at Δ ≤ 44", all on the isolated layer's whole frame.
  - The last clause is read as `reading=over44` by default (D11, Ryan 2026-10-19): at most 0.5 % of pixels differ
    by more than 44.
  - `reading=conservative` is the strict reading (P2-FIDELITY-MEASUREMENT, `fidelity-metrics.ts` GATES): changed
    ≤ 0.5 % and max Δ ≤ 44. It fails on invisible rounding and anti-aliasing (91 of 160 parity cells at W1). It stays
    available, and both are always reported (`gates.conservative`, `gates.over44` per cell; a cell that passes
    over44 but not the strict reading carries a note, and `summary.strictOnly` counts them).
  - **Coverage (D11), gated under both readings.** Whole-frame fractions let a small layer lose most of its ink and
    pass, so each cell is also judged on the layer's own ink (pixels that differ from the blank in either arm):
    - ink: `min(inkSvg, inkGpu) ≥ 0.9 × max(inkSvg, inkGpu) − 16`. Symmetric: thinner strokes and dropped icons fail,
      and so do heavier strokes.
    - over16 of ink: `over16 pixels ≤ 0.2 × inkUnion + 16`. At most one in five of the layer's own ink pixels may
      differ visibly.
    - The 16 px slack (a 2×2 CSS-px dot at dpr 2) is the tiny-layer guard: it is negligible for any real layer and
      stops a 30-pixel layer from failing on a few edge pixels (such a layer must keep ≥ 11 px of ink).
    - The numbers come from the W1 parity sweep (`COVERAGE` in `bench/golden-metrics.ts` has the evidence). Cells
      whose differences are rounding or anti-aliasing only reach ratio 0.925 and over16-of-ink 18.5 % (borders k 4, AA
      on dash ends). The real gaps the whole-frame gates missed all fall outside: ratio burgs 0.21–0.63,
      coordinates 0.55–0.67, rivers 0.66–0.89, military 0.60/0.72, borders/routes k 1 0.83, states k 8 0.84;
      over16-of-ink coastline k 1.6–2.5 30–31 %, routes 28–60 % (dash phase), labels k 1 27.6 %, markers k 1/2 30–35 %,
      emblems k 1/2 55–61 %.
  - Each cell gets a `class`: `pass`, `coverage` (only the coverage gate failed), `gap` (a whole-frame gate failed),
    `empty`, `census` (routing drift only) or `harness`. `summary.table` is the per-layer table.
  - A family that paints nothing in either arm fails: an empty layer is a failure, not a pass. Each arm's ink is
    counted against its own blank capture (every family hidden).
  - A GPU fallback also fails the cell, as does any page error or WebGL validation warning during the run.
  - `aborted` lists the requests the route allowlist aborted (each logs "Failed to load resource:
    net::ERR_FAILED"). On the parity fixture it is one: the Google Analytics `gtag/js` script in `index.html`.
- **Census.** For each cell the report records:
  - native/compat counts from `rendererStatus().gpu.layers`;
  - skipped counts and a route × kind × tag × reason histogram from the opt-in `src/gpu/scene-census.ts` sink
    (`globalThis.__gpuSceneCensus`, which is off in normal pages);
  - the compat-run elements inside the family;
  - the visible drawable SVG elements in the family.
  `census.json` in the evidence directory has the shape of an expectations file. Copy it and pass it as `census=`
  to turn any change in native, compat or skipped counts into a cell failure.
  The native/compat counts are the renderer's (after `prepare.ts`), not the scene walk's: for ocean the walk counts
  5 native while the renderer reports 4 native + 1 compat, because `prepare.ts` re-routes the pattern fill. A change
  to `prepare.ts` routing (PERF-A) therefore shows up as census drift; regenerate the expectations file then.
- **Evidence.**
  - `golden.json`: every cell's metrics, gates, census and failures.
  - `census.json`.
  - `cells/<preset>/d<dpr>/<family>-k<k>-{svg,gpu,diff}.png`, plus `blank-{svg,gpu}.png`. The heatmap shows
    unchanged pixels as the faded SVG, 0 < Δ ≤ 16 light blue, 16 < Δ ≤ 44 orange and Δ > 44 red.
  - The JSON result line lists the PNGs of failing cells only.
- **Self-test.**
  - `gate golden-selftest` re-proves on every tier run, on the shared fixture at k 1, that the harness can still
    tell pass from fail:
    - ocean, rulers and goods pass, captured with `gpu_arm=probe` (so the GPU arm is shown to be the canvas alone);
    - ocean with `break=drop-batch` (the bottom-most fill batch removed from the GPU frame, a dropped path) fails on a
      whole-frame gate;
    - rulers with `break=thin-stroke` (every stroke batch at half width) fails the coverage gate while every
      whole-frame gate passes, which is the case D11 exists for;
    - goods with `break=drop-icon` (every 4th leaf draw batch dropped: a quarter of the resource icons) fails the
      coverage gate (its whole-frame gates fail too).
    A break that changes nothing, or a failure on a harness error instead of a metric, fails the self-test. The
    breaks only touch the GPU frame; use them only to show the harness can fail.
  - The metric math (`bench/golden-metrics.test.ts`) and the PNG codec (`bench/png.ts`) are covered by `gate bench`.
  - `break=drop-batch` and the root-family census read the renderer's internal `gpuRenderer.prepared`. If its shape
    changes, the cell fails with a `harness:` message instead of silently counting zero.

## Labels

`gate labels` (bench/host/labels.ts, pure math in labels-core.ts) checks REWRITE-PLAN §5 rows 15, 16 and 41 against
PROOF-PLAN §4 "Labels" and "Fonts". Tolerances are in `TOL` (labels-core.ts), in device pixels.

- **thresholds.** The app's rule (`updateZoomStyling`, MCP overrides included) flips a group's visibility where
  `rn((d + d/k)/2, 2)·k` crosses 6 or 60. `rn()` makes it flicker: several flips within 0.004 k, so flips closer than
  0.02 k form one zone and the probes sit 0.01 k outside it. Each probe shows one group alone, zooms through d3 and
  compares the settled GPU frame with the SVG: every label the SVG shows must keep half its ink in its box on the GPU,
  and the GPU may not paint ink where the SVG paints none outside the visible labels' boxes. The SVG must also obey
  the rule (otherwise the harness says so). `hideLabels` is switched on if the fixture saved it off.
- **glyphs.** Variant `map` is the fixture as saved; variant `native` removes the text-shadow and edge spaces of the
  curved labels, which otherwise send every state label to compat (text.ts `text-shadow`, `whitespace`).
  The analytic check is **info** (W3b GLYPH2): it reads the GPU's glyph instances back (`gpuRenderer.prepared.payload.glyphs` and atlas keys
  `font|0|ink|char`; the reader is `gpuGlyphs` in labels-core.ts, unit-tested against `glyphBaseline`). Since W3
  GLYPH, text.ts anchors a laid-out curved glyph at the SVG's own reported midpoint (`svgCharPositions`), so this
  check compares that anchor plus the central shift with the SVG's midpoint plus the shift Chromium paints: the probe
  extent shift at the label's CTM scale, rounded up to a whole CSS px when the text sits in a tspan/textPath of a
  central `<text>` (`#labels` sets central on the group; painted minus extent was 0 or exactly 1 device px in every
  probe). It does not see the pen offset from the anchor (the half-kern correction below); pixel registration does.
  Each error is also split along the glyph's baseline (advance, path sampling) and along its normal (baseline,
  central shift, dy), so TEXT can tell the two apart. A shape change in those internals is a harness error. Since
  text.ts anchors on the very SVG positions this check compares against, it agrees with the renderer by
  construction; it stays as a diagnostic and **pixel registration is the gate**. The instance is 18 floats (W3b:
  `ascent descent mode` of the central baseline, which the vertex shader rounds per zoom as Chromium does). The
  variant fails when no native curved label was sampled at all (nothing to register).
  Pixel registration finds, per character's extent box, the shift that best aligns the GPU ink with the SVG ink. A
  window where the GPU ink at that shift is below half the SVG ink (or where every shift scores alike) is **missing**:
  it counts against the within-1-px share, and a label whose whole box is missing fails the variant (`presence`).
  Labels whose `getNumberOfChars` fits no white-space reading of their text are not in the glyph sample; they are
  listed under `skipped` (with their group, and a presence verdict) and counted in the summary.
  A world with fewer on-screen (label, zoom) pairs than the sample size is noted, not failed; camera budget a zoom
  leaves unused carries over to the later zooms. Each failing label gets a crop (SVG | GPU | heatmap) under
  `<world>/glyphs/<variant>/crops/`.
- **thresholds** switch `hideLabels` on when the fixture saved it off, and switch it back before the later steps.
- **advance** re-implements text.ts's measured model in the page rather than reading what the GPU produced:
  kerned starts (`width(prefix(i+1)) − width(char i)`) at the raster bucket, always kerned (SVG kerns under
  optimizeSpeed too), measured with no-break spaces so Canvas2D does not shape word by word and drop kern pairs
  across a space (`wholeRun`). HarfBuzz splits a legacy 'kern' table pair (half into the second glyph's x offset), and
  Chromium's `getStartPositionOfChar` then reports that character half its leading kern before the origin it paints
  it at (ink centroids of tspan-isolated characters at 80 px: Times "AVA" 5.1 px, Verdana and Impact up to 4.3 px,
  `<text>` and `<textPath>` alike); GPOS kerning (Cinzel, Arial, most web fonts) reports the painted origin. The step
  reads which one a string uses off the SVG's own character advances, as text.ts `kernOffsets` does, and compares the
  model's prediction of the reported start with it. That checks both the starts the fallback layout (display:none
  labels) draws at and the kerns the SVG-anchored layout corrects with. Strings whose shaping per-character glyphs
  cannot follow (W3 GLYPH found 7/51 fonts: no-break spaces that do not kern like the space, ligatures, contextual
  alternates) are routed to compat by text.ts itself (`shapingReason`, census reason `label shaping`, W3b GLYPH2):
  a per-(font, features) profile on fixed probe strings, then per-string canvas ink (whole run vs per-glyph) and
  SVG-position checks for flagged fonts only. The step asks the renderer's own check (`gpuRenderer.atlas.shaping`)
  per case and **fails on `maxNativePx`, the cases the GPU draws natively**; routed cases are reported (`compat`,
  `compatWithin` = routed although the model was within tolerance, `compatFonts`). `maxCumPx` stays the raw model
  over every case. `break=measure` shows the comparison is not vacuous (raw model) and that the shaping check routes.
- **fonts.** The fonts are served locally: `fonts.googleapis.com/css2` and the font-URL host answer from system font
  files (macOS defaults, `LABELS_FONT_GOOGLE` / `LABELS_FONT_WEB` / `LABELS_FONT_LOCAL` override). The built-in web
  font (Amatic SC) and any other fonts.gstatic.com face come from the network, so this step is not hermetic. The
  golden gates on SSIM, over16, over44 (the D11 reading) and `inkRatio` ≥ 0.9. `inkRatio` is golden-metrics.ts's
  min/max of the two arms' ink pixel counts, so it does not say which arm paints more; the cell's `ink` field
  (GPU/SVG) does. The conservative reading is reported. A `before` cell measures the same golden before any switch,
  and each switch reports its change from it. Each switched group must keep the labels it showed (native + compat).
  A label that leaves the count is reported with its SVG state; when the app itself hid it in the SVG (on shared, the
  state label "Takeet Union of Caucuses" gets `display: none` after the Amatic SC and Baskerville switches, most
  likely from the viewport culling in src/renderers/label-culling.ts as its box changes with the face) it is a note,
  since both arms follow the SVG; otherwise it fails. After the switches the step puts the switched groups'
  `font-family` back as loaded (`restored`; a mismatch fails the step): the last switch leaves the broken face on
  them, and the `zoom` step's probe takes the map's label face, so it would otherwise be a compat run there.
- **zoom** (W3b GLYPH2): cameras between powers of two, which the other steps never use (their k·dpr is a raster
  bucket). Both parts view a frame **carried** within its bucket: prepared at one zoom, shown at another with the
  renderer blind to mutations (what a gesture shows until it settles; the frame identity must hold), rescaleLabels
  off for the step. `shadows`: the GPU draws straight text outside `#labels` natively with its shadow (a shadowed
  label inside `#labels` is a compat run), so the harness adds its own probe layer (five straight texts, 5-24 units,
  in the map's label face; `#labels` hidden meanwhile) with a visible shadow on both arms (glow
  `rgb(200,30,30) 0 0 4px`, offset `3px 2px 2px`), carried 1.1→1.9, 1.9→1.1, 2.2→3 plus a fresh prepare at 1.5. The
  probe's padded boxes are judged as a golden (D1 SSIM/over16/over44 and D11 coverage); a cell where the GPU drew no
  probe text natively with a shadow fails (and names the probe face when it is not loaded). `carry`: pairs 1.1↔1.9 and 2.3→3.7 on the `native` variant; the GPU's
  own glyph instances (native curved labels) are pixel-registered (same TOL as glyphs, plus the normal component;
  labels the zoom restyled are left out). Info, not gated: the labels golden against a fresh prepare of the same
  view (`CARRY_MARGIN`; compat runs carry a raster of the prepared zoom until the settle refines it) and the fresh
  prepare's absolute D11 verdict (`summary.freshD11`). `LABELS_ZOOM_PARTS=shadows|carry` runs one part.
- Page chrome that changes between captures (`#tooltip`, `#renderModeIndicator`) is hidden by a sheet in `<head>`.

