# Tupaia full WebGL renderer rewrite: architecture plan

**Status: ideation only. Unimplemented and unexecuted.** No code was built, no tests were run, no browser was opened and nothing was benchmarked in this session. The file tools were Read/Glob/Grep/Write/Edit only. All performance figures come from OWNER-BRIEF.md: M1 Max, Chromium, 1280×720, DPR 1, synthetic dispatch, so physical FPS and input-to-photon latency are not established. Evidence cites `source/` (read-only snapshot) and `audits/*.md`. Anything marked INFERRED was not confirmed against source.

This replaces the earlier bounded baseline plan. Corrections are listed in §13.

## 0. Decision

1. **Owner steering: rewrite the whole renderer with no functionality loss.** Every pixel on the visible map, every map hit-test and every camera frame moves to one **raw WebGL2** canvas behind a thin in-house device layer (`GpuDevice`, CONTRACTS.ts).
   - three.js is **not** the core. At runtime it is the vendored global `libs/three.min.js`; npm `three ^0.184` (`source/package.json:55`) is only used for types; the runtime version is unknown. The baseline claimed three's bundle delta was "~0" and that it was "already paid for". Neither is supported.
   - Existing raw/WebGL precedents to reuse: `draw-satellite-texture.ts:514-560` and `erosion-bake.ts:722-731` (render targets), plus the canvas experiments (`burg-canvas.ts`, `relief-raster-worker.ts`).
2. **Exact compat capture lane.** A feature the GPU path cannot yet match exactly is not dropped and not approximated. It is rendered by its existing SVG/Canvas2D code into an offscreen raster at the needed resolution, outside the frame, then cached as a texture and drawn by the GPU.
   - This is an implementation mechanism, not a feature drop (OWNER-BRIEF steering).
   - Every compat-lane row is logged as perf debt with an owner.
3. **SceneDocument becomes the model, in phases.**
   - P1: shadow-parsed from the SVG.
   - P2: read by the GPU renderer, while the live hidden SVG model still takes editor writes.
   - P3: owned, with editors issuing commands and SVG derived for save, export and legacy consumers.
   - The `.map` / binary format, generators, `window.pack/grid`, shared-map API, Cloudflare auth and backend are **not** rewritten (OWNER-BRIEF).
4. **Editable SVG bridge is allowed in P2** under three conditions:
   - it is `visibility:hidden` + `pointer-events:none`, kept in the document (not detached, not `display:none`);
   - it receives **no** per-frame camera writes;
   - editor coordinates come from a `d3.mouse` shim (camera inverse × node world matrix), not from the bridge's CTM.
   P3 removes the gesture→layout coupling (§8).
5. **Rollback:** `?renderer=gpu` flag, default `svg`, through all of P2. This flag **does not exist in source today**; it is a deliverable.

## 1. Definition of "full, no functionality loss"

At release:
- **Display.** During pan, zoom and idle, no map SVG element takes part in on-screen layout, paint or compositing, except the small editor overlay SVG of transient handles (§9).
- **Interaction.** Map hover and click are resolved by CPU picking:
  - spatial grid plus point-in-polygon;
  - **0 `readPixels` on hover**;
  - an optional GPU ID pass only for click disambiguation where features overlap.
  No `getScreenCTM`, `getBBox` or `elementFromPoint` calls on the frame path.
- **Parity.** Every row of the feature matrix (§5) passes its acceptance test in PROOF-PLAN.md, either natively or via the exact compat lane. "Out of app scope" is not an allowed exit for any row.
- **Contracts.**
  - `.map` sections round-trip under invariants I1–I15 (§10).
  - Binary TUPAIA saves round-trip.
  - Notes stay keyed by element id.
  - `window.pack/grid`, the shared map API and editor dialogs keep working.
  - The 3D view, minimap, export, transform-tool preview and cloud versions keep working.

## 2. Measured starting point (OWNER-BRIEF.md; synthetic, DPR 1, M1 Max)

- 100k fixture wheel: 141.7 ms → 41.7 ms with the main atlas. Input: 31.0 → 16.5 ms.
- Shared world pan regressed: 25 → 33.2 ms, with the pan callback going 0.8 → 27.9 ms.
- Relief worker: brought pan back to 25 ms / 0.7 ms, but worsened wheel (41.7 → 74.9 ms) and input (16.5 → 57.5 ms).
- The relief tile removed 10,946 `<use>`. Native paths remain: routes 1257, rivers 744, borders 703.
- The CTM freeze removed a 612 ms forced-layout freeze but did not improve frames.
- Fixture labels mislead:
  - "100k" is 53,194 cells; the shared world is 47,885.
  - The bench harness is not in the snapshot.
  - Test counts do not reconcile: 268 in the brief, 249/32 in implementation-status.md:28, 21 test files in the snapshot (audits/verification.md).

