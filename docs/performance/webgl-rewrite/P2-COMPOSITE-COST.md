# P2 composite cost: 100k wheel-zoom group passes

Status: one runtime change landed in the isolated tree (uncommitted, on top of `1c5ab2b` and the P2-FRAME-PACING mask cull).

- It skips group composites that are provably empty on view.
- In a single headless timing run, the change removes the 100k wheel-zoom frame-pacing miss: **16.7 → 8.4 ms frame p95**.
- No 120 Hz claim, no universal-win claim, no paired comparison. The rewrite is not done.

Environment: M1 Max, ANGLE Metal, Chromium 148, headless. All artifacts are under `host-checks/`. The `p1-delegated-` prefix is written as `…`.

## 1. Evidence vs inference

**Measured**

- **Ablation.** Build `…146904654281000` with timing run `timing-1792146916146134000`. This was a temporary diagnostic that skipped the offscreen group passes entirely; it was not correct output and has been fully reverted.
  - 100k wheel-zoom frame p95 dropped from 16.7 to 8.4–8.6 ms.
  - Nothing else changed in that build.
  - Conclusion: the group offscreen passes cause the remaining miss, not JS, the mask loop or the main fills.
- **Before the change.**
  - Every cell ran 30 composites per frame.
  - Each composite is a full-viewport FBO clear plus a full-screen premultiplied quad at DPR2. That is ~30 extra full-screen fills per frame.
- **After the change** (after-settle `passes`, timing run `timing-1792147200683751000`):

  | Cell | composites | groupsEmpty (skipped) | opaqueMasked |
  |---|---|---|---|
  | 100k, all three gestures | 13 | 17 | 4 |
  | shared pan-near / pan-wide / wheel-zoom | 16 / 16 / 19 | 14 / 14 / 11 | — |

  The counters are zeroed in `render()` every frame, so these are per-frame values, not cumulative totals.

**Inferred, not proven**

- **Why only wheel-zoom missed.** Wheel-zoom fell over the vsync edge, while pan-near and pan-wide at the same composite count did not. The likely reason is the extra fill and mask pixel coverage at zoomed-in scales. Per-pass GPU time was not measured, so this is not shown.
- **Remaining headroom.** The 13 composites that remain are not proven to be cheap; they just fit within budget in this run.

## 2. The change and why it is exact

`src/gpu/framegraph.ts` adds an exported function, `emptyOnView(frame, batch, visible, pad)`. It is called first in `composite()`. If it returns true, the group is counted in `groupsEmpty` and returns **before any GL call**: no target bind, no clear, no stencil and no quad. No resource is allocated, and the lazy group target is untouched.

`emptyOnView` returns true only in these cases:

- **Fill or stroke:** its buffer is absent, `count` is 0, or it has **known** bounds that are `outsideView` with the same conservative `1/k` pad the existing batch cull uses.
  - Unknown (`null`/`undefined`) bounds mean **not empty**, so the full-viewport path still runs.
- **Sprites or glyphs:** the buffer or atlas is absent, or `count` is 0.
- **Image and markers:** always non-empty.
- **Group:** every child is empty. Alternatively, the group has a mask and **no white mask item** can draw on view.

**Why the skip is exact**

- **Empty group.**
  - The draw paths already skip exactly these batches: the same buffer and count guards, and the same `outsideView` cull.
  - So the group FBO would stay fully cleared, at (0,0,0,0).
  - Compositing that with `ONE, ONE_MINUS_SRC_ALPHA` gives `dst·1 + 0`, which leaves dest unchanged bit for bit.
  - Skipping it is therefore identical, at any opacity.
- **Mask with no on-view white item.**
  - The mask bit 0x80 starts clear.
  - Only white items set it; black items only clear it.
  - If no white item rasterises on view, every masked child fails the stencil test, and the case reduces to the empty group above.
  - "White followed by black" is **not** treated as empty (§3), because coverage was not proven.
