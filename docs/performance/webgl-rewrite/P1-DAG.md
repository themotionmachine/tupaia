# P1 DAG — WebGL2 GPU proof slice

Written with file tools only. Nothing below was executed by the agent; the host runs every check in
`P1-GATE-REPORT.md`.

## Nodes (dependency order)

| # | Node | Files | Depends on | Owner |
|---|------|-------|------------|-------|
| 1 | Camera math (float64 CPU, float32 uniforms), viewbox transform parse, visible-world rect | `src/gpu/camera.ts` (+test) | — | worker |
| 2 | SVG path parse + adaptive flattening | `src/gpu/svg-path.ts` (+test) | — | worker |
| 3 | Fill fans / stroke segment instances / bounds | `src/gpu/geometry.ts` (+test) | 2 | worker |
| 4 | CPU pick index (grid, DOM order, fill/stroke tolerance) | `src/gpu/pick.ts` (+test) | 3 | worker |
| 5 | Raw WebGL2 device: loss/restore, DPR ≤ 2 resize, allocation tracking, MSAA targets | `src/gpu/device.ts` (+test) | — | worker → parent fixes |
| 6 | GLSL programs (premultiplied) | `src/gpu/shaders.ts` | 5 | parent |
| 7 | Read-only scene extraction (native draws vs explicit compat runs) | `src/gpu/scene.ts` (+test) | 2 | parent |
| 8 | Pattern tiles (hatching) + relief sprites | `src/gpu/raster.ts` (+test) | 7 | parent |
| 9 | Curved labels: real-font metrics, glyph atlas, instanced quads | `src/gpu/text.ts` (+test) | 7 | parent |
| 10 | Compat lane: export-clone rasterization, budgeted resolution | `src/gpu/compat.ts` | 7, `src/io/export.ts` | parent |
| 11 | Framegraph: DOM-ordered passes, stencil-then-cover, groups/masks | `src/gpu/framegraph.ts` | 5, 6 | parent |
| 12 | Frame preparation with staleness checks after every await | `src/gpu/prepare.ts` | 3, 4, 8–11 | parent |
| 13 | Renderer: canvas over SVG, camera hooks, settle, editor suspension, telemetry, dispose | `src/gpu/renderer.ts` | 1, 12 | parent |
| 14 | Router host contract + lazy backend behind `?renderer=gpu` | `src/renderers/renderer-mode.ts` (+test) | 13 | parent |
| 15 | `main.js` camera/style/visible/details guards | `public/main.js` | 13, 14 | parent |
| 16 | Bench: capture adapter, renderer arm in navigation-quality, final camera in navigation, A/B labels | `bench/gpu-capture.ts`, `bench/navigation-quality.ts`, `bench/navigation.ts`, `bench/renderer-ab*.ts` | 14 | parent |
| 17 | Gate report | `docs/performance/webgl-rewrite/P1-*.md` | all | parent |

`src/io/export.ts` was changed only to expose the existing clone preparation (styles, fonts and images inlined) to the
compat lane. Export output is unchanged.

## Concurrency used

Workers (Haiku 5.5, depth 1, ≤ 6 concurrent, disjoint files) built nodes 1–5 with their tests. The parent reviewed
and reconciled every report, fixed defects (stencil ops, detach/isolate, texture release, mask fill indexing, canvas
flash, lost prepare after restore, drop ordering, lazy-shell leak), and wrote nodes 6–17.

## Gate edges

- P2 must not start until the host gate in `P1-GATE-REPORT.md` passes with measured (not estimated) numbers.
- The SVG default stays authoritative: no node allocates GPU resources or probes WebGL unless `?renderer=gpu` is set.