Conclusion: SVG-side optimizations trade one gesture class against another. Both remaining costs, DOM paint and compositing of tens of thousands of nodes and forced layout on input, go away only when the visible map stops being SVG.

## 3. Architecture layers

```
Editors / dialogs (unchanged UI)  ──commands (P3) / DOM writes (P2)──►  SceneDocument ◄── parse(.map SVG section) / binary
                                                                          │ revisions per layer
  GestureController (one owner of pointer + wheel) ─► Camera ─────────────┤
                                                          ▼               ▼
                          FrameGraph: layer passes → GpuDevice (WebGL2) → canvas
                                   ▲ compat lane textures (off-frame, cached)
  PickService (CPU index; optional GPU ID on click) ◄────── same geometry IR
  SvgMaterializer (lazy): SceneDocument → SVG for save/export/minimap/3D/legacy
```

- **GpuDevice:** WebGL2 context, buffers, textures, programs and render targets.
  - Handles `webglcontextlost` with `preventDefault` and restores in ≤500 ms (no context-loss handling exists anywhere in source today).
  - Handles DPR and resize; DPR is capped at 2 everywhere (`relief-viewport.ts:95` is currently uncapped, and that is not copied).
  - Queries `MAX_TEXTURE_SIZE` with 4096 as the floor.
- **Camera:** `screen = k·world + (x, y)`, with no rotation (`main.js:190`).
  - k lies in [zoomMin(dynamic), zoomExtentMax]. Default [1, 20], user clamp [0.01, 200] (`options.js:213-222`, `:519-523`, `:529-531`).
  - Float32 is enough up to k≈50 for worlds ≤8k px. Above that, use relative-to-center chunk offsets (audits/followup-camera-lod.md §3).
- **FrameGraph:** ordered passes that follow the live DOM layer order (`moveLayer`, `layers.js:1064-1073`), not `drawLayers` order.
  - Each layer has a revision counter, so only dirty layers re-tessellate.
  - Camera changes rewrite one uniform block only.
- **Geometry IR:**
  - per-layer typed arrays: cell polygons with Uint32 indices (~110k vertices exceed Uint16), stroked polylines, instance tables for symbols and glyphs;
  - built in workers where already proven (relief) and checked against SVG output (PROOF-PLAN G-C).
- **Style resolver:** the existing `applyStyle` selector→attribute map and the inline attributes on layer `<g>` elements, compiled to per-layer uniforms and per-feature attributes.
  - Zoom-dependent rules from `updateZoomStyling` (`main.js:548-630`) are recomputed per style tick, never per frame:
    - label size `(d + d/k)/2`;
    - halo `d/k^0.8`, shown only if > 0.1;
    - markers `size/5 + 24/k`;
    - coastline filter switching at k 1.5 / 2.6;
    - rulers `10/k^0.3·2`.

## 4. Rendering techniques (decisive choices)

