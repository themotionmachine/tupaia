# P1 — Viewport bitmap window integration

Status: **checks executed in a later session; see [P1-GATE-NEXT.md](P1-GATE-NEXT.md)** for the artifacts, pass/fail
matrix and measured numbers. When this document was written, no checks had been run, and its estimates below are
superseded by those measurements. The rewrite is **not complete**: the P2 canonical SceneDocument/editor bridge is still
outstanding.

## What changed

| File | Change |
| --- | --- |
| `src/gpu/bitmap-window.ts` | New APIs: `size`, `margin` (the committed capture margin in CSS px), `covers(camera, viewport, margin = 0)` (edge-band check) and `refresh(camera, viewport, stale?, limit = Infinity)`. `limit` caps the new crop set on top of `maxBytes`. |
| `src/gpu/prepare.ts` | Each prepared frame owns one `BitmapWindows(device, 640, WINDOW_BUDGET)`. The canonical cached path PNGs (biomes/heightmap) and the relief base image are now `windows.add(image, meetImageRect(...), opacity)` slots, not full textures. The `cachedPaths` vectors are still used only for CPU pick, and the layer metadata is unchanged. `PrepareContext.camera` is a snapshot taken at job start. The initial `windows.refresh(...)` runs **before** the compat budget, and `windows.bytes` is counted in that budget. `release()` disposes the windows. |
| `src/gpu/prepare.ts` | Memory quick fix: consecutive **screen** overlays no longer merge into one compat raster. They merge only when `!screen && !last.screen`. |
| `src/gpu/renderer.ts` | Coverage guard on `camera()`, `defers()` and `draw()`. Background refresh (`refreshWindows`, `setTimeout 0`, off the rAF path). Near-edge proactive refresh. Miss rate-limiting per camera key. A `windows` telemetry block. |
| `src/gpu/bitmap-window.test.ts` | New tests for margin/edge coverage, the peak-headroom limit, exactly-once release across frame replacement and context loss, stale cancellation before upload, and supersede-on-add. |

The `data-relief-viewport` detail texture is unchanged. It is still owned by the prepared frame's `textures` and assigned to
`slot.detail`. `imageSource` uses it only when it covers the whole view.

## Ownership and lifecycle

- `Prepared` owns its textures and the framegraph. `Prepared.windows` (the manager) owns **only** the crop textures it
  creates, and `Prepared.release()` → `windows.dispose()` frees them. The framegraph slots reference those textures and
  never release them, so nothing is released twice. `BitmapWindows.release()` and `dispose()` are idempotent.
- Decoded source images are immutable inputs. They are never modified, and their world rects are copied on `add`.
- Each refresh runs the `stale()` check at two points: after planning (before any GPU allocation) and after upload.
  It also checks a token, which `add`, `release`, `dispose` and any newer refresh all bump. If the refresh turns stale or
  throws, it releases everything it created. Old bindings are swapped only after a successful commit.
- Renderer staleness for background refreshes: the `generation` changes (context loss, world replace, dispose), the
  prepared frame is replaced, or the device is lost or disposed. When the context is restored, a re-prepare re-adds the
  sources and runs a fresh initial refresh.

## Coverage and fallback semantics

- `covers` tests the visible world against the committed, **unclipped** capture box. Area beyond the image is known to
  be transparent, so it counts as covered.
- When `camera()`, `defers()` or `draw()` find the view uncovered, the renderer hides the canvas, so the SVG shows. The
  renderer queues a background refresh and returns `false` from `camera()`, so the caller applies the SVG transform. The
  renderer never draws a partially blank canvas and never reports GPU success while uncovered.
- If the initial refresh in `prepareFrame` fails without the job going stale (for example, over budget at an extreme
  zoom-out), the frame is still returned uncovered and the SVG remains visible. A stale initial refresh releases the frame
  and returns `null`.
- Proactive refresh: after each draw, if the view grown by `min(240, margin / 2)` CSS px is not covered, a background
  refresh starts. That is before coverage is actually lost, so pans normally stay on the GPU with no full rebuild during
  motion. When the committed margin is 0, there is no proactive refresh, which avoids refresh loops.
- An over-budget miss records the camera key (k, x, y, width, height, dpr). It is not retried until the camera changes.
- A refresh that throws (canvas or upload failure) falls back to SVG with `GPU bitmap window failed: ...`.
- Panning does not write to sourceDOM. Windows read only the decoded images and the camera.

## Memory model

