# P2 parity handoff: GPU prototype vs. "full rewrite without feature loss"

This is a static source audit. No code, tests, `dist`, harness, controls or budget were changed, and no checks were run. This file is the only one written. Two read-only native children did the audits: one on picking and event routing, one on SceneDoc ownership. The primary re-read every citation below that is marked ✔. Runtime evidence comes only from the earlier P2 reports cited here. **The full rewrite is not done.**

## 0. One-line architecture

The GPU canvas is a **navigation paint accelerator layered over a canonical SVG**. The SVG still owns paint truth, hit testing, d3.zoom gestures, editing, save and export.

- The canvas is `pointer-events:none` and is inserted after `<svg id="map">` ✔ `src/gpu/renderer.ts:201-204`. The header comment says the same ✔ `:1-7`.
- A `MutationObserver` on the live SVG reprepares the GPU frame from the DOM ✔ `renderer.ts:234-252`, with `invalidate()` at ✔ `:590-594`.
- Any open editor dialog or customization mode **suspends** the GPU and shows the SVG ✔ `renderer.ts:574-580`.
- Today's feature preservation therefore comes from leaving the SVG path in place, not from GPU parity.

## 1. Readiness matrix

Key: E = exists, W = wired into the UI, V = validated by real evidence.

| # | Feature | Current authoritative path | Real evidence | Gap | Next bounded action |
|---|---|---|---|---|---|
| 1 | **Paint, navigation frames** | GPU canvas from DOM-derived scene. SVG camera written on settle and on hide ✔ `renderer.ts:583-588` | E/W/V(partial). 10 interleaved pairs at DPR 2 on an M1 Max. 100k pan p95 16.8/16.9 → 8.5 ms; wheel 41.7 → 8.4. Shared pan-near 8.5 vs 8.7 is unresolved, CI crosses 0 (P2-COMPARISON-CONFIRMATION §3) | Synthetic DOM timing, not photon latency. Unpaired bootstrap. Windows untested | Stop nav micro-tuning. Leave as is |
| 2 | **Paint fidelity** | Same as row 1 | SSIM passes 8/8; over16 passes 5/8; conservative reading passes 0/8 (P2-FIDELITY-MEASUREMENT §1) | Only 8 full scenes. No per-layer, preset, font or editor goldens | Owner decision (§4), then build goldens |
| 3 | **Cell pick** | CPU quadtree on `pack.cells.p`: `findCell` → `findClosestCell`, `src/utils/graphUtils.ts:235-250` (child) | E/W. No unit test found (child) | Renderer-independent, so already GPU-safe in principle | Add to 500-point parity fixture |
| 4 | **Burg / label / marker / route / river / relief click** | **DOM hit test.** `clicked()` dispatches on `d3.event.target` ancestor ids ✔ `public/modules/ui/editors.js:15-47`. Hits land on the SVG through the pass-through canvas | E/W through the SVG bridge. Header names a known stale-camera window during motion ✔ `renderer.ts:5-7` | No parity test of SVG target vs. stale camera. No GPU-routed dispatch | Tranche §3 |
| 5 | **Canvas-layer CPU picks** | `window.pickBurg` ✔ `src/renderers/burg-canvas.ts:179`, `window.pickRelief` ✔ `relief-canvas.ts:296`. Used as the `clicked()` fallback ✔ `editors.js:41-46` | E/W. Not checked this job | Coordinates use `d3.mouse(viewbox)`, which is subject to the stale-camera window | Include in parity fixture |
| 6 | **GPU pick (`gpuPick`)** | `PickIndex` CPU grid built from SVG elements at prepare time (`prepare.ts:137, 224-387`, child). `GpuRenderer.pick` ✔ `renderer.ts:286-290`, exported as `page.gpuPick` ✔ `:939` | E. **Not W.** Its only consumer is a bench grid sampler ✔ `bench/navigation-quality.ts:408-416` (80 px grid, nearest `[id]`). No recorded agreement figure found in the docs. `pick.test.ts` has 19 `PickIndex` unit cases ✔, including topmost-first `:96` and brute-force `:184`. `GpuRenderer.pick` has no test | No 500-point G-P result. No id-buffer pass. Not wired to `clicked()` | Tranche §3 |
| 7 | **Hover / tooltips** | SVG listeners, e.g. `public/main.js:441, 524-526` (child) | E/W through SVG | Same stale-camera window | Parity fixture (hover sample) |
| 8 | **Edit drag** (burg label, label, marker) | `d3.drag` on SVG selections ✔ `burg-editor.js:13`, `labels-editor.js:10`, `markers-editor.js:9`. GPU is suspended while the dialog is open | E/W through SVG. No G-E replay | GPU does not paint during editing, so editing is never faster | Later: G-E replay scripts |
| 9 | **Style edit / presets** | Writes SVG attributes → observer marks the scene static → reprepare ✔ `renderer.ts:242-244` | E/W. Whether the GPU repaints correctly after preset changes has not been validated (no preset goldens) | REWRITE-PLAN row 28 preset goldens are missing | Goldens, after the §4 decision |
| 10 | **Undo / redo** | Existing per-editor systems on SVG/pack. No SceneDoc command path (child) | E/W as SVG. Not audited further this job | P3 commands not started | Out of scope until SceneDoc ownership |
| 11 | **Save `.map`** | Clones and serializes the live `#map` ✔ `src/io/save.ts:103, 130` | E/W, renderer-independent. The P0 demo.map round-trip covers only the shadow parse | — | None for P2 |
| 12 | **Export SVG/PNG** | Clones the live `#map` ✔ `src/io/export.ts:256`, serializes ✔ `:236`. No GPU reference in `src/io` (child) | E/W through SVG. `export.ts` has uncommitted working-tree changes that were **not reviewed** here | — | Review the diff before any ship |
| 13 | **SceneDoc** | **A lossless diagnostic shadow, not the owner.** Built only by `captureSceneShadow()` from `XMLSerializer(#map)` ✔ `src/renderers/scene-document.ts:426-453`. Exposed on `window` only | E. Not W. `scene-document.test.ts` covers byte-exact round-trip and revisions (child) | No bridge to GPU or editors. The GPU reads the DOM directly (`gpu/scene.ts:204`, child) | Do not promote yet (§3) |
| 14 | **Context loss** | GPU re-prepare | Telemetry only. 581 ms (DPR 2) and 661 ms (DPR 1) loss-to-draw. Post-event 525/602 ms. Gate is ≤500 ms (P2-CONTEXT-RECOVERY) | Scene 229 ms + world raster 211–331 ms. No small fix | Separate structural item (cache scene across loss) |