| Concern | Choice | Why / evidence |
|---|---|---|
| Fills (cells, biomes, states, provinces, cultures, religions, heightmap) | Static triangulated meshes, plus a per-cell lookup texture for the colour index (R16, 512² so maps up to 262k cells fit; 256² caps the map at 65,536 cells) | Recolouring an editor result only rewrites the lookup texture. audits/followup-camera-lod.md E11 |
| Strokes (borders, coastline, rivers, routes, rulers, grid) | Instanced screen-space quad-strip lines with miter/round joins. Width is in world units × k, so it scales like SVG unless the style is non-scaling. Dashes are computed in a fragment shader from arc length | Stroke parity within 1 device px (PROOF-PLAN) |
| Rivers (variable-width polygons) | Use the existing generated outline polygons as fills | Same geometry as SVG |
| Hatch patterns (zones, states; `hatch0..13`) | World-anchored phase, pitch in CSS px `p/k`, matching `patternTransform scale(1/k)` (`zone-hatching.ts:140-207`), snapped to device pixels. Canonical pitch is **4 or 5 px** (`index.html:8815-8861`); only the measured red hatch is 6 px | The baseline's "6 px" is wrong as a general rule |
| Masks and clipPaths (land/water masks, `#statePaths` clips) | Stencil buffer | Exact for binary masks |
| Group opacity on overlapping children | Per-feature alpha when children cannot overlap (cell partitions). Otherwise draw into an offscreen RT and composite with group alpha | Matches SVG group-opacity semantics |
| SVG filters (drop-shadow, blur, dropshadow/coastline switching, `index.html:175-314`) | Port gaussian blur, offset, flood, composite and colour matrix as separable passes. `feTurbulence`/`feDisplacementMap` and any filter not yet ported go through the **compat lane** | No row is dropped |
| Blend modes (relief, `erosion-bake.ts:130-391`) | GL blend equations where they are separable. Otherwise use the RT and shader blend | |
| Relief icons, burg icons, markers, emblems | Instanced quads from a symbol atlas: 2048² pages, 32–64 MB total, rasterized once per symbol and size bucket by the existing SVG symbol code. Replace the 48 MiB relief LRU (`relief-canvas.ts:42`) and the unbounded `decodedSprites` (`:64`) | Exact, because the rasterizer is the source SVG |
| Text (state, burg and custom labels; scale bar; coordinates) | **CPU shaping with Canvas2D `measureText`, plus a Canvas2D glyph atlas bucketed at 1x/2x/4x** (not SDF/MSDF). Curved labels: glyphs placed along the textPath polyline using startOffset (50% default), text-anchor and letter-spacing. Halos are drawn as separate stroked-glyph atlas entries | Canvas2D uses the same font stack as SVG. SDF would change glyph appearance. Fonts must be pinned and loaded with `document.fonts`, because export embeds `@font-face` |
| Picking | CPU: uniform grid over cells (point-in-polygon), an R-tree over symbols and labels, and stroke distance for lines. Click: optional GPU ID pass only when CPU candidates overlap | 0 readbacks on hover. CPU pick ≤1 ms |
| LOD | Inherit only the source thresholds: `dense-zoom` k≤4 overlay hide, re-raster hysteresis 1.2× and 1/1.5×, label culling with 20 **world-unit** padding. Relief density is **not** zoom-dependent in source, so any new density LOD is new design and must not hide icons the SVG shows | audits/followup-camera-lod.md E4, E9 |
| GPU memory | 160 MB target. 256 MB hard no-go. Evict raster layers first, then the atlas LRU, then drop DPR to 1.5 | Corrected arithmetic: camera-lod E5–E8 |

## 5. Feature-parity matrix and migration acceptance

Legend:
- **N** = native GPU at P2.
- **C** = exact compat lane at P2, to be ported later.
- **B** = SVG bridge or live separate SVG, kept intentionally.

Acceptance IDs refer to PROOF-PLAN.md. Every row must pass before the flag default flips (G3), and no row may be removed.

