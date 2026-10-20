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
  LADDER_HEADROOM,
  LADDER_STEPS,
  ladderFit,
  ladderScale,
  ladderStart,
  type Region,
  rasterizeRun,
  resolveInClone,
  scaleRaster,
  stampedClone
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
  sensitivity,
  strokeHitRings,
  resScale as viewScaleOf
} from "./compat-pick";
import {
  compatDirt,
  documentStyle,
  externalReference,
  releaseShared,
  retain,
  type StyleState,
  sharedReleaser
} from "./compat-reuse";
import type { GpuDevice, TextureSource, TrackedBuffer, TrackedTexture } from "./device";
import type { Batch, FillBatch, Frame, ImageBatch, StrokeBatch } from "./framegraph";
import {
  appendFillEdges,
  appendSegments,
  appendStrokeCaps,
  capCode,
  F32,
  hasSharedSegments,
  mayWindDeep,
  normalizeDashes,
  pathBounds
} from "./geometry";
import { appendStencilMeshes, type MeshStats, newMeshStats } from "./mesh";
import { indexOverlays, releaseRuns, swapOverlays, uploadAll } from "./overlays";
import { type HitShape, leafPath, PickIndex } from "./pick";
import { buildReliefAtlas, cachedReliefImage, meetImageRect, rasterizePattern } from "./raster";
import { type GlyphHits, glyphCovers, readGlyphReport } from "./relief-pick";
import type { PrepareStep } from "./restore-phases";
import { buildScene, type Draw, type LayerReport, type Scene, type ShapeStyle } from "./scene";
import { cloneLayers, type SceneCache, type SceneKey } from "./scene-cache";
import { createSlicer, slicePolicy } from "./slice";
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
  // the frame on screen: clean compat runs reuse its rasters and settle details (compat-reuse.ts); absent: none
  previous?: Prepared | null;
  // the CPU payload of the frame a context loss destroyed (retainFrame): a restore at the same key re-uploads it
  // instead of walking and converting the scene again; absent or stale: a full prepare
  retained?: RetainedFrame | null;
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
  stamp: number; // reuse-tracker epoch of the DOM state its raster was cut from (compat-reuse.ts)
  key: string; // what else its raster depends on: world region, base resolution and bucket, or viewport size and DPR
  // its detail: the settle request it answers, the alpha-cropped size it was cut at (null: fully transparent) and the
  // downscale factor applied to fit the budget (1: none); replayed by refineCompat to keep it
  detailMeta?: { request: string; size: [number, number] | null; fit: number };
  // world run: the ladder level its raster is at (compat.ts ladderScale); a reused raster must be at the frame's level
  level?: number;
}

// Per-prepare compat reuse (telemetry). `reasons` counts dirty runs by why they were dirty (at most 8 distinct).
// worldClean/screenClean count runs the tracker found clean; they reused their raster only when `enabled`.
export interface CompatReuse {
  enabled: boolean;
  world: number;
  worldClean: number;
  worldKept: number; // clean world runs whose raster the frame kept (a step down the ladder re-cuts them)
  screen: number;
  screenClean: number;
  details: number; // settle details carried over from the previous frame
  cloned: boolean; // false: every run reused its raster and no export clone was cut
  aborted: string; // why clean world runs were re-cut (world rasters stepped down the ladder), "" otherwise
  structural: string; // the sibling-dependent stylesheet selector that widened invalidation, "" when none
  reasons: Record<string, number>;
  ms: number; // evaluation cost (style state, tracker, references)
  retained: boolean; // restored from a frame's retained CPU payload (retainFrame): no scene walk or conversion
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
    level: number; // world raster ladder level (resolution = base · ladderScale(level))
    // last settle refinement, in refine order: source id and drawn px per world unit (base resolution when kept)
    detail?: { id: string; density: number }[];
    reuse?: CompatReuse;
    // last settle refinement: details kept from an identical earlier request, details cut, export clone cut
    refine?: { kept: number; rasterized: number; cloned: boolean };
  };
  styleKey?: string; // stylesheet state its rasters were cut under (compat-reuse.ts styleState)
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
  // what retainFrame keeps across a context loss (B1 step 1): references only, the vertex arrays included. Kept even
  // with ?gpu-restore-retain=0 (read when a restore prepares): the restore bench switches arms in the page
  // (history.replaceState) without a new prepare, so a frame committed under the opt-out arm must still be retainable.
  payload: Payload;
  release(): void;
}

// ---- retention across context loss (research B1 step 1) -------------------------------------------------------
// A frame's CPU side survives a WebGL context loss; only its GPU objects die. A restore at the same revision, world,
// raster bucket, viewport and picking mode would rebuild an identical scene, conversion and pick index, so the payload
// keeps them (the batch tree, the vertex and glyph instance arrays, the sources of every texture the conversion made,
// the bitmap-window sources and the compat runs) and the restore only re-uploads them. Compat rasters are still cut
// again (from the export clone, cached per revision): their pixels are not retained (step 2).

interface PayloadKey {
  revision: number;
  worldEpoch: number | undefined;
  bucket: number;
  picking: boolean;
  world: string;
  screen: string;
  scale: number; // camera scale when picking: dashed-stroke hit rings follow it (dash-measure.ts)
  maxTexture: number; // relief atlas and canonical relief images are sized to the device limit (an adapter switch)
}

interface Recipe {
  label: string;
  source: TextureSource;
  options: { repeat?: boolean; mipmap?: boolean };
}

interface WindowSource {
  slot: ImageBatch;
  image: HTMLImageElement;
  rect: [number, number, number, number];
  opacity?: number;
  detail: ImageBatch["detail"]; // the relief viewport's sharper canonical image (a recipe texture), at commit
}

