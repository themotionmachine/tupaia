# P0 gate report (G0)

Status: **code complete, gate UNRUN.** Everything below was produced with file tools only. No compiler, test, build, bench or browser was executed in this session. The host orchestrator runs the commands listed in P0-DAG.md "Global acceptance".

## Completed

| Item | Backlog | Files | Notes |
|---|---|---|---|
| SceneDocument shadow capture | O03 | src/renderers/scene-document.ts (+test) | A lossless SVG parse and serialize, with mutations, revisions and census. `captureSceneShadow()` reads `mapData[5]` / the live SVG. It is exposed as `window.captureSceneShadow`. Save, load and export do not call it, so the IO path is untouched and the SVG stays canonical |
| `?renderer=svg\|gpu` flag + lifecycle routing | O04 (partial) | src/renderers/renderer-mode.ts (+test), src/renderers/index.ts | Default is svg, and the default path does no probe, creates no canvas and logs nothing. gpu probes WebGL2. With no registered backend (always the case in P0) it falls back to svg and reports `fallbackReason`. Invalid, conflicting or missing values resolve to svg with a warning. Disposal is idempotent. World replacement is routed on map:generated, map:loaded and map:resampled. There are no canvas, camera or save/export changes |
| Parity harness foundation | O02 (foundation) | bench/renderer-ab.ts (+test), bench/renderer-ab-run.ts, bench/navigation.ts, bench/navigation-compare.ts, bench/navigation.md | See the list below |
| Pins and audits | O01, H01, H02/H08 | p0-audits/*.md | Reconciled in p0-audits/RECONCILIATION.md |
| DAG | n/a | P0-DAG.md | One owner per file, with caps and acceptance commands |

The parity harness foundation adds:

- renderer A/B with a seeded, interleaved ABBA schedule;
- fixture identity: file SHA-256, section count and SVG hash, or generator parameters;
- p50/p95 and bootstrap CIs;
- RGBA fidelity;
- input labels (`synthetic-dom` and `cdp-input` are non-native; `os-native` is unsupported);
- a `GpuCaptureAdapter` interface whose default returns *unsupported*, never pixels.

The A/B analysis refuses to compare when the gpu arm fell back. It also fixes the `demo` world, which used to load BENCH_MAP.

### Invariant coverage (I1–I6, REWRITE-PLAN.md:236-241)

| Invariant | Coverage in P0 | Corpus |
|---|---|---|
| I1 model fixpoint | Synthetic SVG + demo.map roundtrip | demo.map only |
| I2 file fixpoint | demo.map byte roundtrip. The shadow is never saved, so the save.ts normalizations do not apply | demo.map only |
| I3 46 CRLF sections, SVG = mapData[5] | Tested on demo.map, including the binary archive `section(5)` | demo.map only |
| I4 stable ids | Preserved by the lossless parse; no rename-specific test | UNPROVEN beyond demo.map |
| I5 attribute census | The census doc exists (census-dom-attributes.md). The shadow keeps every attribute verbatim. No per-editor allowlist test yet | UNPROVEN beyond demo.map |
| I6 relief data-* / biome extras | Kept verbatim by the lossless parse; no targeted test | UNPROVEN |

## Unrun (host must run)

1. **Unit, type and build checks.** These are the P0-DAG.md global acceptance steps 1–6.
2. **G0 baseline reproduction (O02, "within 10% of brief numbers"): UNRUN.** Run the existing scripts against the current build, with no flag and then with `BENCH_RENDERER=svg`:
   - `node bench/navigation.ts` (BENCH_OUTPUT=… per run)
   - `node bench/navigation-compare.ts BASE.json HEAD.json`
   - `node bench/navigation-quality.ts`
   - `node bench/map.ts` and `node bench/compare.ts`

   The flag-svg run should be indistinguishable from the no-flag run. Because of the new `inputMethod` and `renderer` fields, the comparator pairs only post-P0 files.
3. **G0 shadow corpus (O03, "I1–I6 on corpus"): UNRUN.** There is no corpus manifest; H05 (tests/fixtures/CORPUS.md) was not produced. The only checked fixture is demo.map. In a browser, `captureSceneShadow()` on generated worlds, the 100k world and legacy maps covering each `auto-update.ts` gate still has to be exercised.
4. **Renderer A/B smoke: UNRUN.** Run `node bench/renderer-ab-run.ts`. In P0 the expected result is `comparable: false` with "Slot N requested gpu but ran svg: GPU renderer unavailable until P1". That result is correct and is not a failure.

## Blockers

None for closing P0 code. The gate stays open until the "Unrun" items pass on the host.

These are **not** P0 blockers:

- **No second GPU family.** That is the O23 device gate in P4.
- **No GPU capture adapter.** That is P1 (O09/O10). The default adapter correctly reports unsupported.
- **The per-frame `invokeActiveZooming` hook was deferred.** It moves to P1 O06 to keep svg behaviour identical.

## Known limitations

- O04 is partial: routing happens on world events only, with no camera hook.
- H03, H04, H05, H06 and H07 were not produced as separate files. Partial coverage is described in p0-audits/RECONCILIATION.md, and H06 moves to P1.
- Pre-P0 navigation result JSON cannot be paired with post-P0 JSON, because the comparator now requires `inputMethod`.
- `demo` world results from before and after the fixture fix are not comparable when BENCH_MAP was set.
- bench/navigation-quality.ts:382 has a `.has("reliefWorker")` vs `"1"` mismatch. It is recorded but not fixed.
- The intent of `isOlderThan("1.652.0")` at src/io/auto-update.ts:538 is UNPROVEN. Behaviour is preserved.

## Corrections to PROOF-PLAN.md

PROOF-PLAN.md describes bench/, tests/, the vitest config and tests/fixtures/demo.map as absent. All of them are present. public/libs/d3.min.js (v5.8.0), src/services/fonts.ts and the MCP bridge are also present. G0 should use the existing scripts named above, not a new harness.

## Spend

The CLI spend for this P0 session, including children and excluding ideation, is about $4.2 against the $10 ceiling. That is within the $18 P0 stage cap. Ideation ($7.84) counts toward the $200 owner cap.