| # | Feature (source anchor) | P2 mechanism | Acceptance |
|---|---|---|---|
| 1 | Ocean, `#oceanLayers`, oceanic pattern | N fills. Pattern goes through C until ported | G-C golden, SSIM ≥0.95 |
| 2 | Land heightmap `#terrs` (+ `heightmap-canvas.ts`) | N lookup-texture fill | golden + recolour test |
| 3 | Biomes `#biomes` (+ `#temp` staging) | N | golden. Biome extras round-trip (I6) |
| 4 | Cells grid `#cells` (`cell-mesh-canvas.ts`) | N strokes | golden |
| 5 | Grid / coordinates `#gridOverlay`, `#coordinates` | N strokes + text | golden at k 1/2/4/8 |
| 6 | Compass, scale bar, rulers `#ruler` | N + text. Ruler drag uses the editor overlay | golden + measurer interaction test |
| 7 | States fill + halo, `#statesHalo` | N. Halo uses the RT where it overlaps | group-opacity overlap test |
| 8 | Provinces, borders `#borders` | N fills / strokes | stroke ±1 px |
| 9 | Cultures, religions (incl. `g#relig` from auto-update) | N | golden |
| 10 | Zones + hatches `#zones` (`data-type`, `data-description`) | N hatch shader. Unported patterns use C | hatch pitch within 1 px at k 1/2/4/8 |
| 11 | Coastline, lakes, `#landmass` + filter switching at k 1.5/2.6 | N + filter passes. Filters use C until ported | golden at k 1, 2, 3 |
| 12 | Rivers `#rivers` (`data-basin`) | N fills | golden, hit parity |
| 13 | Routes `#routes > g#route-*` (sibling order = draw order) | N strokes in DOM order | golden, rename via `#routeTemp` preserved |
| 14 | Relief icons `#terrain` (`data-*` settings) | N instanced atlas | relief settings round-trip, golden |
| 15 | Burgs icons/anchors + labels | N instanced + glyph atlas | pick ≥99.5%, label set equality |
| 16 | State/burg labels, custom labels `#addedLabels` + `defs #textPaths` | N glyph atlas with CPU textPath layout | label golden, threshold set equality ±0.01 |
| 17 | Markers, notes (keyed by element id) | N atlas | notes round-trip |
| 18 | Military/regiments `#armies` | N atlas + text | golden + drag via overlay |
| 19 | Ice `#ice` | N fills | golden + ice editor test |
| 20 | Emblems `#emblems` (COArenderer) | N atlas: each emblem rasterized by its SVG | golden |
| 21 | Temperature, precipitation, population, goods, markets | N | golden |
| 22 | Trade animation `#tradeAnimation` (cleared before save) | N animated instances | animation smoke + I-trade |
| 23 | Debug/texture overlays, satellite texture (`draw-satellite-texture.ts`) | N texture | golden |
| 24 | Legend, picker (`data-x/data-y`, `editors.js:167-251, 512`) | B: editor overlay SVG, with metrics from the hidden model | bbox parity ≤1 px, round-trip |
| 25 | Customization mode overlay (`main.js:191-199`) | N texture redraw on change only (not per frame) | customization smoke |
| 26 | Layer toggles `layerIsOn` + ~40 side-effect sites (`layers.js:1050-1059`), `data-layer-off` | N visibility flags. Side effects untouched | toggle census test |
| 27 | Layer reorder (`moveLayer`) | N pass order follows DOM | reorder golden |
| 28 | Style presets (`style-presets.js:91-102`) | Resolver re-reads DOM attributes (P2), then commands (P3) | preset goldens for every built-in preset |
| 29 | All editors (burg, labels, rivers, routes, coastline, lakes, markers, relief, provinces, zones, biomes, heightmap, states, cultures, religions, diplomacy, ice, regiments, emblems, measurers) | Bridge: CPU pick → synthetic events on the hidden model, plus the `d3.mouse` shim | per-editor scripted interaction parity (PROOF-PLAN G-E) |
| 30 | Undo (heightmap, states, markets data undo; **cultures markup undo of `#temp` innerHTML**, `cultures-editor.ts:869-882`; templates undo `index.html:4192`) | Unchanged in P2. Cultures undo becomes a command in P3 | undo/redo replay tests |
| 31 | Save `.map` (text, 46 CRLF sections, SVG = `mapData[5]`) | SVG serialized from the hidden model (P2) or the materializer (P3) | I1–I15 |
| 32 | Binary TUPAIA save (default, `save.ts:51-53`) and load, cloud versions (`cloud-cloudflare.ts:177-270`), ldb lastMap | Same serializer | binary round-trip, date normalized |
| 33 | Load + `auto-update.ts` migrations (need layout) | Run on the hidden live model before the first GPU parse | legacy corpus load test |
| 34 | SVG/PNG/JPEG export, tiles (`export.ts:45-94, 133, 234-279, 507-577`) | B: live styled hidden model (export inlines computed styles) | export goldens vs current |
| 35 | Minimap (`minimap.ts:82-133`, `<use>` of map) | N second viewport sharing GPU resources. Click-to-pan uses camera math, not `getScreenCTM` | minimap golden + click test |
| 36 | 3D view mesh texture (`view-3d-renderer.ts:598-647, 954-978`) and screenshot | N render-to-texture without overlays (I-mesh). Satellite mode unchanged | texture golden |
| 37 | Transform tool preview (`getMapURL("png")` SCALE 4, `transform-tool.js:41-60`) | N offscreen render at 4× | preview golden |
| 38 | Heightmap preview, elevation profile, charts, emblem export | B: separate SVGs, not on the frame path | unchanged tests |
| 39 | Print / fullscreen / presets (unverified in audits) | N (fullscreen = resize). Print uses the export path | smoke (marked UNVERIFIED) |
| 40 | Shared map API / `window.pack/grid` consumers | Unchanged | API smoke |
| 41 | User fonts (calls to `addGoogleFont`/`addWebFont`/`addLocalFont`/`declareFont`; the definitions are **not in the snapshot**) | N: atlas built only after `document.fonts.load` resolves. Re-atlas when fonts change | font-switch golden (UNVERIFIED loader) |
| 42 | Style filters pencil/turbulence/paper/crumpled/splotch, fog/vignette masks | C (turbulence filters). N offscreen alpha (masks) | per-filter golden |
| 43 | Colour emoji / image markers | N RGBA atlas, rasterized by Canvas2D | marker golden on 2 OSes |

