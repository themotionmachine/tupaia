# Parity ledger: GPU default display over the hidden SVG model

Acceptance receipt for W4 (PHASE1-PLAN.md): "The PARITY-LEDGER is updated from those receipts."

Scope is D9: GPU is the default display and the hidden SVG stays the editable model. P3 (SceneDocument ownership)
and P4 (removing the SVG display path) are deferred. Navigate/Edit modes are D10. The default flip is **not yet
approved**; SVG is still the production default and `?renderer=gpu` is opt-in.

Status words: **PASS**, **PASS with known gap** (the gate passes, a stated limit remains), **GAP** (not proven or
failing).

## Receipts

| Receipt | Build | Result | Evidence |
|---|---|---|---|
| Browser tier (shared lock) | `04ec9040` | PASS, 4572 s | `~/.tupaia-gates/gpu-main/browser-20261021T205750-812Z` |
| T2 timing and census runs (below) | `04ec9040` | all PASS | `~/.tupaia-gates/gpu-main/<check>-20261021T22*` and `T23*` |
| Nightly matrix (shared lock) | `04ec9040` | 1 harness flake, then PASS on rerun | `~/.tupaia-gates/gpu-main/nightly-20261021T234530-294Z` |
| Rerun of the flaked step | `8c5986f9` | PASS, 160/160 | `~/.tupaia-gates/gpu-main/golden-20261022T031757-322Z` |
| Production deploy | `04ec9040` | live check below | Worker `d43c7f46-6f66-4ce7-9c8c-58bf013b9bbe`, 2026-10-21 |

All browser runs used `ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max)`. Per D6 there is no second GPU family,
no Windows/iGPU at DPR 1, and no second OS yet; those stay G4 blockers.

## Parity by area

Golden thresholds are D1/D11: SVG arm against GPU arm of the same build on the isolated layer, SSIM >= 0.95, over16
<= 1%, at most 0.5% of pixels over 44 (`reading=over44`), plus the per-layer coverage gate.