- **Stroke and fill bounds** already contain every vertex. This is the `pathBounds` invariant tested in `mesh.test.ts` in P2-FRAME-PACING.

Counters `groupsEmpty` and `opaqueMasked` were added to `passes`. `opaqueMasked` is diagnostic only and changes no behaviour.

## 3. Tests and audit

**Tests.** `src/gpu/framegraph.test.ts` (new, 6 tests) covers:

- off-view and zero-count cases, plus the edge/pad straddle
- unknown bounds falling back to non-empty
- image, markers and non-empty sprites/glyphs never treated as empty
- nested groups
- mask semantics: black-only, white off-view, white with count 0, and white with null bounds, which stays non-empty
- white then black, which stays non-empty
- absent buffers

**Audit: none run.** No Haiku read-only audit child was used, to save budget. The exactness argument in §2 is supported by the tests and by the identical over16 smoke results in §5, not by an independent review.

## 4. Timing: before / after (DPR2, headless, untraced, `timing: null`, 2 iterations)

Before: `timing-1792121697734753000` (the P2-FRAME-PACING after-state). After: `timing-1792147200683751000`.

| Cell | frame p95 before → after (ms) | callback p95 after (ms) | idle frame p95 after (ms) |
|---|---|---|---|
| **100k wheel-zoom** | **16.7 / 16.7 → 8.4 / 8.4** | 0.9 / 0.8 | 8.4 / 8.4 |
| 100k pan-wide | 10.0 / 10.3 → 8.4 / 8.6 | 0.7 / 0.7 | 8.4 / 8.4 |
| 100k pan-near | 8.4 / 9.7 → 8.4 / 8.5 | 0.7 / 0.7 | 8.4 / 8.4 |
| shared pan-near | 9.7 / 9.5 → 9.5 / 8.5 | 0.7 / 0.7 | 8.5 / 8.4 |
| shared pan-wide | 9.8 / 9.7 → 8.4 / 8.4 | 0.6 / 0.6 | 8.7 / 9.5 |
| shared wheel-zoom | 9.8 / 9.6 → 8.5 / 8.4 | 0.7 / 0.7 | 8.5 / 8.4 |

- **CPU is unchanged.** Callback p95 was already ≤ 0.9 ms.
- **The gain is GPU-side and matches the ablation.**
- **Shared cells.** They also dropped. Part of that may be the run-level noise noted in P2-FRAME-PACING §4, so it is not attributed to this change without a paired comparison.
- **No GPU timer** was used in the acceptance run; timer values would be a relative indicator only.
- **Single run.** This is one headless run, so it is not proof of 120 Hz.

**Navigation.** Navigation DPR2 (CDP), `…147411489881000`. Before is P2-FRAME-PACING `…121581176670000`.

| Cell | frame p95 after (ms) | Before |
|---|---|---|
| shared pan-near / pan-wide / wheel-zoom | 8.5 / 8.6 / 8.4 | 8.4 / 9.8 / 9.7 |
| 100k pan-near / pan-wide / wheel-zoom | 8.4 / 8.4 / 8.4 | 8.9 / 8.5 / 8.5 |

- **Result:** failure null, finalCameraExact 6/6, gpuPresentedFraction 1, 0 prepares in motion, 0 long tasks in motion.
- **The navigation harness never showed the 16.7 ms wheel-zoom miss** (before: 8.5). The miss reproduced only in the timing harness, so the timing run in the table above is the before/after evidence.
- **eventToNextRaf for wheel-zoom is ~23 ms p50, both before and after.** This is unchanged and comes from the harness's wheel-dispatch cadence. It is not input-to-photon.

## 5. Acceptance gates (serial; `report.failure` checked on each)

