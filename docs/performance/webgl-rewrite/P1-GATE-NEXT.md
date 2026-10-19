# P1 gate — next pass (bitmap windows, refine-at-settle, miss keys, lost-context draw guard)

Date: 2026-10-15. Host: mgm1, Chrome via the isolated `tupaia_checks` MCP harness (serial runs only). Renderer mode is
still **default SVG, opt-in GPU**. Nothing was deployed. There are no dependency, file-format, original-repo or `tests/e2e`
changes.

All numbers below come from artifacts in `docs/performance/webgl-rewrite/host-checks/p1-delegated-<id>.{json,log}`.
For each run, `exit_code` **and** `report.failure`/`report.errors` were read. The harness can exit 0 even when a run
failed, and one run below did exactly that.

**SVG fallback is not counted as a GPU pass.** In every browser run counted as passing here:
- `status.active === "gpu"`, with an empty `fallbackReason`
- `canvasVisible: true`
- window coverage was `covered`
- navigation reported `gpuPresentedFraction 1`

## Code changes in this pass

| File | Change |
| --- | --- |
| `src/gpu/prepare.ts` | `refineCompat` releases the old detail before it allocates the new one. If a refined run does not fit, it is downscaled into the remaining room (`scaleCanvas`), but only when the result is still sharper than the base compat resolution. Otherwise it is skipped. The budget and tolerances are unchanged. |
| `src/gpu/renderer.ts` | Window misses are split into `windowMiss` (real uncovered miss, counted) and `edgeMiss` (proactive edge refresh that did not fit while the view was still covered, not counted as a miss). Both are reset on commit and in `drop()`. That fixes the canvas staying hidden after a re-prepare at the same camera. |
| `src/gpu/renderer.ts` | `draw()` returns early when `gl.isContextLost()` is true. The context can be lost before `webglcontextlost` fires, while `device.lost` is still false. A draw in that gap created an incomplete `group` target and threw `Incomplete framebuffer group`. |

No `alpha:false` or `antialias:false` (both rejected), no SVG flip, and no loosened budget or tolerance. Panning does not
mutate the source DOM.

## Pass/fail matrix

There are three code states:
- **A**: before this pass's edits
- **B**: after the refine and miss-key edits
- **C**: B plus the lost-context draw guard (the final code)

| Check | State | Artifact id | exit | failure | errors | Result |
| --- | --- | --- | --- | --- | --- | --- |
| smoke dpr1 z1 | A | 1792098319022144000 | 0 | null | [] | PASS |
| smoke dpr1 z2 | A | 1792098328528913000 | 0 | null | [] | PASS |
| smoke dpr1 z4 | A | 1792098338246669000 | 0 | null | [] | PASS |
| smoke dpr1 z8 | A | 1792098347261456000 | 0 | null | [] | PASS |
| smoke dpr2 z1 | A | 1792098355749576000 | 0 | null | [] | PASS |
| smoke dpr2 z2 | A | 1792098289352543000 | 0 | null | [] | PASS |
| smoke dpr2 z4 | A | 1792098406954796000 | 0 | null | [] | PASS |
| smoke dpr2 z8 | A | 1792098418312709000 | 0 | null | [] | PASS |
| hatch dpr1 | A | 1792098427719054000 | 0 | null | [] | PASS |
| hatch dpr2 | A | 1792098435261466000 | 0 | null | [] | PASS |
| navigation dpr2 | A | 1792098443380577000 | 0 | null | [] | PASS |
| context dpr2 | A | 1792098555955639000 | 0 | null | [] | PASS |
| lifecycle dpr2 | A | 1792098567801046000 | 0 | null | [] | PASS |
| unit | B | 1792098721821803000 | 0 | — | — | PASS (52 files, 514 tests) |
| build | B | 1792098728701601000 | 0 | — | — | PASS (pre-existing vite warnings only) |
| bench | B | 1792098784385543000 | 0 | — | — | PASS (20/20). These are the harness's own tests; **no performance numbers were measured** |
| smoke dpr2 z2 | B | 1792098798768270000 | 0 | null | [] | PASS |
| smoke dpr2 z1 | B | 1792098788287573000 | 0 | null | [] | PASS |
| navigation dpr2 | B | 1792098808444204000 | 0 | null | [] | PASS |
| context dpr2 | B | 1792098867485527000 | 0 | null | [] | PASS |
| **lifecycle dpr2** | B | 1792098877769902000 | **0** | **null** | **["Incomplete framebuffer group"]** | **FAIL**. exit 0 hides it; fixed in C |
| build | C | 1792099031949122000 | 0 | — | — | PASS |
| lifecycle dpr2 | C | 1792099040798529000 | 0 | null | [] | PASS |
| unit | C | 1792099112641589000 | 0 | — | — | PASS (52 files, 514 tests) |
| context dpr2 | C | 1792099117901154000 | 0 | null | [] | PASS |
| smoke dpr2 z1 | C | 1792099130883150000 | 0 | null | [] | PASS (byte-identical memory and diff to B) |

