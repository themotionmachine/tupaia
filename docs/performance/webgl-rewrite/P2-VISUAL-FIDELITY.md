# P2 visual fidelity: sharp compat runs refine first

Status: one coherent cause fixed in the isolated GPU lane. Default renderer stays SVG; GPU stays opt-in. Production
frozen P1 ad4f0bf6 untouched. No deploy. **The rewrite is not done**: G-C over16 still fails at 3 of 8 smoke cells,
and SSIM ≥ .95 / the stricter whole-frame diff remain **UNMEASURED**.

## Code state

Change (3 files, on top of working tree = control/tupaia-fidelity-checkpoint):

- `src/gpu/budget.ts` — `refineOrder(rects, visible, sharp = [])`: runs flagged `sharp` sort first, then smallest
  visible area, then painter index. Draw order unchanged.
- `src/gpu/prepare.ts` — `CompatRun.sharp`; `SHARP_COMPAT = {"text", "<svg>", "restored burg vectors"}`; a merged
  world run is sharp if any member is (`last.sharp ||= sharp`); `refineCompat` passes the flags to `refineOrder`.
- `src/gpu/budget.test.ts` — the full-scene ordering case (pattern smaller than a scattered label run by a fog margin).

No change to masks, tolerances, budgets (`GPU_BUDGET`, `DETAIL_RESERVE`), context attributes, AA, ownership,
semantic metadata, picking or DOM camera handling.

## Images inspected and what was seen

DPR2 z1 fidelity, before (artifact `p1-delegated-1792115740578407000`, over16 2.5703%):

- GPU frame: burg and state labels and marker icons visibly
  soft/ghosted next to the SVG reference; fills, rivers, coastlines and routes looked matched.
- Diff heatmap: hottest areas were label and marker clusters, not polygon edges. Thin yellow route/border edges were
  the only edge-only (AA-like) residue.
- Status detail list: every small run refined to density 2 except `label32` at **0.637** (the base world density)
  while `oceanPattern>rect` took 1.754.

After (artifact `p1-delegated-1792115821289846000`, over16 1.831%):

- Labels and markers crisp, correct colours and icons; the ghosting is gone.
- Heatmap still outlines labels/markers in red/orange and route/border edges in yellow — weaker, but present.
- Detail list: all label/marker/icon runs and `ice` at 2; `oceanPattern>rect` 1.106.

Hotspots (128 px tiles, over16 count):

| before | after |
|---|---|
| (256,1152) 2939 | (256,1280) 1822 |
| (128,1280) 2813 | (128,1280) 1812 |
| (1408,384) 2768 | (384,1280) 1593 |
| (256,1280) 2611 | (0,1280) 1579 |
| (1024,640) 2451 | (384,1024) 1362 |
| — | (1408,384) 1204 |

changedFraction 0.186 → 0.176; meanMaxChannelDelta 1.595 → 1.153.

## Cause (evidence vs inference)

Evidence:
- `refineCompat` greedily refines world runs within `GPU_BUDGET - DETAIL_RESERVE` (152 MiB) in `refineOrder` order,
  which was "smallest visible area first".
- At DPR2 z1 the run holding the remaining labels+markers kept the base density 0.637 while the ocean pattern was
  refined; after reordering, the same budget refines the labels+markers run to 2 and the pattern drops to 1.106.
  Tracked memory is essentially unchanged (159,378,993 → 159,380,441 B).

Inference (not proven):
- `label32` is a merged run: adjacent world compat elements merge in DOM order, and no `markers` id ever appears in the
  detail list, so it most likely contains the last label group, the markers `<svg>`s and the fog mask. Its alpha
  bounds therefore span nearly the whole view, so it measured larger than the pattern (which is smaller by the fog
  margin) and was refined last, after the budget ran out.

Source-backed pattern (RENDERER-READING-GUIDE.md): §2 WebGL best practices — budget before allocating, so a fixed
budget's allocation order *is* the quality policy; §4 text is its own rendering system — glyph/icon detail loses far
more from a blurry base than a smooth fill or tiled pattern does. Ordering by content type is the smallest change
that respects both without raising the budget.

## G-C over16 table (gate ≤ 1%)

Before = baseline numbers from the task; after = ordinary smokes on the final candidate.