| Check | Artifact | Result |
|---|---|---|
| Unit | `…147189198128000` | 579 pass (573 + 6 new) |
| Build | `…147193936682000` | pass |
| Timing (6 cells, untraced) | `timing-1792147200683751000` | see §4 |
| Smoke DPR2 z1 / z2 / z4 / z8 | `…147288671115000`, `…147298488577000`, `…147307465443000`, `…147316213558000` | failure null, GPU active, samples 0, antialias false. over16 **1.8311 / 0.9939 / 0.7908 / 0.2084 %**. Baseline: 1.8311 / 0.9938 / 0.7908 / 0.2084; z2 is 0.009938693 in both, a rounding difference only. maxDelta 255 / 255 / 237 / 158 |
| Smoke DPR1 z1 / z2 / z4 / z8 | `…147325190851000`, `…147369331737000`, `…147378036339000`, `…147386754457000` | failure null, MSAA samples 4. over16 **1.3214 / 0.7592 / 1.1817 / 0.2746 %**, identical to baseline |
| Hatch DPR2 / DPR1 | `…147395373546000` / `…147403613853000` | failure null; over16 0 at all zooms and pan, maxDelta ≤ 1, noReprepare true |
| Navigation DPR2 (CDP) | `…147411489881000` | see §4 |
| Context loss/restore, lifecycle | **not run** | Resource ownership is unchanged. The skip returns before any allocation or GL call, and adds no new object. |

**Smoke over16 failures.** The 3 failures out of 8 are **pre-existing and unchanged**:

- DPR2 z1 at 1.83 %
- DPR1 z1 at 1.32 %
- DPR1 z4 at 1.18 %

Every over16 value matches baseline, which is what an exact skip should produce.

## 6. Memory (tracked allocations, MiB = 2^20 B)

**Peak**

| Run | Peak | Baseline |
|---|---|---|
| Timing, 100k cells | 210967046 B = **201.19 MiB** | 210967070 B |
| Timing / navigation, shared wheel-zoom and 100k cells | 204850141 B = **195.36 MiB** | same |

- Both peaks are below the **256 MiB PEAK_LIMIT** (268435456 B).
- The change allocates nothing.

**Steady**

- 100k after settle: GPU total 114052986 B = **108.77 MiB**, plus CPU 24531992 B = 23.40 MiB.
- That is under the **160 MiB steady target**, which is the `budget` 167772160 field in status.
- Navigation end-of-cell GPU total for 100k is 159380426 B = 152.0 MiB, also under 160 MiB.
- The earlier P2-FRAME-PACING wording compared a peak against the 160 MiB budget. That was the wrong limit: peaks are measured against the 256 MiB PEAK_LIMIT.

## 7. Unchanged gates and open items

- G-C remains **5/8** smoke over16 passes. **SSIM is unmeasured.**
- **Input-to-photon is unmeasured.** eventToNextRaf is not input-to-photon.
- Context restore is still ~**601–605 ms**, above the 500 ms target (not rerun).
- Heap growth of **38.7 MB** is still open.
- **Windows is not done.** Only macOS/ANGLE Metal was measured.
- SceneDoc, editor and picking are incomplete.
- **No paired blocks** (2..5) were run, and no formal SVG/GPU comparison is claimed.
- **No 120 Hz claim and no universal-win claim.**
  - All cells now read ~8.4 ms in one headless run, but that is not a paired, multi-run result.
- Budgets, thresholds, AA, alpha, resolution and the harness are unchanged.

## 8. Next recommendation

1. **Run the paired comparison first, before any further optimisation.** Every timing cell now sits at the vsync floor in single runs, so the next decision needs variance data, not more speed.
2. **Optimise further only if paired data shows wheel-zoom near the edge.**
   - The candidate is a direct path for the **4 `opaqueMasked` groups** (opacity 1 plus mask). These could stencil-mask straight to the main target and skip the FBO.
   - That needs its own exactness proof: overlapping children inside an opaque group must still composite as SVG does.
   - The alternative is to scissor the remaining 13 composites to group bounds.
3. **Context restore (> 500 ms) and SSIM** are still open gates. They are a better use of budget than more frame-time work.