## 6. Text details (audits/followup-text-defs.md)

- **Sizing.** State label size is chosen by character count, and fit is checked with DOM `getBBox` (`draw-state-labels.ts:314-334`). In P2 that `getBBox` runs on the hidden live model. P3 replaces it with Canvas2D `measureText` and needs a parity test, because advance widths must match the browser's SVG text layout.
- **Bucket pops.** Fixed 1x/2x/4x buckets resample and visibly pop, since label sizes run continuously from 6 to 60 px. Decision: key glyphs by (font, weight/style, size quantized to ≤12.5% steps, DPR). Glyph pages get LRU eviction. Use the label threshold test plus the screenshot gate.
- **Shaping.** Source has no bidi or segmentation handling. Shape per **label string**: rasterize whole runs with Canvas2D `fillText` where possible, then split into per-glyph quads along the path using `measureText` of prefixes. This keeps the browser's shaping (ligatures, complex scripts) for straight labels. Curved complex-script labels go through the compat lane until proven.
- **Inline SVG in labels.** No `text-anchor`/`dominant-baseline` is set on map labels (UNVERIFIED for all groups). Halos (stroke + paint-order) become a second stroked atlas entry.
- **Invalidation.** User edits to text or textPaths bump the label layer revision. Fonts must finish loading before atlasing.

## 7. Compat capture lane (exact, off-frame)

- **Input:**
  - any layer or feature subtree flagged `compat` in the layer registry;
  - an arbitrary user filter or mask on any element, since presets can attach them.
- **Mechanism:**
  1. Clone the subtree from the hidden model, with its `<defs>` closure.
  2. Serialize it to an SVG blob and draw it to an `OffscreenCanvas` (or the Canvas2D path for existing canvas renderers), at viewport-tile resolution `k·dpr`.
  3. Upload it as a texture.
- **Timing:** only at style/detail ticks or idle, never in the frame callback.
- **During a gesture:** reuse the last texture, scaled, with re-raster hysteresis 1.2× / 1/1.5× (`dense-zoom.ts:431`).
- **Budget:** the compat lane may add ≤5 ms to input (the worker-lane gate) and must not regress the wheel gate. Rows that exceed this are the first to be ported natively.
- **Fidelity:** pixel-exact against the source renderer at capture resolution, since it *is* the source renderer. Scaling artefacts during gestures are bounded by the hysteresis.

## 8. Editor bridge (P2) → command model (P3) (audits/followup-editor-bridge.md)

**P2 bridge, the minimum that removes frame coupling while keeping every editor working:**

1. **Hidden live model.** The `#map` SVG stays in the document with `visibility:hidden; pointer-events:none`.
   - Not detached: 49 document-level lookups in 17 files would break, e.g. `burg-canvas.ts:145`, `relief-canvas.ts:215`.
   - Not `display:none`: that gives a zero bbox and a null CTM.
   - The camera transform is **not** written to its `#viewbox` per frame. It is written only on save, export or exit, so no style or layout invalidation happens per frame.
2. **GestureController** owns pointer and wheel on the canvas.
   - Camera gestures update the Camera object, then one uniform.
   - Editor gestures:
     1. CPU pick → target model node → synthetic `mousedown` (with `view: window`, button 0, real clientX/Y) on that node.
     2. `mousemove`/`mouseup` are re-dispatched on `window`.
     3. On a pick miss, `click` goes to `#viewbox`.
     4. The native click is never also forwarded, to avoid double dispatch.
   - Brush modes (`relief-editor.js:106,183`, `heightmap-editor.js:694`, `provinces-editor.js:859`, `zones-editor.js:188`, `biomes-editor.js:367`) suppress camera panning while active, which closes the zoom/brush overlap risk.