interface Payload {
  key: PayloadKey;
  layers: Record<string, LayerReport>;
  reasons: string[];
  pick: PickIndex;
  relief: Prepared["relief"];
  tessellation: MeshStats;
  batches: Batch[]; // the committed batch tree: its textures are matched to recipes, window slots and compat runs
  vertices: {
    fans: Float32Array;
    segments: Float32Array;
    caps: Float32Array;
    sprites: Float32Array;
    edges: Float32Array;
  };
  glyphs: Float32Array;
  glyphCount: number;
  // the glyph atlas canvas the instances index: the renderer's live atlas (the next prepare clears it), or the copy a
  // retained restore uploaded (owned by this payload)
  atlasCanvas: HTMLCanvasElement | null;
  atlasCopy: boolean;
  // the live atlas's generation (GlyphAtlas.clear bumps it) when this frame's glyphs were laid out in it
  atlasGeneration: number;
  recipes: Map<TrackedTexture, Recipe>;
  windows: WindowSource[];
}

export interface RetainedFrame extends Payload {
  runs: { slot: ImageBatch; elements: Element[]; screen: boolean; sharp: boolean; hits?: HitShape[] }[];
  atlas: HTMLCanvasElement | null; // a copy of the glyph atlas the frame's instances index
}

const payloadKey = (ctx: PrepareContext, picking: boolean): PayloadKey => ({
  revision: ctx.revision,
  worldEpoch: ctx.worldEpoch,
  bucket: ctx.bucket,
  picking,
  world: `${ctx.world.x},${ctx.world.y},${ctx.world.width},${ctx.world.height}`,
  screen: `${ctx.screen.width}x${ctx.screen.height}@${ctx.screen.dpr}`,
  scale: picking ? ctx.camera.k : 0,
  maxTexture: ctx.device.maxTextureSize
});

const sameKey = (a: PayloadKey, b: PayloadKey) =>
  (Object.keys(a) as (keyof PayloadKey)[]).every(key => a[key] === b[key]);

// Opt-out for the A/B (bench/host/restore-timing.ts): ?gpu-restore-retain=0 makes every restore a full prepare.
export function retainEnabled(): boolean {
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").get("gpu-restore-retain") !== "0";
  } catch {
    return true;
  }
}

const walk = (batches: Batch[], visit: (batch: Batch) => void) => {
  for (const batch of batches) {
    visit(batch);
    if (batch.kind === "group") {
      for (const item of batch.mask ?? []) visit(item.fill);
      walk(batch.children, visit);
    }
  }
};

// Every texture of the tree has a source and every image slot is a window or a compat run: rehydrate can rebuild it.
export function complete(retained: RetainedFrame): boolean {
  const slots = new Set<ImageBatch>([
    ...retained.windows.map(item => item.slot),
    ...retained.runs.map(run => run.slot)
  ]);
  let ok = true;
  walk(retained.batches, batch => {
    if (batch.kind === "fill" && batch.tile) ok &&= retained.recipes.has(batch.tile.texture);
    else if (batch.kind === "sprites") ok &&= retained.recipes.has(batch.texture);
    else if (batch.kind === "image") ok &&= slots.has(batch);
  });
  for (const item of retained.windows) if (item.detail?.texture) ok &&= retained.recipes.has(item.detail.texture);
  return ok;
}

// Re-uploads a retained frame's texture sources, re-adds its bitmap windows and gives its compat runs empty slots (the
// world loop cuts their rasters as usual); returns the runs and a copy of the batch tree that points at all of them.
export function rehydrate(
  retained: RetainedFrame,
  make: (label: string, source: TextureSource, options?: Recipe["options"]) => TrackedTexture,
  addWindow: (image: HTMLImageElement, rect: [number, number, number, number], opacity?: number) => ImageBatch
): { runs: CompatRun[]; batches: Batch[] } {
  const textures = new Map<TrackedTexture, TrackedTexture>();
  for (const [old, recipe] of retained.recipes) textures.set(old, make(recipe.label, recipe.source, recipe.options));
  const slots = new Map<ImageBatch, ImageBatch>();
  for (const item of retained.windows) {
    const slot = addWindow(item.image, item.rect, item.opacity);
    const detail = item.detail;
    if (detail?.texture)
      slot.detail = { texture: textures.get(detail.texture)!, rect: [...detail.rect], covers: [...detail.covers] };
    slots.set(item.slot, slot);
  }
  const runs = retained.runs.map(run => {
    const slot: ImageBatch = { kind: "image", texture: null, rect: [0, 0, 0, 0], screen: run.screen, detail: null };
    slots.set(run.slot, slot);
    return {
      slot,
      elements: [...run.elements],
      screen: run.screen,
      sharp: run.sharp,
      hits: run.hits,
      stamp: 0,
      key: ""
    };
  });
  const copy = (batch: Batch): Batch => {
    switch (batch.kind) {
      case "fill":
        return batch.tile
          ? { ...batch, tile: { ...batch.tile, texture: textures.get(batch.tile.texture)! } }
          : { ...batch };
      case "sprites":
        return { ...batch, texture: textures.get(batch.texture)! };
      case "image":
        return slots.get(batch)!;
      case "group":
        return {
          ...batch,
          mask: batch.mask?.map(item => ({ fill: copy(item.fill) as FillBatch, white: item.white })) ?? null,
          children: batch.children.map(copy)
        };
      default:
        return { ...batch };
    }
  };
  return { runs, batches: retained.batches.map(copy) };
}

// Called on context loss, before the frame is dropped, with the renderer's live glyph atlas. Its glyphs are the frame's
// only while no prepare has cleared it since the frame laid its labels out: every prepare clears it first, including
// one that is still in flight, was aborted (motion, suspend) or whose result was released, while the frame stays.
// A frame that was itself restored from a payload indexes that payload's own copy instead.
export function retainFrame(
  prepared: Prepared | null,
  live: Pick<GlyphAtlas, "canvas" | "generation">
): RetainedFrame | null {
  if (!prepared) return null;
  const { glyphCount, atlasCanvas, atlasCopy, atlasGeneration } = prepared.payload;
  let copy: HTMLCanvasElement | null = null;
  if (glyphCount && atlasCopy) copy = atlasCanvas;
  else if (glyphCount) {
    if (!atlasCanvas || atlasCanvas !== live.canvas || live.generation !== atlasGeneration) return null;
    copy = document.createElement("canvas");
    copy.width = atlasCanvas.width;
    copy.height = atlasCanvas.height;
    const context = copy.getContext("2d");
    if (!context) return null;
    context.drawImage(atlasCanvas, 0, 0);
  }
  return {
    ...prepared.payload,
    runs: prepared.runs.map(({ slot, elements, screen, sharp, hits }) => ({ slot, elements, screen, sharp, hits })),
    atlas: copy
  };
}