**What was not re-run on C:**
- the six other smoke cells and hatch (last run on A)
- navigation (last run on B)

The C guard only skips draws on a lost context, so those results should carry over. They are still B/A results, not C
results.

The lifecycle error in B appeared in only one run. It depends on timing between `loseContext()` and the async
`webglcontextlost` event, so one clean C run shows the race no longer reproduced. It does not prove the race is gone.

## Memory (tracked GPU allocations; budget 167,772,160 B = 160 MiB steady, 256 MiB peak)

| Case | Steady total | Peak | Notes |
| --- | --- | --- | --- |
| smoke dpr1 z1/z2/z4/z8 (A) | 132.2 / 130.5 / 127.8 / 123.3 MB | = steady | windows margin 640 |
| smoke dpr2 z1 (C) | **167,771,837 B** (159.9997 MiB) | 167,771,837 | 323 B headroom. Refinement fills the remaining room by design. Pre-refine 137.7 MB. Windows 56.1 MB at margin 320 |
| smoke dpr2 z2 (B) | 165,711,973 | = steady | |
| smoke dpr2 z4 / z8 (A) | 155.1 / 137.2 MB | = steady | |
| navigation shared wheel-zoom (B) | 157.7 MB | 210.8 MB | old and new crops during the swap |
| navigation 100k wheel-zoom (B) | 151.2 MB | **222.4 MB** (212.1 MiB) | highest peak observed |
| lifecycle dpr2, 20 world switches (C) | flat 165,712,833 B every cycle (count 49) | ≤ budget | `0` while lost; 113.7 MB after restore (refinement pending) |
| context dpr2 (C) | 165.7 MB → 0 on loss → 113.7 MB after restore | 165.7 MB | lastRestoreMs 597.9 |

**Stoploss:** not triggered. Steady stays ≤ 160 MiB and the highest peak is 212 MiB, under 256 MiB.

JS heap (lifecycle, forced GC): heapGrowthBytes is 37.9 MB on C (42.3 MB on B, 38.5 MB on A) over 20 world switches.
That averages about 1.9 MB per switch; the per-cycle shape has not been analysed. GPU memory stays flat; the JS creep is a blocker below.

### Correction to P1-VIEWPORT-INTEGRATION.md

The "about 323 MB steady / 375 MB peak" in `P1-VIEWPORT-INTEGRATION.md` is the **old pre-window CDP capture**. It is not
the current measurement. The current measured maxima are **167.77 MB steady** (DPR2 z1) and **222.4 MB peak** (100k
wheel-zoom). Both are tracked allocations as reported by the GPU device, not OS or driver residency.

## Fidelity (GPU vs SVG reference diff, 2560×1440 at DPR2)

| Case | over16 fraction | maxDelta | mean max-channel delta |
| --- | --- | --- | --- |
| dpr2 z1 (B and C) | 3.09% (A: 3.30%) | 220 | 1.81 |
| dpr2 z2 (B), context after restore (C) | 1.01% | 255 | 0.715 |
| dpr1 z1 / z2 / z4 / z8 (A) | 1.33% / 0.77% / 1.21% / 0.35% | — | — |
| dpr2 z4 / z8 (A) | 0.83% / 0.29% | — | — |

**Blur limit.** DPR2 z1 is the worst cell:
- compat resolution is 0.56
- labels (compat runs, reason `text`), markers (`<svg>`), burg icons and fog are compat rasters, not native vectors
- refine-at-settle sharpens what fits in the remaining 30 MB, but text detail at DPR2 z1 is still softer than SVG

This is a budget limit, not a bug. It cannot be fixed without native text/markers or a larger budget, and the budget was
not raised.

## Performance: retaken vs the old CDP figures

