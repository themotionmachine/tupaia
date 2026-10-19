# P0 audit: bench harness

Scope: read-only facts about `bench/` as it stood before the P0 edits, plus a list of the P0 additions. Paths are relative to `implementation/`. The Haiku packet that owned this file reported its findings but did not write the file. Opus transcribed those findings and re-checked each cited line with Grep. Nothing was executed.

## 1. Runners

| Runner | Input path | Evidence |
|---|---|---|
| bench/navigation.ts | Synthetic DOM: `target.dispatchEvent(event)` inside `page.evaluate` | bench/navigation.ts:261 |
| bench/navigation-quality.ts | Playwright `page.mouse.move` / `page.mouse.wheel`, which goes through CDP `Input.dispatch*` | bench/navigation-quality.ts:279-280 |
| bench/navigation-compare.ts | Pairs two navigation.ts result files and prints medians | bench/navigation-compare.ts |
| bench/map.ts, bench/compare.ts | Map generation/IO bench and comparator; the only bench scripts CI runs (with compare.test.ts) | package/CI config (per the earlier session) |

Neither input path is native OS input. navigation.ts bypasses hit testing; navigation-quality.ts goes through browser input routing but is still injected. `bench/renderer-ab.ts` `INPUT_METHODS` records this. `synthetic-dom` and `cdp-input` are supported but not native; `os-native` is unsupported.

## 2. URL construction

- navigation.ts:118 builds `/?local&seed=7319&width=1280&height=720` + `workerQuery` + `rendererQuery(renderer)`. P0 added the last term. When `BENCH_RENDERER` is unset it returns "", so the URL is byte-identical to the previous one.
- navigation-quality.ts:69 builds the same base URL without the renderer term. That is deliberate: P0 leaves it unchanged.

## 3. Environment variables

navigation.ts reads `BENCH_DIST`, `BENCH_OUTPUT`, `BENCH_SAMPLES`, `BENCH_TRACE`, `BENCH_FRAMES`, `BENCH_HEADLESS`, `BENCH_CHANNEL`, `BENCH_ANGLE`, `BENCH_GPU`, `BENCH_RENDERER` (new in P0), `BENCH_RELIEF_WORKER`, `BENCH_MAP`, `BENCH_MAP_LABEL`, `BENCH_MAP_META`, `BENCH_WORLDS` and `BENCH_TRACE_DIR`.

navigation-quality.ts reads `BENCH_DIST`, `BENCH_MAP`, `BENCH_CHANNEL`, `BENCH_ANGLE`, `BENCH_GPU`, `BENCH_DISABLE_WORKER`, `BENCH_RELIEF_WORKER`, `BENCH_OUTPUT` and `BENCH_BASE_IMAGE`.

renderer-ab-run.ts (new) reads `BENCH_AB_A`, `BENCH_AB_B`, `BENCH_AB_REPEATS`, `BENCH_AB_SEED` and `BENCH_AB_OUTPUT`. It forwards everything else to each navigation.ts child.

## 4. Defects found

1. **Demo fixture (fixed in P0).** The `demo` world used to load the `BENCH_MAP` text whenever that variable was set, so the "demo" results could actually come from another map. navigation.ts now passes `worldText(world)`: the shared text for the shared world, `tests/fixtures/demo.map` for `demo`, and undefined for generated worlds. This changes which map the `demo` world loads when `BENCH_MAP` is set. Results from before the fix should not be paired with results from after it for that world.
2. **reliefWorker check (recorded, not fixed).** navigation-quality.ts:382 expects `worker` whenever `reliefWorker` is present (`.has`). The source requires the value `"1"` (src/renderers/relief-raster-worker.ts:38-41). As a result, a `?reliefWorker=0` URL would expect `worker` while the app keeps `main`. The bench only ever sets `=1`, so current runs are unaffected. Fixing it is outside the P0 ownership.

## 5. Result schema

navigation.ts writes `schema: 2` (navigation.ts:525). The comparator checks the idle and input fields only when `schema >= 2`. P0 adds these fields without bumping the schema:

- `renderer`: requested value, or undefined.
- `inputMethod`: always `"synthetic-dom"`.
- `rendererStatus: {start, end}`: from the page's `rendererStatus()`, or null on builds without it.
- `fixtures`: per-world `FixtureIdentity`.

`fixtureHash` is kept.

The comparator now requires `renderer` and `inputMethod` to match. It also rejects a pair whose end active renderer differs when a renderer was requested. Because `inputMethod` is missing from old files, pairing a pre-P0 result with a post-P0 result fails. That is a deliberate loss of compatibility, documented in bench/navigation.md.

## 6. P0 additions

- `bench/renderer-ab.ts` is pure, with no Playwright import. It provides:
  - the env parser and the URL fragment;
  - fixture identity (SHA-256 of the file, the CRLF section count, and a hash of the SVG section);
  - a seeded ABBA schedule;
  - nearest-rank percentiles and a bootstrap CI of the median delta;
  - an RGBA fidelity comparator;
  - the `GpuCaptureAdapter` interface and an `unsupportedGpuCapture` default that returns no image;
  - `captureProblems`;
  - `analyzeAb`, which refuses comparison on fallback, mixed arms, fixture drift, or missing or unsupported input labels.
- `bench/renderer-ab.test.ts` (node:test) checks hand-computed values and the real demo.map. It does not re-implement the logic it tests.
- `bench/renderer-ab-run.ts` is a host-only orchestrator that spawns one navigation.ts process per slot.

## 7. Unproven

- Whether `page.evaluate` returns `rendererStatus()` with exactly the snapshot shape after JSON cloning. It should, because the snapshot is plain data, but this has not been run.
- Whether headless-shell exposes WebGL2. This does not matter in P0, because the gpu arm falls back whatever the probe result.