interface Graph {
  cells: { i: ArrayLike<number>; v: number[][] };
  vertices: { p: [number, number][] };
}
const globals = globalThis as unknown as { grid?: Graph; pack?: Graph };
const ignoredRoot = new Set(["defs", "style", "title", "desc", "metadata", "script"]);

const mat3 = (m: ArrayLike<number>) => new Float32Array([m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]);

// The rings of the last mesh, keyed by the canonical mesh image's href: cell-mesh-canvas.ts re-encodes it exactly when
// the geometry key (every vertex index and coordinate bit) or the stroke changes, so an unchanged href is an unchanged
// mesh. 100k cells cost a full ring walk per prepare otherwise.
let ringCache: { key: string; graph: Graph; rings: Subpath[] } | null = null;

export function cellRings(key = ""): Subpath[] {
  // grid/pack are `var`s (window properties); `customization` is a top-level `let`, readable only as a bare global
  const graph = typeof customization === "number" && customization === 1 ? globals.grid : globals.pack;
  if (!graph?.cells?.v || !graph.vertices?.p) return [];
  if (key && ringCache?.key === key && ringCache.graph === graph) return ringCache.rings;
  const rings = walkRings(graph);
  ringCache = key ? { key, graph, rings } : null;
  return rings;
}

function walkRings(graph: Graph): Subpath[] {
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
  const payloadAt = payloadKey(ctx, picking);
  // the generation this prepare lays labels out at; a clear while it runs makes the frame's atlas unretainable
  const atlasGeneration = ctx.atlas.generation;
  const retained =
    ctx.retained && retainEnabled() && sameKey(ctx.retained.key, payloadAt) && complete(ctx.retained)
      ? ctx.retained
      : null;
  // a retained restore converts nothing: its scene is the payload's layer reports
  const scene: Scene = retained ? { draws: [], layers: cloneLayers(retained.layers) } : sceneFor(viewbox, ctx);
  const textures: TrackedTexture[] = [];
  const buffers: TrackedBuffer[] = [];
  const windows = new BitmapWindows(device, 640, WINDOW_BUDGET);
  // world rasters reused from ctx.previous (one shared reference each, compat-reuse.ts retain)
  const reused: TrackedTexture[] = [];
  const releaser = sharedReleaser(device);
  // Screen overlay textures are owned by their slot (refreshOverlays swaps them in place), everything else by `textures`.
  // Compat textures can be shared with the previous or next frame, so every release goes through the shared count.
  const release = () => {
    for (const resource of [...textures, ...reused]) releaseShared(device, resource);
    for (const resource of buffers) device.release(resource);
    releaseRuns(runs, releaser);
    textures.length = buffers.length = reused.length = 0;
    windows.dispose();
  };
  const fans = new F32(1 << 16);
  const tessellation = newMeshStats();
  const segments = new F32(1 << 16);
  const caps = new F32(1 << 14);
  const edges = new F32(1 << 14); // fill anti-aliasing edges (framegraph fringe)
  const sprites = new F32(1 << 10);
  const glyphs: Float32Array[] = [];
  let glyphCount = 0;
  const pick = retained?.pick ?? new PickIndex(ctx.world.width, ctx.world.height);
  let relief: Prepared["relief"] = retained?.relief ?? null;
  // texture sources and bitmap-window sources the conversion used, for retainFrame
  const recipes = new Map<TrackedTexture, Recipe>();
  const windowSources: WindowSource[] = [];
  const make = (label: string, source: TextureSource, options: Recipe["options"] = {}) => {
    const texture = device.texture(label, source, options);
    recipes.set(texture, { label, source, options });
    textures.push(texture);
    return texture;
  };
  const addWindow = (image: HTMLImageElement, rect: [number, number, number, number], opacity?: number) => {
    const slot = windows.add(image, rect, opacity);
    windowSources.push({ slot, image, rect: [...rect], opacity, detail: null });
    return slot;
  };
  const runs: CompatRun[] = [];
  const reasons: string[] = [];
  const tiles = new Map<string, FillBatch["tile"] | string>();
  // the synchronous draw conversion yields every SLICE_MS so a 100k-element world does not block input for seconds
  const policy = slicePolicy();
  const slice = createSlicer(policy.budget, undefined, undefined, policy.inputPending, policy.floor);

  // `layer` is null for screen overlays: they sit outside the world and are not pickable
  const compat = (
    element: Element,
    reason: string,
    out: Batch[],
    layer: string | null,
    screen = false,
    shapes?: HitShape[]
  ) => {
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
    runs.push({ slot, elements: [element], screen, sharp, stamp: 0, key: "" });
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
    const edgeFirst = edges.length / 4;
    return {
      kind: "fill",
      first,
      count: appendStencilMeshes(subpaths, fans, tessellation),
      color: null,
      tile: null,
      evenOdd,
      bounds: pathBounds(subpaths),
      edgeFirst,
      edgeCount: appendFillEdges(subpaths, edges, evenOdd),
      deepWinding: !evenOdd && mayWindDeep(subpaths)
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
      bounds: pathBounds(subpaths, Math.max(0, style.width) * 2),
      sharedSegments: hasSharedSegments(subpaths)
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
        const texture = make(`pattern ${id}`, result.canvas, { repeat: true });
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
        const hits = !picking
          ? null
          : view
            ? sensitivity(view.getComputedStyle(draw.element))
            : { fill: true, stroke: true, box: false };
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
            pick.setDepth(
              pick.addFill(
                draw.layer,
                id,
                hitRings().map(s => s.points),
                style.evenOdd
              ),
              depth,
              path
            );
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
        // opt-in native hairlines (?gpu-native-cells=1); by default scene.ts routes the mesh to compat, which shows the
        // canonical mesh bitmap SVG displays
        const href = draw.element.getAttribute("href") || draw.element.getAttribute("xlink:href") || "";
        const rings = cellRings(href);
        const batch = stroke(rings, { stroke: draw.stroke, width: draw.width, dashes: [], dashOffset: 0 });
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
        out.push(addWindow(image, meetImageRect(rect, image.naturalWidth, image.naturalHeight), draw.opacity));
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
          const slot = addWindow(
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
              const sharper = make("canonical relief viewport", detail);
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
        const texture = make("relief atlas", atlas.canvas, { mipmap: true }); // device: LINEAR_MIPMAP_LINEAR
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
        if (picking)
          for (const shape of compatShapes(draw.element as unknown as CompatRoot, viewbox as SVGGraphicsElement))
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
        const shapes = picking
          ? compatShapesBatch(draw.elements as unknown as CompatRoot[], viewbox as SVGGraphicsElement)
          : [];
        draw.elements.forEach((element, i) => {
          compat(element, draw.reason, out, draw.layer, false, shapes[i]);
        });
      }
    }
    return true;
  };

  try {
    const before: Batch[] = [];
    const after: Batch[] = [];
    const batches: Batch[] = [];
    if (retained) {
      const restored = rehydrate(retained, make, addWindow);
      runs.push(...restored.runs);
      batches.push(...restored.batches);
      reasons.push(...retained.reasons);
    } else {
      let seen = false;
      for (const child of svg.children) {
        if (child === viewbox) seen = true;
        else if (!ignoredRoot.has(child.tagName) && getComputedStyle(child).display !== "none") {
          compat(child, "screen overlay", seen ? after : before, null, true);
          if (picking && seen) runs[runs.length - 1].hits = overlayShapes(child, svg);
        }
      }
      if (!(await convert(scene.draws, batches))) {
        release();
        return null;
      }
    }
    ctx.mark?.("scene");
    const vertices = retained?.vertices ?? {
      fans: fans.view(),
      segments: segments.view(),
      caps: caps.view(),
      sprites: sprites.view(),
      edges: edges.view()
    };
    let glyphData = retained?.glyphs ?? null;
    if (retained) glyphCount = retained.glyphCount;
    const atlasCanvas = retained ? retained.atlas : ctx.atlas.canvas;

    // Still to upload after the compat rasters: glyph atlas and vertex data (≈ CPU arrays).
    const glyphBytes = glyphCount && atlasCanvas ? atlasCanvas.width * atlasCanvas.height * 4 : 0;
    const vertexBytes =
      (vertices.fans.length +
        vertices.segments.length +
        vertices.caps.length +
        vertices.sprites.length +
        vertices.edges.length +
        glyphCount * GLYPH_FLOATS) *
      4;
    const pending = glyphBytes + vertexBytes;
    const owned = () => textures.reduce((sum, texture) => sum + texture.bytes, 0) + windows.bytes;

    const worldRuns = runs.filter(run => !run.screen);
    const base = compatResolution(worldRuns.length, ctx.world, 2, device.maxTextureSize);
    const { world: region } = ctx;
    const worldKey = `${region.x},${region.y},${region.width},${region.height}@${base}/${ctx.bucket}`;
    const screenKey = `${ctx.screen.width}x${ctx.screen.height}@${ctx.screen.dpr}`;
    // world rasters depend on the base resolution; the ladder level they shrank to is checked in the world loop
    for (const run of runs) run.key = run.screen ? screenKey : worldKey;
    const mib = (bytes: number) => `${(bytes / 2 ** 20).toFixed(1)} MiB`;
    const rgba = (texture: TrackedTexture | null | undefined) => (texture ? texture.width * texture.height * 4 : 0);

    // Reuse: a run whose elements, raster key and stylesheets match a run of the previous frame, and that nothing
    // reachable changed since that raster was cut, takes its texture (and its settle detail) instead of a new raster.
    const reuse = adoptRuns(device, svg, runs, ctx.previous ?? null);
    const { adopted, report } = reuse;
    report.retained = !!retained;
    for (const [run] of adopted) if (!run.screen && run.slot.texture) reused.push(run.slot.texture);
    const reusedScreen = [...adopted.keys()].reduce((n, run) => (run.screen ? n + rgba(run.slot.texture) : n), 0);
    // Tracked bytes as a full re-prepare sees them: it releases every previous detail at its start. A carried detail
    // stays allocated instead, but its bytes never exceed the reused rasters a full re-prepare would allocate again.
    const tracked = () => device.memory().total - reuse.detailBytes;

    // World raster level (resolution = base · ladderScale(level)), chosen with the budget below; 0 is the base.
    let level = 0;
    let resolution = base;
    // world runs rasterized this prepare, transparent ones included: each records the level its raster is at
    const cut: CompatRun[] = [];
    const held: { run: CompatRun; canvas: HTMLCanvasElement; rect: Region }[] = [];
    // clean world runs counted at the current level with their reused texture
    const kept = new Set<CompatRun>();
    const sum = (screen: boolean) =>
      held.reduce((n, item) => (item.run.screen === screen ? n + item.canvas.width * item.canvas.height * 4 : n), 0) +
      (screen ? reusedScreen : [...kept].reduce((n, run) => n + rgba(run.slot.texture), 0));
    // Built only when some run needs a raster: a prepare that reuses every run cuts no export clone.
    let clone: SVGSVGElement | null = null;
    let cloneStamp = 0;
    const cloneNow = async () => {
      if (!clone) {
        ({ clone, stamp: cloneStamp } = await stampedClone(ctx.revision));
        report.cloned = true;
      }
      return clone;
    };
    if (runs.some(run => !adopted.has(run))) await cloneNow();
    ctx.mark?.("clone");
    const rasterize = async (run: CompatRun): Promise<boolean> => {
      const source = await cloneNow();
      if (ctx.stale()) return false;
      const resolved = resolveManyInClone(run.elements, source);
      const missing = resolved.find(item => typeof item === "string");
      if (missing) {
        const i = resolved.indexOf(missing);
        const e = run.elements[i];
        throw new Error(
          `compat: ${missing} for <${e.tagName}> #${e.id} parent #${e.parentElement?.id} attrs ${e.getAttributeNames().join(",")} source siblings ${[...(e.parentElement?.children || [])].map(c => c.tagName).join(",")} clone siblings ${[...((e.parentElement?.id && source.querySelector(`#${CSS.escape(e.parentElement.id)}`)?.children) || [])].map(c => c.tagName).join(",")}`
        );
      }
      const region = run.screen ? { x: 0, y: 0, ...ctx.screen } : ctx.world;
      const ratio = run.screen ? ctx.screen.dpr : resolution;
      const [w, h] = [Math.max(1, Math.round(region.width * ratio)), Math.max(1, Math.round(region.height * ratio))];
      // raster px per live CSS px: a world raster is cut at `ratio` px per unit for CSS px per unit ≈ bucket / dpr
      // (the reuse key holds the bucket, not the exact zoom); a screen raster at dpr px per CSS px
      const cssScale = run.screen ? ctx.screen.dpr : (ratio * ctx.screen.dpr) / ctx.bucket;
      const canvas = await rasterizeRun(source, resolved as Element[], region, w, h, run.screen, cssScale);
      if (ctx.stale()) return false;
      run.stamp = cloneStamp;
      if (!run.screen) {
        run.level = level;
        cut.push(run);
      }
      const cropped = cropRaster(canvas, region);
      if (cropped) held.push({ run, ...cropped }); // fully transparent: slot keeps texture null and draws nothing
      return true;
    };
    // Screen overlays first (fixed size at the screen DPR): their bytes are known before the window crops take room.
    for (const run of runs) {
      if (!run.screen || adopted.has(run)) continue;
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
      const limit = compatAllowance(tracked(), owned(), pending + reserve);
      const committed = await windows.refresh(ctx.camera, ctx.screen, ctx.stale, limit);
      if (!committed && ctx.stale()) {
        release();
        return null;
      }
    }
    ctx.mark?.("windows");

    // This frame's compat share: the steady budget minus the group target reserve, what it already uploaded (bitmap
    // window crops included) and what is still pending, and never past the peak beside the previous frame. Over it,
    // world rasters step down the ladder; a share too small for useful world rasters (or for the screen overlays)
    // fails the prepare, and the renderer shows the SVG. Reused rasters count where a full re-prepare would allocate
    // them.
    const budget = compatAllowance(tracked(), owned(), pending);
    if (budget < sum(true))
      throw new BudgetError(`compat: screen overlays need ${mib(sum(true))}, ${mib(budget)} fits`);
    // With reuse on, world rasters shrink along the fixed ladder (compat.ts): a frame that keeps world rasters starts
    // at the previous frame's level, or higher (sharper) when the previous frame's world bytes would fit the room there,
    // so a reused frame steps back up as a full re-prepare would (an estimate: the dirty runs may change size). With
    // reuse off (the default), they shrink to an exact fit (fitScale) as before the ladder, level reporting the
    // equivalent fractional step.
    const ladder = report.enabled;
    const previous = ctx.previous;
    if (ladder && previous && [...adopted.keys()].some(run => !run.screen)) {
      const bytes = previous.runs.reduce((n, run) => (run.screen ? n : n + rgba(run.slot.texture)), 0);
      level = ladderStart(previous.compat.level, bytes, budget - sum(true));
      resolution = base * ladderScale(level);
    }
    // World rasters in run order at the current level. Whenever their bytes exceed the room, the level steps down to
    // one that fits under LADDER_HEADROOM of it: every held fresh raster is resampled to it (scaleRaster), later runs
    // are cut at it, and a kept raster (a GPU texture, which cannot shrink) is cut again at it after the queue.
    const queue = [...worldRuns];
    for (let i = 0; i < queue.length; i++) {
      const run = queue[i];
      if (adopted.has(run) && adopted.get(run)!.level === level) {
        run.level = level;
        kept.add(run);
      } else {
        if (adopted.has(run)) reuse.drop(run, reused, "world level changed");
        if (ctx.stale() || !(await rasterize(run))) {
          release();
          return null;
        }
      }
      const worldRoom = budget - sum(true);
      const bytes = sum(false);
      if (bytes <= worldRoom) continue;
      if (worldRoom < MIN_COMPAT_BUDGET)
        throw new BudgetError(`compat: world rasters need ${mib(bytes)}, ${mib(worldRoom)} fits the GPU budget`);
      let next: number;
      let scale: number;
      if (ladder) {
        next = ladderFit(bytes, worldRoom * LADDER_HEADROOM, level);
        scale = ladderScale(next) / ladderScale(level);
      } else {
        scale = fitScale(bytes, worldRoom);
        next = level - LADDER_STEPS * Math.log2(scale);
      }
      for (const item of held) if (!item.run.screen) item.canvas = scaleRaster(item.canvas, scale);
      for (const run of cut) run.level = next;
      for (const run of kept) {
        reuse.drop(run, reused, "world rasters stepped down the ladder");
        queue.push(run);
      }
      kept.clear();
      level = next;
      resolution = ladder ? base * ladderScale(level) : resolution * scale;
    }
    for (const { run, canvas, rect } of held) {
      run.slot.texture = device.texture(run.screen ? "compat screen" : "compat world", canvas);
      if (!run.screen) textures.push(run.slot.texture);
      run.slot.rect = [rect.x, rect.y, rect.width, rect.height];
      canvas.width = canvas.height = 0;
    }
    report.worldKept = kept.size;
    ctx.mark?.("world");

    const upload = (label: string, data: Float32Array) => {
      if (!data.length) return null;
      const buffer = device.buffer(label, data);
      buffers.push(buffer);
      return buffer;
    };
    if (!glyphData) {
      glyphData = new Float32Array(glyphCount * GLYPH_FLOATS);
      let offset = 0;
      for (const chunk of glyphs) {
        glyphData.set(chunk, offset);
        offset += chunk.length;
      }
    }
    let atlas: TrackedTexture | null = null;
    if (glyphCount && atlasCanvas) {
      atlas = device.texture("glyph atlas", atlasCanvas);
      textures.push(atlas);
    }
    const tree = [...before, ...batches, ...after];
    const frame: Frame = {
      batches: tree,
      fans: upload("fans", vertices.fans),
      segments: upload("segments", vertices.segments),
      caps: upload("stroke caps", vertices.caps),
      edges: upload("fill edges", vertices.edges),
      sprites: upload("sprites", vertices.sprites),
      glyphs: upload("glyphs", glyphData),
      atlas
    };
    ctx.mark?.("buffers");
    // CPU glyph canvas, counted once here (the renderer's atlas, or the retained copy it was restored from)
    const atlasBytes = atlasCanvas ? atlasCanvas.width * atlasCanvas.height * 4 : 0;
    // Kept for retainFrame: views of the conversion's arrays (their capacity, up to twice the used length), the glyph
    // instances and every texture source (an upper bound: some, such as the cached relief images, are held by their
    // caches anyway).
    const vertexHeld = Object.values(vertices).reduce((n, array) => n + array.buffer.byteLength, 0);
    const recipeHeld = [...recipes.values()].reduce(
      (n, { source }) => n + ("width" in source && "height" in source ? source.width * source.height * 4 : 0),
      0
    );
    const payloadHeld = vertexHeld + glyphData.byteLength + recipeHeld;
    const payload: Payload = {
      key: payloadAt,
      layers: retained?.layers ?? cloneLayers(scene.layers),
      reasons: [...reasons],
      pick,
      relief,
      tessellation: retained?.tessellation ?? tessellation,
      batches: tree,
      vertices,
      glyphs: glyphData,
      glyphCount,
      atlasCanvas: glyphCount ? atlasCanvas : null,
      atlasCopy: !!retained,
      atlasGeneration: ctx.atlas.generation === atlasGeneration ? atlasGeneration : -1,
      recipes,
      windows: windowSources.map(item => ({ ...item, detail: item.slot.detail && { ...item.slot.detail } }))
    };
    const overlays = indexOverlays(runs, ctx.screen);
    // tracker entries older than every raster this frame or the previous one still draws can no longer matter
    compatDirt.prune(
      [...runs, ...(ctx.previous?.runs ?? [])].reduce((min, run) => Math.min(min, run.stamp), compatDirt.now())
    );
    return {
      frame,
      picking,
      pick,
      bucket: ctx.bucket,
      revision: ctx.revision,
      layers: scene.layers,
      compat: {
        runs: runs.length,
        elements: runs.reduce((n, run) => n + run.elements.length, 0),
        reasons,
        resolution,
        level,
        reuse: report
      },
      styleKey: reuse.style?.key,
      runs,
      overlays,
      relief,
      windows: windows.size ? windows : null,
      // retained CPU memory: pick index, glyph atlas canvas and the payload kept for a context restore
      cpuBytes: pick.bytes() + overlays.bytes() + atlasBytes + payloadHeld,
      tessellation: payload.tessellation,
      payload,
      release
    };
  } catch (error) {
    release();
    throw error;
  }
}

