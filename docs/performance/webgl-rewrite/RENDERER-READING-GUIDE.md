# Renderer engineering reading guide

User clarification: the task is immersion in established implementation practices, not another WebGL-vs-WebGPU selection exercise. This guide supersedes the emphasis on backend comparisons in RENDERING-ARCHITECTURE-REVIEW.md. No new library dependency is implied.

## 1. Stable layer state and selective updates
Read deck.gl Layer Lifecycle and Attribute Management:
https://deck.gl/docs/developer-guide/custom-layers/layer-lifecycle
https://deck.gl/docs/developer-guide/custom-layers/attribute-management

Lessons: identify layers stably, preserve expensive state across draws, separate initialization/update/draw/finalization, and invalidate individual attributes when possible. Viewport changes need not regenerate world geometry.
Apply to renderer.ts/prepare.ts/scene.ts: which exact source change causes which buffer or texture to become dirty? Can one label edit or a scale-bar redraw force unrelated geometry to rebuild? Do not ignore real edits. Document which data are world-space versus screen-space.
Review output: mutation -> affected resource -> refresh operation -> proof that unrelated buffers survive.

## 2. Resource lifetime, batching and avoiding stalls
Read WebGL best practices:
https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices

Lessons: estimate VRAM explicitly, eagerly release unused objects, avoid unnecessary synchronous API calls and framebuffer attachment churn, and batch work where useful.
Apply to device.ts/framegraph.ts/budget.ts/bitmap-window.ts: one owner per allocation; budget before allocating; account old+new replacement peaks and render targets; define context-loss cancellation; state whether counters represent tracked allocations or physical residency.
Review output: ownership table, worst-case allocation arithmetic and tests for stale/error/loss paths. The 160MiB limit is an engineering target, not a browser law.

## 3. Practical 2D scene management
Read PixiJS performance tips:
https://pixijs.com/8.x/guides/concepts/performance-tips

Lessons: scene organization, batching, culling, text and texture handling have tradeoffs; do not assume enabling every optimization helps every scene.
Apply to scene.ts/framegraph.ts/raster.ts: identify unnecessary draw/state changes, cache only stable content, measure culling overhead and avoid rebuilding caches for camera-only changes. Preserve painter order, masks and opacity.
Review output: before/after trace, not merely fewer lines of code or fewer named batches.

## 4. Text is its own rendering system
Read deck.gl TextLayer:
https://deck.gl/docs/api-reference/layers/text-layer

Lessons: reusable font atlases are a normal GPU text technique; SDF is an optional sharpness strategy across scales. Texture-based text does not inherently mean low quality.
Apply to text.ts and compatibility rasters: distinguish cached individual glyphs from full-layer bitmaps. Test font metrics, outlines, curved labels, glyph availability, kerning/shaping and export behavior.
Review output: a font/zoom/DPR fidelity matrix; explain limitations without pretending all SVG text is trivial.

## 5. Preparation versus drawing
Read MapLibre Native rendering data flow (native/Android reference; principles, not APIs):
https://maplibre.org/maplibre-native/docs/book/design/android-map-rendering-data-flow.html
Read browser OffscreenCanvas guidance:
https://web.dev/articles/offscreen-canvas

Lessons: preparation, spatial organization, resource upload and drawing are distinct phases. Workers can offload serializable preparation; they cannot inspect live SVG DOM.
Apply to prepare.ts/scene-document.ts/compat.ts: profile each phase, choose explicit input snapshots, reuse prepared data, transfer ownership deliberately, and make cancellation deterministic.
Review output: measured CPU/GPU/transfer breakdown and a dataflow that keeps camera handling responsive.

## How to use this guide

Before each implementation chunk, study the relevant source section and the matching existing code. A read-only review should produce:
1. The established pattern and its source.
2. Evidence of how our code currently behaves.
3. A small applicable change, or a reason the pattern does not fit.
4. A test or trace that could disprove the proposed benefit.

Keep a distinction between source-backed practice, our inference and measured results. Feed useful lessons into normal task briefs and review checklists. Do not commission a broad technology bake-off, add production dependencies or rewrite working subsystems merely because an example library does things differently.
