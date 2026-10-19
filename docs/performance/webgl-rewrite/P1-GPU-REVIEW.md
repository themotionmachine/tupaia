# P1 GPU review: pass performance, mask/stencil, text baseline

Date: 2026-10-15. Scope: a read-only review of `src/gpu/{device,framegraph,prepare,renderer,text,shaders}.ts`, plus
`budget.ts` and `scene.ts` where they bear on these files. I ran no shell commands, benchmarks or browsers. Every impact
statement here is reasoned from the code, not measured. The host's Metal M1 Max DPR2 numbers (shared callbacks ~1 ms;
dense callbacks 10–26 ms; wheel p95 ~33 ms; pixel-over-16 1.59% at k1 and ~2.84% at k2 against a 1% target) are taken
as given and were not reproduced. Two sub-reviews (pass performance, text) were checked line by line before inclusion.
Where they made claims I could not confirm, those claims were corrected or dropped.

## 0. What is *not* wrong (rules out the usual suspects)

- No GPU→CPU sync on the frame path. The frame path contains no `readPixels`, `getError`, `fenceSync`/`clientWaitSync`,
  `finish` or per-frame `getParameter`. `checkFramebufferStatus` runs only in `GpuDevice.target()` (`device.ts:180,189`),
  which is called on resize (`framegraph.ts:366-370`). `getParameter` runs only in `limits()` (`device.ts:98-101`).
- No per-frame texture uploads. Every `device.texture` call is in prepare/refine. The only per-frame upload is the
  marker buffer (see §1.5).
- The dense cell grid is **one** instanced stroke batch (`prepare.ts:210-212`, `cellRings()`), not one draw per cell.
  So 53 194 cells do not mean 53 194 draw calls.
- Consequence: with no readback, a 10–26 ms JS callback is either (a) command-encoding cost from many batches/state
  calls, or (b) ANGLE/Chromium backpressure when the GPU is still busy with earlier frames. That backpressure lands
  inside the next frame's GL calls. Telling these apart is the first experiment (§4, E1).

## 1. Findings, highest confidence first

### 1.1 Correctness: nested groups share a single offscreen target, and `masked` is reset unconditionally (high confidence)
`framegraph.ts:366-374` keeps exactly one `this.group` target. It binds that target and clears colour and stencil.
`prepare.ts:315-323` recurses through `convert()`, so a `group` batch can contain another `group`. When an inner
`composite()` runs inside an outer one:
1. it clears the FBO the outer group is still drawing into, which erases the outer siblings drawn so far;
2. after its blit, it binds the default framebuffer (`framegraph.ts:394`), so the outer group's remaining children go
   straight to the screen, at full opacity and unmasked;
3. it sets `this.masked = false` (`framegraph.ts:390`), which drops an outer mask for later siblings;
4. the outer composite then blits the inner group's leftovers a second time, applying the outer opacity.

The host should first count nested groups in the shared and dense scenes. If there are none, this is latent. If there
are any, it is a source of pixel diffs. Fix (bounded): keep a small stack of targets indexed by nesting depth, rebind
the parent target after the child composites, and save and restore `masked` instead of clearing it.

### 1.2 Overdraw: every group costs a full-viewport clear, copy and blended quad, even when the group is culled or tiny (high confidence)
`composite()` runs for every `group` batch without checking bounds. Groups are never culled; `framegraph.ts:158-165`
culls only `fill` and `stroke`. Each composite does the following:
- a full drawing-buffer colour+stencil clear (`:372-374`);
- `blitFramebuffer` over the full `width×height` (`:391-393`). At DPR≥2, `targetSamples()` returns 0
  (`budget.ts:84`), so this is a plain non-MSAA copy, i.e. pure extra bandwidth;
- a full-viewport blended textured quad back onto the MSAA default framebuffer (`:395-396`).

At 2880×1800 that is about 3 full-screen passes of ~20 MB per group per frame, even when every child was culled.
`prepare.ts:330` wraps the live trade markers in a group whenever trade opacity is below 1. That case pays the cost on
every frame.

### 1.3 Fidelity: group content loses anti-aliasing at DPR2 (high confidence from code; size of effect unmeasured)
The default framebuffer is MSAA (`device.ts:51`, `antialias: true`). The group target is single-sample at DPR≥2
(`budget.ts:84`). Fills are stencil-then-cover with no analytic AA (`shaders.ts:4`). Anything inside a group (opacity
groups and **every stencil mask edge**) is therefore rasterized aliased, while the same geometry outside a group gets
MSAA. This plausibly contributes to the 1.59%/2.84% over-16 fractions along masked or translucent layer edges.
Cheap check: in the existing pixel diff, split over-threshold pixels by whether they fall inside a group's area.