Navigation DPR2 (B, artifact 1792098808444204000) used injected CDP input. It measures event timestamp to the next
requestAnimationFrame, which is **not** physical input-to-photon. It is a pilot, not 10 interleaved pairs. In every run:
- gpuPresentedFraction was 1
- coverage was `covered`
- misses were 0
- the final camera was exact

| World / gesture | Frame p50 / p95 / max (ms) | Event→RAF p50 / p95 (ms) | Long tasks | Window refreshes |
| --- | --- | --- | --- | --- |
| shared pan-near | 8.3 / 8.4 / 9.4 | 6.0 / 8.4 | 0 | 0 |
| shared pan-wide | 8.3 / 8.4 / 9.5 | 6.1 / 8.0 | 0 | 7 |
| shared wheel-zoom | 8.3 / 8.4 / 10.3 | 22.6 / 24.4 | 0 | 8 |
| 100k pan-near | 8.3 / 9.1 / 100 | 6.2 / 8.7 (max 98.7) | 1 × 102 ms | 8 |
| 100k pan-wide | 8.3 / 8.5 / 26.2 | 6.1 / 8.4 | 0 | 15 |
| 100k wheel-zoom | 8.3 / 10.2 / 18.2 | 23.4 / 32.5 | 0 | 16 |

Compared with the old CDP figures:
- **Shared pans.** The old RAF was about 8.4 ms; it is now 8.3 ms p50 and 8.4 ms p95. That is unchanged; both are at the
  display frame interval.
- **Dense wheel, RAF.** Original pilot RAF p95 was 16.8 ms; B is RAF p50/p95/max 8.3 / 10.2 / 18.2 ms on the 100k
  world. Same-metric comparison: RAF p95 16.8 → 10.2 ms.
- **Dense wheel, event→RAF.** Original pilot event→RAF p95 was 42.9 ms; B is event→RAF p50/p95 23.4 / 32.5 ms.
  Same-metric comparison: event→RAF p95 42.9 → 32.5 ms. (An earlier draft of this doc compared 42.9 with RAF p50 8.3;
  that mixed metrics and percentiles and was wrong.) Both are CDP-dispatched input in one run each, not photon latency
  and not the 10 interleaved-pair gate.
- **100k pan-near.** It still shows one prepare during motion (preparesDuringMotion 1), a 102 ms long task (294 ms on A)
  and an idle frame max of 457.9 ms.

## Gesture cases the harness lacks

None of these have been tested:
- rapid pan/zoom reversal
- resize or DPR change mid-gesture
- world switch **during** motion
- context loss **during** motion

Lifecycle and context exercise these only at rest. The B lifecycle race shows that loss timing matters.

## Remaining blockers

1. **Re-run on final code.** The six other smoke cells, hatch and navigation have not been re-run on C.
2. **100k pan-near.** A prepare during motion causes a 100–300 ms long task.
3. **JS heap creep.** 37.9 MB over 20 world switches; not yet diagnosed.
4. **DPR2 z1 sits at the budget edge.** It has 323 B headroom by design, but any extra allocation there makes refinement
   skip.
5. **The 16 MiB compat floor** can in principle exceed the budget. This has not been observed.
6. **Telemetry coverage** is computed from the view, not from canvas visibility.
7. **zoom-update-scheduler** may drop the final exact paint. This is unverified, although finalCameraExact passed in
   navigation.
8. **Crop copy on the main thread.** The Canvas2D crop copy runs there; move it to `createImageBitmap` or a worker.
9. **No unit coverage for `renderer.ts`.** The miss-key, drop and lost-guard logic is covered only by browser checks.
10. **Fidelity.** Text, markers and icons are compat rasters (blur limit above).
11. **Missing gesture cases** (listed above).
12. **Missing measurement.** The 10 interleaved A/B pair gate for dense wheel has not been run.

## Next bounded chunk

- **P2.** Build the canonical SceneDocument/editor bridge, so the GPU path reads canonical scene state instead of the
  SVG DOM.
- **Full rewrite.** Native text/markers and removing compat rasters are still outstanding.

P1 is a viewport/memory gate only. It is not the full rewrite.

## Spend

$3.72464861 (actual receipt) of the $10 cap, including the two read-only audits. No other paid API was used. The
navigation-reliability follow-up is accounted separately in P1-NAVIGATION-RELIABILITY.md.
