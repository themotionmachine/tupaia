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
| shared | `smoke`, `fidelity`, `context`, `lifecycle`, `hatch`, `canonical`, `palette`, `package-smoke`, `paint`, `picking`, `integration`, `replay`, `replay-selftest`, `metrics`, `golden`, `golden-selftest`, `consumers`, `consumers-selftest` |
| exclusive | `navigation`, `native-recovery`, `restore`, `timing`, `profile`, `gpu-timing`, `paired`, `replay-resume` |

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
| `unit` | no | `vitest run` is green. | ~6 s |
| `build` | no | `tsc` then `CF_BUILD=1 vite build` (= `npm run build`). `typecheck=false` skips the tsc step. Browser checks serve the resulting `dist/`. | ~5 s |
| `bench` | no | Node unit tests for the bench math: A/B stats, compare, frame budget, trace, fidelity metrics, golden metrics and PNG codec, picking oracle, and the host-lock tiers. | ~15 s |
| `canonical` | shared | `bench/direct-integration-metal-local-init.ts`, rendering-only, dpr 2, zoom 2, short cohort, under the Metal ANGLE backend. The GPU path initialises locally, resyncs labels and routes, round-trips save/export, and falls back cleanly to SVG on teardown. This is the opt-in acceptance smoke. | ~105 s |
| `palette` | shared | `bench/host/palette.ts`: command-palette and keyboard creation flows across the svg, gpu and gpu-select arms, with exact settled-paint parity between rendering-only GPU and GPU-select. **Known failing on gpu/rewrite (2026-10-19)**: `#commandPaletteResults` never shows an option in the svg arm. Being fixed separately. | ~45 s |
| `picking` | shared | `bench/picking-parity.ts`: GPU pick against the SVG `elementFromPoint` oracle on the shared and 100k worlds. Arguments are `dpr`, `zoom`, `phase=settled\|motion`, `reliefMode` and `denseLabels`. | 30–110 s |
| `integration` | shared | `bench/renderer-integration.ts`: editors, stale-fallback, save/export round trip, resync, marker and route cohorts under the GPU renderer. Arguments are `cohort=short\|full`, `focus=all\|route`, `preamble` and `launcher=metal\|swiftshader`. The gate fails unless **every** verdict is PASS: UNTESTED and UNDERCOVERED fail. The default `metal` launcher (new-headless Chromium, ANGLE on Metal) is checked against the WebGL adapter string; `swiftshader` (Playwright's headless shell, CPU WebGL) only reproduces the pre-W1 runs, whose slow frames let d3's zoom "end" land before the stale clicks and left the route and marker cohorts UNTESTED. The report's `staleWindow` gives each cohort's eligible count and wheel-to-click time. The route-undo cohort is retired (it timed the undo of a route the editor had not changed). | ~4–5 min (short) |
| `replay` | shared | `bench/host/editor-replay.ts`: each script in `bench/host/editor-scripts/` (burg, label, marker, relief, route) is recorded on the svg arm of the parity fixture, then replayed under `gpu` and `gpu-select` at the same frozen camera and client points. Each step must match the recording: pack/grid hashes, the model-DOM hashes and net attribute/child deltas (dense-zoom overlays, culling classes and blob: URLs normalised away), dispatchClick and editor call counts (double or missing dispatch), dialogs, and no camera move mid-step or mid-brush. A GPU arm must also be suspended with its canvas hidden while the editor is open, and must resume after the close, to a current and then a refined frame. Arguments are `editors=all\|a,b`, `arms`, `dpr`, `launcher` and `fixture` (default parity: the scripts name its entities). | ~2.5 min |
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
| `metrics` | shared | G-C fidelity (PROOF-PLAN §4). By default (`manifest=fresh`) it captures the 8 dpr×zoom cells from the current `dist/` with the smoke harness, then runs `bench/fidelity-metrics-run.ts`. It **fails if any pair misses SSIM ≥ 0.95**. over16 and the conservative reference gate are reported but do not fail it (the P2 baseline is 5/8 over16). `manifest=<path>` re-measures existing captures. | ~6–9 min |
| `paired` | exclusive | One immutable ABBA block (2 SVG + 2 GPU slots) of `bench/renderer-ab-run.ts`, headful Chromium Metal, for `block=1..5`. Records the dist fingerprint before and after; a block fails if dist changed. | ~3.5 min |
| `paired-summary` | no | `bench/host/paired-summary.ts` over five passing blocks from one dist, either the newest set or `dirs=a,b,c,d,e`. Fails if any metric is not comparable. Timing deltas are descriptive. | ~1 s |
| `timing` / `profile` / `gpu-timing` | exclusive | `bench/navigation.ts`, `profile-navigation.ts` or `timer-navigation.ts` on the shared and 100k worlds at dpr 2 (`arm`, `headless`, `trace`). `profile` adds the top self-time CPU frames. | 2–10 min |
| `paint` | shared | `bench/direct-emblem-culling-contract.ts`: synthetic emblem-culling paint and lifecycle contract. | ~5 s |
| `package-smoke` | shared | `bench/host/package-smoke.ts`: the packaged `dist/` boots in default SVG with no WebGL request, and lazy save/export imports resolve. | ~20 s |
| `boundary-after` | no | `bench/renderer-bundle-boundary.ts`: the static module graph for default boot and save/export contains no GPU presentation code (the GPU stays lazy). | ~1 s |
| `boundary-before` | no | The same analysis, but expects GPU code to be **present**. Run it only against a pre-split baseline build; it fails on current builds by design. | ~1 s |
| `golden` | shared | `bench/host/layer-golden.ts`: the per-layer golden (D1, D5). See "Per-layer golden" below. | ~3–4 min for all families at k {1,4}, dpr 2 |
| `golden-selftest` | shared | Proves the golden can still fail and pass: `layers=ocean k=1` on the shared fixture must pass, and the same cell with `break=drop-batch` must fail on a metric gate after a batch was actually dropped. A harness error or a no-op break fails the check. `reading=` as for golden. | ~40 s |
| `consumers` | shared | `bench/host/consumers.ts`: the document's consumers (REWRITE-PLAN rows 31-38 and 40), `?renderer=svg` against `?renderer=gpu` on the same world and build, on the parity fixture and the shared fixture (`worlds=parity,shared`). Text save (46 sections, SVG at index 5, identical between arms at a non-identity camera, I8 I9 I11 I12 I15), binary save and `ldb` lastMap and reload round trips (I14), cloud save/load/conflict/versions/restore against a mocked Worker (no network), SVG/PNG/JPEG/tiles exports, the `mesh` texture and the 3D view (mesh and satellite), the transform tool's 4x preview, the minimap (viewport rectangle and click target), the elevation profile, charts and emblem dialogs, the heightmap preview, and a hash of `window.pack`/`grid` that the renderer must not change (row 40). Raster output is compared exactly; a tiny difference counts as rasterizer noise only when the SVG handed to the rasterizer is byte-identical between arms (the bound is `RASTER_NOISE` in `consumers.ts`; `control=1` runs a second svg page instead of the gpu arm to measure it). The gpu arm must stay on the gpu path through every probe. `break=save-tamper\|export-tamper\|tamper` perturbs the gpu arm's save and/or PNG export; see `consumers-selftest`. Evidence: `consumers.json` (every check with its status and file) plus the saves, exports and screenshots of both arms under `<world>/{svg,gpu}/`. | ~15-25 min |
| `consumers-selftest` | shared | Proves the consumers harness can still fail: runs the `save` and `export` steps on the parity fixture with `break=tamper` (the gpu arm's text save and PNG export are perturbed) and requires `save.arms-equal`, `save.svg-section-identical` and `export.png` to FAIL, with no harness error and no other unexpected failure. | ~6 min |
| `stroke-probe` | shared | `bench/host/stroke-probe.ts`: a synthetic `#strokeProbe` layer on a generated map, SVG arm against GPU arm at `dpr` (default `1,2`) × `k` (default `1,4`). **Lines:** horizontal probe lines (solid widths 0.25–2.5 and the default style's dash styles: `2` butt, `0 2` round dots, `.8 1.6`, `1 2` round, `5`, square-capped `2`); per line, in device px, mean ink width (column coverage), dash duty, pitch (autocorrelation), phase (GPU against SVG cross-correlation) and the along/across aspect of round dots. A line fails when width differs by more than 1 px, pitch by more than 1 px, phase by more than 1 px, a dot's aspect by more than 0.25, or an arm is empty (PROOF-PLAN §4 strokes). A line is `not comparable` (counted apart, never as a pass) for sub-pixel dots SVG drops while GPU stays below 0.1 px of mass, and for the aspect of dots under 2 device px or with no measurable mass. **Joins:** zigzag polylines with 60–135° turns (miter, round, bevel), a dashed borders-style zigzag, crossing subpaths in one path and a translucent self-crossing path; each fails on any notch (a pixel SVG covers ≥ 0.9 that GPU leaves ≥ 0.35 lighter), any spur (the reverse) or an ink mass more than 10% from SVG's. Evidence: `stroke-probe.json` and `probe-d<dpr>-k<k>-{svg,gpu}.png`. | ~1 min |
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
| `quick` | typecheck → unit → build | ~15 s |
| `browser` | build → *shared lock* → canonical → palette → picking → integration (short cohort) → golden-selftest → golden (D5 gate scale: all families, k 1,4, dpr 2, default preset, `fixture=parity`) | ~15–17 min |
| `nightly` | golden × 24, each under its own *shared slot* (released between steps): dpr {1,2} × the 12 built-in presets, each step all families at k {1,2,4,8} plus the coastline switch points 1.4/1.6/2.5/2.7 (`coastk`), `fixture=parity`, `keep=fail`. Always runs every step (`keep_going` is implied). | ~3–4 h |
| `full` | *exclusive lock* → browser → fidelity → navigation → metrics (fresh) → paired blocks 1–5 at dpr 2 → paired-summary | ~45–50 min |

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
| `reading` | `conservative` or `over44` (see the verdict) | `conservative` |
| `keep` | `all`, or `fail` to keep PNGs for failing cells only | `all` |
| `bg` | backdrop `#rrggbb` | `#ffffff` |
| `break` | `none`, or `drop-batch` (self-test only, see below) | `none` |
| `params` | extra `gpu-*` page URL flags for the run, `+`-joined, e.g. `params=gpu-native-shapes=1` or `params=gpu-fill-aa=0` | none |

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
- **Verdict per cell (D1).**
  - SSIM ≥ 0.95, over16 ≤ 1 %, and "≤ 0.5 % at Δ ≤ 44", all on the isolated layer's whole frame.
  - The default reading of the last clause, `reading=conservative`, is P2-FIDELITY-MEASUREMENT's reading and the
    repo convention (`fidelity-metrics.ts` GATES): changed ≤ 0.5 % and max Δ ≤ 44.
  - `reading=over44` (at most 0.5 % of pixels differ by more than 44) is a looser, **opt-in** reading. Nobody has
    approved it as the gate (P2-FIDELITY-MEASUREMENT: "do not retune silently"), so the `browser` and `nightly`
    tiers never use it. On the 2026-10-19 shared-fixture run it would have passed `temperature` with 47–65 % of
    pixels changed. Making it the default is Ryan's decision.
  - Both readings are always reported (`gates.conservative`, `gates.over44` per cell).
  - All gates are whole-frame fractions, so a small or faint family can lose much of its ink and still pass. Each
    cell therefore reports `inkRatio` (min/max of the two arms' ink pixels) and `over16OfInk`, and carries a
    non-gating `notes` entry when the ratio is under 0.9 or over16 exceeds 10 % of the layer's ink. The result line
    lists passing cells with notes; read them before trusting a PASS for compass, burgs, markers or scaleBar.
  - A family that paints nothing in either arm fails: an empty layer is a failure, not a pass. Each arm's ink is
    counted against its own blank capture (every family hidden). Page chrome over the canvas blends differently
    from the same chrome over the SVG.
  - A GPU fallback also fails the cell, as does any page error or WebGL validation warning during the run.
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
  - `gate golden layers=ocean k=1 fixture=shared` passes. On 2026-10-19 the result was SSIM 1.0000, over16 0, and
    0.04 % of pixels changed by 1 code value.
  - The same run with `break=drop-batch` fails at SSIM 0.82 and over16 99.7 %. That mode removes the bottom-most
    fill/stroke batch from the GPU frame only, which is a dropped path. Use it only to show the harness can fail.
  - `gate golden-selftest` re-runs both of those as one check (and it is a step of `browser`), so the harness's
    ability to fail is re-proven on every tier run rather than once by hand.
  - The metric math (`bench/golden-metrics.test.ts`) and the PNG codec (`bench/png.ts`) are covered by `gate bench`.
  - `break=drop-batch` and the root-family census read the renderer's internal `gpuRenderer.prepared`. If its shape
    changes, the cell fails with a `harness:` message instead of silently counting zero.
