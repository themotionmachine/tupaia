# P0 executable DAG

Stage cap: **$18** (SPENDING-PLAN.md:91). This run's CLI ceiling is $10, including children. Each file has exactly one owner. Packets marked "Opus" were written by the primary agent, and packets marked "Haiku" by a bounded child (no shell, no paid API, no agents, assigned files only). Acceptance commands are host-run; none were executed in this session.

## Nodes

| Node | Backlog | Owner | Owned files (exclusive) | Depends on | Cap | Acceptance (host) |
|---|---|---|---|---|---|---|
| A1 pins | O01 | Haiku | docs/performance/webgl-rewrite/p0-audits/pins-d3-three-fonts.md | none | $0.40 | Review: every row cites path:line; unverified rows are marked UNPROVEN |
| A2 hatch/zoom/flags | (O04 input) | Haiku | p0-audits/hatch-zoom.md | none | $0.40 | Same review |
| A3 IO format/undo | (O03 input, H03/H04 scope) | Haiku | p0-audits/io-format-undo.md | none | $0.40 | Same review |
| A4 lookups + globals | H02 + H08 | Haiku | p0-audits/census-lookups-globals.md | none | $0.40 | Same review |
| A5 DOM attributes | H01 | Haiku | p0-audits/census-dom-attributes.md | none | $0.40 | Same review |
| A6 bench audit | (O02 input) | Haiku report, Opus write | p0-audits/bench-harness.md | none | $0.30 | Same review |
| R1 reconcile | n/a | Opus | p0-audits/RECONCILIATION.md | A1–A6 | $0.30 | Spot checks cite current code |
| S1 SceneDocument | O03 | Opus | src/renderers/scene-document.ts, src/renderers/scene-document.test.ts | A3 | $1.50 | `npx vitest run src/renderers/scene-document.test.ts` |
| S2 renderer flag | O04 (partial) | Opus | src/renderers/renderer-mode.ts, src/renderers/renderer-mode.test.ts | A2 | $1.20 | `npx vitest run src/renderers/renderer-mode.test.ts` |
| S3 wiring | O03/O04 | Opus | src/renderers/index.ts (two appended side-effect imports) | S1, S2 | $0.05 | `npx tsc --noEmit`; `npm run build` |
| B1 A/B core | O02 | Opus | bench/renderer-ab.ts, bench/renderer-ab.test.ts | A6 | $1.20 | `node --test bench/renderer-ab.test.ts` |
| B2 runner edits | O02 | Opus | bench/navigation.ts, bench/navigation-compare.ts, bench/navigation.md | B1, S2 | $0.80 | `node --test bench/compare.test.ts bench/frame-budget.test.ts bench/trace.test.ts`; manual `BENCH_RENDERER=svg node bench/navigation.ts` |
| B3 A/B runner | O02 | Opus | bench/renderer-ab-run.ts | B1, B2 | $0.40 | Manual `node bench/renderer-ab-run.ts`. Expected: report.json with `comparable:false` and the reason "requested gpu but ran svg" |
| D1 docs | n/a | Opus | P0-DAG.md, P0-GATE-REPORT.md | all | $0.40 | Review |
| G0 run | O02/O03 gate | Host | bench/results/** (output only) | S3, B2, B3 | host compute, $0 model spend | See P0-GATE-REPORT.md "Unrun" |

Sum of model caps: $8.15, which is within the $10 CLI ceiling and the $18 stage cap.

```
A1 ─┐
A2 ─┼─> S2 ─┐
A3 ─┼─> S1 ─┼─> S3 ─────────────┐
A4 ─┤       └─> B2 ─> B3 ───────┼─> D1 ─> G0 (host)
A5 ─┤  A6 ─> B1 ─> B2           │
A6 ─┴─> R1 ─────────────────────┘
```

## Global acceptance (host, in order)

1. `npx tsc --noEmit`
2. `npx biome check src/renderers bench`
3. `npx vitest run src/renderers/scene-document.test.ts src/renderers/renderer-mode.test.ts`
4. `npx vitest run`, so that existing suites still pass with the two new side-effect imports
5. `node --test bench/renderer-ab.test.ts bench/compare.test.ts bench/frame-budget.test.ts bench/trace.test.ts`
6. `npm run build`
7. Manual, opt-in only: the navigation runs listed in P0-GATE-REPORT.md. Never run Playwright e2e automatically.

## P1 outline (not implemented; cap $32)

P1 must not start until G0 has been run on the host.

| Node | Backlog | Owned files (proposed) | Contract |
|---|---|---|---|
| O05 GpuDevice | O05 | src/gpu/device.ts (+test) | Implements `RendererBackend` from src/renderers/renderer-mode.ts. It is registered only through `RendererRouterOptions.gpuBackend`; P0's default router has none. It must return `kind: "gpu"`, throw on init failure (the router falls back), and make `dispose()` idempotent |
| H06 camera math | H06 | src/gpu/camera-math.ts (+test) | Moved here from P0, because P0 excluded camera changes |
| O06 camera | O06 | src/gpu/camera.ts, public/main.js (one hook in `invokeActiveZooming`) | This is the deferred half of O04. svg must remain identical: the hook is a no-op unless `rendererStatus().active === "gpu"` |
| O07–O09 | O07–O09 | src/gpu/** | Consume the read-only `captureSceneShadow()`. Never write back to the SVG |
| Capture | O09/O10 | bench/gpu-capture-*.ts | Implements `GpuCaptureAdapter`. It must return real pixels plus `gpu.vendor` and `gpu.renderer`; `captureProblems` must be empty |
| H09–H15 | H09–H15 | As listed in IMPLEMENTATION-BACKLOG.json | One owner per file |

The second GPU family is O23 (P4). It is not a P0 or P1 dependency.
