# Tupaia full WebGL renderer rewrite: ideation README

**Status: ideation only.**
- Nothing was implemented, built, tested, run in a browser or deployed. This session had only Read/Glob/Grep/Write/Edit and native Haiku children; no shell or network.
- The contracts and backlog are unimplemented drafts.
- `source/` was not modified.
- Only `audits/` and `outputs/` were written.

## Decision in one paragraph

Rewrite the renderer so that every visible map pixel, every map hit-test and every camera frame runs on **raw WebGL2 behind a thin in-house device layer**. three.js is not the core: at runtime it is the vendored `libs/three.min.js`, and npm three is types-only.

Nothing is dropped. Anything the GPU path cannot yet match exactly goes through an **exact compat capture lane**. That lane rasterizes the existing SVG or Canvas2D renderer off-frame into a cached texture, and each use is logged as performance debt, not as a feature cut.

**SceneDocument** takes ownership of the model in phases:
- **P1:** a shadow copy parsed alongside the SVG.
- **P2:** the GPU renderer reads it. Editors still work through a hidden, live, in-document SVG model (`visibility:hidden`, never written per frame), a `d3.mouse` shim, a single gesture controller and a small overlay SVG.
- **P3:** editors issue commands and SVG is derived.

The `.map`/binary formats, generators, `window.pack/grid`, the shared API, auth and backend stay as they are. A `?renderer=gpu|svg` flag keeps rollback a single flip through P2.

## Artifacts

| File | Contents |
|---|---|
| `outputs/REWRITE-PLAN.md` | Architecture, rendering choices, **43-row feature-parity matrix with acceptance**, text, compat lane, editor bridge, exact remaining SVG dependencies, invariants I1–I15, phases P0–P4, baseline corrections, uncertainties |
| `outputs/PROOF-PLAN.md` | Measurement rules, G0/G1 (hard stop-loss) thresholds, fidelity/hit/label/font gates, editor-bridge parity (G-E), save/export/consumer gates (G-S), G3/G4 |
| `outputs/SPENDING-PLAN.md` | USD200 allocation, Opus vs 34 Haiku packets, low/base/high billable math with the >100k Haiku premium and an unverified Opus long-context sensitivity, working-token vs billable usage, stop-losses |
| `outputs/CONTRACTS.ts` | Type-only draft: Camera (dynamic zoomMin, clamp [0.01,200]), GpuDevice, SceneDocument, SaveCodec, Command, SvgMaterializer, LayerRenderer, CompatLane, TextLayout, PickService, EditorBridge, PointerShim |
| `outputs/IMPLEMENTATION-BACKLOG.json` | 25 Opus items + 34 Haiku packets by stage, with caps and gates |
| `audits/layers.md`, `interactions.md`, `snapshots.md`, `gpu.md`, `verification.md`, `migration.md` | Six initial Haiku audits |
| `audits/followup-consumers-invariants.md`, `followup-editor-bridge.md`, `followup-camera-lod.md`, `followup-text-defs.md` | Adversarial Haiku follow-ups |
| `audits/01-06-*.md` | The earlier bounded baseline's audits (kept unchanged) |

## Native Haiku children in this session: 11

- **Six initial audits:** layers, interactions, snapshots, gpu, verification, migration.
- **Five adversarial follow-ups:** consumers/model-file-undo invariants, editor event bridge, camera and atlas/LOD, text and defs, plus a second text-and-defs run. The first text-and-defs run finished without writing its file, and its transcript was outside the readable sandbox, so the audit was re-dispatched.

All children ran on the built-in general-purpose type at depth 1 with no more than 6 concurrent. Each was given the required restriction line.

**Audit quality caveats:**
- `migration.md` and `verification.md` exceed the 2,500-word report limit.
- `verification.md` repeats baseline errors: 6 px hatch, ≤4 ms input, k=0.8. PROOF-PLAN overrides them.
- `followup-editor-bridge.md` found listener placement by ripgrep, and its d3 internals are INFERRED from upstream d3 v1 because `libs/d3.min.js` is absent. The file labels both.

**Cost:** the orchestrator reports the receipt cost. This file does not state it. The CLI's running estimate was non-authoritative and is not a receipt. Console / Usage Cost API figures are authoritative.

## Corrections to the earlier baseline (details: REWRITE-PLAN §13)

**Zoom and camera**
- scaleExtent is `[1,20]` at boot, then a dynamic minimum, then a user clamp of [0.01,200]. It is not `[0.8,20]`.

**Dependencies and code that don't exist yet**
- three is not "already paid for" and its bundle delta is not ~0.
- `mcp/src/bridge.js` is absent.
- `?renderer=gpu`, `?reliefWorker` and a GPU zoom branch do not exist in source.
- There is no context-loss handling anywhere.

**Editor and model**
- A detached, never-displayed model SVG breaks 49 document-level lookups, the minimap `<use>` and `getBBox`.
- "Zero editor changes" is false.
- The 3D view, transform-tool preview and cultures markup undo are in scope.

**Rendering details**
- Hatch pitch is 4/5 px canonical, not 6 px.
- Text uses a Canvas2D atlas with fine size steps, not SDF.
- Memory arithmetic was wrong: the target is now 160 MB, with 256 MB as the no-go line.

**Data, gates and tests**
- The SVG is `mapData[5]` (0-indexed), not "line 5".
- The input gate was ≤4 ms, which no measurement supports; gates are now per-metric.
- Test counts don't reconcile: 268 vs 249/32 vs 21 files.

## Credible uncertainties

**Missing from the snapshot**
- d3 is absent, so drag and event internals are INFERRED.
- The font loader definitions are absent.
- `bench/` is absent.
- The `demo.map` fixture is absent.

**Unproven or unmeasured**
- Canvas2D `measureText` vs SVG text advance parity is unproven.
- Editor-open frame cost and hidden-model recalc cost are unmeasured.
- Only one GPU family has been measured (M1 Max, DPR 1, synthetic input). A Windows iGPU at DPR 2 is unknown.
- Float32 precision limits and device limits are arithmetic, not measurements.

**Budget**
- The budget model is calibrated on one ideation session.
- The high case (~$342) exceeds USD200; stage caps and stop-losses enforce the ceiling.
- No Opus long-context premium is listed in the brief. It is treated as unverified sensitivity.

## Next owner decisions

1. Approve P0 ($18 cap) and confirm whether ideation spend counts toward the USD200 (assumed yes, $30 line).
2. Provide `libs/d3.min.js` and the font loader source, or confirm where they come from.
3. Name the second GPU device for G1/G4.
