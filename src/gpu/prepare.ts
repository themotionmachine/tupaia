// Turns the canonical SVG into one GPU frame: shared vertex/instance buffers, pattern tiles, relief and glyph
// atlases, compat rasters (DOM-ordered slots) and the CPU pick index. Async with a staleness check after every
// await: a superseded job releases what it allocated and returns null.
import type { ReliefSprite } from "../renderers/relief-canvas";
import { BitmapWindows } from "./bitmap-window";
import {
  compatAllowance,
  fitScale,
  GPU_BUDGET,
  MIN_COMPAT_BUDGET,
  refineOrder,
  reliefCell,
  windowAllowance
} from "./budget";
import type { Camera } from "./camera";
import { resolveManyInClone } from "./clone-map";
import {
  compatClone,
  compatResolution,
  cropRaster,
  type Region,
  rasterizeRun,
  resolveInClone,
  scaleRaster
} from "./compat";
import {
  type CompatRoot,
  compatShapes,
  compatShapesBatch,
  dashHitRings,
  PICK_TOLERANCE,
  pickDepth,
  pickId,
  rasterHits,
  resScale as viewScaleOf,
  sensitivity,
  strokeHitRings
} from "./compat-pick";
import type { GpuDevice, TrackedBuffer, TrackedTexture } from "./device";
import type { Batch, FillBatch, Frame, ImageBatch, StrokeBatch } from "./framegraph";
import { appendSegments, appendStrokeCaps, capCode, F32, normalizeDashes, pathBounds } from "./geometry";
import { appendStencilMeshes, type MeshStats, newMeshStats } from "./mesh";
import { indexOverlays, releaseRuns, swapOverlays, uploadAll } from "./overlays";
import { type HitShape, leafPath, PickIndex } from "./pick";
import { buildReliefAtlas, cachedReliefImage, meetImageRect, rasterizePattern } from "./raster";
import { type GlyphHits, glyphCovers, readGlyphReport } from "./relief-pick";
import type { PrepareStep } from "./restore-phases";
import { buildScene, type Draw, type LayerReport, type Scene, type ShapeStyle } from "./scene";
import type { SceneCache, SceneKey } from "./scene-cache";
import { createSlicer } from "./slice";
import { flattenPath, type Subpath } from "./svg-path";
import { GLYPH_FLOATS, type GlyphAtlas, layoutLabels } from "./text";

export interface PrepareContext {
  device: GpuDevice;
  revision: number;
  bucket: number; // power-of-two raster scale for patterns and glyphs (camera scale × DPR)
  world: Region;
  screen: { width: number; height: number; dpr: number };
  camera: Camera; // snapshot at job start: initial bitmap window capture
  atlas: GlyphAtlas;
  stale(): boolean;
  mark?(step: PrepareStep): void; // optional phase timing (restore-phases.ts); prepareFrame only
  // optional scene reuse across context restores (scene-cache.ts); absent: every prepare walks the DOM
  scenes?: SceneCache;
  worldEpoch?: number;
  picking?: boolean; // false: presentation only; canonical SVG remains responsible for editor targets
}

// The scene curve tolerance; buildScene's own default, passed explicitly so the cache key cannot drift from it.
export const SCENE_CURVE_TOLERANCE = 0.2;

// A cached scene when the key still matches (a restore with no DOM revision or world change since it was built),
// otherwise a fresh walk that is stored for the next prepare.
function sceneFor(viewbox: Element, ctx: PrepareContext): Scene {
  if (!ctx.scenes || ctx.worldEpoch === undefined) return buildScene(viewbox, SCENE_CURVE_TOLERANCE);
  const key: SceneKey = {
    revision: ctx.revision,
    worldEpoch: ctx.worldEpoch,
    curveTolerance: SCENE_CURVE_TOLERANCE,
    viewbox
  };
  const hit = ctx.scenes.get(key);
  if (hit) return hit;
  const built = buildScene(viewbox, SCENE_CURVE_TOLERANCE);
  ctx.scenes.store(key, built);
  return built;
}

// Canonical cached bitmaps (path/relief PNGs) upload only viewport crops: their steady share cap. Each refresh is
// further limited by windowAllowance (old+new swap peak and the steady budget once the old set is released).
export const WINDOW_BUDGET = 64 << 20;

interface CompatRun {
  slot: ImageBatch;
  elements: Element[];
  screen: boolean;
  sharp: boolean; // holds text, marker <svg> or burg icon vectors: refined before smooth fills (refineOrder)
  hits?: HitShape[]; // screen overlay above #viewbox: its hit area in SVG-local CSS px, as of its current raster
}

// Hit shapes of a root overlay in the root <svg>'s user space (SVG-local CSS px: #map has no viewBox).
export const overlayShapes = (root: Element, svg: SVGSVGElement) =>
  compatShapes(root as unknown as CompatRoot, svg as unknown as SVGGraphicsElement);

// Compat reasons whose content is high-frequency glyph/icon detail rather than a smooth fill or texture.
export const SHARP_COMPAT = new Set(["text", "<svg>", "restored burg vectors"]);