| Area | Status | Check | Key numbers | Evidence |
|---|---|---|---|---|
| Per-layer pixel parity, gate matrix | PASS | `golden` k {1,4}, DPR 2, default preset | 74/74 cells, 0 fail, 45 pass only under the loosened reading | `golden-20261021T210740-073Z` |
| Per-layer pixel parity, shared map | PASS | `golden fixture=shared k=1,4` | 72 cells: 57 pass, 15 N/A, 0 fail | `golden-20261021T221806-359Z` |
| Per-layer pixel parity, nightly | PASS | `golden` k {1,2,4,8} x DPR {1,2} x 12 presets | 24 runs of 160 cells, all 160/160 except one flake (next row) | `nightly-20261021T234530-294Z` |
| Nightly flake `golden[d2 cyberpunk]` | PASS on rerun | same step on `8c5986f9` | 1 cell (`goods/k1`) failed on the harness rule "SVG arm still changing after 10 shots", 80 px; Chromium GPU-raster redraw alternated between identical frames. Fixed by `gpu/w4c-flake` (`8c5986f9`). Rerun 160/160; cell rerun alone passed | `golden-20261022T031757-322Z`; failing run `golden-20261022T013430-228Z` |
| Presets | PASS | `presets` all 12, parity fixture, k 1,4, DPR 2 | 12 x 74 cells, 0 fail; N/A only for `clean` vignette and `cyberpunk` borders/vignette (empty in both arms) | `presets-20261021T222246-829Z` |
| Cyberpunk borders on black | PASS | `golden layers=borders bg=#000000` | 4/4 at DPR 1 and 2 | `golden-20261022T015426-895Z`, `...T015443-327Z` |
| Old save versions | PASS | `corpus` 8 maps (v0.9b to v1.123, demo v1.112), golden on | 237 checks, 0 failed; 40 gates, 1 unreachable (`1.0.0`: nothing loads that version) | `corpus-20261021T230137-874Z`, nightly `corpus-20261022T020334-114Z` |
| Labels | PASS | `labels` (+selftest) | 14/14 threshold cells; 200 map labels, 0 missing; glyph pixel p95 0.058, p99 0.098 | `labels-20261021T220746-674Z` |
| Stroke rasterization | PASS | `stroke-probe` | joins 8/8 in every cell; lines/shapes differ only in cells marked n/c (not compared) | `stroke-probe-20261021T221334-099Z` |
| Coat-of-arms race | PASS | `coa-race` | 3/3 (k 2,4,8); 134 symbols re-prepared; ink SVG 185354 vs GPU 185316 at k2 | `coa-race-20261021T211115-694Z` |
| Hatch settle | PASS | `hatch` DPR 2 | no re-prepare; max delta 1 at k 1,2,4,8 and pan; over16 0 | `hatch-20261021T230116-784Z` |
| Paint | PASS | `paint` | 56 reads | `paint-20261021T230115-718Z` |
| Palette and presets state | PASS | `palette` | 23/23 stages; settled paint exactly equal across arms | `palette-20261021T205941-156Z` |
| Toggles | PASS with known gap | `toggles` (+census selftest) | 99 pass, 0 fail, 1 info. On-state golden after a toggle is 28/31; `burgs`, `scaleBar`, `vignette` fail it (reported, not gated; `TOGGLE_STRICT=1` gates) | `toggles-20261021T215458-149Z` |
| Customization | PASS | `customization` | 11/11 | `customization-20261021T220313-628Z` |
| Resize and print | PASS with known gap | `resize-print` | 26 pass, 0 fail, 2 info. Known gap `dpr-change-backing`: backing store 2560x1440 where 1280x720 is expected at DPR 1. Print is protected by the `beforeprint` hook, not by the `@media print` rule | `resize-print-20261021T220445-271Z` |
| Reuse fidelity (compat raster reuse) | PASS | `reuse-fidelity` (+selftest) | 89 checks, 64 pass, 0 fail, 25 info. Reuse exercised on 15/21 (zoom), 20/21 (move), 19/21 (toggle) families; visible definition edit on 5/21 | `reuse-fidelity-20261021T211245-520Z` |
| Picking | PASS | `picking` 3 worlds (+ nightly k1, k4) | cells 2359/2359 (parity), 1892/1892 (shared), 1313/1313 (100k); pick p95 0.7 / 1.4 / 1.8 ms; semantic mismatches 1 / 0 / 5 (D3: reported, not gating). `strictFailures` on 100k: relief 98.66%, river 99.20% (<99.5%, not gating). Lake, route, coastline cohorts "insufficient" samples | `picking-20261021T205958-610Z` |
| Stale pick window | PASS | `integration` | wheel-to-click p50 34 ms, max 36 ms, none past wheel end (route and marker cohorts, n=10 each) | `integration-20261021T210110-432Z` |
| Editor replay (SVG, GPU, GPU+select) | PASS | `replay` and `replay-resume editors=all` | all 39 editor scripts PASS in all 3 arms, both runs; steady heap 152 MiB | `replay-20261021T212126-181Z`, `replay-resume-20261021T231534-753Z` |
| Consumers (save, export, minimap, 3D, API) | PASS | `consumers` (+selftest) | 295 checks, 0 failed; row 33 SKIP (1 check, not exercised) | `consumers-20261021T214153-018Z` |
| Canonical SVG model and fallback | PASS | `canonical` | label resync 10/10, 0 dropped; fallback to SVG clears hook, renderer and canvases | `canonical-20261021T205806-445Z` |
| Boot order | PASS | `boot-order` | 3/3 at 1500 ms delay (GPU waits for first world, `d0b151e8`) | `boot-order-20261021T205755-384Z` |
| Smoke / context | PASS | `smoke`, `context` | active `gpu`, 0 errors, 30/30 caravan markers on GPU, context restore `active` | `smoke-20261021T221348-899Z`, `context-20261021T230122-898Z` |
| Memory | PASS | `memory-cycles` (nightly) | 3/3; heap 31.5 MB at cycle 0, 33.4 MB at cycle 20 | `memory-cycles-20261022T015657-259Z` |
| Harness self-tests | PASS | golden, reuse, replay, consumers, labels, census, corpus selftests | each seeded break is caught (e.g. replay catches model, dom, dispatch, stale) | same browser and nightly dirs |

## Timing (T2, exclusive lock, DPR 2)