// Pairs this prepare's compat runs with the previous frame's: same elements in the same order, same raster key, same
// stylesheet state, and clean in the reuse tracker (compat-reuse.ts) with no reference to a non-definition element.
// A clean run takes the previous texture (shared) and, while their bytes stay within the reused rasters, its settle
// detail; every other previous detail is released now, as a full re-prepare does at its start.
// Off by default, pending a decision: with the subtree rule and the world raster ladder (PERF W1), a route close on the
// route-focus run (Metal, DPR 2, three route closes, single runs) keeps 4/6 world and 2/3 screen runs and the prepare
// goes 2.9/5.4/5.8 -> 2.2/3.1/2.8 s (integration-20261019T210149-621Z -> 211754-900Z), and canonical passes with it
// on, but no check yet compares a reused raster against SVG after an edit, and resume stays 5.5-8.1 s. The ladder is
// part of reuse: off, world rasters fit the budget exactly, as before W1. Opt in with ?gpu-compat-reuse=1 or a build with
// VITE_GPU_COMPAT_REUSE=1. The dirty-run telemetry (lastPrepare.reuse reasons) needs the flag too: off, the renderer
// installs no tracker feed or outside-input watcher, and the default path matches the pre-reuse renderer.
export function compatReuseEnabled(): boolean {
  if (import.meta.env?.VITE_GPU_COMPAT_REUSE === "1") return true;
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").get("gpu-compat-reuse") === "1";
  } catch {
    return false;
  }
}

