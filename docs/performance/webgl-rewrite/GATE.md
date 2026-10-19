# Host gate for the GPU renderer

`bench/gate/gate.ts` is the single entry point for every check that proves the opt-in WebGL renderer
(`?renderer=gpu`). It replaces the harness Codex ran from outside git
(`tupaia-webgl-rewrite-2026-10-13/control/tupaia-checks-v15.py` and `opt-in-run-check.py`). It keeps the same
check names and argument rules, and adds tiers, a blocking host lock and evidence that lives outside the repo.

```sh
npm run gate -- quick                    # typecheck + vitest + build, no browser
npm run gate -- canonical                # one browser check (takes the host lock itself)
node bench/gate/gate.ts picking dpr=1 zoom=8 phase=motion
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

Every browser/GPU check takes a **blocking** exclusive `fcntl.flock` on `/tmp/tupaia-host-gates.lock`. That is the
same file `hostlock.py` uses, through a small python3 helper, so gates in different worktrees and hand-wrapped
`hostlock.py` jobs queue behind one another. They never run concurrently. Browser children run under `nice -n 5`.

- Typecheck, unit, build, bench (node tests), boundary and paired-summary do not take the lock.
- A tier acquires the lock at its first browser step and holds it until the tier ends, so nothing else can slip in
  between its steps. The build runs before the lock is taken.
- If the gate is itself running under `hostlock.py` (detected from the process ancestry) or under another gate
  (`TUPAIA_GATE_LOCK_HELD=1`), it does not lock again, because locking again would deadlock against the parent.
- The lock dies with the gate: the helper exits as soon as the gate's pipe closes. There is no stale-lock cleanup to do.

So do **not** wrap the gate in `hostlock.py`. It is harmless, but it is not needed.

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
| `bench` | no | Node unit tests for the bench math: A/B stats, compare, frame budget, trace, fidelity metrics, picking oracle. | ~10 s |
| `canonical` | yes | `bench/direct-integration-metal-local-init.ts`, rendering-only, dpr 2, zoom 2, short cohort, under the Metal ANGLE backend. The GPU path initialises locally, resyncs labels and routes, round-trips save/export, and falls back cleanly to SVG on teardown. This is the opt-in acceptance smoke. | ~105 s |
| `palette` | yes | `bench/host/palette.ts`: command-palette and keyboard creation flows across the svg, gpu and gpu-select arms, with exact settled-paint parity between rendering-only GPU and GPU-select. **Known failing on gpu/rewrite (2026-10-19)**: `#commandPaletteResults` never shows an option in the svg arm. Being fixed separately. | ~45 s |
| `picking` | yes | `bench/picking-parity.ts`: GPU pick against the SVG `elementFromPoint` oracle on the shared and 100k worlds. Arguments are `dpr`, `zoom`, `phase=settled\|motion`, `reliefMode` and `denseLabels`. | 30–110 s |
| `integration` | yes | `bench/renderer-integration.ts`: editors, stale-fallback, save/export round trip, resync, marker, route and undo cohorts under the GPU renderer. Arguments are `cohort=short\|full`, `focus=all\|route` and `preamble`. | ~7–9 min (short) |
| `smoke` | yes | `bench/host/gpu-smoke.ts`: the GPU path activates without fallback, trade animation advances, and the GPU frame is compared with the SVG frame (`diff`). `layer=` isolates one layer for diagnosis only. | ~40 s |
| `fidelity` | yes | `bench/host/gpu-fidelity.ts`: smoke plus a diff heatmap PNG and the top 20 error hotspots. Diagnostic only. | ~40 s |
| `context` | yes | Smoke plus an injected WebGL context loss, then restore. | ~45 s |
| `lifecycle` | yes | Smoke plus 20 map reloads with forced GC. Reports JS heap growth and context loss/restore. | ~3 min |
| `hatch` | yes | `bench/host/hatch-motion.ts`: hatch pitch and phase stay stable across camera-only zoom and pan, with no re-prepare. | ~30 s |
| `navigation` | yes | `bench/host/native-navigation-pilot.ts`: CDP-injected pan-near, pan-wide and wheel-zoom on shared and 100k. Reports frame p95, event-to-rAF p95 and the GPU-presented fraction. Fails only on errors; timings are descriptive. | ~2–3 min |
| `native-recovery` | yes | `bench/host/native-recovery.ts`: moving-pick proof, recovery CPU profile and context loss while moving (defaults to world 100k, gesture wheel-zoom). | ~1–2 min |
| `metrics` | yes | G-C fidelity (PROOF-PLAN §4). By default (`manifest=fresh`) it captures the 8 dpr×zoom cells from the current `dist/` with the smoke harness, then runs `bench/fidelity-metrics-run.ts`. It **fails if any pair misses SSIM ≥ 0.95**. over16 and the conservative reference gate are reported but do not fail it (the P2 baseline is 5/8 over16). `manifest=<path>` re-measures existing captures. | ~6–9 min |
| `paired` | yes | One immutable ABBA block (2 SVG + 2 GPU slots) of `bench/renderer-ab-run.ts`, headful Chromium Metal, for `block=1..5`. Records the dist fingerprint before and after; a block fails if dist changed. | ~3.5 min |
| `paired-summary` | no | `bench/host/paired-summary.ts` over five passing blocks from one dist, either the newest set or `dirs=a,b,c,d,e`. Fails if any metric is not comparable. Timing deltas are descriptive. | ~1 s |
| `timing` / `profile` / `gpu-timing` | yes | `bench/navigation.ts`, `profile-navigation.ts` or `timer-navigation.ts` on the shared and 100k worlds at dpr 2 (`arm`, `headless`, `trace`). `profile` adds the top self-time CPU frames. | 2–10 min |
| `paint` | yes | `bench/direct-emblem-culling-contract.ts`: synthetic emblem-culling paint and lifecycle contract. | ~5 s |
| `package-smoke` | yes | `bench/host/package-smoke.ts`: the packaged `dist/` boots in default SVG with no WebGL request, and lazy save/export imports resolve. | ~20 s |
| `boundary-after` | no | `bench/renderer-bundle-boundary.ts`: the static module graph for default boot and save/export contains no GPU presentation code (the GPU stays lazy). | ~1 s |
| `boundary-before` | no | The same analysis, but expects GPU code to be **present**. Run it only against a pre-split baseline build; it fails on current builds by design. | ~1 s |
| `lock-probe` | (takes it) | Acquires and releases the host lock and launches nothing. Shows whether another job holds the lock, and for how long you would wait. | 0 s + wait |

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
| `browser` | build → *lock* → canonical → palette → picking → integration (short cohort) | ~11–13 min |
| `full` | browser → fidelity → navigation → metrics (fresh) → paired blocks 1–5 at dpr 2 → paired-summary | ~40–45 min |

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