export interface Prepared {
  picking?: boolean; // absent on older callers means enabled
  frame: Frame;
  pick: PickIndex;
  bucket: number;
  revision: number;
  layers: Record<string, LayerReport>;
  compat: {
    runs: number;
    elements: number;
    reasons: string[];
    resolution: number;
    // last settle refinement, in refine order: source id and drawn px per world unit (base resolution when kept)
    detail?: { id: string; density: number }[];
  };
  runs: CompatRun[];
  // root overlays above the world (indexOverlays); rebuilt with the rasters by refreshOverlays, so a pick always
  // answers for the overlay pixels currently drawn
  overlays: PickIndex;
  // the materialized #terrain group and the icons its pick instances index (instance k = children[k]); null when the
  // relief is compact (click-through) or absent. `support` is per href: null when the narrowphase covers it, else
  // readGlyphReport's reason (its instances are boxes that select terrain-unsupported); `instances` counts icons.
  relief: {
    group: Element;
    icons: ReliefSprite[];
    support: Map<string, { reason: string | null; instances: number }>;
  } | null;
  // owns the cropped canonical bitmap textures (null without canonical bitmaps); disposed by release()
  windows: BitmapWindows | null;
  cpuBytes: number;
  tessellation: MeshStats;
  release(): void;
}

interface Graph {
  cells: { i: ArrayLike<number>; v: number[][] };
  vertices: { p: [number, number][] };
}
const globals = globalThis as unknown as { grid?: Graph; pack?: Graph };
const ignoredRoot = new Set(["defs", "style", "title", "desc", "metadata", "script"]);

const mat3 = (m: ArrayLike<number>) => new Float32Array([m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]);

function cellRings(): Subpath[] {
  // grid/pack are `var`s (window properties); `customization` is a top-level `let`, readable only as a bare global
  const graph = typeof customization === "number" && customization === 1 ? globals.grid : globals.pack;
  if (!graph?.cells?.v || !graph.vertices?.p) return [];
  const rings: Subpath[] = [];
  for (let i = 0; i < graph.cells.i.length; i++) {
    const vertices = graph.cells.v[graph.cells.i[i]];
    if (!vertices || vertices.length < 3) continue;
    const points: number[] = [];
    for (const v of vertices) {
      const p = graph.vertices.p[v];
      if (p) points.push(p[0], p[1]);
    }
    rings.push({ points, closed: true });
  }
  return rings;
}

// The compat rasters do not fit the memory caps. Beside a previous frame this may be only the old+new swap peak.
export class BudgetError extends Error {}

