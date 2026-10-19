# P2 — GPU frame callback draw cost (100k full world)

Scope: the main-thread cost of `FrameGraph.render()` at the 100k full-world view. Before this change the callback p95 was ~11 ms,
over the 8.3 ms 120 Hz budget. Production, the frozen P1 path, defaults, deploy, bench protocol and harness (including
`bench/profile-navigation.ts`) are all unchanged. All artifacts are in `host-checks/`.

## 1. Profile: what was measured vs inferred

- **Measured.** Traced timing profile `timing-1792118197676584000/` (cpuprofile). It is weak: ~470 samples, and the top-N
  summary was unreadable, so self time was read straight from the cpuprofile nodes.
  - The hot self-time frames under `render()` are native WebGL entry points: `colorMask`, `drawArrays`/instanced draws,
    `uniformMatrix3fv`, `stencilMask`, `stencilFunc`/`stencilOp`, `vertexAttribDivisor`/`vertexAttribPointer`, `useProgram`.
  - JS-side tessellation, culling and sorting do not show up as significant.
- **Telemetry.** The draw batch counts were 167 submitted / 2714 culled (wide) and 447 / 2434 (zoom). Each submitted
  stencil-then-cover fill or stroke issues roughly 10–20 state setters, and most of them repeat the previous batch's value.
- **Inferred, not proven by the profile alone.** Chrome's per-call validation and command serialization dominate. The cost
  scales with the number of GL calls, not with GPU work. The before/after timing below supports this inference. The profile
  is evidence only, never acceptance.

## 2. Native audit (one Haiku child)

The audit read `framegraph.ts`/`device.ts` and listed per-batch redundant calls:

- re-issued `useProgram`
- `colorMask`/`stencilMask` toggles around each stencil-then-cover pair
- identical `stencilFunc`/`stencilOp`
- unchanged view-matrix and color uniforms
- `bindBuffer` + `enableVertexAttribArray` + `vertexAttribPointer` + `vertexAttribDivisor` re-specified on a VAO that
  already holds the same pointer

The audit also flagged these as candidates. They are **not** addressed here:

- per-frame DOM `querySelectorAll` for editor reasons
- `markers.collect` running twice
- translucent stroke scissor clears
- marker `bufferData` reallocation plus the `memory()` scan
- composite passes for groups whose content was fully culled

## 3. Change

- `src/gpu/gl-state.ts` (new): `GlState` is a per-frame shadow of the state the frame graph sets per batch.
  - Each setter issues its GL call only if the value differs from what this frame has already set.
  - Covered state: program, VAO, color mask, stencil write mask, stencil func, front/back stencil op, and
    `uniform1i/1f/1fv/4fv/Matrix3fv`.
  - Float attribute pointers are tracked per VAO.
  - Uniforms are compared **by content**, because callers reuse scratch arrays.
  - A null (inactive) uniform location issues nothing, which is the same no-op GL performs.
- `src/gpu/framegraph.ts`: every draw-time setter goes through `this.state`.
  - `state.reset(gl)` runs at the start of each frame, after the marker buffer upload, which is the only other
    `bindBuffer` user.
  - It also runs again right after the mid-frame `device.target()` in the group composite.
  - `bindVertexArray(null)` runs at the end of the frame.
  - The opaque stroke path uses the existing `plain()` helper.
- `src/gpu/renderer.ts`: telemetry adds `stateCalls {issued, skipped}`.

**Why this is safe.** The emitted call sequence is the uncached sequence with no-op calls removed. Draw order and the
effective state at every draw are unchanged. Nothing is reordered, merged, culled or skipped, and painter order, group
opacity, masks, fill rules, caps, dashes, pattern UVs and marker animation all use the same draws with the same state.

Not cached: textures, blend, scissor, framebuffer, viewport. These are still issued as before. AA is unchanged, and the
DPR≥2 `antialias=false` fix is kept: DPR2 runs report antialias false / samples 0, DPR1 runs antialias true / samples 4.
Memory budgets and tolerances are untouched.

## 4. Tests

`src/gpu/gl-state.test.ts` (4 tests):

1. A property test over 20 seeds × 400 random setter steps against a model GL. At random "draw" points, the cached path's
   effective state matches the uncached reference exactly. The cached path issues fewer calls.
2. A reused scratch matrix whose content changed is re-uploaded.
3. `reset()` re-issues state that was changed outside the cache.
4. Attribute pointers are tracked per VAO.

Unit: 564/564 pass (`p1-delegated-1792118627859364000`). Build: pass (`p1-delegated-1792118632349303000`).

## 5. Before/after, untraced timing (DPR2, 2 iterations per cell)

Before: `timing-1792117615559905000`. After: `timing-1792118637772165000`.

