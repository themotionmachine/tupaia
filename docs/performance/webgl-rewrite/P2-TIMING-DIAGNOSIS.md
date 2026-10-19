# P2 timing diagnosis: GPU navigation cadence at DPR2

Status: one cause identified, with trace evidence, and fixed in the isolated GPU lane. Default renderer stays SVG; GPU
stays opt-in. Production frozen P1 is untouched. No deploy, no default flip, no harness/config/budget-file edits.
Paired blocks 2–5 **were not run** (by instruction). **This does not close the rewrite**: G-C over16 still fails at
3/8 cells, and the fix has not yet been re-measured under the headful paired protocol.

## Question

The earlier headless CDP navigation checks reported ~8.4 ms frames. The headful synthetic A/B pilot
(`host-checks/paired-dpr2-block1`, immutable, build `c1813c08…3def9a`) showed the GPU arm slower. Which harness was
right, and what does the GPU path actually cost per frame?

## Finding

**Both harnesses were measuring something real.** The `timing` check (same build, DPR2 1280×720 → 2560×1440 backing,
M1 Max, Chromium 148, ANGLE Metal, Skia Graphite, 120 Hz) reproduced the slow cadence both headless and headful,
traced and untraced. The 8.4 ms navigation numbers came from runs whose gesture/world mix the slowdown did not hit
hard (see "Reconciliation").

### Observed (trace, `host-checks/timing-1792116964614600000/`, headful + trace)

- In motion, each WebGL draw is followed by a compositor-frame ack ~13 ms later. At idle the same ack arrives in 0.2–0.4 ms.
- cc gates the next `SendBeginMainFrame` on `DidReceiveCompositorFrameAck`. A ~13 ms ack therefore skips every other
  8.33 ms vsync, and rAF cadence settles at 16.7 ms (60 Hz).
