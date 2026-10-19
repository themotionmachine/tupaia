# P1 bitmap viewport window cache

`src/gpu/bitmap-window.ts` (`BitmapWindows`, pure `cropPlan`) bounds GPU memory for the immutable canonical decoded
images (cached path/relief PNGs) by uploading only the source pixels around the camera. Pixels are copied 1:1 with
Canvas2D `drawImage` at identical source/destination sizes and smoothing off: no resampling. It does not render SVG and
does not schedule anything; integration is root-owned. Not wired into `prepare`/`renderer`/`scene`/`device`/`framegraph`.

## Caller contract

- `add(image, rect, opacity)` before the first `refresh`. `image` must be decoded (`naturalWidth/Height` > 0), immutable,
  and `≤ device.maxTextureSize`; `rect` is the already SVG-meet-fitted world `[x, y, width, height]`. Returns an
  `ImageBatch` slot (texture `null` until a refresh commits). Adding supersedes any in-flight refresh and clears coverage.
  Sources whose pixels change must be disposed and re-added (new instance), not mutated.
- `refresh(camera, viewport, stale?)`: capture window = `visibleWorld(camera, viewport, margin)`; margin starts at
  `marginCss` and halves (bounded, ≤16 attempts, last is 0) until summed RGBA crop bytes ≤ `maxBytes`.
  - `true`: all slots swapped atomically (texture + crop world rect); old owned textures released after the swap.
    A slot whose image does not intersect the window gets `texture: null` (known transparent) and that is valid.
  - `false`: over budget at margin 0, stale (`stale()` checked before and after upload), superseded by a newer
    `refresh`/`release`/`add`/`dispose`, or disposed. Old bindings and coverage are untouched.
  - throws: canvas or upload failure (e.g. tainted image); every texture created by that job is released first.
- `covers(camera, viewport)`: whole visible world inside the last committed (unclipped) capture window. Root should
  schedule `refresh` before the camera leaves coverage and draw the SVG fallback whenever `covers` is false.
- `bytes`: summed `TrackedTexture.bytes` currently owned. `release()`: drop textures/coverage, keep sources.
  `dispose()`: idempotent release + drop source references; never touches source DOM.

## Risks

- Peak GPU memory during a refresh is old + new textures (≤ 2 × `maxBytes`) until the swap releases the old set.
- The CPU canvas copies are synchronous on the main thread; with the default 80 MiB budget a refresh can copy up to
  ~20 Mpx. Root should call it off the interaction path.
- Only one `await` (microtask) separates planning from upload; `stale` is evaluated synchronously around upload, so
  root's staleness predicate must be cheap and side-effect free.
- Texture filtering is `LINEAR` (device default); 1:1 crops are exact at source resolution, sampling at other zooms
  matches the uncropped texture except within half a texel of the gutter edge, which the 1 px gutter keeps outside the
  window.
- After WebGL context loss textures are gone; root must `release()` and `refresh()` on restore.
- Tests stub Canvas2D/device (`bitmap-window.test.ts`); not yet run in this session (no shell) and not browser-verified.
