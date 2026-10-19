# P1 memory + fidelity repair

Status: **code + pure tests written, nothing executed here.** The tests, lint, typecheck and every gate below need the
host to run them. SVG stays the default renderer until the host proof passes.

Starting point (host evidence): MEMORY FAIL, with 322,504,633 B tracked at DPR1 (no-go 256 MiB, target 160 MiB).
FIDELITY FAIL, with 4.71 % of pixels > 16 and max 217. Relief icons were visibly blurrier. Animation, presentation and
frame advance passed.

## What "memory" means now

`GpuDevice.memory()` is a **tracked allocation estimate**: the bytes this renderer uploaded or allocated.
- Textures count ×4/3 when mipmapped.
- Buffers count at their uploaded size.
- Targets count via `targetBytes` (MSAA colour + MSAA depth/stencil + resolve texture).

It is not measured driver or process GPU usage. Telemetry now reports this:
`memory: { basis: "tracked-allocations", gpu, peak, budget, cpu }`.
- `peak` is the device's high-water mark (`peak()` / `resetPeak()`).
- `budget` is `GPU_BUDGET` = 160 MiB.
- `cpu` is the retained pick index plus the glyph atlas canvas. The glyph atlas was previously counted twice; it is now
  counted once.

## Memory changes (`src/gpu/budget.ts`, `prepare.ts`, `compat.ts`, `framegraph.ts`, `device.ts`, `renderer.ts`)

| Area | Before | Now |
| --- | --- | --- |
| Compat world rasters | full-world rect at `resolution`, forced floor | decoded, then **alpha-cropped** (non-zero alpha bounds + 1 px transparent pad, copied not resampled, world rect adjusted). Fully transparent runs upload nothing (`texture: null`). |
| Compat budget | none | `max(16 MiB, GPU_BUDGET − TARGET_BUDGET − own textures − glyph atlas − vertex bytes)`; screen runs are subtracted first. If the cropped world rasters exceed it, `fitScale` shrinks them uniformly and later runs decode at the reduced resolution. There is no forced 0.25 floor. |
| Group target | 4× MSAA always | `targetSamples`: the most samples (4, 2, 0) whose target fits `TARGET_BUDGET` = 80 MiB. 1080p DPR1 keeps 4× (71 MiB), 1440p gets 2×, 2880×1800 (DPR2) gets 0×, at 59 MiB. |
| Relief atlas | 256 px cells + mipmaps | cell = `reliefCell(largest icon × bucket)`: power of two, 16..256, no mipmaps. |
| Detail refinement | could stack on top of the base raster | released before re-prepare and before each settle. It is allowed only when `memory().total + full ≤ GPU_BUDGET`, and it is cropped. |
| Peak | untracked | `high` updated on every buffer/texture/target allocation and buffer growth. |

## Fidelity changes

- **Relief:** cells sized to the on-screen icon size and sampled linearly, close to 1:1. This replaces minification
  from 256 px through mip levels, which was the blur source. The real icons are kept; nothing is substituted.
- **Detail composite:** `imageSource` picks exactly one raster per batch:
  - The detail raster is used only when the view lies inside its `covers`; otherwise the base raster is used.
  - Screen runs never use detail.
  - Alpha is never doubled.
  - A transparent detail (null texture) draws nothing rather than the blurrier base.
- **Crisp first idle frame:** after a successful prepare with no camera motion, `scheduleSettle()` runs the bounded
  refinement immediately.
- **Refinement races:** each settle takes `++refines`, and every prepare bumps the same token. `ctx().stale()` checks the
  token, so a settle never writes into a re-prepared frame. Clone restore before decode and `finally` cleanup are kept.
- The native passes are unchanged. Gate thresholds are unchanged.

## Trade layer: no silent loss

- **Root effects:** `scene.ts` records a `filter` / `clip-path` / `mask` on `#tradeAnimation` as `unsupported` and
  reports the layer non-native with a reason. `prepare.ts` then throws:
  `trade layer <effect> unsupported on GPU markers`. The renderer falls back to the SVG viewport with
  `GPU prepare failed: …`.
- **Per-frame marker check:** `markerIssue(group)` (pure) accepts only what the D3 controller writes, which is one
  `<use>` of `#trade-marker-land|water` plus an invisible hit circle. It refuses, with a named reason:
  - unknown or missing symbols
  - other child elements
  - painted circles
  - `filter` / `clip-path` / `mask` / `opacity`, as an attribute or in `style`, on the group or the `<use>`
  - unparsable transforms

  When `collect()` sets `issue`, `draw()` calls `fallBack("GPU trade markers: …")` and does not render.
- The unused `fallbackDisk` helper and its test are removed.

## Tests added (pure, no DOM/GL)

- `src/gpu/budget.test.ts`:
  - `alphaBounds`, `padBounds`, `cropRegion` (density preserved)
  - `fitScale`, `targetBytes`, `targetSamples` (resolution table above)
  - `reliefCell`
  - `imageSource`: one source; detail only inside its coverage; never for screen runs; null detail kept.
- `src/gpu/markers.test.ts`: `markerIssue` accepts the controller's shape and names each refusal.

No existing assertion was relaxed. `device.test.ts`'s exact `memory()` shape is unchanged.

## Budget arithmetic (DPR1 1920×1080, estimate)

- Group target at 4×: 1920·1080·36 B ≈ 71.2 MiB, within the 80 MiB reserve.
- Native textures, glyph atlas and vertex data come next.
- Compat gets the remainder, at least 16 MiB, after alpha cropping.
- A settle detail is added only if the total stays ≤ 160 MiB.

The steady state should therefore stay ≤ 160 MiB unless natives + target alone exceed it. In that case compat is still
granted 16 MiB, and the overage shows in telemetry rather than being hidden.

## Known limitations (not fixed)

- **Swap peak:** during re-prepare, the new frame is built while the old frame is still alive (detail is released
  first). `peak` can therefore exceed the steady total by up to one frame's native textures and buffers.
- **Transient CPU decode canvas:** each world run decodes at up to 2²⁴ px (64 MiB RGBA) before cropping. This is CPU
  memory, untracked by the GPU estimate, and one run at a time.
- **4K backing stores:** a 3840×2160 target needs ≈ 95 MiB even single-sampled (12 B/px), which is over the 80 MiB
  reserve. Compat then gets only its 16 MiB floor, at reduced resolution, and the total may exceed 160 MiB.
- **DPR2 MSAA:** DPR2 without MSAA relies on pixel density for anti-aliasing. Fidelity at DPR2 needs host proof.
- Nested group framebuffer rebinding is a pre-existing issue and is not touched.
- A trade layer `transform` was already handled by the root transform. Only filter/clip/mask refuse.

## Host checks required (run by host; none were run here)

1. `vitest` (the whole `src/gpu`, especially `budget.test.ts`, `markers.test.ts`, `device.test.ts`) and Biome lint +
   `tsc`.
2. DPR1 and DPR2 memory gate: `gpu` ≤ 160 MiB (no-go 256 MiB). Record `peak` and `compat.resolution`.
3. Fidelity gate with the frozen-token diff at the unchanged thresholds. Compare the relief crop against the earlier
   capture.
4. Initial idle frame: the detail refinement lands without camera motion, with no re-prepare loop or console errors.
5. Animation proof: 30 markers moving, frames advancing, no page errors.
6. Trade fallback:
   - Set `filter` on `#tradeAnimation` → SVG shown with the reason.
   - Append a `<path>` child, or an unknown href, to a marker group → SVG shown with `GPU trade markers: …`.
7. SVG remains the default renderer mode.