function adoptRuns(device: GpuDevice, svg: SVGSVGElement, runs: CompatRun[], previous: Prepared | null) {
  const started = performance.now();
  const adopted = new Map<CompatRun, CompatRun>();
  const report: CompatReuse = {
    enabled: compatReuseEnabled(),
    world: runs.filter(run => !run.screen).length,
    worldClean: 0,
    worldKept: 0,
    screen: runs.filter(run => run.screen).length,
    screenClean: 0,
    details: 0,
    cloned: false,
    aborted: "",
    structural: "",
    reasons: {},
    ms: 0,
    retained: false
  };
  const count = (reason: string) => {
    const keys = Object.keys(report.reasons);
    const key = report.reasons[reason] !== undefined || keys.length < 8 ? reason : "other";
    report.reasons[key] = (report.reasons[key] ?? 0) + 1;
  };
  // Off: the renderer feeds the tracker and watches outside inputs only when reuse is on (input-path cost), so its
  // verdicts would be meaningless; skip the evaluation too. The renderer released the previous details at prepare start.
  const style: StyleState | null = runs.length && report.enabled ? documentStyle(svg) : null;
  if (!report.enabled && runs.length) report.reasons["reuse off"] = runs.length;
  report.structural = style?.structural ?? "";
  const now = compatDirt.now();
  let detailBytes = 0;
  const carried = new Set<ImageBatch["detail"]>();
  if (style && previous?.runs.length) {
    const before = new Map<Element, CompatRun>();
    for (const run of previous.runs) before.set(run.elements[0], run);
    const pairs: { run: CompatRun; old: CompatRun }[] = [];
    for (const run of runs) {
      const old = before.get(run.elements[0]);
      if (
        !old ||
        old.screen !== run.screen ||
        old.elements.length !== run.elements.length ||
        old.elements.some((element, i) => element !== run.elements[i])
      )
        count("new run");
      else if (old.key !== run.key) count("raster key");
      else if (previous.styleKey !== style.key) count("stylesheets");
      else pairs.push({ run, old });
    }
    const verdicts = compatDirt.evaluate(
      pairs.map(pair => pair.old),
      !!style.structural
    );
    const document = svg.ownerDocument;
    pairs.forEach(({ run, old }, i) => {
      const external =
        verdicts[i] ||
        externalReference(run.elements as unknown as Parameters<typeof externalReference>[0], id =>
          document.getElementById(id)
        );
      if (external) count(verdicts[i] || `reference ${external}`);
      else {
        if (run.screen) report.screenClean++;
        else report.worldClean++;
        if (report.enabled) adopted.set(run, old);
      }
    });
    let reusedBytes = 0;
    for (const [run, old] of adopted) {
      const texture = old.slot.texture;
      run.slot.texture = texture && retain(texture);
      run.slot.rect = [...old.slot.rect];
      run.stamp = now; // verified clean up to now
      reusedBytes += texture ? texture.width * texture.height * 4 : 0;
    }
    for (const [run, old] of adopted) {
      const detail = old.slot.detail;
      if (run.screen || !detail || !old.detailMeta) continue;
      const bytes = detail.texture ? detail.texture.width * detail.texture.height * 4 : 0;
      if (detailBytes + bytes > reusedBytes) continue;
      detailBytes += bytes;
      run.slot.detail = { ...detail, texture: detail.texture && retain(detail.texture) };
      run.detailMeta = old.detailMeta;
      carried.add(detail);
      report.details++;
    }
  } else if (report.enabled) for (let i = 0; i < runs.length; i++) count(previous ? "new run" : "no previous frame");
  if (previous)
    for (const run of previous.runs)
      if (run.slot.detail && !carried.has(run.slot.detail)) {
        releaseShared(device, run.slot.detail.texture);
        run.slot.detail = null;
        run.detailMeta = undefined;
      }
  report.ms = Math.round((performance.now() - started) * 10) / 10;
  const result = {
    adopted,
    report,
    style,
    detailBytes,
    // Re-cuts a clean world run after all (its raster is at another ladder level than the frame): drops its shared
    // texture and carried detail from this frame, and the carried detail from the previous one too, so both look as a
    // full re-prepare leaves them.
    drop(run: CompatRun, reused: TrackedTexture[], why: string) {
      const old = adopted.get(run);
      if (!old || run.screen) return;
      const texture = run.slot.texture;
      const at = texture ? reused.indexOf(texture) : -1;
      if (at >= 0) reused.splice(at, 1);
      releaseShared(device, texture);
      run.slot.texture = null;
      run.slot.rect = [0, 0, 0, 0];
      const detail = run.slot.detail;
      if (detail) {
        result.detailBytes -= detail.texture ? detail.texture.width * detail.texture.height * 4 : 0;
        releaseShared(device, detail.texture);
        if (old.slot.detail?.texture === detail.texture) {
          releaseShared(device, detail.texture);
          old.slot.detail = null;
          old.detailMeta = undefined;
        }
        run.slot.detail = null;
        run.detailMeta = undefined;
        report.details--;
      }
      adopted.delete(run);
      report.aborted ||= why;
    }
  };
  return result;
}