**Preserved through the canonical SVG bridge:** clicks, hover, every editor, drag, style edits, undo, save, export and load. This is a transitional compatibility path, and it is honest in that no feature is removed.

**GPU path still incomplete:** routed picking, painting while editing, any editor-facing behavior, per-layer, preset and font fidelity, recovery time, and Windows.

## 2. Static vs. runtime evidence

- **Static only (this job):** every row-level E/W claim in §1. The children found the source; the primary verified the ✔ lines.
- **Runtime (prior reports, unchanged):** timing (row 1), the 8-scene fidelity metrics (row 2) and recovery telemetry (row 14). The latest recorded run had 586 unit tests passing, the build passing, and 31 bench tests passing (11 of them math).
- **Not claimed:** any 500-point hit parity, any G-E editor parity, or any browser behavior of `clicked()` under GPU mode. Unit tests at `PickIndex` level are not UI parity.

## 3. Recommended next tranche: **G-P picking parity, then a GPU-routed click dispatch**

**Why this one.** The candidates are picking parity, SceneDoc editor ownership and native labels.

- **Picking is the cheapest change that is actually load-bearing.** The pick index already exists and is unit-tested (row 6). The click dispatcher is a single function (row 4). It is also the prerequisite for everything later: the GPU cannot keep painting during editing, and the SVG cannot ever leave the hit path, until GPU hits are proven to equal SVG hits.
- **SceneDoc ownership** is the real rewrite core: P3 commands, undo, and the save materializer. It is several times larger, and it can be validated only with G-E replay infrastructure that does not exist yet.
- **Native labels** are paint-fidelity work. Doing them before the fidelity decision in §4 risks tuning against an undecided gate.