| Cell | callback p95 before (ms) | callback p95 after (ms) | frame p95 before → after (ms) |
|---|---|---|---|
| 100k pan-wide | 11.3 / 11.2 | 7.3 / 7.9 | 16.7 → 16.7 |
| 100k wheel-zoom | 10.7 / 10.8 | 5.2 / 5.3 | 16.7 → 16.7 |
| 100k pan-near | 1.3 / 1.3 | 1.1 / 1.1 | unchanged |
| shared (all) | ~0.5–0.6 | ~0.6–0.7 | ~8.4–9.0, unchanged |

- Callback p50 stayed at ~1.0 ms.
- Draw batches are identical before and after, and so are the memory peaks, byte for byte.
- `stateCalls` at 100k wide is ~15169 issued / ~7376 skipped per frame; at zoom it is 16360 / 10794.
  - **Correction (P2-FRAME-PACING.md §2):** these are per-frame values, since `render()` zeroes the counts every frame.
  - They do not come from the ~160 draw batches. They come from the then-unculled group mask loop: 1432 mask fills per
    frame, mostly off-view.
- One secondary metric for 100k wheel-zoom went from 10.2/8.5 to 16.4/16.6 ms. It is probably idle-interval noise, but
  that has not been shown.

## 6. Gates (all run serially from the primary; `report.failure` was checked on each)

| Check | Artifact | Result |
|---|---|---|
| Smoke DPR2 z1/z2/z4/z8 | `…118733106531000`, `…118742493123000`, `…118751272421000`, `…118760378021000` | failure null, GPU active; over16 1.8311 / 0.9938 / 0.7908 / 0.2084 %, identical to baseline |
| Smoke DPR1 z1/z2/z4/z8 | `…118806572357000`, `…118814302529000`, `…118821884585000`, `…118829582192000` | failure null; over16 1.3214 / 0.7592 / 1.1817 / 0.2746 %, identical to baseline |
| Hatch DPR2 / DPR1 | `…118836943798000` / `…118844319516000` | failure null, over16 0 at all zooms and pan, maxDelta ≤ 1, noReprepare true |
| Navigation DPR2 | `…118851096957000` (pre-change `…117898666201000`) | failure null, finalCameraExact 6/6, gpuPresentedFraction 1, 0 prepares or long tasks in motion; frame p95 8.4 in every cell, same as before |
| Context loss/restore | `…118923286548000` | failure null, restore 605 ms (baseline 596.5), 0 window misses |
| Lifecycle | `…118975122189000` | failure null; heapGrowth 38.7 MB. This is the pre-existing heap growth (~42 MB in the baseline), not caused by this change and still unresolved |
| Paired v2 DPR2 block 1 | `paired-v2-dpr2-block1/` | exit 0, dist unchanged, but **comparable: false** (SVG/GPU idle cadence differs > 2 ms for shared pan-wide and wheel-zoom); stopped there, no further blocks |

The `…` prefix is `p1-delegated-1792`. The 3 of 8 smoke over16 failures are pre-existing and unchanged.

Navigation keeps the 100k cells at the 8.4 ms frame floor both before and after, so it is neutral and does not reproduce
the timing harness's 16.7 ms frame p95.

Paired block 1 is informational only, because the harness marked it non-comparable. In it, the GPU arm's 100k pan-wide
callback p95 was 8.4 ms, higher than in the timing run and right at the budget, so the headroom at 100k wide is thin.

## 7. Limitations

- **Frame p95 at 100k wide/zoom is still 16.7 ms in the timing harness.** The callback now fits in 8.3 ms, so the
  remaining frame-interval cost is outside the JS callback: GPU execution, the compositor, or the harness. This change
  does not reach 120 Hz frame pacing there. The 8.3 ms floor is not photon timing, and synthetic dispatch is not latency.
- The callback headroom is thin: 7.3–7.9 ms in the timing run and 8.4 ms in paired block 1.
- Textures, blend, scissor and framebuffer are not cached.
- The paired comparison is non-comparable, and only 1 of 5 blocks was run.
- This is not a universal win. Shared cells are flat, and the callback p95 there rose ~0.1 ms, which is within noise.
  Paired block 1 still shows SVG with a lower callback than GPU at 100k pan-wide and pan-near.

## 8. Next slices (one at a time, each with proof)

1. Find where the 100k frame interval goes beyond the callback: GPU time via timer queries, or the compositor.
2. Remove per-frame DOM `querySelectorAll` (editor reasons) and the duplicate `markers.collect`.
3. Marker `bufferData` reallocation → `bufferSubData` into a sized buffer, and drop the per-frame `memory()` scan.
4. Skip the composite for groups whose batches were all culled (needs an exactness proof for group opacity/mask).
5. Translucent stroke scissor clears, and per-batch texture binds.