| Constant | Value | Meaning |
| --- | --- | --- |
| `WINDOW_BUDGET` | 64 MiB | Steady cap for all crops of one prepared frame (`maxBytes`) |
| `PEAK_LIMIT` | 256 MiB | Each refresh is limited to `PEAK_LIMIT - device.memory().total`, so old + new crops during a swap stay under the peak target |
| Margin | 640 CSS px | Halves until the crop set fits (down to visible-only) |

Byte accounting is in actual RGBA bytes (`sw * sh * 4`) and goes through the tracked device, so it shows up in
`device.memory()` and `device.peak()`. The compat budget sees `textures + windows.bytes`.

Expected effect (estimate, **not measured**):
- Previously the relief base alone was uploaded as a full 4096×1867 texture (about 30.6 MB), plus full biomes/heightmap
  textures. The earlier CDP capture recorded about 323 MB steady and a 375 MB peak. **Correction:** that is the old
  pre-window figure, not the current measurement. The measured maxima with windows are 167.77 MB steady (DPR2 z1) and
  222.4 MB peak (100k wheel-zoom); see P1-GATE-NEXT.md.
- Now a 1920×1080 dpr1 viewport at 1:1 source density with the 640 px margin needs about (3200×2360×4) ≈ 30 MB per fully
  overlapping source at worst. The budget halves the margin when the sources together exceed 64 MiB.
- The screen-overlay merge fix stops screen overlays from merging into large compat rasters.
- The 160 MiB steady / 256 MiB peak targets still need to be confirmed by the checks below.

## Telemetry

`GpuTelemetry.windows = { coverage: "none" | "covered" | "missing", bytes, margin, refreshes, misses }`

- `none` means the frame has no window sources.
- `refreshes` counts committed background refreshes.
- `misses` counts over-budget refreshes, rate-limited per camera key.

## Tests

`src/gpu/bitmap-window.test.ts` (vitest, node environment, with a fake device and a stubbed canvas) covers:
- integer crops
- 1:1 copy
- coverage of transparent area beyond the image
- margin halving
- the `limit` cap
- the edge-band `covers`
- the atomic swap
- stale/throw release
- release/dispose superseding a refresh
- supersede-on-add
- exactly-once release across frame replacement and context loss

These tests were written but not run in that session. They have since passed in the `unit` check (52 files, 514 tests;
see P1-GATE-NEXT.md).

Not unit-tested here: `prepareFrame` and `GpuRenderer` need a real DOM and WebGL2, and nothing in the current suite
imports them. Their integration (including the screen-overlay merge) has to be covered by the browser checks below.

## Required checks (executed later; results in P1-GATE-NEXT.md)

All of these have now been run with the MCP `run_check` tool. `bench` ran only the harness's own tests and recorded no
performance numbers; the navigation check provided the measurements.

| Check | Scope |
| --- | --- |
| `unit` | Full vitest, including the new bitmap-window cases |
| `build` | Type-check plus bundle |
| `bench` | Navigation and memory bench; record `windows.*` telemetry, `memory().total` and `peak()` |
| `smoke` | dpr 1/2 × zoom 1/2/4/8 (8 runs). No uncaught or GL errors, exact final camera, SVG save and canonical source unchanged |
| `hatch` | Both DPRs |
| `navigation` | Pan to the coverage edge. Expect `refreshes` > 0 and no SVG fallback flashes during steady pans |
| `context` | Lose and restore: windows disposed, re-prepared, coverage `covered` again, no leaked tracked bytes |
| `lifecycle` | World replace and dispose during an in-flight window refresh: no leaks, no errors |

Artifacts to attach once they run: check logs and the telemetry JSON under `docs/performance/webgl-rewrite/host-checks/`.

## Known performance limits

- Each refresh copies the crop on the main thread with Canvas2D `drawImage` and then uploads it. That can be up to
  about 64 MB in the worst case, which can cost a frame or more. It runs in a `setTimeout` task, not in rAF, but it is
  still main-thread work.
- When the margin is small (dense sources, high dpr), refreshes happen more often. Zooming out far enough that even the
  visible-only crop exceeds the budget falls back to SVG for that view.
- There is no downsampled level for zoomed-out views. Crops are copied 1:1 from the source pixels, so a zoomed-out view of a large image costs
  its full source-pixel area.

## Remaining blockers

1. Superseded: all checks are executed, and the memory targets are met (≤ 160 MiB steady, 212 MiB peak). For the current
   blocker list, see P1-GATE-NEXT.md.
2. Not every check has been re-run on the final code (P1-GATE-NEXT.md lists which ones).
3. P2: canonical SceneDocument/editor bridge (not started in this chunk).
4. Possible follow-up: move the crop copy off the main thread (`createImageBitmap` with a crop rect, or a worker), if
   the bench shows refresh hitches.