### 1.4 Submission: thin or translucent strokes rasterize every instance twice (high confidence)
`framegraph.ts:256-258`: when `screenWidth < 1`, colour alpha is scaled by width. Every hairline therefore takes the
translucent path, even if its colour is opaque. The translucent path draws all instances once with stencil coverage
(`:274-277`), then **again** with colour writes off just to zero bit 0x01 (`:278-281`). For the dense grid at low zoom,
that is two instanced draws over 53 194 rings' worth of segments.

### 1.5 Submission: redundant per-batch state (medium-high confidence; matters most when batch counts are high)
- `use()` (`framegraph.ts:177-183`) re-runs `useProgram`, `bindVertexArray` and `uniformMatrix3fv` on **every** batch,
  even when consecutive batches share a program. `fill()` reaches it through `stencilFan()` (`:211`).
- `attribute()` (`:185-201`) re-specifies `bindBuffer`, `enableVertexAttribArray`, `vertexAttribPointer` and
  `vertexAttribDivisor` on every batch. For fills the fan pointer is always offset 0 (`:212`, with `first` passed to
  `drawArrays`), so the VAO could be set up once per frame (or once per `frame.fans`). Re-specifying it on every
  batch defeats the VAO, and under ANGLE-Metal each pointer change can invalidate the vertex descriptor.
- `image()` calls `visibleWorld()` for each image batch (`:358`), although `this.visible` already holds it (`:132`).
- `updateBuffer` (`device.ts:120-126`) calls `bufferData` (a possible reallocation) and then `this.memory()`, which
  walks every tracked resource. This happens every frame that has markers (`framegraph.ts:137`). It is small, but it
  is per frame.

### 1.6 Memory: the group target allocates an unused depth buffer (high confidence)
`device.ts:176` allocates `DEPTH24_STENCIL8`. Nothing uses depth (`device.ts:53`, `depth: false`; no depth test
anywhere). At 2880×1800 single-sample, that is ~20.7 MB, of which ~15.5 MB is the depth part and wasted.
`STENCIL_INDEX8` on `STENCIL_ATTACHMENT` would save roughly 15 MiB of the reported ~147 MiB. The accounting in
`targetBytes()` (`budget.ts:70-72`) would need to change to match. Risk: confirm `checkFramebufferStatus` is COMPLETE on
ANGLE-Metal. The existing `drawComplete` flag already detects this.

### 1.7 Mask/stencil logic: checked by hand, correct for the supported subset
- Bit layout (`framegraph.ts:3`): 0x80 is the mask bit and 0x7F is the winding. The cases traced:
  - Masked nonzero cover, `LESS 0x80/0xff`, passes only when the mask bit is set *and* the winding is nonzero.
    `DECR_WRAP` under write mask 0x7F keeps 0x80 intact (0x80 → 0xFF), which is correct.
  - Masked even-odd cover, `EQUAL 0x81/0x81`, is correct.
  - Mask writes (`:377-386`) test `NOTEQUAL ref&0x7F(=0)` and then `REPLACE` with write mask 0xFF. White writes 0x80
    and black writes 0, and both clear the winding, so document order is respected.
  - Translucent masked strokes keep 0x80 because the write mask is 0x01. Opaque masked strokes, sprites, glyphs and
    images test `EQUAL 0x80/0x80` through `plain()`.
- The `white` test checks the red channel only (`prepare.ts:320`). That is safe because `scene.ts:231-232` already
  rejects any mask fill that is not pure opaque white or black.
- Not modelled: the default SVG mask region (x/y/width/height = −10%/120% of the bbox). `scene.ts:223` rejects only
  `maskUnits`/`maskContentUnits`. Mask content outside the default region would leak on the GPU. This is low risk
  for full-map masks, but the host should check it against the actual masks.
- A winding count that is an exact multiple of 128 reads as zero. This is negligible.
- The mask edge AA issue is covered in §1.3. The nested-mask issue is covered in §1.1.

## 2. Ranked bounded fixes (no rewrite, no dependency)

