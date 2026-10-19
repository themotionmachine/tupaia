# Rendering architecture validation — October 15, 2026

Preliminary research, not an experimental verdict. Existing WebGL2 choice is plausible; current SVG-mutation-to-whole-scene-prepare bridge has NOT been validated as the final architecture.

## Direct primary-source findings

- deck.gl emphasizes avoiding unnecessary layer/buffer regeneration, stable data identity, incremental updates, and optional worker-prepared attribute buffers: https://deck.gl/docs/developer-guide/performance
- MapLibre recommends chunking and vector tiling for large datasets; this supports investigating bounded spatial chunks, not a claim that all Tupaia data must become geographic vector tiles: https://maplibre.org/maplibre-gl-js/docs/guides/large-data/
- deck.gl TextLayer uses a shared font atlas and optionally SDF to keep text sharper across sizes. Textures are a normal GPU text representation; our whole-layer compatibility rasters are a different tradeoff: https://deck.gl/docs/api-reference/layers/text-layer
- OffscreenCanvas can move Canvas work into a worker, separating some rendering work from main-thread interaction. It cannot directly consume live SVG DOM: https://web.dev/articles/offscreen-canvas
- Browser guidance recommends explicit VRAM estimation/caps; WebGL has no portable total-VRAM query. Therefore current device allocation counters are estimates, not driver/OS residency: https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices

## Inference from our evidence

Warm navigation can be smooth but canonical SVG decoration writes still trigger expensive CPU-side prepares. This implicates invalidation granularity/main-thread preparation, not evidence that WebGL2 itself is inadequate. Changing to WebGPU or Rust alone would not eliminate that work. This is an inference, not a measured backend comparison.

The 160MiB target is our engineering budget, not a browser-defined universal threshold. Exact pixel copies preserve source fidelity but a single moving viewport crop has replacement peaks, readiness coupling and synchronous copies. A stable spatial tile cache/LOD deserves a bounded comparison. A 4096x4096 RGBA8 texture is64MiB; double-buffered replacement is128MiB before other allocations. This is illustrative arithmetic, not our actual texture dimensions.

## Decision experiments, in order

1. Warm-camera trace: count actual DOM parsing, tessellation, layer rasterization, texture uploads, GPU draws and long tasks separately. Camera-only input should reuse world geometry. Record tile/visibility updates separately from semantic edits; no dropping real edits.
2. Selective invalidation: prove pan/zoom and one-object/style edits preserve all other buffers. Verify exact final camera, text/marker styles, hatch pitch, picking and save/export.
3. Cache comparison on identical real fixtures: current crops vs bounded spatial tile/LOD cache. Measure peak/steady tracked memory, upload/copy time, seams, fallback visibility, fidelity, context restore, cancellation.
4. Text comparison: existing glyph atlas/SDF or multi-resolution atlas, including curved labels, font metrics, outlines, arbitrary saved fonts, kerning and shaping. Do not equate bitmap use with poor quality.
5. Offload preparation only after identifying its measured cost. Workers require serializable render data/transferable buffers; canonical DOM ownership needs a deliberate bridge.
6. Reuse-vs-build review: compare scoped library components or a retained-layer reference implementation before proposing a whole MapLibre/deck.gl replacement. Tupaia is an editable illustrated map, so arbitrary symbols/masks/export compatibility must be included.

Proposed bounded follow-up: 60–120 minutes and $5–10 reported Anthropic usage BEFORE implementation of a second renderer backend. Fermi planning estimate, not a guarantee or an additional authorization beyond the existing $200 cap. Deliver traces, two small comparable experiments and a recommendation. Do not commit to WebGPU, Rust, a tile server or a new production dependency based only on generic demos.