| Area | Status | Check | Key numbers | Evidence |
|---|---|---|---|---|
| Navigation | PASS with known gap | `navigation worlds=shared,100k,parity zoom=2` | pan frame p95 8.7-9.5 ms; GPU presented fraction 1; Layerize max <= 0.4 ms; wheel-zoom frame p95 8.7-8.8 ms on shared and 100k but **16.1 ms on parity** (eventToNextRaf p95 31.4 ms); shared/100k wheel eventToNextRaf p95 16.6-16.7 ms against a 16.7 ms budget | `navigation-20261021T221403-398Z` |
| Trade layer live | PASS | `trade-live` | 30/30 caravans moved on GPU, 0 DOM writes, p95 16 ms vs 9 ms frozen, 119 fps | `trade-live-20261021T221514-913Z` |
| Context-loss restore | PASS | `restore world=100k` | loss to draw 1115 ms; restored to draw 951 ms; prepare 915 ms; same revision, payload retained 3/3 | `restore-20261021T221603-320Z` |
| Native recovery | PASS | `native-recovery` x4 | recovery wall: wheel 100k 3332 ms, pan-wide 2176 ms, pan-near 1931 ms, parity wheel 3292 ms; 0 failed prepares; 0 hit mismatches and 0 SVG writes while moving | `native-recovery-20261021T221634-461Z`, `...T221700-006Z`, `...T221723-526Z`, `...T221746-591Z` |
| Editor resume (D12) | PASS with known gap | `replay-resume` Metal, 39 scripts | worst current frame: `heightmap` 1840 ms (gpu), 1874 ms (gpu-select); `goods` 1764 / 1977 ms; refined worst 2653 / 2870 ms (`goods`). Browser-tier `replay` run: worst current 1940 ms (gpu), 2242 ms (gpu-select). Target is 2 s to the first current frame | `replay-resume-20261021T231534-753Z`, `replay-20261021T212126-181Z` |

## Production check

Deployed `gpu/integrate` `04ec9040` as Worker `d43c7f46-6f66-4ce7-9c8c-58bf013b9bbe` on 2026-10-21. Rollback chain:
`93b5c879`, then `d2c61040`, then `5224b113`.

Live check: `?renderer=gpu` was active on 10 of 10 loads; the shared map loaded with 47,885 cells; 0 page errors;
writes blocked. SVG remains the default.

## Known gaps and follow-ups

1. **Editor resume near the 2 s target.** Heightmap and `goods` resume reach 1.8-2.0 s to the current frame (up to
   2.2 s in the browser-tier run, gpu-select arm); refined frames take up to 2.9 s. Thin or no margin.
2. **Wheel-zoom frame budget.** Shared and 100k hold p95 8.7-8.8 ms but eventToNextRaf p95 is 16.6-16.7 ms against
   16.7. On the parity world frame p95 is 16.1 ms and eventToNextRaf p95 31.4 ms.
3. **First DOM write before any gesture.** It still costs about 155 ms of Layerize, because the svg-cover arms only
   on the first gesture. Decision pending with Ryan.
4. **No pixel or pick gate runs under an armed svg-cover.** Moving-proof checks (`native-recovery`) cover hit
   agreement and write counts only.
5. **Chord count follows the zoom at which a bucket was prepared.** Accepted by Ryan 2026-10-21.
6. **`dpr-change-backing`** (resize-print): backing store stays at the larger size after a DPR drop.
7. **15 shared-fixture layers are empty in both arms** at the shared-map cameras (lakes, compass, provinces,
   coastline, military, fog, legend, and burgs at k4): N/A, not a pass.
8. **Compat re-cut after pans.** After a pan, compat windows are re-cut instead of reused (observed "kept 0 cut 22",
   about 900 ms in the background); reuse is proven only for the cases `reuse-fidelity` exercises.
9. **Toggle on-state golden** fails for `burgs`, `scaleBar`, `vignette` (3 of 31) and is reported, not gated.
10. **Picking:** semantic mismatches (up to 5 on 100k) and two strict cohort misses (relief, river) are reported
    under D3; several cohorts have too few samples.
11. **Coat-of-arms visibility contract.** Four assertions were changed by PANEND. Pending Ryan's acknowledgement.
12. **D14 retired.** GLYPH3 (W4b) cuts placed glyphs at their real rotation and sub-pixel phase; `PRESET_EXCEPTIONS` is
    empty and cyberpunk labels pass the presets gate with no exception.
13. **Hardware (D6):** second GPU family, Windows/iGPU at DPR 1 and 60 Hz, second OS.
14. **Default flip not yet approved.** P3 and P4 remain deferred until a measured need appears.