3. **`d3.mouse`/`d3.pointer` shim.** It returns the camera inverse × the node's world matrix (from `parseTransform`, `measurers.js:73`, `editors.js:502`) for the listener node.
   - This is required because element-scoped `d3.mouse(this)` sites need their own CTM, e.g. `relief-editor.js:112/138/202`, `labels-editor.js:149`, `units-editor.js:151-238`.
   - The canvas `getBoundingClientRect` is read once per frame at most.
4. **Editor overlay SVG** above the canvas holds transient handles and hit proxies only, with one root transform per frame.
5. **Geometry reads.**
   - Path length/point (~12 sites) and text bbox sites keep working on the hidden model.
   - The O(N) relief `getBBox` loop at drag start (`relief-editor.js:129-135`) is ported to instance-table math in P2 because of its performance hazard.
6. **Fix the stale `d3.event` read** after the 100 ms debounce (`general.js:78-85`, INFERRED) by capturing coordinates synchronously.

**Caveat:** `libs/d3.min.js` is absent from the snapshot, so d3-drag internals (`event.view` listeners, `d3.event` lifetime) are INFERRED. Pinning and verifying them is backlog item P0.

**P3 command model:**
- Editors call `SceneDocument` commands (`moveBurg`, `setLabelText`, `editPath`, …).
- Undo becomes a command journal. Cultures' markup undo is replaced with a data snapshot.
- The SVG model is materialized lazily for save, export and remaining legacy consumers.
- Exit criterion: no editor reads or writes model DOM during a gesture, and the hidden model may be absent while editing.

## 9. Exact remaining SVG dependencies and why they do not affect frames

| Remaining SVG | Phase | Why it is outside the frame path |
|---|---|---|
| Hidden live `#map` model | P2 only | `visibility:hidden` + `pointer-events:none`. No per-frame camera write. Edits mutate only what changed. Their style/layout cost lands on edit, not on pan/zoom. P3 removes it from the editing path |
| Editor overlay SVG (handles, ruler, legend/picker) | P2+ | Hundreds to ~3k nodes worst case (INFERRED), one transform write per frame. Gate: input/wheel thresholds measured *with an editor open* |
| Export/save serialization | P2+ | On demand only. P3 uses a materializer into a detached document, except export, which needs a live styled clone: built transiently, then removed |
| Load-time `auto-update.ts` migrations | P2+ | Once per load, before the first frame |
| Compat-lane captures | P2+ | Off-frame, cached, hysteresis |
| Minimap | — | Becomes a GPU viewport. Its `<use>` of the map is removed |
| Charts, elevation profile, heightmap preview, emblem editor, temperature graph, overviews | unchanged | Separate small SVGs in dialogs, not the map |

## 10. Save and model invariants (from audits/migration.md, followup-consumers-invariants.md)

| ID | Invariant |
|---|---|
| I1 | Model fixpoint: `parse(serialize(doc)) == doc`. |
| I2 | File fixpoint with declared normalizations (date in params `save.ts:60-63`, icon newline collapse `save.ts:156`). |
| I3 | 46 CRLF sections. SVG = `mapData[5]` (0-indexed). Split on `\r\n` because the SVG contains LF. CRLF repair at `load.ts:188-195`. |
| I4 | Element ids are stable (notes, routes, labels). The renames at `tools.js:241-283` are preserved. |
| I5 | DOM-attribute census allowlist. Every attribute or `data-*` written by any editor round-trips. This is the anti-functionality-loss net. |
| I6 | Relief `data-*`, biome extras (additive 4th field `save.ts:94-95`). |
| I7 | Render equivalence (PROOF-PLAN goldens). |
| I8 | Canonical size on save (`save.ts:115-116`, `export.ts:275-276`). The camera is not persisted. |
| I9 | `#ruler`, `#tradeAnimation` cleared. `.viewport-culled` stripped. Dynamic parts restored before serialize (`save.ts:104-109, 131`). |
| I10 | Section index layout fixed (3 = biomes, 4 = notes, 5 = SVG). |
| I11 | Trade `data-layer-off` (`save.ts:124-127`). |
| I12 | Save blocked during customization (`save.ts:15`). |
| I13 | Mesh texture excludes overlays. Satellite mode replaces the texture. |
| I14 | Binary TUPAIA round-trip equals text round-trip at the model level. |
| I15 | `#temp` never leaks into saves (currently INFERRED to be able to: test and preserve current behaviour exactly, then fix only with owner approval). |

## 11. Phases and gates (details in PROOF-PLAN.md and the backlog)