// Settle-time sharper raster of world compat runs for the visible region at backing resolution, alpha-cropped and kept
// within GPU_BUDGET (tracked total, so the base frame and target count). Returns false when stale, over budget or
// nothing to refine. Each slot draws its detail only while the view stays inside `covers`, else its base texture.
// A detail already cut for this exact request at full density, from content unchanged since (this frame's, or one
// prepareFrame carried over from a clean run), is kept where a full re-refine would allocate the same bytes; the
// export clone is cut only when some detail must be rasterized.
export async function refineCompat(
  prepared: Prepared,
  ctx: PrepareContext,
  visible: Region,
  pixels: { width: number; height: number },
  budget = GPU_BUDGET
): Promise<boolean> {
  const world = prepared.runs.filter(run => !run.screen && run.slot.texture);
  if (!world.length) return false;
  const { device } = ctx;
  // Sharp runs, then smallest visible footprint first (see refineOrder); every previous detail that is not kept is
  // released before any room is measured, so a stale detail of a later run never counts against an earlier one.
  const order = refineOrder(
    world.map(run => run.slot.rect),
    visible,
    world.map(run => run.sharp)
  );
  const runs = order.map(index => world[index]);
  const request = `${visible.x},${visible.y},${visible.width},${visible.height}@${pixels.width}x${pixels.height}`;
  const bytesOf = (run: CompatRun) => {
    const texture = run.slot.detail?.texture;
    return texture ? texture.width * texture.height * 4 : 0;
  };
  const drop = (run: CompatRun) => {
    releaseShared(device, run.slot.detail?.texture);
    run.slot.detail = null;
    run.detailMeta = undefined;
  };
  const kept = new Set<CompatRun>();
  for (const run of runs) {
    if (run.slot.detail && run.detailMeta?.request === request) kept.add(run);
    else drop(run);
  }
  // kept details of runs this pass has not reached yet: a full re-refine has not allocated them at that point
  let keptAfter = runs.reduce((n, run) => (kept.has(run) ? n + bytesOf(run) : n), 0);
  const covers: [number, number, number, number] = [visible.x, visible.y, visible.width, visible.height];
  const stats = { kept: 0, rasterized: 0, cloned: false };
  let clone: SVGSVGElement | null = null;
  const density = pixels.width / visible.width;
  // The detail a raster alpha-cropped to `size` (null: fully transparent) becomes with `room` left: full (fit 1),
  // downscaled into the room while that still beats the base raster's density, or none (null: the base stays).
  const decide = (size: [number, number] | null, room: number): number | null => {
    if (!size) return 1;
    const bytes = size[0] * size[1] * 4;
    if (bytes <= room) return 1;
    const fit = Math.sqrt(Math.max(0, room) / bytes);
    if (!(density * fit > prepared.compat.resolution)) return null;
    return Math.floor(size[0] * fit) >= 1 && Math.floor(size[1] * fit) >= 1 ? fit : null;
  };
  const report: { id: string; density: number }[] = [];
  prepared.compat.detail = report;
  prepared.compat.refine = stats;
  let refined = false;
  for (const run of runs) {
    const element = run.elements[0];
    const entry = {
      id: element.id || `${element.parentElement?.id ?? ""}>${element.tagName}`,
      density: prepared.compat.resolution
    };
    report.push(entry);
    if (ctx.stale()) return false;
    const meta = run.detailMeta;
    if (kept.has(run) && meta) {
      const bytes = bytesOf(run);
      keptAfter -= bytes;
      kept.delete(run);
      // what a full re-refine cuts here, beside only the details before this run: the same detail is kept
      const fit = decide(meta.size, budget - (device.memory().total - keptAfter - bytes));
      if (fit === meta.fit) {
        entry.density = density * fit;
        stats.kept++;
        refined = true;
        continue;
      }
      drop(run);
      if (fit === null) continue; // it would keep the base: nothing to cut
    }
    if (!clone) {
      clone = await compatClone(ctx.revision);
      stats.cloned = true;
      if (ctx.stale()) return false;
    }
    const resolved = resolveManyInClone(run.elements, clone);
    if (resolved.some(item => typeof item === "string")) return false;
    // the detail is cut at device density: dpr raster px per live CSS px
    const canvas = await rasterizeRun(
      clone,
      resolved as Element[],
      visible,
      pixels.width,
      pixels.height,
      false,
      ctx.screen?.dpr ?? 1 // absent in partial test contexts
    );
    if (ctx.stale()) return false;
    let cropped = cropRaster(canvas, visible);
    // Check the alpha-cropped allocation, not a hypothetical full viewport. Sparse labels and markers can fit
    // even when an uncropped viewport would exceed the budget. A run that cannot fit is downscaled into the remaining
    // headroom while that still beats the base raster's density, else it keeps the base.
    const size: [number, number] | null = cropped && [cropped.canvas.width, cropped.canvas.height];
    let room = budget - device.memory().total;
    if (size && size[0] * size[1] * 4 > room && keptAfter) {
      // a full re-refine would see the room without the later kept details: free them, they are cut again in turn
      for (const later of kept) drop(later);
      kept.clear();
      keptAfter = 0;
      room = budget - device.memory().total;
    }
    const fit = decide(size, room);
    if (cropped && fit !== 1) {
      const scaled = fit === null ? null : scaleCanvas(cropped.canvas, fit);
      cropped.canvas.width = cropped.canvas.height = 0;
      if (!scaled) continue;
      cropped = { canvas: scaled, rect: cropped.rect };
    }
    entry.density = density * (fit ?? 1);
    refined = true;
    stats.rasterized++;
    run.detailMeta = { request, size, fit: fit ?? 1 };
    if (!cropped) run.slot.detail = { texture: null, rect: covers, covers };
    else {
      const { x, y, width, height } = cropped.rect;
      const texture = device.texture("compat detail", cropped.canvas);
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
      if (!element.matches("g, #ruler *, #scaleBar > text, #prec text")) continue;
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
      // href="#" (an empty fragment) references nothing in either tree
      if (ids.some(id => id && !clone.querySelector(`#${CSS.escape(id)}`))) return null;
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
export async function refreshOverlays(
  prepared: Prepared,
  ctx: PrepareContext,
  roots: Element[]
): Promise<OverlayRefresh> {
  const runs: CompatRun[] = [];
  for (const root of roots) {
    const run = prepared.runs.find(item => item.screen && item.elements[0] === root);
    if (!run || !root.isConnected || getComputedStyle(root).display === "none") return "full";
    runs.push(run);
  }
  if (!runs.length) return "committed";
  // The copies come from the live roots, but their defs, embedded fonts, root attributes and the styles computed under
  // them are the cached clone's: the refreshed raster is only as current as the clone (fail closed for reuse).
  const { clone, stamp } = await stampedClone(ctx.revision);
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
      ? overlayShapes(root, root.parentElement)
      : run.hits;
  });
  const region = { x: 0, y: 0, ...ctx.screen };
  const [w, h] = [
    Math.max(1, Math.round(region.width * region.dpr)),
    Math.max(1, Math.round(region.height * region.dpr))
  ];
  const held: { run: CompatRun; cropped: ReturnType<typeof cropRaster> }[] = [];
  try {
    for (const run of runs) {
      const resolved = resolveInClone(run.elements[0], clone);
      if (typeof resolved === "string") return "full";
      const canvas = await rasterizeRun(clone, [resolved], region, w, h, true, region.dpr);
      const cropped = ctx.stale() ? null : cropRaster(canvas, region);
      if (canvas !== cropped?.canvas) canvas.width = canvas.height = 0;
      held.push({ run, cropped });
      if (ctx.stale()) return "stale";
    }
    const { device } = ctx;
    const releaser = sharedReleaser(device);
    const old = runs.reduce((n, run) => n + (run.slot.texture?.bytes ?? 0), 0);
    const bytes = held.reduce(
      (n, { cropped }) => n + (cropped ? cropped.canvas.width * cropped.canvas.height * 4 : 0),
      0
    );
    if (bytes > windowAllowance(device.memory().total, old)) return "full";
    const textures = uploadAll(
      held,
      ({ cropped }) => cropped && device.texture("compat screen", cropped.canvas),
      releaser
    );
    swapOverlays(
      held.map(({ run, cropped }, i) => ({
        run,
        texture: textures[i],
        rect:
          cropped && ([cropped.rect.x, cropped.rect.y, cropped.rect.width, cropped.rect.height] as ImageBatch["rect"])
      })),
      releaser
    );
    runs.forEach((run, i) => {
      run.hits = hits[i];
      run.stamp = stamp;
    });
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
      releaseShared(device, run.slot.detail.texture);
      run.slot.detail = null;
      run.detailMeta = undefined;
    }
}
