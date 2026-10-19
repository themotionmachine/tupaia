# P1 animation report: live trade markers on the GPU path

Status: **code written, not executed.** No tests, type-check, Biome or browser run were performed in this session
(file tools only). Everything below describes intended behaviour; the host must verify it.

## Problem

The P1 mutation probe (`host-checks/p1-mutation-probe.json`) showed ~54k `attributes:g#:transform` records from the D3
trade animation. The renderer's root `MutationObserver` treated every non-`#viewbox` record as a static revision, so each
tween tick invalidated the ~1.6 s static prepare, which never finished while trade animation ran: the GPU canvas
stayed hidden (starvation), and markers could only ever have appeared as frozen compat raster.

## Design

| Piece | File | What it does |
| --- | --- | --- |
| Classifier | `src/gpu/markers.ts` `classify()` | `"none"` / `"dynamic"` / `"static"` per observer batch. Dynamic = `childList` on `#tradeAnimation` adding/removing only `<g>`, or any record whose target is (inside) a `<g>` child of `#tradeAnimation`. `#viewbox` transform stays ignored (camera-owned). Records on nodes already detached are skipped (their parent's `childList` record covers them). Anything else, including style/transform/opacity on `#tradeAnimation` itself, the highlight `<path>`, defs, presets: `"static"` → full invalidate, unchanged. |
| Observer | `src/gpu/renderer.ts` | `static` → `invalidate()`; `dynamic` → `requestDraw()` only (one rAF-coalesced frame). |
| Scene | `src/gpu/scene.ts` | Top-level `#tradeAnimation` emits a `trade` draw: marker `<g>` children are skipped; other children (e.g. `path.highlight`) are walked natively. Hidden/`display:none` layer returns before this, so no marker slot exists and markers are not drawn. |
| Prepare | `src/gpu/prepare.ts` | `trade` → static siblings, then a `{ kind: "markers" }` slot, wrapped in an opacity group when layer opacity < 1. DOM layer order is preserved. |
| Instances | `TradeMarkers.collect()` | Each GPU frame reads the live `#viewbox > #tradeAnimation` groups in DOM order: root × group × `<use>` transforms (`parseTransform`/`multiply`) applied to the `<use>` x/y/width/height box → origin + two axes (6 floats). Rotation, translation, size and any root transform follow D3 exactly. Consecutive markers of one kind form one instanced run. Groups with `display="none"`, unknown hrefs, unparsable transforms or degenerate boxes are skipped. |
| Draw | `src/gpu/framegraph.ts` `markers()`, `shaders.ts` `marker` | Instanced RGBA quads with the existing `sprite` fragment shader (full colour texture, premultiplied); **not** the alpha-only glyph atlas shader. One dynamic buffer, reused via `updateBuffer`. |
| Textures | `TradeMarkers.load()` | One 256×256 mipmapped texture per kind, rasterised from the real `<symbol id="trade-marker-{land,water}">` (viewBox + children) via the existing `decodeSvg`. The symbol is requested lazily the first time a marker of that kind is seen; a missing symbol (still fetching) is retried next frame. |

### Lifecycle

- **New segment / marker removed / `clear()`**: D3 adds/removes `<g>` → dynamic → next frame reads the new set.
  Nothing is cached per marker, so there is nothing stale to clean up.
- **World replace**: `markers.release()` frees both textures and bumps a token so in-flight decodes are discarded;
  the existing rebind of SVG root and observers is unchanged.
- **Context loss**: `markers.forget()` (handles died with the context; token bumped). After restore the graph is rebuilt
  (new marker buffer) and textures reload lazily on the next frame that has markers.
- **Dispose**: `markers.release()` before `graph.dispose()` / `device.dispose()`; the framegraph releases its marker
  buffer.
- **Texture failure**: decode failure or `device.texture` throwing (e.g. tainted source) falls back to a procedural
  premultiplied grey disk, warns once, and markers keep moving.

### Memory

Bounded: 2 textures × 256² × 4 B + mips ≈ 0.7 MB; one instance buffer of 24 B × live markers. The CPU staging array
grows by doubling and is never shrunk (high-water mark of concurrent markers).

### Telemetry

`mutationKinds` (unbounded debug map) is removed. `GpuTelemetry.markers` reports how many markers the last frame drew.

## Honest limits / debt

1. **DOM-mirror bridge (perf debt).** D3 still writes a `transform` attribute per marker per tick, the browser still
   runs the observer, and the GPU frame re-walks `#tradeAnimation` and re-parses transforms every frame. This is
   O(live markers) per frame with string parsing; it is a P1 transitional bridge, not the final design. A P2 port
   should drive instances from the tween state directly and drop the DOM writes.
2. **Stale-camera hit testing.** Click semantics are unchanged because the SVG `<g>`/`<circle>` remain the hit targets.
   During inexact camera motion (the GPU camera leading the throttled SVG `#viewbox` transform), the invisible circles
   can be offset from the GPU-drawn markers until the SVG camera syncs. Marker clicks during a pan/zoom gesture can miss
   or hit slightly off.
3. **Root effects not applied to markers.** If `#tradeAnimation` itself has a filter, clip-path or mask, its static
   siblings go through compat with that effect, but the GPU markers are drawn without it (reported as non-native
   `"<effect> not applied to markers"`). A root transform *is* honoured. Current presets set no such effect on this layer.
4. **Paint order within the layer.** Markers are drawn after all static siblings of `#tradeAnimation` (e.g. the
   highlight path), regardless of DOM interleaving. Visually this keeps markers above the highlight.
5. **Symbol fidelity.** Symbols are rasterised once at 256 px, so very large on-screen markers are softened. Paint
   inherited from the `<use>` (`fill`/`stroke`/`currentColor`) is not applied. Non-square `<use>` boxes stretch the
   texture instead of applying `preserveAspectRatio` letterboxing (D3 always emits equal width and height).
6. **Click circles are not drawn.** They have `fill: none; stroke: none`, so this matches the SVG.
7. **Per-marker `opacity`/`display` beyond `display="none"` on the group, and CSS styling of markers, are not
   mirrored.** The D3 controller sets neither.
8. **Static invalidation is coarse.** One static record among many dynamic records still triggers a full prepare
   (correctness over speed). Highlight add/remove is static.

## Tests added

`src/gpu/markers.test.ts` (pure, no DOM):

- `markerKind` accept/reject;
- `writeMarker` translate+rotate composition, root scale with non-square boxes, offset writes, and rejection of
  degenerate input;
- `classify` none/dynamic/static cases, including mixed batches and detached targets;
- `fallbackDisk` size, alpha and premultiplication.

The existing suite is untouched.

## Not verified (host to run)

- `vitest`, `tsc`, `biome check`;
- the browser parity harness with live trade animation: the canvas becomes visible and markers move, rotate, spawn and
  despawn;
- the frame time with N live markers;
- context-loss restore with markers in flight;
- world replace during animation;
- texture fallback (e.g. block `./images/markers/*.svg`).