- Renderer CPU per frame was ~0.3 ms (callbackP95 0.8 ms on the shared world). The main thread was idle, not busy.
- GPU main thread: a `RunTask` of 5576 µs wall vs 258 µs thread time, i.e. blocked waiting on GPU work, not computing.
- Context attributes at DPR2: `antialias: true`, `samples: 4` (reported by the check's `contextProperties`).

### Inferred (consistent with the evidence; mechanism not instrumented below ANGLE)

- With `antialias: true` the canvas default framebuffer is an implicit 4× MSAA 2560×1440 surface, ~118 MB. Every
  frame pays a full-surface multisample resolve before the compositor can sample the canvas. On Metal/Graphite that
  resolve plus the compositor's own pass delayed the ack past one vsync.
- This surface is invisible to the renderer's tracked memory (`memory.basis: tracked-allocations`). The 160 MiB
  steady figure never included it.

The inference became a tested hypothesis via the single change below; no other variable was changed.

## Change

The canvas drawing buffer now follows the same density rule the offscreen group targets already used
(`targetSamples` returns 0 at DPR ≥ 2):

- `src/gpu/budget.ts:129-134`: `canvasAntialias(dpr)` returns `dpr < 2`, with a comment pointing here.
- `src/gpu/renderer.ts:201`: `new GpuDevice(…, { antialias: canvasAntialias(globalThis.devicePixelRatio || 1) })`.
- `src/gpu/device.ts:51`: the default `antialias: true` is unchanged (DPR1 keeps 4× MSAA). Restore reuses the same
  attributes, so a restored context keeps the setting (verified by the context check below).
- `src/gpu/budget.test.ts:188-195`: covers DPR 1/1.5/2/3 and the consistency with `targetSamples`.

Caveat: context attributes are fixed at creation. If a window moves between a DPR1 and a DPR2 display, the setting
follows the DPR at creation (or at the last context restore). This is not handled; it falls back to either good AA or
the old cost, never to a failure.

Practice this follows (cited from memory; not fetched in this job):

- The MDN "WebGL best practices" guidance on sizing the drawing buffer for `devicePixelRatio` and treating it as real
  memory.
- MapLibre GL JS ships `antialias: false` by default; its MSAA is opt-in.
- The repo's own `targetSamples` rationale: at Retina density, pixel density stands in for MSAA.

## Before / after (`timing` check, DPR2, 2 iterations per cell, ms)

Before: untraced headless `host-checks/timing-1792117126463686000/`. The traced headful run
`timing-1792116964614600000` gave the same picture. After: untraced headless `host-checks/timing-1792117615559905000/`
(load avg 4.9 at start).

| world / gesture | frameP95 before → after | callbackP95 before → after | idleFrameP95 before → after |
|---|---|---|---|
| shared pan-near | 16.7–17.8 → **8.4** | 0.8 → 0.6 | 8.4–8.8 → 8.4–8.6 |
| shared pan-wide | 16.7–17.8 → **8.5** | 0.8 → 0.5–0.6 | 8.4–8.8 → 8.4 |
| shared wheel-zoom | 16.7–17.8 → **8.5–8.6** | 0.8 → 0.6 | 8.4–8.8 → 8.4 |
| 100k pan-near | 25 → **8.4** | 10.8 → 1.3 | 8.4 → 8.4 |
| 100k pan-wide | 25 → **16.7** | 11.2 → 11.2–11.3 | 8.4 → 8.4 |
| 100k wheel-zoom | 18.2 / 25 → **16.7** | 12.8–13.9 → 10.7–10.8 | 16.7 → 10.2 / 8.5 |

Other after values:

- inputDispatchP95 went from 0.5 to 0.3 on the shared world. This is reported but not counted as a win: lower
  dispatch only moves work, it doesn't remove it.
- firstFrameWaitMs was 4.6–12.7.
- motionSurfaceActiveCount was 0 everywhere.
- 100k wheel-zoom had one frame > 25 ms per iteration (first10Max 25.1).
- The strict 2 ms idle cadence gate is unchanged. Idle p95 is 8.4–8.6 except one 100k wheel-zoom iteration at 10.2.

**Honest reading:**

- The shared world and 100k pan-near now hold 120 Hz.
- 100k pan-wide and wheel-zoom improved from 25 ms to 16.7 ms, but **they are still at 60 Hz**. Their bottleneck is
  now different: the frame callback itself costs ~11 ms of main-thread CPU at the 100k full-world view.
  That is the next target, not something this change claims to fix.

### Navigation check (after, `p1-delegated-1792117898666201000`, DPR2)

- All 6 runs have finalCameraExact true, gpuPresentedFraction 1 (no hidden SVG during motion), preparesDuringMotion
  0, and long tasks during gestures 0.
- frame p95 is 8.4–8.6 ms. The previous navigation run, `p1-delegated-1792115966885336000`, had 8.4–10.3.
- eventToNextRaf p95 / max:

  | gesture | before | after |
  |---|---|---|
  | 100k wheel-zoom | 29.7 / 37.3 | 24.6 / 25.9 |
  | shared wheel-zoom | 24.7 / 25.2 | 24.3 / 25.8 |
  | pans | ≤ 8.8 | ≤ 8.8 |

  The ~23 ms wheel p50 is the same before and after. It comes from how wheel events get to rAF in this harness, not
  from the renderer.
- Contradiction: navigation shows 100k pan-wide at 8.4 p95, while `timing` shows 16.7. The `timing` check measures
  a wider full-world sweep that keeps ~2900 batches in view. I treat `timing` as the stricter measurement. The
  navigation figures are not used to claim the 100k case is fixed.

## Reconciliation of headless vs headful

- The slow cadence was not a headful-only artifact. It reproduced headless under `timing` once the gesture swept a
  large drawn area.
- *Inferred, not traced:* the earlier smooth headless navigation runs measured gestures whose ack cost stayed just
  under a vsync.
- The pilot's GPU arm ran the full drawing buffer at 2560×1440 with 4× MSAA in every pair, so it paid the full cost.

I did not pick a preferred harness. The pilot JSONs stay immutable and are not reinterpreted. Whether the fix closes
the headful gap is **unverified** until a paired block is rerun on this build (not done here, by instruction).

## Visual / memory effect

- Smoke `contextProperties`: DPR2 runs show `antialias: false, samples: 0`. DPR1 runs show `true, 4`.
- Pixels, DPR2 z2: compared with the pre-change artifact `p1-delegated-1792115859065882000`, over16 is identical to
  every digit (0.009938693576388888). changedFraction went 0.16555745 → 0.16555664 and meanMaxChannelDelta
  0.7035083 → 0.7035075. Fills are tessellated meshes and much content is compat rasters, so canvas MSAA barely
  touched the image.
- Untracked default-framebuffer memory at 2560×1440: ~118 MB (4× colour + resolve) → ~29 MB (single-sample colour,
  plus stencil). This is arithmetic from the format, not a measured process figure.

### G-C smoke table (after; gate over16 ≤ 1%)

| DPR | zoom | over16 after | previous | gate | tracked bytes | artifact |
|---|---|---|---|---|---|---|
| 2 | 1 | 1.831% | 1.831% | FAIL (pre-existing) | 159,380,441 | p1-delegated-1792117764536347000 |
| 2 | 2 | 0.9939% | 0.994% | pass | 159,372,253 | p1-delegated-1792117782026434000 |
| 2 | 4 | 0.791% | 0.791% | pass | 155,087,005 | p1-delegated-1792117808113647000 |
| 2 | 8 | 0.208% | 0.208% | pass | 137,195,593 | p1-delegated-1792117815596392000 |
| 1 | 1 | 1.321% | 1.321% | FAIL (pre-existing) | 132,196,081 | p1-delegated-1792117822274287000 |
| 1 | 2 | 0.759% | 0.759% | pass | 130,441,389 | p1-delegated-1792117828093813000 |
| 1 | 4 | 1.182% | 1.182% | FAIL (pre-existing) | 127,756,549 | p1-delegated-1792117834263811000 |
| 1 | 8 | 0.275% | 0.275% | pass | 123,240,757 | p1-delegated-1792117840486747000 |

- Results for all 8: errors [], failure null, active gpu, sourceCurrent true, contextLosses 0, windows covered,
  refinementWaitMs 1–2. 5/8 pass, unchanged.
- Steady memory is ≤ 159.4 MB tracked, within the 160 MiB budget (167,772,160).
- Navigation peak was 204,850,141 B, within the 256 MiB cap.

## Checks run (this tranche, final code)

| check | artifact | result |
|---|---|---|
| unit | p1-delegated-1792117712229243000 | 54 files / 560 tests pass |
| build | p1-delegated-1792117717611218000 | exit 0 (new dist fingerprint not recorded) |
| smoke ×8 | table above | 5/8 G-C pass, same as before |
| hatch DPR2 | p1-delegated-1792117848955730000 | maxDelta ≤ 1, over16 0 at z1/2/4/8/pan, noReprepare |
| hatch DPR1 | p1-delegated-1792117854475670000 | maxDelta ≤ 1, over16 0 at z1/2/4/8/pan, noReprepare |
| navigation DPR2 | p1-delegated-1792117898666201000 | see above |
| context DPR2 | p1-delegated-1792117954074880000 | loss + restore OK, lastRestoreMs 596.5, heapGrowth 0, restored attrs antialias false |
| timing (diagnostic) | timing-1792116964614600000 (traced headful, before), timing-1792117126463686000 (before), timing-1792117615559905000 (after) | tables above |

Not run, and why:

- **Paired blocks 1–5:** blocks 2–5 were excluded by instruction. Block 1 was not rerun either, so the old raw
  pilot stays the only paired record.
- **lifecycle:** buffer and texture ownership did not change. Only a context-creation attribute did, and the context
  check covers restore.
- **`timing` on DPR1:** DPR1 behaviour is unchanged by construction.
- **fidelity:** the smoke pixel gate covers the change, and the pixel delta is ~1e-6.
- No Haiku review child was spawned: the diff is ~10 lines and has unit coverage.

## Remaining gates / open issues

- G-C over16 fails at DPR2 z1 (1.831%), DPR1 z1 (1.321%) and DPR1 z4 (1.182%). These failures predate this change.
  SSIM is unmeasured.
- 100k full-world pan-wide and wheel-zoom are still at 60 Hz, because of ~11 ms main-thread callback CPU.
- Context restore takes ~600 ms (596.5 ms here).
- JS heap is +42 MB vs SVG (from the earlier tranche; not re-measured).
- Windows / integrated GPUs are untested. The ack-delay mechanism may differ there (D3D11 ANGLE).
- Not yet verified under the headful paired protocol on this build.
- The runtime DPR change is not handled (see "Caveat").

## Next chunk recommendation

Target the 100k full-world frame callback (~11 ms CPU, ~2900 batches in view). Candidates to profile first, in this
order:

1. per-batch program / VAO / uniform rebinding in the framegraph fill/composite loop: sort or merge batches by
   program and texture;
2. `markers.collect` per frame;
3. culling cost at full-world zoom.

Then rerun `timing`, and only after that a single paired block (block 1 on the new build, with a versioned protocol
note), before any block 2–5.

## Spend

About $4.1 of the $8 CLI limit at writing, including all checks. No child agents. Cumulative reconciled
spend before this tranche was $75.058757205 (cap $200).