**Dependency order and acceptance:**

1. **Build the 500-point hit-parity fixture** (PROOF-PLAN §4 "Hit parity"; backlog H15). Use seeded points per fixture at DPR 1 and 2, k ∈ {1, 2, 4, 8}, on settled frames. Compare `gpuPick` against `elementFromPoint` plus the same ancestor-id rule `clicked()` uses.
   - Accept: 100% cell agreement more than 1 px from borders. At least 99.5% agreement for burgs, labels and markers. Report routes, rivers and relief raw. Topmost order matches SVG. Report every mismatch; no masking.
2. **Add a stale-camera probe.** Sample during motion, before the exact update, and report how far SVG targets diverge from `gpuPick`. This measures the known limitation at `renderer.ts:5-7`. Measurement only.
3. **Add a flagged dispatch adapter.** Under `?renderer=gpu`, map the `PickHit` id to its DOM element and invoke the existing `clicked()` branch with that element as the target. Editors stay on SVG, and suspension is unchanged.
   - Accept: no double dispatch, identical editor opened, the same `elSelected`, and unit tests for the mapping.
4. **Only then** start G-E replay scripts for click-select. Drag stays SVG-suspended.

Out of scope: SceneDoc promotion, native label rework, recovery restructuring, the default flip and production.

**Fermi cost (uncertain).** Recent bounded tranches cost about $3.7–$4.2 each (P1-GATE-NEXT, P1-NAVIGATION-RELIABILITY, P2-TIMING-DIAGNOSIS). Cumulative spend went from $75.06 to about $93.1 over the last several P2 jobs.

| Steps | API cost | Engineer-hours |
|---|---|---|
| 1–2 | ~$5–10 (1–2 tranches) | ~4–10 |
| 3 | ~$4–8 | ~3–8 |
| 1–3 total | **~$9–18** | **~7–18** |

These figures assume the same tool and harness, and the error bars are wide. This is **more than the ~$7 left under the $100 quiet checkpoint once a safety margin is kept**, so it should start at a new budget decision, not now.

## 4. Fidelity reference: owner decision kept separate

The PROOF-PLAN §4 clause "≤0.5% of pixels at delta ≤44" is ambiguous. Under the labelled conservative reading (changed ≤0.5% and max ≤44), all 8 scenes fail: changed is 10.7–17.6% and max is 113–255. The raw RGB gates are reported as measured:

- SSIM passes 8/8 (0.9833–0.997).
- over16 passes 5/8. The failures are DPR 2 z1 at 1.831%, DPR 1 z1 at 1.321% and DPR 1 z4 at 1.182%.

There was no retuning, no masking and no cherry-picking. The plan owner has to choose the intended reading before goldens or label work proceed. This decision does not block the picking tranche.

## 5. Handoff

- **Performance proof completed:** 10 interleaved pairs at DPR 2 on an M1 Max show the GPU at the 120 Hz floor on 100k pan and wheel, where the SVG misses vsync. The shared-world pan-near result is unresolved. The evidence is synthetic DOM timing with unpaired CIs and n = 10 per arm, not photon latency. Nav micro-tuning has stopped.
- **Correctness blockers:**
  - G-P hit parity has not been measured.
  - The GPU pick is not wired.
  - G-E editor parity does not exist.
  - Fidelity is 0/8 under the conservative reading and 5/8 on over16.
  - Context recovery misses ≤500 ms (581/661 ms).
  - Windows is untested.
  - SceneDoc is a shadow, not the owner.
- **Production state:** frozen at P1. Later P2 fixes are unshipped. SVG is the default. There has been no deploy and no default flip. Heap is 38.7 MB open; tracked GPU memory is 160 MiB steady, 256 MiB peak, with the last peak around 201 MiB, under budget.
- **Next decision (owner):** (a) choose the reading of the fidelity reference; (b) fund the G-P picking tranche in §3 at an estimated $9–18 under a fresh cap. Pausing at the quiet checkpoint below $100 is consistent with this handoff, and no further work is needed just to use up budget.