| # | Fix | Code | Likely impact | Fidelity risk | Cheap validation |
|---|-----|------|---------------|---------------|------------------|
| 1 | **Bound the group pass.** Store union child bounds on `GroupBatch` at prepare (fill/stroke have `bounds`; image has `rect`; glyph boxes are already computed for picking). In `composite()`, (a) skip the group when its bounds are outside `this.visible`; (b) enable `SCISSOR_TEST` to the bounds' device rect for the clear, children and blit, and draw the quad over that rect only; (c) when `samples === 0`, render into an FBO whose colour attachment is the sampled texture and skip the blit. Fix the nested-target and `masked` bugs (§1.1) in the same change. | `framegraph.ts:363-397`, `prepare.ts:315-330`, `device.ts:164-199` | Removes up to 3 full-screen passes per group per frame. This is the largest pure GPU-bandwidth item, and it applies on every frame when trade opacity is below 1. | Low if the bounds include stroke width and AA padding (≥1 device px). Scissor clipping that is too tight would cut edges. | E2: log the count of composites and their total pixel area per frame. A/B wheel p95. Pixel diff must stay identical (scissor/blit removal should be bit-exact). |
| 2 | **Replace the stroke cleanup redraw with a masked stencil clear.** After the translucent draw (`:277`), use `stencilMask(0x01)` plus `clear(STENCIL_BUFFER_BIT)`, optionally scissored to the stroke's screen bounds, instead of redrawing every instance. `glClear` honours the stencil write mask and scissor, so 0x80 and the winding bits are preserved. | `framegraph.ts:273-282` | Halves the instanced work for every hairline or translucent stroke, including the dense grid at low zoom. | None expected: the final stencil state is identical. | E3: count translucent-path instances per frame. Pixel diff should be identical. Time dense wheel p95 at k≤1. |
| 3 | **Drop redundant per-batch state.** Track the last program kind and skip `useProgram`/`bindVertexArray` when it is unchanged. Set `u_matrix` once per program per frame (re-set it for `image` only around group quads). Bind the fill VAO's fan pointer once per frame (offset 0). Reuse `this.visible` in `image()`. Use `bufferSubData` in `updateBuffer` when the size fits, and drop the per-call `memory()` walk. | `framegraph.ts:177-201,209-226,358`, `device.ts:120-126` | Scales with submitted batch count. Probably minor in shared (108 submitted), material if dense submits hundreds or thousands of fills. | None (state-only). | E1 first. Then count GL calls per frame with a debug wrapper, before and after. |

Not ranked as fixes:
- **`antialias:false`.** Worth one experiment, since the constructor already accepts overrides (`device.ts:89`), to
  find out whether the frame is fill-bound. But stencil-cover fills would then be aliased everywhere, so it is not
  an acceptable fix as it stands.
- **The still-visible SVG under an `alpha:true` canvas.** It is probably a large part of the 33 ms p95, because Chromium
  keeps painting and rasterizing the dense SVG on every zoom. It lies outside the reviewed files and interacts with
  compat rasterization and d3.zoom, so it should be measured (E4) before anyone touches it.
- **`STENCIL_INDEX8` (§1.6).** A memory win, not a speed fix.

## 3. Text: native `central` baseline for the 12 curved state labels

**Where the fallback happens.** `text.ts:210` (`dominantBaseline` must be `auto`) is enforced at `text.ts:294-296`. The
whole label then goes to compat at `prepare.ts:304-306`. The value comes from `public/index.css` (`#labels {
dominant-baseline: central }`). Note that `dominant-baseline` *is* inherited in SVG 2 / CSS Inline 3, and Chromium
implements it that way, so the tspan's computed value is reliable. One sub-review said otherwise; that claim is wrong.

**The layout has no baseline term.** Glyphs are rasterized on the alphabetic baseline (`text.ts:63`) and placed at
`ly = dy + glyph.top/scale` (`text.ts:347`). Allowing `central` without also adding a shift would put every label
roughly 0.3 em off.

**What Chromium's `central` is (from memory of the Blink source; the host must validate).** For horizontal text,
Blink takes the central baseline from the primary font's float ascent/descent:
`FontMetrics::FloatAscent(kCentralBaseline) = (ascent + descent) / 2`. The offset from the alphabetic baseline is
therefore **(ascent − descent) / 2**, using the same `SimpleFontData` metrics that Canvas `fontBoundingBoxAscent` and
`fontBoundingBoxDescent` report. `textBaseline = "middle"` is specified as the em-box middle, and Blink's choice of
metrics for it is not guaranteed to match. Use the explicit `fontBoundingBox` formula, not `"middle"`.

Recommended narrow implementation:
1. Allow `central` only for this textPath case. Compute
   `shift = (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2`, with `m` measured from the **raster font
   divided by `scale`** (`cssFont(style, px*scale)`), not at `px`. Blink lays out SVG text with a font scaled by the
   screen CTM, and Mac `SimpleFontData` may round ascent/descent. Measuring at the small `px` size can be ~0.5 px off.