export async function prepareFrame(svg: SVGSVGElement, ctx: PrepareContext): Promise<Prepared | null> {
  const { device } = ctx;
  const picking = ctx.picking !== false;
  const viewbox = svg.querySelector("#viewbox");
  if (!viewbox) throw new Error("missing #viewbox");
  const scene = sceneFor(viewbox, ctx);
  const textures: TrackedTexture[] = [];
  const buffers: TrackedBuffer[] = [];
  const windows = new BitmapWindows(device, 640, WINDOW_BUDGET);
  // Screen overlay textures are owned by their slot (refreshOverlays swaps them in place), everything else by `textures`.
  const release = () => {
    for (const resource of [...textures, ...buffers]) device.release(resource);
    releaseRuns(runs, device);
    textures.length = buffers.length = 0;
    windows.dispose();
  };
  const fans = new F32(1 << 16);
  const tessellation = newMeshStats();
  const segments = new F32(1 << 16);
  const caps = new F32(1 << 14);
  const sprites = new F32(1 << 10);
  const glyphs: Float32Array[] = [];
  let glyphCount = 0;
  const pick = new PickIndex(ctx.world.width, ctx.world.height);
  let relief: Prepared["relief"] = null;
  const runs: CompatRun[] = [];
  const reasons: string[] = [];
  const tiles = new Map<string, FillBatch["tile"] | string>();
  // the synchronous draw conversion yields every SLICE_MS so a 100k-element world does not block input for seconds
  const slice = createSlicer();

  // `layer` is null for screen overlays: they sit outside the world and are not pickable
  const compat = (element: Element, reason: string, out: Batch[], layer: string | null, screen = false, shapes?: HitShape[]) => {
    if (reasons.length < 16 && !reasons.includes(reason)) reasons.push(reason);
    if (picking && layer !== null)
      for (const shape of shapes ?? compatShapes(element as unknown as CompatRoot, viewbox as SVGGraphicsElement))
        pick.addShape(layer, shape);
    const last = runs[runs.length - 1];
    // world runs merge while adjacent; each screen root keeps its own alpha-cropped raster (corner controls would
    // otherwise share one viewport-sized texture)
    const sharp = SHARP_COMPAT.has(reason) || element.tagName === "text";
    if (last && !screen && !last.screen && out[out.length - 1] === last.slot) {
      last.sharp ||= sharp;
      return void last.elements.push(element);
    }
    const slot: ImageBatch = { kind: "image", texture: null, rect: [0, 0, 0, 0], screen, detail: null };
    runs.push({ slot, elements: [element], screen, sharp });
    out.push(slot);
  };

  // Scene classification is provisional: asynchronous glyph/pattern preparation can still require compatibility.
  // Report the final lane instead of claiming candidates that were never submitted as native geometry.
  const nativeFallback = (draw: Draw, reason: string, out: Batch[]) => {
    const layer = scene.layers[draw.layer];
    layer.native--;
    layer.compat++;
    if (!layer.reasons.includes(reason)) layer.reasons.push(reason);
    compat(draw.element, reason, out, draw.layer);
  };

  const fill = (subpaths: Subpath[], evenOdd: boolean): FillBatch => {
    const first = fans.length / 2;
    return {
      kind: "fill",
      first,
      count: appendStencilMeshes(subpaths, fans, tessellation),
      color: null,
      tile: null,
      evenOdd,
      bounds: pathBounds(subpaths)
    };
  };

  const stroke = (
    subpaths: Subpath[],
    style: Pick<ShapeStyle, "stroke" | "width" | "dashes" | "dashOffset" | "lineJoin" | "lineCap">
  ) => {
    const dashes = normalizeDashes(style.dashes);
    if (dashes.length > 8) return null;
    const first = segments.length / 5;
    const count = appendSegments(subpaths, segments);
    appendStrokeCaps(subpaths, caps, style.lineJoin, style.lineCap);
    const batch: StrokeBatch = {
      kind: "stroke",
      first,
      count,
      color: style.stroke!,
      width: style.width,
      dashes: new Float32Array(8),
      dashCount: dashes.length,
      dashPeriod: dashes.reduce((sum, value) => sum + value, 0),
      dashOffset: style.dashOffset,
      dashCap: capCode(style.lineCap),
      bounds: pathBounds(subpaths, Math.max(0, style.width) * 2)
    };
    batch.dashes.set(dashes);
    return batch;
  };

  const tile = async (id: string): Promise<FillBatch["tile"] | string> => {
    const key = `${id}@${ctx.bucket}`;
    if (!tiles.has(key)) {
      const pattern = svg.ownerDocument.getElementById(id);
      const result = pattern ? await rasterizePattern(pattern, ctx.bucket) : `missing pattern #${id}`;
      if (typeof result === "string") tiles.set(key, result);
      else {
        const texture = device.texture(`pattern ${id}`, result.canvas, { repeat: true });
        textures.push(texture);
        tiles.set(key, { texture, worldToUv: mat3(result.worldToUv), referenceZoom: result.referenceZoom });
      }
    }
    return tiles.get(key)!;
  };

  const convert = async (draws: Draw[], out: Batch[]): Promise<boolean> => {
    // CSS px per world unit at prepare time; sets dashed-stroke chord tolerance (0.5 / scale), see dash-measure.ts
    const viewScale = picking ? viewScaleOf(viewbox as SVGGraphicsElement) : 1;
    const positions = new Map<Element, Map<Element, number>>();
    for (const draw of draws) {
      await slice.tick(); // a superseded job is caught by the check below, right after the yield
      if (ctx.stale()) return false;
      const id = picking ? pickId(draw.element) : "";
      const depth = picking ? pickDepth(draw.element) : 0;
      const path = depth ? leafPath(draw.element, depth, positions) : null;
      if (draw.kind === "shape") {
        const { style, subpaths } = draw;
        const pending: Batch[] = [];
        // Hit areas follow the element's computed pointer-events (stylesheet rules such as #regions { none }), read
        // once at prepare time; the painted style alone would index click-through layers above selectable ones.
        const view = draw.element.ownerDocument.defaultView;
        const hits = !picking ? null : view ? sensitivity(view.getComputedStyle(draw.element)) : { fill: true, stroke: true, box: false };
        // Hit geometry is flattened at the compat pick tolerance, not the paint tolerance: a 0.2-unit chord error is
        // comparable to a thin route's half width (dashed strokes: see strokeHitRings).
        let hitPaths: Subpath[] | null = null;
        const hitRings = () => (hitPaths ??= flattenPath(draw.d, PICK_TOLERANCE).filter(s => s.points.length >= 2));
        // dashed: the on-dashes themselves are the rings (open, capped), so the pick's own dash pass is off
        const dashed = normalizeDashes(style.dashes).length > 0;
        const dashRings = () => dashHitRings(draw.d, style.dashes, style.dashOffset, viewScale);
        const strokeRings = () => strokeHitRings(dashed ? dashRings : null, hitRings);
        if (style.fill || style.pattern) {
          const batch = fill(subpaths, style.evenOdd);
          if (style.pattern) {
            const result = await tile(style.pattern);
            if (typeof result === "string") {
              nativeFallback(draw, result, out);
              continue;
            }
            batch.tile = result;
          } else batch.color = style.fill;
          pending.push(batch);
          if (hits?.fill)
            pick.setDepth(pick.addFill(draw.layer, id, hitRings().map(s => s.points), style.evenOdd), depth, path);
        }
        if (style.stroke) {
          const batch = stroke(subpaths, style);
          if (!batch) {
            nativeFallback(draw, "dash pattern > 8", out);
            continue;
          }
          pending.push(batch);
          if (hits?.stroke) {
            const rings = strokeRings();
            const index = pick.addStroke(
              draw.layer,
              id,
              rings.map(s => s.points),
              rings.map(s => s.closed),
              style.width / 2,
              dashed
                ? { dashes: [], dashOffset: 0, lineCap: style.lineCap ?? "butt" }
                : { dashes: style.dashes, dashOffset: style.dashOffset, lineCap: style.lineCap ?? "butt" }
            );
            pick.setDepth(index, depth, path);
          }
        }
        out.push(...pending);
      } else if (draw.kind === "cells") {
        const batch = stroke(cellRings(), { stroke: draw.stroke, width: draw.width, dashes: [], dashOffset: 0 });
        if (batch?.count) out.push(batch);
      } else if (draw.kind === "cachedPaths") {
        const image = await cachedReliefImage(draw.element, device.maxTextureSize);
        if (ctx.stale()) return false;
        const rect: ImageBatch["rect"] = [
          Number(draw.element.getAttribute("x") || 0),
          Number(draw.element.getAttribute("y") || 0),
          Number(draw.element.getAttribute("width")),
          Number(draw.element.getAttribute("height"))
        ];
        if (!image || !rect.every(Number.isFinite) || rect[2] <= 0 || rect[3] <= 0)
          throw new Error("Canonical path bitmap unavailable");
        // displays the canonical PNG (viewport crops). SVG hit testing sees that <image>, not its retained vectors
        // (they are an attribute, not DOM): pointer-events="none" (path-layer-canvas) makes the layer click-through,
        // otherwise the image rect is the hit area. The vectors are not hit regions in either case.
        out.push(windows.add(image, meetImageRect(rect, image.naturalWidth, image.naturalHeight), draw.opacity));
        if (picking && rasterHits(draw.element)) {
          const [x, y, w, h] = rect;
          pick.setDepth(pick.addBox(draw.layer, id, [x, y, x + w, y, x + w, y + h, x, y + h]), depth, path);
        }
      } else if (draw.kind === "relief") {
        // The compact raster is pointer-events="none" (relief-canvas.ts): SVG clicks pass through it to the layers
        // below and then to clicked()'s pickBurg/pickRelief fallbacks, so its sprites are not hit regions.
        // Materialized glyphs (#terrain > <use>, icons[k] = children[k]) are hit by SVG: each sprite box is the
        // broadphase of instance k and the symbol's painted primitives its narrowphase (relief-pick.ts). A symbol
        // outside the supported subset keeps its whole box as hit area (no narrowphase); its instance k is still
        // recorded for diagnostics, and the renderer never resolves it to a target, so selection reports it
        // terrain-unsupported with the href's reason.
        const sensitive = picking && rasterHits(draw.element);
        const materialized = draw.element.tagName.toLowerCase() === "g";
        const id = picking ? pickId(draw.element) : "";
        const glyphs = new Map<string, GlyphHits | null>();
        const support: NonNullable<Prepared["relief"]>["support"] = new Map();
        if (sensitive && materialized) relief = { group: draw.element, icons: draw.icons, support };
        const addHit = (icon: (typeof draw.icons)[number], k: number) => {
          if (!sensitive) return;
          const { x, y, s } = icon;
          const box = [x, y, x + s, y, x + s, y + s, x, y + s];
          if (!materialized) {
            pick.addBox(draw.layer, id, box);
            return;
          }
          if (!glyphs.has(icon.i)) {
            const read = readGlyphReport(draw.element, icon.i);
            glyphs.set(icon.i, read.glyph);
            support.set(icon.i, { reason: read.reason, instances: 0 });
          }
          support.get(icon.i)!.instances++;
          const glyph = glyphs.get(icon.i);
          pick.addInstance(draw.layer, id, box, k, glyph ? (px, py, t) => glyphCovers(glyph, icon, px, py, t) : null);
        };
        const addHits = () => draw.icons.forEach(addHit);
        const cached = await cachedReliefImage(draw.element, device.maxTextureSize);
        if (ctx.stale()) return false;
        const width = Number(draw.element.getAttribute("width"));
        const height = Number(draw.element.getAttribute("height"));
        if (cached && width > 0 && height > 0) {
          const slot = windows.add(
            cached,
            meetImageRect(
              [Number(draw.element.getAttribute("x") || 0), Number(draw.element.getAttribute("y") || 0), width, height],
              cached.naturalWidth,
              cached.naturalHeight
            )
          );
          const viewport = draw.element.parentElement?.querySelector("image[data-relief-viewport]");
          if (viewport) {
            const detail = await cachedReliefImage(viewport, device.maxTextureSize);
            if (ctx.stale()) return false;
            const rect: ImageBatch["rect"] = [
              Number(viewport.getAttribute("x")),
              Number(viewport.getAttribute("y")),
              Number(viewport.getAttribute("width")),
              Number(viewport.getAttribute("height"))
            ];
            if (detail && rect.every(Number.isFinite) && rect[2] > 0 && rect[3] > 0) {
              const sharper = device.texture("canonical relief viewport", detail);
              textures.push(sharper);
              slot.detail = {
                texture: sharper,
                rect: meetImageRect(rect, detail.naturalWidth, detail.naturalHeight),
                covers: rect
              };
            }
          }
          scene.layers[draw.layer].source = "canonical-raster-cache";
          addHits();
          out.push(slot);
          continue;
        }
        scene.layers[draw.layer].source = "instanced-atlas";
        const ids = [...new Set(draw.icons.map(icon => icon.i))];
        const largest = draw.icons.reduce((max, icon) => Math.max(max, icon.s), 0);
        const atlas = await buildReliefAtlas(ids, device.maxTextureSize, Math.max(64, reliefCell(largest, ctx.bucket)));
        if (ctx.stale()) return false;
        if (atlas.failed.length) {
          compat(draw.element, "relief sprite decode", out, draw.layer);
          continue;
        }
        // cells are 1-2× the on-screen icon size at this bucket: plain linear sampling, no trilinear mip blur
        const texture = device.texture("relief atlas", atlas.canvas, { mipmap: true });
        device.gl.bindTexture(device.gl.TEXTURE_2D, texture.handle);
        device.gl.texParameteri(device.gl.TEXTURE_2D, device.gl.TEXTURE_MIN_FILTER, device.gl.LINEAR_MIPMAP_LINEAR);
        textures.push(texture);
        const first = sprites.length / 7;
        draw.icons.forEach((icon, k) => {
          const [u0, v0, u1, v1] = atlas.uv.get(icon.i)!;
          sprites.push5(icon.x, icon.y, icon.s, u0, v0);
          sprites.push2(u1, v1);
          addHit(icon, k);
        });
        out.push({ kind: "sprites", first, count: draw.icons.length, texture });
      } else if (draw.kind === "label") {
        const batch = await layoutLabels([draw.element], ctx.bucket, ctx.atlas);
        if (ctx.stale()) return false;
        if (batch.failed.length) {
          nativeFallback(draw, `label ${batch.failed[0].reason}`, out);
          continue;
        }
        // hit areas are the DOM text's character cells (SVG hit testing), not the glyph-ink quads painted here
        if (picking) for (const shape of compatShapes(draw.element as unknown as CompatRoot, viewbox as SVGGraphicsElement))
          pick.addShape(draw.layer, shape);
        glyphs.push(batch.instances);
        const last = out[out.length - 1];
        // consecutive labels share one instanced draw; DOM order is preserved because nothing sits between them
        if (last?.kind === "glyphs" && last.first + last.count === glyphCount) last.count += batch.count;
        else out.push({ kind: "glyphs", first: glyphCount, count: batch.count });
        glyphCount += batch.count;
      } else if (draw.kind === "group") {
        const children: Batch[] = [];
        if (!(await convert(draw.children, children))) return false;
        const mask = draw.mask?.flatMap(item =>
          item.kind === "shape"
            ? [{ fill: fill(item.subpaths, item.style.evenOdd), white: item.style.fill?.[0] === 1 }]
            : []
        );
        out.push({ kind: "group", opacity: draw.opacity, mask: mask ?? null, children });
      } else if (draw.kind === "trade") {
        if (draw.unsupported) throw new Error(`trade layer ${draw.unsupported} unsupported on GPU markers`);
        // static siblings first, then the live marker slot (instances are supplied per frame)
        const children: Batch[] = [];
        if (!(await convert(draw.children, children))) return false;
        children.push({ kind: "markers" });
        if (draw.opacity < 1) out.push({ kind: "group", opacity: draw.opacity, mask: null, children });
        else out.push(...children);
      } else {
        const shapes = picking ? compatShapesBatch(draw.elements as unknown as CompatRoot[], viewbox as SVGGraphicsElement) : [];
        draw.elements.forEach((element, i) => compat(element, draw.reason, out, draw.layer, false, shapes[i]));
      }
    }
    return true;
  };

  try {
    const before: Batch[] = [];
    const after: Batch[] = [];
    let seen = false;
    for (const child of svg.children) {
      if (child === viewbox) seen = true;
      else if (!ignoredRoot.has(child.tagName) && getComputedStyle(child).display !== "none") {
        compat(child, "screen overlay", seen ? after : before, null, true);
        if (picking && seen) runs[runs.length - 1].hits = overlayShapes(child, svg);
      }
    }
    const batches: Batch[] = [];
    if (!(await convert(scene.draws, batches))) {
      release();
      return null;
    }
    ctx.mark?.("scene");

    // Still to upload after the compat rasters: glyph atlas and vertex data (≈ CPU arrays).
    const glyphBytes = glyphCount ? ctx.atlas.canvas.width * ctx.atlas.canvas.height * 4 : 0;
    const vertexBytes = (fans.length + segments.length + caps.length + sprites.length + glyphCount * GLYPH_FLOATS) * 4;
    const pending = glyphBytes + vertexBytes;
    const owned = () => textures.reduce((sum, texture) => sum + texture.bytes, 0) + windows.bytes;

    const worldRuns = runs.filter(run => !run.screen);
    let resolution = compatResolution(worldRuns.length, ctx.world, 2, device.maxTextureSize);
    const mib = (bytes: number) => `${(bytes / 2 ** 20).toFixed(1)} MiB`;
    const held: { run: CompatRun; canvas: HTMLCanvasElement; rect: Region }[] = [];
    const sum = (screen: boolean) =>
      held.reduce((n, item) => (item.run.screen === screen ? n + item.canvas.width * item.canvas.height * 4 : n), 0);
    const clone = runs.length ? await compatClone(ctx.revision) : null;
    ctx.mark?.("clone");
    const rasterize = async (run: CompatRun): Promise<boolean> => {
      const resolved = resolveManyInClone(run.elements, clone!);
      const missing = resolved.find(item => typeof item === "string");
      if (missing) {
        const i = resolved.indexOf(missing);
        const e = run.elements[i];
        throw new Error(
          `compat: ${missing} for <${e.tagName}> #${e.id} parent #${e.parentElement?.id} attrs ${e.getAttributeNames().join(",")} source siblings ${[...(e.parentElement?.children || [])].map(c => c.tagName).join(",")} clone siblings ${[...(clone!.querySelector(`#${CSS.escape(e.parentElement?.id || "")}`)?.children || [])].map(c => c.tagName).join(",")}`
        );
      }
      const region = run.screen ? { x: 0, y: 0, ...ctx.screen } : ctx.world;
      const ratio = run.screen ? ctx.screen.dpr : resolution;
      const [w, h] = [Math.max(1, Math.round(region.width * ratio)), Math.max(1, Math.round(region.height * ratio))];
      const canvas = await rasterizeRun(clone!, resolved as Element[], region, w, h, run.screen);
      if (ctx.stale()) return false;
      const cropped = cropRaster(canvas, region);
      if (cropped) held.push({ run, ...cropped }); // fully transparent: slot keeps texture null and draws nothing
      return true;
    };
    // Screen overlays first (fixed size at the screen DPR): their bytes are known before the window crops take room.
    for (const run of runs) {
      if (!run.screen) continue;
      if (ctx.stale() || !(await rasterize(run))) {
        release();
        return null;
      }
    }
    ctx.mark?.("screen");

    // Initial crops for the snapshot camera, before the compat budget so their actual bytes count. They leave the
    // screen overlays plus MIN_COMPAT_BUDGET for world rasters, within both the steady share and the peak room beside
    // the previous frame. false without staleness means even the visible-only crop does not fit: the frame stays
    // uncovered and the renderer shows the SVG for that view instead of a frame missing its canonical bitmaps.
    if (windows.size) {
      const reserve = sum(true) + (worldRuns.length ? MIN_COMPAT_BUDGET : 0);
      const limit = compatAllowance(device.memory().total, owned(), pending + reserve);
      const committed = await windows.refresh(ctx.camera, ctx.screen, ctx.stale, limit);
      if (!committed && ctx.stale()) {
        release();
        return null;
      }
    }
    ctx.mark?.("windows");

    // This frame's compat share: the steady budget minus the group target reserve, what it already uploaded (bitmap
    // window crops included) and what is still pending, and never past the peak beside the previous frame. Over it,
    // world rasters shrink; a share too small for useful world rasters (or for the screen overlays) fails the
    // prepare, and the renderer shows the SVG.
    const budget = compatAllowance(device.memory().total, owned(), pending);
    if (budget < sum(true)) throw new BudgetError(`compat: screen overlays need ${mib(sum(true))}, ${mib(budget)} fits`);
    if (runs.length) {
      for (const run of runs) {
        if (run.screen) continue;
        if (ctx.stale() || !(await rasterize(run))) {
          release();
          return null;
        }
        const worldRoom = budget - sum(true);
        const scale = fitScale(sum(false), worldRoom);
        if (scale < 1 && worldRoom < MIN_COMPAT_BUDGET)
          throw new BudgetError(`compat: world rasters need ${mib(sum(false))}, ${mib(worldRoom)} fits the GPU budget`);
        if (scale < 1) {
          for (const item of held) if (!item.run.screen) item.canvas = scaleRaster(item.canvas, scale);
          resolution *= scale;
        }
      }
      for (const { run, canvas, rect } of held) {
        run.slot.texture = device.texture(run.screen ? "compat screen" : "compat world", canvas);
        if (!run.screen) textures.push(run.slot.texture);
        run.slot.rect = [rect.x, rect.y, rect.width, rect.height];
        canvas.width = canvas.height = 0;
      }
    }
    ctx.mark?.("world");

    const upload =(label: string, data: F32 | Float32Array, length: number) => {
      if (!length) return null;
      const buffer = device.buffer(label, data instanceof F32 ? data.view() : data);
      buffers.push(buffer);
      return buffer;
    };
    const glyphData = new Float32Array(glyphCount * GLYPH_FLOATS);
    let offset = 0;
    for (const chunk of glyphs) {
      glyphData.set(chunk, offset);
      offset += chunk.length;
    }
    let atlas: TrackedTexture | null = null;
    if (glyphCount) {
      atlas = device.texture("glyph atlas", ctx.atlas.canvas);
      textures.push(atlas);
    }
    const frame: Frame = {
      batches: [...before, ...batches, ...after],
      fans: upload("fans", fans, fans.length),
      segments: upload("segments", segments, segments.length),
      caps: upload("stroke caps", caps, caps.length),
      sprites: upload("sprites", sprites, sprites.length),
      glyphs: upload("glyphs", glyphData, glyphData.length),
      atlas
    };
    ctx.mark?.("buffers");
    const atlasBytes = ctx.atlas.canvas.width * ctx.atlas.canvas.height * 4; // CPU glyph canvas, counted once here
    const overlays = indexOverlays(runs, ctx.screen);
    return {
      frame,
      picking,
      pick,
      bucket: ctx.bucket,
      revision: ctx.revision,
      layers: scene.layers,
      compat: { runs: runs.length, elements: runs.reduce((n, run) => n + run.elements.length, 0), reasons, resolution },
      runs,
      overlays,
      relief,
      windows: windows.size ? windows : null,
      // retained CPU memory: pick index and glyph atlas canvas (vertex arrays are dropped after upload)
      cpuBytes: pick.bytes() + overlays.bytes() + atlasBytes,
      tessellation,
      release
    };
  } catch (error) {
    release();
    throw error;
  }
}

