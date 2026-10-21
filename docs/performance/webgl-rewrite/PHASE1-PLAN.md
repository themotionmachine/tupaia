# Phase 1: finish P2 parity and the recovery work (Claude, from 2026-10-19)

Branch `gpu/integrate`. Production is still `deploy/2026-10-18-5224b113`, with SVG as the default.

Phase 0 established:
- An audit of all 43 matrix rows: 9 native, 12 compat, 8 bridge, 14 partial.
- No row has a passing row-specific acceptance check yet.
- The renderer is further along than its proof. Several earlier "passes" compared GPU output against GPU output.
- The remaining performance cost (editor resume 6–10 s, 100K context-loss recovery 7.7 s) comes mostly from
  re-rasterizing every compat run on any change.

## Decisions

Each one can be overruled by Ryan.

| # | Decision |
|---|---|
| D1 | Goldens are judged per layer family on the isolated layer, SVG arm against GPU arm of the same build. The thresholds stay as written: SSIM ≥0.95, over16 ≤1%, ≤0.5% at Δ≤44. A check never compares GPU against GPU. |
| D2 | REWRITE-PLAN §5 mechanism cells are relabelled to what was built. Compat (C) and bridge (B) are valid at P2. Native ports happen only when a golden fails or a perf target needs them. |
| D3 | Row 15 picking is gated on the semantic outcome matching SVG `clicked()`. Raw GPU-index agreement is reported but does not gate. |
| D4 | I-trade = I9 + I11. API smoke = the row-40 three-part check. The customization, row-37 and row-38 smokes belong under G-S. The editor criterion while an editor suspends to SVG is **resume latency**, not frame p95. |
| D5 | Golden matrix. Gate: k {1,4} × DPR 2 × default preset. Nightly: k {1,2,4,8} (plus coastline switch points) × DPR {1,2} × 12 presets. |
| D6 | Out of Phase 1, needs hardware: a second GPU family, Windows/iGPU at DPR 1 and 60 Hz, and the second OS for row 43. These are G4 blockers. |
| D7 | Checks run in three tiers (below). Builders run T0 only. The orchestrator runs T1 when a wave merges. T2 runs at phase boundaries and overnight. |
| D8 | Performance work runs alongside parity work. The perf packet owns `prepare.ts`/`compat.ts` in W0–W1. The parity packets that touch those files (COMPAT, RES) run later and rebase onto it. |
| D9 | **Scope (Ryan, 2026-10-19).** "Finished" means GPU is the default display and the hidden SVG stays the editable model. REWRITE-PLAN P3 (SceneDocument ownership) and the P4 step that removes the SVG display path are deferred until a measured need appears. The remaining work is parity, recovery speed, hardening and the default flip. |
| D10 | **Navigate/Edit modes (Ryan, 2026-10-19).** Switching between navigating (GPU, fast) and editing (canonical SVG and editors) becomes an explicit, visible mode with keyboard shortcuts, instead of only an implicit suspend when an editor opens. Packet MODE (W1). |
| D11 | **Golden reading (Ryan, 2026-10-19).** The D1 clause "≤0.5% at Δ≤44" gates as *at most 0.5% of pixels differ by more than 44* (`reading=over44`). The strict reading (any Δ>0 ≤0.5% and maxDelta ≤44) fails on invisible rounding and anti-aliasing (91 of 160 parity cells). The switch lands **together with** a per-layer coverage gate, because whole-frame fractions let small layers lose most of their ink: GPU ink ≥ about 0.9× the SVG ink of that layer, and a small cap on over16 as a share of the layer's own ink. Both readings stay in the report. |
| D12 | **Editor resume goal (Ryan, 2026-10-19).** The 2 s goal is measured to the first *current* GPU frame (the edit is in it and it navigates at GPU speed). Time to the refined (fully sharp) frame is reported, not gated. The goal is judged on the decluttered editor scripts (Metal: 1.1–1.3 s current, 1.8–2.0 s refined at W1). The dense every-layer case (marker: 5.7–7.4 s current) is tracked as a separate performance target of 4 s current, not a release blocker. All resume timings come from the Metal launcher under the exclusive lock. |
| D13 | **What shows during resume (Ryan, 2026-10-19).** After an editor that changed the model closes, the SVG stays visible until the GPU frame is current. A stale GPU frame labelled "Updating" is shown only when the editor changed nothing. |
| D14 | **Preset label exception (Ryan, 2026-10-20).** Under `cyberpunk`, labels k1 misses the D11 coverage cap (over16 25.4% of the layer's ink, cap 20%): the preset paints labels white on the golden's white backdrop, so the cell's ink is two fixture labels whose rotated and sub-pixel glyphs the GPU resamples from an atlas cut at phase 0, where Skia rasterizes each glyph in place. An exact match needs per-phase/rotation glyph cuts (about 4x atlas for straight text, a cell per curved glyph). Accepted as a documented exception (`PRESET_EXCEPTIONS` in `bench/host/census-core.ts`), revisited if real maps show visibly soft rotated labels. Default-preset labels pass. **Retired (W4b GLYPH3, 2026-10-21):** the settle now cuts the glyphs in view in place (`src/gpu/glyph-fine.ts` placed cut, per-glyph rotation and sub-pixel phase), cyberpunk labels k1 reads 7.8% and passes without the exception; `PRESET_EXCEPTIONS` is empty. |

## Test scheme

| Tier | What | Where | Lock |
|---|---|---|---|
| T0 | `npm run gate -- quick` (typecheck, vitest, build), plus the builder's own unit tests and `buildScene` characterization tests | every builder, every change | none |
| T1 | correctness: per-layer goldens SVG↔GPU, editor replay, consumers (save/export/minimap/3D), palette, canonical, picking | orchestrator at each wave merge; harness builders get one self-test slot | **shared**: several correctness runs at once, capped |
| T2 | timing: native Metal paired A/B against the previous tag, navigation, recovery, route resume, nightly golden matrix | phase boundaries and overnight | **exclusive**: nothing else in a browser |

Timing evidence must come from a quiet host. Correctness checks do not need one, so they no longer queue behind
timing runs.

## Waves

The packet definitions are in the Phase 0 synthesis (kept outside git), summarized here.

- **W0:**
  - GOLD (per-layer golden runner and census; owns `gate.ts`, including the shared/exclusive lock)
  - FIX (parity fixture that populates every row)
  - SEAM (happy-dom `buildScene` tests)
  - RAS (pattern-tile dash and clamp fixes)
  - PERF-A (compat reuse per dirty run and a lazy clone; owns `prepare.ts`/`compat.ts`)
  - MCPFIX (the 7 MCP failures inherited from phase 1)
- **W1:** MODE (explicit Navigate/Edit mode: indicator, shortcuts, no collisions with existing hotkeys; uses the navigation-only fast path), REPLAY (G-E editor replay), CONS (save/export/consumers), LIFE (renderer lifecycle bugs: font guard
  first), PRIM (native primitives in `scene.ts`), PERF-B (keep the CPU payload across context loss).
- **W2:** CENSUS (toggles, presets, resize, print), LABELS, EDIT (the other 15 editors and the undo systems),
  COMPAT, CORPUS.
- **W3:** STROKE, PICK, RES, and fixes for whatever the sweeps find.
- **W4:** acceptance. T2 in full, plus all new checks, as a non-diagnostic receipt. The PARITY-LEDGER is updated
  from those receipts.

Every packet goes through: build (own worktree, T0) → independent review of the diff → fix → merge → T1 at the
wave's end.