2. Place glyphs at `ly = dy + shift + glyph.top/scale` (y-down: the baseline moves down so the em centre sits on the
   path). The offset is applied in the glyph's rotated local frame, which matches SVG textPath.
3. **Self-check once per label at prepare.** Take the first visible char's `text.getExtentOfChar(i)` (and
   `getStartPositionOfChar(i)`), and compare its perpendicular offset from the path with the computed glyph box. If it
   differs by more than about 0.25 CSS px, fall back with the reason `"central baseline mismatch"`. This stays honest
   without making production depend on DOM positions.

**Exact SVG char positions as the primary source instead.** For 12 labels the per-char cost is negligible, and the
positions absorb baseline, kerning and `text-rendering` behaviour all at once. The drawbacks: the labels must be laid
out and visible (the APIs return zeros under `display:none`, which would break if the SVG is later hidden), and the
positions are exact only for the prepare zoom, because Blink's scaled-font layout shifts slightly with zoom. Either
approach is defensible. The analytic shift plus the self-check is the narrower change.

**Existing layout errors and risks (independent of `central`):**
1. **`text-rendering: optimizeSpeed` is not modelled (likely real).** State labels set it
   (`src/renderers/draw-state-labels.ts:138`). In Blink, `optimizeSpeed` disables kerning and ligatures (from memory;
   verify). `prefixAdvances` measures with Canvas's default `fontKerning: "auto"` (`text.ts:322-324`), and
   `textRendering` is not in `STYLE_DEFAULTS` (`text.ts:200-215`). So GPU advances are probably *kerned* while SVG
   advances are not. The error is a fraction of a px per kerned pair and accumulates along the label. Fix: set
   `measure.fontKerning = "none"` (and avoid ligature prefixes) when `textRendering === "optimizeSpeed"`. Validate
   with `getComputedTextLength()` against the summed GPU advances on an "AV"/"To" label.
2. **Ligatures vs per-codepoint glyphs.** `text.ts:69` rasterizes each codepoint alone, but prefix advances could
   include `fi`/`fl` ligature widths. This is moot if item 1 disables ligatures. `fontVariantLigatures` is not
   checked otherwise.
3. **Advances measured at `px` but drawn at `px*scale`** (`text.ts:322` vs `:330`). With hinting or rounding, these
   are not linear. Measure advances at `px*scale` and divide, to match Blink's scaled-font layout.
4. **Path flattening tolerance 0.1** (`text.ts:284`) makes arc length differ slightly from the exact curve. This is
   minor, but it accumulates toward the label end when `text-anchor: middle` is used.
5. **Tspan `x` treated as a new chunk at `startOffset + x`** (`text.ts:303-307`). This is plausible, but no one has
   checked it against Blink for multi-line state labels.

## 4. Cheap experiments (host-side, in order)

- **E1 (encode vs backpressure).** In one dense wheel frame, log `graph.drawBatches.submitted`/`culled` and the
  `graph.render()` duration. Then run one debug frame followed by `gl.finish()` and time the two separately. If
  `render()` is fast and `finish` is slow, the frame is GPU-bound: do fixes 1 and 2. If `render()` itself is
  10–26 ms, the frame is encode-bound: do fix 3 and look at the batch count.
- **E2.** Count composites per frame and sum their pixel areas. Repeat with trade opacity forced to 1.
- **E3.** Count translucent-path stroke instances per frame at k = 0.5, 1 and 2 in dense.
- **E4.** With the GPU canvas shown, set `visibility:hidden` on `#viewbox` in a throwaway build *after* prepare, and
  compare wheel p95. This measures the cost of SVG paint underneath. It is not a fix.
- **E5 (central).** On a straight horizontal path, render one tspan with `dominant-baseline: auto` and one with
  `central`, then diff the `getExtentOfChar(0).y` values. Compare the difference with `(fontBoundingBoxAscent −
  fontBoundingBoxDescent)/2` measured at `px*scale/scale` and at `px`, and record the error at each of the two zooms.
- **E6 (kerning).** For one state label, compare `getComputedTextLength()` with the summed GPU advances, with
  Canvas `fontKerning` set to "auto" and then to "none".

## 5. Not claimed

- No item above has been benchmarked. No fix has been implemented or proven to pass the visual gate.
- The Blink metric semantics in §3 (central = (asc − desc)/2 from `FontMetrics`, and `optimizeSpeed` disabling kerning)
  are recalled from the Blink source, not verified in this session.
- Nested groups (§1.1) are possible in the code structure. I did not confirm whether they occur in the benchmark
  scenes.