// Settle-time sharper raster of world compat runs for the visible region at backing resolution, alpha-cropped and kept
// within GPU_BUDGET (tracked total, so the base frame and target count). Returns false when stale, over budget or
// nothing to refine. Each slot draws its detail only while the view stays inside `covers`, else its base texture.
export async function refineCompat(
  prepared: Prepared,
  ctx: PrepareContext,
  visible: Region,
  pixels: { width: number; height: number },
  budget = GPU_BUDGET
): Promise<boolean> {
  const world = prepared.runs.filter(run => !run.screen && run.slot.texture);
  if (!world.length) return false;
  // Sharp runs, then smallest visible footprint first (see refineOrder); every previous detail is released before any
  // room is measured, so a stale detail of a later run never counts against an earlier one.
  const order = refineOrder(
    world.map(run => run.slot.rect),
    visible,
    world.map(run => run.sharp)
  );
  const runs = order.map(index => world[index]);
  for (const run of runs) {
    ctx.device.release(run.slot.detail?.texture);
    run.slot.detail = null;
  }
  const covers: [number, number, number, number] = [visible.x, visible.y, visible.width, visible.height];
  const clone = await compatClone(ctx.revision);
  const density = pixels.width / visible.width;
  const report: { id: string; density: number }[] = [];
  prepared.compat.detail = report;
  let refined = false;
  for (const run of runs) {
    const element = run.elements[0];
    const entry = { id: element.id || `${element.parentElement?.id ?? ""}>${element.tagName}`, density: prepared.compat.resolution };
    report.push(entry);
    if (ctx.stale()) return false;
    const resolved = resolveManyInClone(run.elements, clone);
    if (resolved.some(item => typeof item === "string")) return false;
    const canvas = await rasterizeRun(clone, resolved as Element[], visible, pixels.width, pixels.height, false);
    if (ctx.stale()) return false;
    let cropped = cropRaster(canvas, visible);
    // Check the alpha-cropped allocation, not a hypothetical full viewport. Sparse labels and markers can fit
    // even when an uncropped viewport would exceed the budget. A run that cannot fit is downscaled into the remaining
    // headroom while that still beats the base raster's density, else it keeps the base.
    const bytes = cropped ? cropped.canvas.width * cropped.canvas.height * 4 : 0;
    const room = budget - ctx.device.memory().total;
    if (cropped && bytes > room) {
      const fit = Math.sqrt(Math.max(0, room) / bytes);
      const sharper = density * fit > prepared.compat.resolution;
      const scaled = sharper ? scaleCanvas(cropped.canvas, fit) : null;
      cropped.canvas.width = cropped.canvas.height = 0;
      if (!scaled) continue;
      cropped = { canvas: scaled, rect: cropped.rect };
      entry.density = density * fit;
    } else entry.density = density;
    refined = true;
    if (!cropped) run.slot.detail = { texture: null, rect: covers, covers };
    else {
      const { x, y, width, height } = cropped.rect;
      const texture = ctx.device.texture("compat detail", cropped.canvas);
      run.slot.detail = { texture, rect: [x, y, width, height], covers };
      cropped.canvas.width = cropped.canvas.height = 0;
    }
  }
  return refined;
}

