// Turns the canonical SVG into one GPU frame: shared vertex/instance buffers, pattern tiles, relief and glyph
// atlases, compat rasters (DOM-ordered slots) and the CPU pick index. Async with a staleness check after every
// await: a superseded job releases what it allocated and returns null.
import { computedStyleText } from "../io/inline-style";
import type { ReliefSprite } from "../renderers/relief-canvas";
import { BitmapWindows, type WindowDetail } from "./bitmap-window";
import {
  compatAllowance,
  DETAIL_RESERVE,
  DETAIL_SHARE,
  FIRST_DETAIL_BUDGET,
  FIRST_DETAIL_MS,
  fitScale,
  GPU_BUDGET,
  MIN_COMPAT_BUDGET,
  PEAK_LIMIT,
  refineOrder,
  reliefCell,
  STEADY_SLACK,
  steadyOverrun,
  steadyReserve,
  targetReserve,
  windowAllowance
} from "./budget";
import { type Camera, type Viewport, visibleWorld } from "./camera";
import { resolveManyInClone } from "./clone-map";
import {
  compatClone,
  compatResolution,
  cropRaster,
  LADDER_HEADROOM,
  LADDER_STEPS,
  ladderFit,
  ladderHint,
  ladderScale,
  ladderStart,
  type Region,
  rasterizeRun,
  resolveInClone,
  scaleRaster,
  stampedClone
} from "./compat";
import {
  type BatchMember,
  type Box,
  boundsWithin,
  measureBounds,
  newWindowStats,
  rasterizeWindowed,
  WINDOW_PAD_PX,
  WindowBatches,
  type WindowStats
} from "./compat-bounds";
import {
  type CompatRoot,
  compatShapes,
  compatShapesBatch,
  dashHitRings,
  pickDepth,
  pickId,
  pickTolerance,
  rasterHits,
  sensitivity,
  strokeHitRings,
  resScale as viewScaleOf
} from "./compat-pick";
import {
  compatDirt,
  documentStyle,
  type ReuseNode,
  referenceClosure,
  releaseShared,
  retain,
  type StyleState,
  sameExternals,
  sharedReleaser
} from "./compat-reuse";
import type { GpuDevice, TextureSource, TrackedBuffer, TrackedTexture } from "./device";
import {
  type Batch,
  type FillBatch,
  type Frame,
  hasMaskedGroup,
  type ImageBatch,
  type StrokeBatch
} from "./framegraph";
import {
  aliasedShape,
  analyticShape,
  appendFillEdges,
  appendSegments,
  appendStrokeCaps,
  capCode,
  curveTolerance,
  F32,
  hasCurves,
  hasSharedSegments,
  mayWindDeep,
  measuredSubpaths,
  normalizeDashes,
  pathBounds,
  thinFill,
  thinHairline
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
import { GLYPH_FLOATS, type GlyphAtlas, glyphAtlasRows, layoutLabels } from "./text";

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
  // the prepare gave up because the live DOM changed under it without a revision bump (a run element was detached):
  // the caller must prepare again once it ends
  sourceChanged?(): void;
  // a prepare whose frame nobody sees until it commits, so it commits on the base rasters and the settle refinement
  // sharpens it (firstDetails skips, D12: the world first, the detail after): "restore" recovers from a context loss
  // (renderer.ts restored()), "resume hold" runs behind the canonical SVG after an editor changed the model (D13)
  behind?: "restore" | "resume hold";
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
  // world run: the world box its live geometry reaches (compat-bounds.ts measureBounds; null: unbounded), measured once
  // per frame at the frame's revision
  bounds?: Box | null;
  // world run: its elements' own world boxes (measured with `bounds`; null: unknown), what the run reaches in a view
  boxes?: Box[] | null;
  // live elements outside the definitions its raster paints through, by id (compat-reuse.ts referenceClosure), as of
  // the prepare that cut or reused it
  externals?: Map<string, ReuseNode>;
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
  // the layers (#viewbox children, or root overlay ids) whose frame draws a raster reused from the previous frame
  keptLayers: string[];
  // the level the world loop started at from an earlier frame's bytes (ladderEstimate), when nothing was kept; absent
  // when it started at level 0 or from kept rasters (ladderStart)
  ladderHint?: number;
}

// Hit shapes of a root overlay in the root <svg>'s user space (SVG-local CSS px: #map has no viewBox).
export const overlayShapes = (root: Element, svg: SVGSVGElement) =>
  compatShapes(root as unknown as CompatRoot, svg as unknown as SVGGraphicsElement);

// Compat reasons whose content is high-frequency glyph/icon detail rather than a smooth fill or texture: text, marker
// <svg>s, burg icons, emblem and icon <use>s, regiment emoji, and the small basic shapes the compat lane draws (rain
// drops, population lines, ruler and goods markers: scene.ts routes <circle>/<rect>/<line>... here unless
// ?gpu-native-shapes=1). Blurry from the whole-world raster, they are what makes a first frame unreadable.
export const SHARP_COMPAT = new Set([
  "text",
  "<svg>",
  "restored burg vectors",
  "use",
  "<circle>",
  "<ellipse>",
  "<rect>",
  "<line>",
  "<polyline>",
  "<polygon>"
]);

// A layer folded into one run (#armies) joins its reasons with "; ": sharp when any of them is. Every text reason
// ("text", "text emoji", "text tspan"...) is sharp.
export const sharpReason = (reason: string) =>
  reason.split("; ").some(part => SHARP_COMPAT.has(part) || part.startsWith("text "));