| DPR | zoom | before | after | gate | artifact (after) |
|---|---|---|---|---|---|
| 2 | 1 | 2.57% | **1.831%** | FAIL | p1-delegated-1792115850115671000 |
| 2 | 2 | 1.25% | **0.994%** | pass | p1-delegated-1792115859065882000 |
| 2 | 4 | 0.79% | 0.791% | pass | p1-delegated-1792115910174601000 |
| 2 | 8 | 0.21% | 0.208% | pass | p1-delegated-1792115921174883000 |
| 1 | 1 | 1.32% | 1.321% | FAIL | p1-delegated-1792115932086167000 |
| 1 | 2 | 0.76% | 0.759% | pass | p1-delegated-1792115941328346000 |
| 1 | 4 | 1.18% | 1.182% | FAIL | p1-delegated-1792115950231872000 |
| 1 | 8 | 0.27% | 0.275% | pass | p1-delegated-1792115958532013000 |

Pass count went from 4/8 to 5/8. Only the two cells where the budget had been binding changed (DPR2 z1/z2). At DPR2
z4/z8 and all DPR1 cells, every run already refined to full density (detail lists all at 2·zoom·dpr/2), so the order
change can't affect them, and they reproduce the baseline. The DPR2 z2 margin is thin (0.994%).

All 8 smokes: errors [], failure null, active gpu, no fallbackReason, sourceCurrent true, contextLosses 0, windows
covered, refinementWaitMs 1–2.

## Memory and performance

Tracked steady memory per smoke (cap 167,772,160; practical target 159,383,552):

| DPR | z1 | z2 | z4 | z8 |
|---|---|---|---|---|
| 2 | 159,380,441 | 159,372,253 | 155,087,005 | 137,195,593 |
| 1 | 132,196,081 | 130,441,389 | 127,756,549 | 123,240,757 |

All are within the 152 MiB practical target. Navigation peak was 204,850,141 B (256 MiB cap 268,435,456). DPR2 z1 refine job
took ~287 ms vs 257 ms before (one more large run rasterized at 2×). This is off the motion path: refinement runs at settle.

Navigation (`p1-delegated-1792115966885336000`, DPR2, shared + 100k worlds × pan-near/pan-wide/wheel-zoom): all 6
runs finalCameraExact true, gpuPresentedFraction 1, preparesDuringMotion 0, longTasks during gestures 0, frame p95
8.4–10.3 ms. The 100k wheel-zoom run ended with `refinementPending: true` (a ~700 ms 100k refine was still running when
the capture was taken). I don't know whether this predates the change, because no pre-change navigation run was taken this session.

Hatch (`p1-delegated-1792116022925539000`): maxDelta ≤ 1, over16 0 at z1/2/4/8/pan; cameraOnlyNoSvgUpdates, noReprepare.

Other checks: build `p1-delegated-1792115815164910000` exit 0; unit `p1-delegated-1792115843648137000` 54 files /
559 tests pass. Context/lifecycle were not run: ownership and allocation lifetimes are unchanged (same runs, same
detail allocations, only their order). No Haiku review was run: the diff is ~10 lines and has unit coverage.

## Tradeoff

The ocean pattern gives up density at DPR2 z1 (1.754 → 1.106). It is a low-frequency tiled texture, so the visual
cost is small, and the measured whole-frame diff improved. When the budget isn't binding, the order makes no difference.

## Remaining gates (not met / not measured)

- G-C over16 fails at DPR2 z1 (1.831%), DPR1 z1 (1.321%), DPR1 z4 (1.182%).
- SSIM ≥ .95: UNMEASURED. Stricter whole-frame diff: UNMEASURED.
- The remaining DPR2 z1 residue is concentrated in label/marker outlines in the bottom-left band (y≈1024–1280). Its cause
  is unknown: glyph-edge AA, sub-pixel registration of the compat crop, or the resampled pattern beneath are all candidates.
- DPR1 z1/z4 failures happen with every run at full density, so budget ordering isn't their cause.

## Next bounded step

With the code in its current state, run `fidelity` with `layer=labels` and then `layer=markers` at DPR2 z1 and DPR1 z4. Compare the
isolated over16 values and hotspots with the full scene, to split text/marker error from what lies beneath. If the
isolated label diff is a consistent 1-px offset rather than edge-only AA, check compat crop registration (`cropRegion`
/ pixel-snapping of the detail rect) before considering any AA or text-system change.