// Floors both sides so the scaled bytes never exceed `fit²` of the source; null when nothing would remain.
function scaleCanvas(source: HTMLCanvasElement, fit: number): HTMLCanvasElement | null {
  const width = Math.floor(source.width * fit);
  const height = Math.floor(source.height * fit);
  if (width < 1 || height < 1) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

// Overlay content the export clone rewrites or inlines beyond styles (dense zoom, culling, images): refresh by prepare.
const OVERLAY_UNSUPPORTED = "[data-dense-zoom], .viewport-culled, image, foreignObject";
const reference = /url\(\s*["']?#([^"')\s]+)/g;

// Brings one live screen overlay into the cached export clone as prepareMapClone would have: a deep copy styled by
// a mirror of export.ts inlineStyle (computed under a host with the clone root's attributes, so the same CSS
// applies). null when the copy needs more than that or references a def the clone pruned or lacks.
function overlayCopy(live: Element, clone: SVGSVGElement): Element | null {
  const copy = live.cloneNode(true) as Element;
  if (copy.matches(OVERLAY_UNSUPPORTED) || copy.querySelector(OVERLAY_UNSUPPORTED)) return null;
  const host = clone.cloneNode(false) as SVGSVGElement;
  host.appendChild(copy);
  document.body.appendChild(host);
  try {
    const empty = host.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "g"));
    const defaults = getComputedStyle(empty);
    for (const element of [copy, ...copy.querySelectorAll("*")]) {
      if (!element.matches("g, #ruler *, #scaleBar > text")) continue;
      const computed = getComputedStyle(element);
      let style = "";
      const add = (key: string) => {
        const value = computed.getPropertyValue(key);
        if (key === "cursor" || element.hasAttribute(key) || value === defaults.getPropertyValue(key)) return;
        style += `${key}:${value};`;
      };
      for (let i = 0; i < computed.length; i++) add(computed[i]);
      for (const key in computed) add(key);
      if (style !== "") element.setAttribute("style", style);
    }
    empty.remove();
  } finally {
    host.remove();
  }
  for (const element of [copy, ...copy.querySelectorAll("*")])
    for (const name of element.getAttributeNames()) {
      const value = element.getAttribute(name) || "";
      const ids = [...value.matchAll(reference)].map(match => match[1]);
      if (/^(xlink:)?href$/.test(name) && value.startsWith("#")) ids.push(value.slice(1));
      if (ids.some(id => !clone.querySelector(`#${CSS.escape(id)}`))) return null;
    }
  return copy;
}

export type OverlayRefresh = "committed" | "stale" | "full";

// Screen-overlay lane: a change inside a root overlay (e.g. a #scaleBar redraw) re-rasterizes only that prepared
// compat screen batch, in place, and swaps its slot texture; painter order, opacity and the rest of the frame are
// untouched. The cached export clone is updated too so later rasters at this revision agree. Every new texture is
// uploaded before any old one is released and only after the last staleness check, within windowAllowance (old+new
// swap peak, steady budget once the old set is gone). "full" asks the caller for a full prepare instead: the overlay
// is new, hidden, unsupported or over budget.
export async function refreshOverlays(prepared: Prepared, ctx: PrepareContext, roots: Element[]): Promise<OverlayRefresh> {
  const runs: CompatRun[] = [];
  for (const root of roots) {
    const run = prepared.runs.find(item => item.screen && item.elements[0] === root);
    if (!run || !root.isConnected || getComputedStyle(root).display === "none") return "full";
    runs.push(run);
  }
  if (!runs.length) return "committed";
  const clone = await compatClone(ctx.revision);
  if (ctx.stale()) return "stale";
  // every copy is resolved before any is swapped in, so a "full" exit leaves the clone as it was
  const swaps: [Element, Element][] = [];
  for (const run of runs) {
    const copy = overlayCopy(run.elements[0], clone);
    const target = copy && resolveInClone(run.elements[0], clone);
    if (!target || typeof target === "string") return "full";
    swaps.push([target, copy]);
  }
  for (const [target, copy] of swaps) target.replaceWith(copy);
  // hit areas read from the live roots in the same task the clone copies were taken, committed with the rasters
  const hits = runs.map(run => {
    const root = run.elements[0];
    return prepared.picking !== false && run.hits && root.parentElement instanceof SVGSVGElement
      ? overlayShapes(root, root.parentElement) : run.hits;
  });
  const region = { x: 0, y: 0, ...ctx.screen };
  const [w, h] = [Math.max(1, Math.round(region.width * region.dpr)), Math.max(1, Math.round(region.height * region.dpr))];
  const held: { run: CompatRun; cropped: ReturnType<typeof cropRaster> }[] = [];
  try {
    for (const run of runs) {
      const resolved = resolveInClone(run.elements[0], clone);
      if (typeof resolved === "string") return "full";
      const canvas = await rasterizeRun(clone, [resolved], region, w, h, true);
      const cropped = ctx.stale() ? null : cropRaster(canvas, region);
      if (canvas !== cropped?.canvas) canvas.width = canvas.height = 0;
      held.push({ run, cropped });
      if (ctx.stale()) return "stale";
    }
    const { device } = ctx;
    const old = runs.reduce((n, run) => n + (run.slot.texture?.bytes ?? 0), 0);
    const bytes = held.reduce((n, { cropped }) => n + (cropped ? cropped.canvas.width * cropped.canvas.height * 4 : 0), 0);
    if (bytes > windowAllowance(device.memory().total, old)) return "full";
    const textures = uploadAll(held, ({ cropped }) => cropped && device.texture("compat screen", cropped.canvas), device);
    swapOverlays(
      held.map(({ run, cropped }, i) => ({
        run,
        texture: textures[i],
        rect: cropped && ([cropped.rect.x, cropped.rect.y, cropped.rect.width, cropped.rect.height] as ImageBatch["rect"])
      })),
      device
    );
    runs.forEach((run, i) => (run.hits = hits[i]));
    prepared.overlays = indexOverlays(prepared.runs, ctx.screen);
  } finally {
    // the canvases are copied into textures (or abandoned); free their backing stores on every exit
    for (const { cropped } of held) if (cropped) cropped.canvas.width = cropped.canvas.height = 0;
  }
  return "committed";
}

export const hasDetail = (prepared: Prepared) => prepared.runs.some(run => run.slot.detail?.texture);

export function releaseDetail(prepared: Prepared, device: GpuDevice): void {
  for (const run of prepared.runs)
    if (run.slot.detail) {
      device.release(run.slot.detail.texture);
      run.slot.detail = null;
    }
}