// How a prepare planned the steady budget and what it actually uploaded (RES2 telemetry). `estimate` is what the compat
// share held back for the glyph atlas and vertex data before they were uploaded, `uploaded` the tracked bytes of the
// same kinds after; `steady` the projected committed total (resident + target + this frame), `overrun` its excess over
// `budget` (0 when within). `firstDetails` is why the first frame did or did not cut details.
export interface PrepareMemory {
  resident: number;
  target: number;
  slack: number;
  estimate: Record<string, number>;
  uploaded: Record<string, number>;
  frame: number;
  steady: number;
  budget: number;
  overrun: number;
  firstDetails: "cut" | "off" | "revision only" | "restore" | "resume hold" | "none sharp" | "no room" | "skipped";
}

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
    // how the world runs of the prepare (and of the last refinement) were cut (compat-bounds.ts)
    windows?: WindowStats;
    refineWindows?: WindowStats;
    // the steady-budget plan of the prepare (RES2): see PrepareMemory
    memory?: PrepareMemory;
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
  // GLYPHZ (W4a): each natively laid out label and its contiguous instance range in payload.glyphs, in instance order
  // (glyph-fine.ts re-cuts them at the exact device scale on settle); empty for a frame restored from a payload
  glyphLabels?: { element: SVGTextElement; first: number; count: number }[];
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
  detail: WindowDetail | null; // the relief viewport's sharper canonical image, cropped with the window
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
  // the world rasters' base resolution, ladder level and bytes (null: no world run): where the next prepare of this
  // world, or the restore of this payload, starts its world loop (compat.ts ladderHint)
  ladder?: { base: number; level: number; bytes: number } | null;
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

// A prepare that only follows a DOM revision (an edit) on the frame it replaces: same world, raster bucket, viewport,
// picking mode and device limit (the camera scale may differ within the bucket). No previous frame (a load, a restore,
// a frame dropped to fit) or any of those changed (a zoom to another bucket, a resize) is not one.
export function revisionOnly(previous: PayloadKey | null | undefined, next: PayloadKey): boolean {
  if (!previous) return false;
  return (["worldEpoch", "bucket", "picking", "world", "screen", "maxTexture"] as const).every(
    key => previous[key] === next[key]
  );
}

// Tracked GPU bytes a frame owns, each resource once (a compat texture can sit in a run and the recipes): its compat
// rasters and their settle details, the bitmap window crops, pattern/relief textures, glyph atlas and vertex buffers.
export function frameBytes(prepared: Pick<Prepared, "runs" | "windows" | "payload" | "frame">): number {
  const seen = new Set<object>();
  let total = 0;
  const add = (resource: { bytes: number } | null | undefined) => {
    if (!resource || seen.has(resource)) return;
    seen.add(resource);
    total += resource.bytes;
  };
  for (const run of prepared.runs) {
    add(run.slot.texture);
    add(run.slot.detail?.texture);
  }
  for (const texture of prepared.payload?.recipes.keys() ?? []) add(texture);
  for (const item of Object.values(prepared.frame))
    if (item && typeof item === "object" && "kind" in item && (item.kind === "buffer" || item.kind === "texture"))
      add(item as { bytes: number });
  return total + (prepared.windows?.bytes ?? 0);
}

// Tracked bytes no frame owns: the renderer's own allocations (trade-marker sprite textures and instance buffer, the
// unit-quad buffers), measured as the tracked total minus the per-screen targets (the group target and its mask
// coverage, both reserved by targetReserve) and the frame on screen. Read at the start of a prepare, before it allocates
// anything.
export function residentBytes(
  memory: { total: number; targets: number },
  previous: Pick<Prepared, "runs" | "windows" | "payload" | "frame"> | null | undefined
): number {
  return Math.max(0, memory.total - memory.targets - (previous ? frameBytes(previous) : 0));
}

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
  return ok;
}