| Phase | Deliverable | Gate | Rollback |
|---|---|---|---|
| P0 | Harness (bench, goldens, save corpus incl. binary + legacy maps, DOM census); pin d3/three/fonts; `?renderer` flag skeleton | G0: harness reproduces baseline numbers ±10%; census complete | none needed |
| P1 | GpuDevice, Camera, FrameGraph, fills + strokes + hatch + one text layer + CPU pick + compat lane, flag-gated | G1: gpu.md thresholds (wheel p95 ≤20 ms, input p95 ≤16.5 ms, pan callback ≤1 ms, 0 hover readbacks) | flag off; **stop-loss if G1 fails at its cap** |
| P2 | All 43 matrix rows (N or C), editor bridge, minimap, 3D texture, transform preview | G2: matrix rows green with flag on | flag default `svg` |
| P3 | SceneDocument ownership, editor commands, materializer, compat rows ported where cheap | G3: save/export/consumer goldens; flag default flips to `gpu` | flag flip back |
| P4 | Hardening: second GPU family, DPR 2, context loss, memory, remove SVG display path behind a deprecation window | G4: owner sign-off | release revert |

## 12. Ownership

- **Opus** owns: SceneDocument schema + parse/serialize, Camera + GestureController, GpuDevice/FrameGraph, compat lane, text layout, editor bridge + shim, flag routing, `main.js`/`layers.js`/`editors.js`/`save.ts`/`load.ts`/`export.ts` integration, every gate review.
- **Haiku** packets own leaf modules: per-layer IR extractors, censuses, tests, goldens specs, docs. One file per packet (IMPLEMENTATION-BACKLOG.json).

## 13. Baseline claims corrected

| Baseline claim | Correction (evidence) |
|---|---|
| scaleExtent `[0.8,20]`, test at k=0.8 | `[1,20]` at boot (`main.js:238`), then dynamic min (`options.js:213-222`), user clamp [0.01,200] (`options.js:519-523`). No 0.8 anywhere |
| three already a paid-for prod dep, bundle ~0 | Runtime three is vendored `libs/three.min.js`. npm three is types-only. Raw WebGL2 chosen |
| `mcp/src/bridge.js` must keep working | Not present in the snapshot |
| `?renderer=gpu`, `?reliefWorker`, GPU branch in `invokeActiveZooming` exist | Not in source (`main.js:540-546`). They are deliverables |
| Model SVG "detached, never displayed" | Breaks 49 document lookups, minimap `<use>`, `getBBox` under display:none. Use a hidden live model (P2) → command model (P3) |
| "Zero editor changes" | False. Shim + gesture controller + overlay + relief bbox port are required |
| Approximate per-layer raster bridge | Replaced by an *exact* compat capture lane |
| SDF text | CPU-shaped Canvas2D glyph atlas with fine size quantization |
| Hatch 6 px | Canonical 4/5 px; 6 px only the measured red hatch |
| `.map` "line 5" | `mapData[5]` 0-indexed (line 6), CRLF split |
| 3D view out of scope | In scope (texture consumer) |
| Context-loss handled by three | No context-loss handling exists. New requirement |
| Memory 100–200 MB, atlas 16–64 MB, RTs 15 MB, verts 2.2 MB Uint16 | Sums 57–245 MB; atlas 32–64 MB; RT 33 MB each at 1080p DPR2; Uint32 required. Target 160 MB, no-go 256 MB |
| Relief density reuses dense-zoom k≤4 | Relief density is not zoom-dependent in source |
| Input gate ≤4 ms | gpu.md per-metric thresholds tied to measurements |
| 268 tests | 21 test files in snapshot; counts don't reconcile |

## 14. Credible uncertainties

- d3 version/internals (vendored lib absent). Font loader definitions absent. `bench/` absent. `tests/fixtures/demo.map` absent.
- Canvas2D `measureText` vs SVG text layout advance parity is unproven. It is the riskiest text item.
- Editor-bridge frame cost with an editor open is unmeasured. The zoom/brush overlap is INFERRED.
- Hidden-live model memory and style-recalc cost on large edits is unmeasured.
- Whether GPU meets G1 on a Windows iGPU at DPR 2 is unknown. M1 Max at DPR 1 is the only measured device.
- Float32 error and device limits are INFERRED arithmetic.
- The cost model (SPENDING-PLAN) is calibrated from one ideation session, not implementation sessions.