// Re-uploads a retained frame's texture sources, re-adds its bitmap windows and gives its compat runs empty slots (the
// world loop cuts their rasters as usual); returns the runs and a copy of the batch tree that points at all of them.
export function rehydrate(
  retained: RetainedFrame,
  make: (label: string, source: TextureSource, options?: Recipe["options"]) => TrackedTexture,
  addWindow: (
    image: HTMLImageElement,
    rect: [number, number, number, number],
    opacity?: number,
    detail?: WindowDetail | null
  ) => ImageBatch
): { runs: CompatRun[]; batches: Batch[] } {
  const textures = new Map<TrackedTexture, TrackedTexture>();
  for (const [old, recipe] of retained.recipes) textures.set(old, make(recipe.label, recipe.source, recipe.options));
  const slots = new Map<ImageBatch, ImageBatch>();
  for (const item of retained.windows) {
    const slot = addWindow(item.image, item.rect, item.opacity, item.detail);
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
    // only the rows the instances sample (the upload takes no more); uvs stay normalized by the full atlas
    copy = document.createElement("canvas");
    copy.width = atlasCanvas.width;
    copy.height = Math.min(atlasCanvas.height, glyphAtlasRows(prepared.payload.glyphs, glyphCount));
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
  // hit geometry chord error: a fixed fraction of a CSS px up to this bucket's largest zoom (compat-pick.ts)
  const hitTolerance = pickTolerance(ctx.bucket, ctx.screen.dpr, ctx.camera.k);
  // what the steady budget holds that neither this frame nor the one it replaces owns, before anything is allocated
  const resident = residentBytes(device.memory(), ctx.previous);
  const editOnly = revisionOnly(ctx.previous?.payload?.key, payloadAt);
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
  const glyphLabels: NonNullable<Prepared["glyphLabels"]> = [];
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
  const addWindow = (
    image: HTMLImageElement,
    rect: [number, number, number, number],
    opacity?: number,
    detail: WindowDetail | null = null
  ) => {
    const slot = windows.add(image, rect, opacity, detail);
    windowSources.push({ slot, image, rect: [...rect], opacity, detail });
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
      for (const shape of shapes ??
        compatShapes(element as unknown as CompatRoot, viewbox as SVGGraphicsElement, hitTolerance))
        pick.addShape(layer, shape);
    const last = runs[runs.length - 1];
    // world runs merge while adjacent; each screen root keeps its own alpha-cropped raster (corner controls would
    // otherwise share one viewport-sized texture)
    const sharp = sharpReason(reason) || element.tagName === "text";
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
    const edgeFirst = edges.length / 2; // ring points (geometry.ts appendFillEdges)
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
    style: Pick<ShapeStyle, "stroke" | "width" | "dashes" | "dashOffset" | "lineJoin" | "lineCap" | "crisp">,
    distances?: ArrayLike<number>[]
  ) => {
    const dashes = normalizeDashes(style.dashes);
    if (dashes.length > 8) return null;
    const first = segments.length / 5;
    const count = appendSegments(subpaths, segments, distances);
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
      sharedSegments: hasSharedSegments(subpaths),
      hairline: thinHairline(style)
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
        const tag = draw.sourceTag ?? draw.element.tagName; // a <use> draws its referenced shape
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
        const hitRings = () => (hitPaths ??= flattenPath(draw.d, hitTolerance).filter(s => s.points.length >= 2));
        // dashed: the on-dashes themselves are the rings (open, capped), so the pick's own dash pass is off
        const dashed = normalizeDashes(style.dashes).length > 0;
        const dashRings = () => dashHitRings(draw.d, style.dashes, style.dashOffset, viewScale);
        const strokeRings = () => strokeHitRings(dashed ? dashRings : null, hitRings);
        // strokes and thin fills are flattened again for the raster bucket into Chrome's own chords (svg-path.ts
        // SkiaFlattening), dashed curves on SVG's dash measure (geometry.ts curveTolerance, measuredSubpaths)
        const curved = hasCurves(draw.d);
        const fine = curved ? curveTolerance(ctx.bucket, SCENE_CURVE_TOLERANCE) : SCENE_CURVE_TOLERANCE;
        const refine = curved;
        if (style.fill || style.pattern) {
          const thin = refine && thinFill(subpaths);
          const batch = fill(
            thin ? flattenPath(draw.d, fine, { scale: ctx.bucket, fill: true }) : subpaths,
            style.evenOdd
          );
          batch.analytic = analyticShape(tag, subpaths); // SVG draws it analytically or with 4x MSAA
          batch.aliased = aliasedShape(tag, style);
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
          // dashed curves 4x finer (0.075 device px): each SVG dash is cut from the true curve, and chords within 0.3 px
          // of it left dash ends off by up to a quarter px (stroke-probe d2 k4 trails: 27 % of the ink over Δ16);
          // parity world: +4.9k-14k points by bucket, under 0.4 MiB
          const measured = dashed && curved ? measuredSubpaths(draw.d, fine / 4, ctx.bucket) : null;
          const batch = stroke(
            measured?.subpaths ?? (refine ? flattenPath(draw.d, fine, { scale: ctx.bucket, fill: false }) : subpaths),
            style,
            measured?.distances
          );
          if (!batch) {
            nativeFallback(draw, "dash pattern > 8", out);
            continue;
          }
          batch.analytic = analyticShape(tag, subpaths, batch.dashCount > 0);
          batch.aliased = aliasedShape(tag, style);
          // a thin analytic stroke is the 1 device px line's profile times the width in either mode (geometry.ts)
          if (batch.analytic) batch.hairline = true;
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
          // The dense-zoom relief viewport image is a sharper copy of the visible part: a detail of the same window,
          // cropped and budgeted with it (at most the padded viewport image, which is twice the visible area).
          let sharper: WindowDetail | null = null;
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
            if (detail && rect.every(Number.isFinite) && rect[2] > 0 && rect[3] > 0)
              sharper = {
                image: detail,
                rect: meetImageRect(rect, detail.naturalWidth, detail.naturalHeight),
                covers: rect
              };
          }
          const slot = addWindow(
            cached,
            meetImageRect(
              [Number(draw.element.getAttribute("x") || 0), Number(draw.element.getAttribute("y") || 0), width, height],
              cached.naturalWidth,
              cached.naturalHeight
            ),
            undefined,
            sharper
          );
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
          for (const shape of compatShapes(
            draw.element as unknown as CompatRoot,
            viewbox as SVGGraphicsElement,
            hitTolerance
          ))
            pick.addShape(draw.layer, shape);
        glyphs.push(batch.instances);
        glyphLabels.push({ element: draw.element, first: glyphCount, count: batch.count });
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
          ? compatShapesBatch(draw.elements as unknown as CompatRoot[], viewbox as SVGGraphicsElement, hitTolerance)
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

    if (!glyphData) {
      glyphData = new Float32Array(glyphCount * GLYPH_FLOATS);
      let offset = 0;
      for (const chunk of glyphs) {
        glyphData.set(chunk, offset);
        offset += chunk.length;
      }
    }
    // the glyph atlas uploads only the rows its instances sample (glyphAtlasRows)
    const atlasRows =
      glyphCount && atlasCanvas ? Math.min(atlasCanvas.height, glyphAtlasRows(glyphData, glyphCount)) : 0;

    // Still to upload after the compat rasters: glyph atlas and vertex data (≈ CPU arrays).
    const glyphBytes = atlasCanvas ? atlasCanvas.width * atlasRows * 4 : 0;
    const vertexBytes =
      (vertices.fans.length +
        vertices.segments.length +
        vertices.caps.length +
        vertices.sprites.length +
        vertices.edges.length +
        glyphCount * GLYPH_FLOATS) *
      4;
    const pending = glyphBytes + vertexBytes;
    // per kind, compared with the uploads in the telemetry (PrepareMemory)
    const estimate: Record<string, number> = {
      "glyph atlas": glyphBytes,
      fans: vertices.fans.length * 4,
      segments: vertices.segments.length * 4,
      "stroke caps": vertices.caps.length * 4,
      sprites: vertices.sprites.length * 4,
      "fill edges": vertices.edges.length * 4,
      glyphs: glyphCount * GLYPH_FLOATS * 4
    };
    // the per-screen targets this backing store gets (framegraph composite: the group target, and the mask coverage
    // beside it when the frame has masked groups), not the flat TARGET_BUDGET cap, plus the resident allocations and
    // the explicit slack (steadyReserve)
    const { width: cssWidth, height: cssHeight, dpr } = ctx.screen;
    const masked = hasMaskedGroup(batches);
    const reserveTarget = targetReserve(cssWidth * dpr, cssHeight * dpr, device.maxSamples ?? 0, dpr, masked);
    const reserved = steadyReserve(reserveTarget, resident);
    const allowance = (spent: number) => compatAllowance(tracked(), owned(), spent, undefined, undefined, reserved);
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
    // World runs are cut over their own window of the world raster (compat-bounds.ts), screen runs over the viewport.
    const windowStats = newWindowStats();
    const cutRun = async (
      run: CompatRun,
      source: SVGSVGElement,
      clones: Element[],
      region: Region,
      w: number,
      h: number,
      cssScale: number
    ) => {
      if (run.screen)
        return cropRaster(await rasterizeRun(source, clones, region, w, h, true, cssScale, run.elements), region);
      if (run.bounds === undefined) measureBounds([run], viewbox);
      return rasterizeWindowed({
        clone: source,
        clones,
        full: region,
        width: w,
        height: h,
        cssScale,
        stats: windowStats,
        bounds: run.bounds ?? null,
        live: run.elements
      });
    };
    // World runs still to cut at the current level share decodes where their windows are disjoint (compat-bounds.ts
    // WindowBatches): planned when the first of them is cut, again after the level steps down the ladder.
    let shared: { resolution: number; cuts: WindowBatches<CompatRun> } | null = null;
    const disposeShared = async () => shared?.cuts.dispose();
    const batched = async (run: CompatRun, source: SVGSVGElement, w: number, h: number, cssScale: number) => {
      if (run.screen) return undefined;
      if (shared?.resolution !== resolution) {
        await shared?.cuts.dispose();
        const done = new Set([...cut, ...kept]);
        const pending = [
          run,
          ...worldRuns.filter(
            other => other !== run && !done.has(other) && adopted.get(other)?.level !== level && other.bounds
          )
        ];
        const resolved = resolveManyInClone(
          pending.flatMap(other => other.elements),
          source
        );
        const members: [CompatRun, BatchMember][] = [];
        let at = 0;
        for (const other of pending) {
          const clones = resolved.slice(at, at + other.elements.length);
          at += other.elements.length;
          if (clones.some(item => typeof item === "string")) continue;
          members.push([other, { clones: clones as Element[], live: other.elements, bounds: other.bounds ?? null }]);
        }
        const args = { clone: source, full: ctx.world, width: w, height: h, cssScale, stats: windowStats };
        shared = { resolution, cuts: new WindowBatches(args, members) };
      }
      return shared.cuts.take(run);
    };
    const rasterize = async (run: CompatRun): Promise<boolean> => {
      const source = await cloneNow();
      if (ctx.stale()) return false;
      const resolved = resolveManyInClone(run.elements, source);
      const missing = resolved.find(item => typeof item === "string");
      // A run element removed since the scene was read: drawCoordinates rebuilds the graticule on each camera settle
      // and that churn is routed to the overlay lane without a revision bump, so it can land mid-prepare. This prepare
      // predates the change; abort it (the renderer re-prepares or refreshes the overlay) instead of failing for good.
      if (missing === "detached element") {
        ctx.sourceChanged?.();
        return false;
      }
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
      const cropped =
        (await batched(run, source, w, h, cssScale)) ??
        (await cutRun(run, source, resolved as Element[], region, w, h, cssScale));
      if (ctx.stale()) {
        if (cropped) cropped.canvas.width = cropped.canvas.height = 0;
        return false;
      }
      run.stamp = cloneStamp;
      if (!run.screen) {
        run.level = level;
        cut.push(run);
      }
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
      const limit = allowance(pending + reserve);
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
    const budget = allowance(pending);
    if (budget < sum(true))
      throw new BudgetError(`compat: screen overlays need ${mib(sum(true))}, ${mib(budget)} fits`);
    // Zoomed past the base resolution, the view's sharp runs read from their settle detail (and the first frame's,
    // firstDetails), not from the world raster: world rasters leave them detailShare of the room. At the overview the
    // world raster is the view at device density, and takes all of it.
    const share = detailShare(worldRuns, base, ctx.camera, ctx.screen, budget - sum(true));
    // With reuse on, world rasters shrink along the fixed ladder (compat.ts): a frame that keeps world rasters starts
    // at the previous frame's level, or higher (sharper) when the previous frame's world bytes would fit the room there,
    // so a reused frame steps back up as a full re-prepare would (an estimate: the dirty runs may change size). With
    // reuse off (the default), they shrink to an exact fit (fitScale) as before the ladder, level reporting the
    // equivalent fractional step.
    const ladder = report.enabled;
    const previous = ctx.previous;
    if (ladder && previous && [...adopted.keys()].some(run => !run.screen)) {
      const bytes = previous.runs.reduce((n, run) => (run.screen ? n : n + rgba(run.slot.texture)), 0);
      level = ladderStart(previous.compat.level, bytes, budget - sum(true) - share);
      resolution = base * ladderScale(level);
    } else if (ladder) {
      // Nothing kept, but an earlier frame of this world (the one on screen, or the payload a context loss left) says
      // how many bytes its world rasters took: start where those fit instead of at level 0 (W4 RESUME). A different
      // world (size, epoch) or base resolution says nothing.
      const before = previous?.payload;
      const hint =
        before?.key.world === payloadAt.world && before.key.worldEpoch === payloadAt.worldEpoch
          ? before.ladder
          : (retained?.ladder ?? null);
      if (hint && hint.base === base && hint.bytes > 0 && worldRuns.length) {
        level = ladderHint(hint.level, hint.bytes, budget - sum(true) - share);
        resolution = base * ladderScale(level);
        report.ladderHint = level;
      }
    }
    // World rasters in run order at the current level. Whenever their bytes exceed the room, the level steps down to
    // one that fits under LADDER_HEADROOM of it: every held fresh raster is resampled to it (scaleRaster), later runs
    // are cut at it, and a kept raster (a GPU texture, which cannot shrink) is cut again at it after the queue.
    // one measurement pass (label culling off) for every world run that may be cut
    measureBounds(
      worldRuns.filter(run => !adopted.has(run)),
      viewbox
    );
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
      const worldRoom = budget - sum(true) - share;
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
    await disposeShared();
    for (const { run, canvas, rect } of held) {
      run.slot.texture = device.texture(run.screen ? "compat screen" : "compat world", canvas);
      if (!run.screen) textures.push(run.slot.texture);
      run.slot.rect = [rect.x, rect.y, rect.width, rect.height];
      canvas.width = canvas.height = 0;
    }
    report.worldKept = kept.size;
    report.keptLayers = layersOf([...kept, ...[...adopted.keys()].filter(run => run.screen)], viewbox);
    ctx.mark?.("world");

    const upload = (label: string, data: Float32Array) => {
      if (!data.length) return null;
      const buffer = device.buffer(label, data);
      buffers.push(buffer);
      return buffer;
    };
    let atlas: TrackedTexture | null = null;
    if (glyphCount && atlasCanvas) {
      atlas = device.texture("glyph atlas", atlasCanvas, { rows: atlasRows });
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
      windows: windowSources.map(item => ({ ...item })),
      ladder: worldRuns.length
        ? { base, level, bytes: worldRuns.reduce((n, run) => n + rgba(run.slot.texture), 0) }
        : null
    };
    const overlays = indexOverlays(runs, ctx.screen);
    // tracker entries older than every raster this frame or the previous one still draws can no longer matter
    compatDirt.prune(
      [...runs, ...(ctx.previous?.runs ?? [])].reduce((min, run) => Math.min(min, run.stamp), compatDirt.now())
    );
    // The frame's closures (release and the rest) share this function's scope, so keeping `ctx` alive keeps the frame it
    // was built beside alive, and that frame's own `ctx` after it: every prepare would chain the one before (about 6 MB
    // and 70 DOM nodes per prepare in the memory census). Nothing below this line reads the previous frame.
    ctx.previous = null;
    const prepared: Prepared = {
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
        reuse: report,
        windows: windowStats
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
      glyphLabels: retained ? [] : glyphLabels,
      release
    };
    // The first frame's sharp runs at device density (firstDetails), for a load or a camera bucket only: an edit's
    // prepare commits on its base rasters and the settle refinement sharpens it (the edit's GPU frame is not held back
    // by up to FIRST_DETAIL_MS). A stale job gives up like any other step.
    const first = await firstDetails(prepared, ctx, reserved, editOnly);
    if (first === "stale") {
      release();
      return null;
    }
    ctx.mark?.("detail");
    const uploaded: Record<string, number> = { "glyph atlas": frame.atlas?.bytes ?? 0 };
    for (const [key, label] of [
      ["fans", "fans"],
      ["segments", "segments"],
      ["caps", "stroke caps"],
      ["sprites", "sprites"],
      ["edges", "fill edges"],
      ["glyphs", "glyphs"]
    ] as const)
      uploaded[label] = frame[key]?.bytes ?? 0;
    const own = frameBytes(prepared);
    const steady = resident + reserveTarget + own;
    prepared.compat.memory = {
      resident,
      target: reserveTarget,
      slack: STEADY_SLACK,
      estimate,
      uploaded,
      frame: own,
      steady,
      budget: GPU_BUDGET,
      overrun: steadyOverrun(steady),
      firstDetails: first
    };
    if (prepared.compat.memory.overrun)
      console.warn(
        `GPU steady budget: ${mib(steady)} planned over ${mib(GPU_BUDGET)} (frame ${mib(own)}, target ${mib(reserveTarget)}, resident ${mib(resident)})`
      );
    return prepared;
  } catch (error) {
    release();
    throw error;
  }
}

// The room world rasters leave the view's sharp runs when the camera is zoomed past their base resolution: one detail
// at device density per sharp world run (each at most the refined view), at most DETAIL_SHARE, and never more than half
// the world room or past MIN_COMPAT_BUDGET of it. The 80 MiB flat target reserve used to leave this room by accident
// (the group target is 29.5 MB at 1280x720 DPR 2); sized to the actual target (targetReserve), world rasters would
// take it all and the settle detail of a zoomed view had none (dense parity world, k8: no detail at all).
export function detailShare(
  runs: readonly CompatRun[],
  base: number,
  camera: Camera,
  viewport: Viewport,
  room: number
): number {
  const sharp = runs.filter(run => run.sharp).length;
  if (!sharp || !detailShareEnabled()) return 0;
  const { visible, pixels } = refineView(camera, viewport);
  if (!(visible.width > 0) || pixels.width / visible.width <= base) return 0;
  const want = Math.min(DETAIL_SHARE, sharp * pixels.width * pixels.height * 4);
  return Math.max(0, Math.min(want, room / 2, room - MIN_COMPAT_BUDGET));
}

// Compat world rasters are cut once for the whole world, at most 2 px per unit and lower under budget pressure (1.1 px
// on the dense parity world): icons, markers and short labels drawn from them were unreadable in the first GPU frame
// of any zoom past 1 until the settle refinement replaced them (W2 TEXT). Before the frame commits, the sharp runs
// (SHARP_COMPAT: text, marker <svg>, burg icon vectors, <use> emblems, primitive shapes) get their settle detail for the
// camera the prepare started at: the request the settle refinement makes next, which then keeps them (releaseDetail
// keeps a matching request) instead of re-cutting. Bounded by FIRST_DETAIL_BUDGET, the room the steady budget leaves
// once the previous frame is gone (and the peak room beside it now) and FIRST_DETAIL_MS of wall time (smallest
// footprint first, so markers and icons before the precipitation field); runs whose base is already as dense as the
// screen are skipped. Detail is optional: a failure leaves the base. "stale" only when the job went stale. Not for a
// revision-only prepare (`editOnly`, an edit on the same camera bucket): the orchestrator's W3b call, so an edit's
// frame is not held back by up to FIRST_DETAIL_MS (its settle refinement sharpens it right after). Nor for a prepare
// behind the SVG (`ctx.behind`, W4 RESUME): the recovery from a context loss (0.7-1 s of the 100k restore was this pass)
// and the resume hold after an editor changed the model (0.15-0.2 s of the heightmap editor's resume), where the
// canonical SVG shows until the frame is current. The frame presents the world first and the settle refinement cuts
// the same details right after it.
export async function firstDetails(
  prepared: Prepared,
  ctx: PrepareContext,
  reserve: number,
  editOnly = false
): Promise<PrepareMemory["firstDetails"] | "stale"> {
  if (!firstDetailEnabled()) return "off";
  if (editOnly) return "revision only";
  if (ctx.behind) return ctx.behind;
  if (!prepared.runs.some(run => run.sharp && !run.screen && run.slot.texture)) return "none sharp";
  const { device } = ctx;
  // everything the frame holds, carried-over settle details included (they are tracked, and a detail this pass drops
  // gives its bytes back through `spent`)
  const start = device.memory().total;
  const steady = GPU_BUDGET - DETAIL_RESERVE - reserve - frameBytes(prepared);
  const deadline = performance.now() + FIRST_DETAIL_MS;
  const room = () => {
    if (performance.now() > deadline) return 0;
    const spent = device.memory().total - start;
    return Math.min(FIRST_DETAIL_BUDGET - spent, steady - spent, PEAK_LIMIT - device.memory().total);
  };
  if (room() <= 0) return "no room";
  const { visible, pixels } = refineView(ctx.camera, ctx.screen);
  try {
    await refineCompat(prepared, ctx, visible, pixels, GPU_BUDGET, {
      only: run => run.sharp,
      room,
      minGain: 1.01,
      first: true
    });
  } catch {
    // optional, like the settle refinement: the base rasters keep drawing
  }
  return ctx.stale() ? "stale" : prepared.compat.refine?.rasterized ? "cut" : "skipped";
}

function layersOf(runs: readonly CompatRun[], viewbox: Element): string[] {
  const ids = new Set<string>();
  for (const run of runs) {
    let node: Element | null = run.elements[0] ?? null;
    while (node?.parentElement && node.parentElement !== viewbox && node.parentElement !== viewbox.parentElement)
      node = node.parentElement;
    if (node) ids.add(node.id || node.tagName);
  }
  return [...ids];
}

// Pairs this prepare's compat runs with the previous frame's: same elements in the same order, same raster key, same
// stylesheet state, and clean in the reuse tracker (compat-reuse.ts) with no reference to a non-definition element.
// A clean run takes the previous texture (shared) and, while their bytes stay within the reused rasters, its settle
// detail; every other previous detail is released now, as a full re-prepare does at its start.
// On by default (COST W3), after bench/host/reuse-fidelity.ts (gate reuse-fidelity): per edit (zoom within a raster
// bucket, a marker move, a layer toggle) and layer family, the frame that reused rasters across the edit is as close to
// the SVG as a fresh prepare of the same state, current and refined; its self-test (a tracker blind to edits) fails.
// A definition change dirties only the runs that paint through it (compat-reuse.ts definitionIds), so emblems generated
// on zoom and a layer holding clip paths turned off no longer re-cut every run. The ladder is part of reuse: off, world
// rasters fit the budget exactly, as before W1. Opt out with ?gpu-compat-reuse=0 or a build with
// VITE_GPU_COMPAT_REUSE=0: the renderer then installs no tracker feed or outside-input watcher, and the dirty-run
// telemetry (lastPrepare.reuse reasons) reads "reuse off".
export function compatReuseEnabled(): boolean {
  if (import.meta.env?.VITE_GPU_COMPAT_REUSE === "0") return false;
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").get("gpu-compat-reuse") !== "0";
  } catch {
    return true;
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
    retained: false,
    keptLayers: []
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
  // What each run paints through (referenceClosure), recorded on every run: a definition change dirties only the runs
  // that name it, and a later frame reuses a run's raster only while its live external references are the same elements
  const document = svg.ownerDocument;
  const closures = new Map<CompatRun, ReturnType<typeof referenceClosure>>();
  const closureOf = (run: CompatRun) => {
    let closure = closures.get(run);
    if (!closure) {
      closure = referenceClosure(run.elements as unknown as Parameters<typeof referenceClosure>[0], id =>
        document.getElementById(id)
      );
      closures.set(run, closure);
      run.externals = closure.externals;
    }
    return closure;
  };
  if (style) for (const run of runs) closureOf(run);
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
    const closures = pairs.map(({ run }) => closureOf(run));
    const verdicts = compatDirt.evaluate(
      pairs.map(pair => pair.old),
      !!style.structural,
      closures.map(closure => closure.ids),
      style.references,
      closures.map(closure => [...closure.externals.values()]),
      id => styleReach(svg, style.scopes.get(id), pairs, closures)
    );
    pairs.forEach(({ run, old }, i) => {
      // a live element the run paints through (the states halo clips by #stateN paths): watched by the tracker while
      // it is the same element inside svg#map (the tracker sees only svg#map records), else never reused
      const { externals, external } = closures[i];
      const outside = [...externals].find(([, node]) => !svg.contains(node as unknown as Node));
      const why =
        verdicts[i] ||
        (outside
          ? `reference #${outside[0]}`
          : sameExternals(old.externals, externals)
            ? ""
            : `reference ${external} replaced`);
      if (why) count(why);
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
      // the same geometry: measuring it again would restyle the map (compat-bounds.ts measureBounds)
      if (old.bounds !== undefined) {
        run.bounds = old.bounds;
        run.boxes = old.boxes;
      }
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

// Which paired runs a change to a stylesheet-named definition can reach (CompatDirt.evaluate styleReach): those with an
// element, or a live element they paint through (referenceClosure externals), that is, contains or sits inside an
// element the naming rules match now. null (every run) when the rules are unknown (an at-rule names the id), their
// selectors do not parse, or one matches inside a definition or outside svg#map: content reached through a reference
// (a <use> of a matched path) is not followed here.
const DEFINITION_ANCESTOR = "defs, symbol, pattern, marker, clipPath, mask, filter, linearGradient, radialGradient";
function styleReach(
  svg: SVGSVGElement,
  selectors: readonly string[] | null | undefined,
  pairs: readonly { run: CompatRun }[],
  closures: readonly { externals: Map<string, ReuseNode> }[]
): ((run: number) => boolean) | null {
  if (!selectors?.length) return null;
  let matched: Element[];
  try {
    matched = [...svg.ownerDocument.querySelectorAll(selectors.join(","))];
  } catch {
    return null;
  }
  if (matched.some(element => !svg.contains(element) || element.closest(DEFINITION_ANCESTOR))) return null;
  if (!matched.length) return () => false;
  return i => {
    const reached = [
      ...pairs[i].run.elements,
      ...(closures[i].externals.values() as Iterable<unknown> as Iterable<Element>)
    ];
    return reached.some(element => matched.some(target => target.contains(element) || element.contains(target)));
  };
}

// Settle-time sharper raster of world compat runs for the visible region at backing resolution, alpha-cropped and kept
// within GPU_BUDGET (tracked total, so the base frame and target count). Returns false when stale, over budget or
// nothing to refine. Each slot draws its detail only while the view stays inside `covers`, else its base texture.
// A detail already cut for this exact request at full density, from content unchanged since (this frame's, or one
// prepareFrame carried over from a clean run), is kept where a full re-refine would allocate the same bytes; the
// export clone is cut only when some detail must be rasterized.
// The view a settle refinement cuts details for: the visible world plus 64 CSS px, at backing density plus 128 CSS px
// (the renderer's settle and prepareFrame's first-frame pass ask for the same request, so the second keeps the first).
export function refineView(
  camera: Camera,
  viewport: Viewport
): { visible: Region; pixels: { width: number; height: number } } {
  const [x0, y0, x1, y1] = visibleWorld(camera, viewport, 64);
  const margin = 128 * viewport.dpr;
  return {
    visible: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    pixels: {
      width: Math.round(viewport.width * viewport.dpr + margin),
      height: Math.round(viewport.height * viewport.dpr + margin)
    }
  };
}

export const refineRequest = (visible: Region, pixels: { width: number; height: number }) =>
  `${visible.x},${visible.y},${visible.width},${visible.height}@${pixels.width}x${pixels.height}`;

export interface RefineOptions {
  // only these world runs are considered (their details kept, cut or dropped); the others are left as they are
  only?: (run: CompatRun) => boolean;
  // bytes the pass may still allocate now (default: budget - tracked total)
  room?: () => number;
  // skip a run unless the detail would be more than `minGain` times denser than its base raster
  minGain?: number;
  // the first frame's pass (firstDetails): runs even with ?gpu-refine=0, which turns off only the settle refinement
  first?: boolean;
}

// Diagnosis switches (page URL flags, also golden `params=`):
// - ?gpu-refine=0 turns off only the settle refinement, so a golden run measures the first frame a prepare commits
//   (its first-frame details included) instead of the refined one;
// - ?gpu-first-detail=0 leaves the first frame on its base rasters (firstDetails off);
// - ?gpu-detail-share=0 gives world rasters the whole compat room when zoomed (detailShare off), the A/B arm for the
//   first-frame cost of that share to non-sharp layers.
const flagOn = (name: string) => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").get(name) !== "0";
  } catch {
    return true;
  }
};
export const firstDetailEnabled = (): boolean => flagOn("gpu-first-detail");
export const refineEnabled = (): boolean => flagOn("gpu-refine");
export const detailShareEnabled = (): boolean => flagOn("gpu-detail-share");

export async function refineCompat(
  prepared: Prepared,
  ctx: PrepareContext,
  visible: Region,
  pixels: { width: number; height: number },
  budget = GPU_BUDGET,
  options: RefineOptions = {}
): Promise<boolean> {
  if (!options.first && !refineEnabled()) return false;
  const { only } = options;
  const world = prepared.runs.filter(run => !run.screen && run.slot.texture && (!only || only(run)));
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
  // The first frame's pass has FIRST_DETAIL_MS for a fixed cost per run (serialize, decode, read back): the runs with
  // the most elements first (the rain, emblems, burg icons, armies), not three-element market runs.
  if (options.first) runs.sort((a, b) => b.elements.length - a.elements.length);
  const request = refineRequest(visible, pixels);
  const roomNow = options.room ?? (() => budget - device.memory().total);
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
  // every run this pass may cut, measured in one batch: one restyle at most (measureBounds)
  const viewbox = runs[0]?.elements[0]?.closest?.("#viewbox"); // absent on partial test elements
  if (viewbox)
    measureBounds(
      runs.filter(run => !kept.has(run)),
      viewbox
    );
  // Sharp runs share the room at one density instead of first come, first served: in a dense scene the runs refined
  // first took it all at full density and a view-wide one refined later (the rain at k 8) kept the 1 px-per-unit base.
  // Each sharp run's detail is at most `share` of the device density, sized from an estimate of the detail it cuts
  // (detailFootprint), against the room a full re-refine starts with (kept details freed).
  const sharpBytes = runs.reduce(
    (n, run) => (run.sharp ? n + detailFootprint(run, visible, density, kept.has(run)) : n),
    0
  );
  const startRoom = roomNow() + keptAfter;
  const share = sharpBytes > startRoom ? Math.sqrt(Math.max(0, startRoom) / sharpBytes) : 1;
  // The detail a raster alpha-cropped to `size` (null: fully transparent) becomes with `room` left: full (fit 1),
  // downscaled into the room (a sharp run to its share at most) while that still beats the base raster's density, or
  // none (null: the base stays).
  const decide = (size: [number, number] | null, room: number, cap = 1): number | null => {
    if (!size) return 1;
    const bytes = size[0] * size[1] * 4;
    const fit = Math.min(cap, bytes <= room ? 1 : Math.sqrt(Math.max(0, room) / bytes));
    if (fit >= 1) return 1;
    if (!(density * fit > prepared.compat.resolution)) return null;
    return Math.floor(size[0] * fit) >= 1 && Math.floor(size[1] * fit) >= 1 ? fit : null;
  };
  const report: { id: string; density: number }[] = [];
  prepared.compat.detail = report;
  prepared.compat.refine = stats;
  const windowStats = newWindowStats();
  prepared.compat.refineWindows = windowStats;
  let refined = false;
  let shared: WindowBatches<CompatRun> | null = null;
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
      const fit = decide(meta.size, roomNow() + keptAfter + bytes, run.sharp ? share : 1);
      if (fit === meta.fit) {
        entry.density = density * fit;
        stats.kept++;
        refined = true;
        continue;
      }
      drop(run);
      if (fit === null) continue; // it would keep the base: nothing to cut
    }
    // the base raster is already about as dense as the detail would be (k 1 with an unscaled base)
    if (options.minGain && density <= prepared.compat.resolution * options.minGain) continue;
    // the first frame's pass out of room (or past FIRST_DETAIL_MS): leave the rest to the settle refinement rather
    // than cut what it would drop (a full settle pass still cuts a fully transparent run as a null detail)
    if (options.first && roomNow() <= 0) continue;
    if (!clone) {
      clone = await compatClone(ctx.revision);
      stats.cloned = true;
      if (ctx.stale()) return false;
    }
    const resolved = resolveManyInClone(run.elements, clone);
    if (resolved.some(item => typeof item === "string")) return false;
    // the detail is cut at device density: dpr raster px per live CSS px, over the run's window of the visible raster
    // a kept detail dropped above: measured now
    if (viewbox) measureBounds([run], viewbox);
    // COST2: the runs this pass may still cut share decodes where their windows are disjoint (WindowBatches)
    shared ??= refineBatches(
      runs.slice(runs.indexOf(run)),
      kept,
      clone,
      visible,
      pixels,
      ctx.screen?.dpr ?? 1,
      windowStats
    );
    let cropped =
      (await shared.take(run)) ??
      (await rasterizeWindowed({
        clone,
        clones: resolved as Element[],
        full: visible,
        width: pixels.width,
        height: pixels.height,
        cssScale: ctx.screen?.dpr ?? 1, // absent in partial test contexts
        stats: windowStats,
        bounds: run.bounds ?? null,
        live: run.elements
      }));
    if (ctx.stale()) {
      if (cropped) cropped.canvas.width = cropped.canvas.height = 0;
      return false;
    }
    // Check the alpha-cropped allocation, not a hypothetical full viewport. Sparse labels and markers can fit
    // even when an uncropped viewport would exceed the budget. A run that cannot fit is downscaled into the remaining
    // headroom while that still beats the base raster's density, else it keeps the base.
    const size: [number, number] | null = cropped && [cropped.canvas.width, cropped.canvas.height];
    let room = roomNow();
    if (size && size[0] * size[1] * 4 > room && keptAfter) {
      // a full re-refine would see the room without the later kept details: free them, they are cut again in turn
      for (const later of kept) drop(later);
      kept.clear();
      keptAfter = 0;
      room = roomNow();
    }
    const fit = decide(size, room, run.sharp ? share : 1);
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
  await shared?.dispose();
  return refined;
}

// The batches a refinement pass cuts from (compat-bounds.ts WindowBatches): `runs` from the first one it cuts, without
// the details it may keep. A run the pass then skips (out of room, past FIRST_DETAIL_MS) leaves its cut unused.
function refineBatches(
  runs: readonly CompatRun[],
  kept: ReadonlySet<CompatRun>,
  clone: SVGSVGElement,
  visible: Region,
  pixels: { width: number; height: number },
  cssScale: number,
  stats: WindowStats
): WindowBatches<CompatRun> {
  const pending = runs.filter(run => !kept.has(run) && run.bounds);
  const resolved = resolveManyInClone(
    pending.flatMap(run => run.elements),
    clone
  );
  const members: [CompatRun, BatchMember][] = [];
  let at = 0;
  for (const run of pending) {
    const clones = resolved.slice(at, at + run.elements.length);
    at += run.elements.length;
    if (clones.some(item => typeof item === "string")) continue;
    members.push([run, { clones: clones as Element[], live: run.elements, bounds: run.bounds ?? null }]);
  }
  return new WindowBatches(
    { clone, full: visible, width: pixels.width, height: pixels.height, cssScale, stats },
    members
  );
}

// Bytes of the detail a settle refinement cuts for `run` over `visible` at `density` px per unit, at full density: a
// kept detail's own cut size (exact); else the smaller of two upper bounds, the run's base raster rect and the union of
// its element boxes (measureBounds), each clipped to the view, plus the crop's 1 px (and the window's padding). The base
// rect alone spans the world for a run of labels spread over it, so in a zoomed view with a few small labels every
// sharp run looked view-sized: six label runs (115 MB) against ~106 MB of room shared out a 0.96 density, and every
// label detail was resampled (shared fixture labels k4: ink 31585 GPU vs 22364 SVG px, coverage failed).
export function detailFootprint(run: CompatRun, visible: Region, density: number, kept = false): number {
  if (kept && run.detailMeta) {
    const size = run.detailMeta.size;
    return size ? size[0] * size[1] * 4 : 0;
  }
  // `pad` px on each side, plus the crop's 1 px
  const bytes = (box: Box | null, pad: number) =>
    box && box.x1 > box.x0 && box.y1 > box.y0
      ? Math.ceil((box.x1 - box.x0) * density + 2 * pad + 2) * Math.ceil((box.y1 - box.y0) * density + 2 * pad + 2) * 4
      : 0;
  const [x, y, w, h] = run.slot.rect;
  const rect = {
    x0: Math.max(x, visible.x),
    y0: Math.max(y, visible.y),
    x1: Math.min(x + w, visible.x + visible.width),
    y1: Math.min(y + h, visible.y + visible.height)
  };
  // the base rect is already the ink (alpha-cropped); geometric boxes miss what screen px add (text-shadow)
  const byRect = bytes(rect, 0);
  return run.boxes ? Math.min(byRect, bytes(boundsWithin(run.boxes, visible), WINDOW_PAD_PX)) : byRect;
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
      const style = computedStyleText(element, getComputedStyle(element), key => defaults.getPropertyValue(key));
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

// Releases every settle detail, except those cut for `keep` (a refineRequest): the settle refinement that follows
// keeps them itself where a full re-refine would cut the same (the prepare-time first-frame details, refineCompat).
export function releaseDetail(prepared: Prepared, device: GpuDevice, keep?: string): void {
  for (const run of prepared.runs)
    if (run.slot.detail && !(keep !== undefined && run.detailMeta?.request === keep)) {
      releaseShared(device, run.slot.detail.texture);
      run.slot.detail = null;
      run.detailMeta = undefined;
    }
}
