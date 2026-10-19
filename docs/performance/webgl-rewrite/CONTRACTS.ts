/**
 * Tupaia full WebGL renderer rewrite: CONTRACT DRAFT.
 * STATUS: ideation only. NOT implemented, NOT wired, NOT type-checked (no tsc was run). Type-only:
 * no runtime code, no imports, no new dependencies. The GPU core is raw WebGL2 behind GpuDevice;
 * three.js is not a dependency of this core.
 * "MUST" lines are invariants intended to become unit, property or golden tests (PROOF-PLAN.md).
 */

// ---------------------------------------------------------------- Camera
/** screen_css = k * world + (x, y); no rotation (public/main.js:190). */
export interface CameraState {
  readonly k: number;
  readonly x: number;
  readonly y: number;
  /** Bumped on every change; uniforms are re-uploaded only when it changes. */
  readonly revision: number;
}

/**
 * scaleExtent is NOT [0.8, 20].
 * - Boot: [1, 20] (main.js:238).
 * - fitMapToScreen: min = rn(max(svgW/graphW, svgH/graphH), 3) (options.js:213-222); may be <1 or >1.
 * - User clamp: min >= 0.01, max <= 200 (options.js:519-523). Restore default: [1, 20] (options.js:529-531).
 * - translateExtent: [0,0]..[graphW,graphH], or the padded variant (options.js:218-234).
 */
export interface ZoomExtent {
  readonly min: number; // MUST be >= 0.01
  readonly max: number; // MUST be <= 200; default 20
  readonly translate: readonly [[number, number], [number, number]];
}

export interface Camera {
  get(): CameraState;
  extent(): ZoomExtent;
  /** Same math as zoomTo (main.js:529-531): translate(-x*z + W/2, -y*z + H/2).scale(z). */
  zoomTo(worldX: number, worldY: number, k: number, durationMs?: number): void;
  screenToWorld(sx: number, sy: number): [number, number];
  worldToScreen(wx: number, wy: number): [number, number];
  /**
   * Column-major 3x3 clip matrix, for k <= ~50 and world <= ~8k px.
   * Above that, RTC: per-chunk translation is computed in float64 on the CPU.
   */
  clipMatrix(cssW: number, cssH: number, chunkOrigin?: [number, number]): Float32Array;
  /**
   * MUST NOT write any DOM. The hidden model #viewbox is synced only by syncModelTransform()
   * (on save, export or exit).
   */
  subscribe(fn: (s: CameraState) => void): () => void;
  syncModelTransform(): void;
}

// ---------------------------------------------------------------- Device
export interface GpuLimits {
  readonly maxTextureSize: number; // queried; renderer assumes >= 4096
  readonly timerQuery: boolean;
}

export interface GpuDevice {
  readonly gl: WebGL2RenderingContext;
  readonly limits: GpuLimits;
  /** DPR is capped at 2 (do NOT copy relief-viewport.ts:95). May drop to 1.5 under memory pressure. */
  readonly dpr: number;
  /** Sum of tracked allocations. Target 160 MB; no-go above 256 MB. */
  memoryBytes(): number;
  /** webglcontextlost: preventDefault; restore all resources from CPU-side IR within 500 ms. */
  onContextLost(fn: () => void): () => void;
  onContextRestored(fn: () => void): () => void;
  resize(cssW: number, cssH: number, dpr: number): void;
}

// ---------------------------------------------------------------- SceneDocument (P1 shadow -> P2 read -> P3 owned)
export type ElementId = string;

export interface SceneDocument {
  readonly schema: number;
  readonly meta: Record<string, string>;
  /** Options, including tupaiaLocks. */
  readonly options: Record<string, unknown>;
  /** window.grid / window.pack are referenced, not copied. */
  readonly world: { readonly grid: unknown; readonly pack: unknown };
  readonly labels: ReadonlyMap<ElementId, LabelRecord>;
  /** #terrain data-* settings (I6). */
  readonly relief: { readonly settings: Readonly<Record<string, string>> };
  /** Additive 4th biome field (save.ts:94-95). */
  readonly biomeExtras: unknown;
  /** Keyed by element id (I4). */
  readonly notes: ReadonlyMap<ElementId, unknown>;
  /** applyStyle selector -> attributes; also preset DOM writes. */
  readonly styleOverrides: ReadonlyMap<string, Readonly<Record<string, string>>>;
  readonly legend: unknown;
  readonly picker: unknown;
  /** DOM order (moveLayer), NOT drawLayers order. */
  readonly layers: readonly LayerRecord[];
  /** I5 allowlist: every attribute/data-* written anywhere round-trips, even if unknown to the renderer. */
  readonly unknownAttributes: ReadonlyMap<ElementId, Readonly<Record<string, string>>>;
  revision(layer: LayerId): number;
}

export interface LabelRecord {
  readonly id: ElementId;
  readonly group: string;
  readonly text: string;
  /** References defs #textPaths. */
  readonly pathId?: ElementId;
  /** Default "50%". */
  readonly startOffset?: string;
  readonly attrs: Readonly<Record<string, string>>;
}

export type LayerId = string; // e.g. "states", "zones", "routes", "terrain", ...

export interface LayerRecord {
  readonly id: LayerId;
  readonly visible: boolean; // layerIsOn state; data-layer-off honoured
  readonly mechanism: "native" | "compat";
  readonly attrs: Readonly<Record<string, string>>; // opacity, filter, mask, clip-path, style
}

export interface SaveCodec {
  /**
   * mapData is split on "\r\n" (the SVG section contains LF). SVG = mapData[5] (0-indexed); 46 sections.
   * MUST I1: parse(serialize(doc)) deep-equals doc.
   * MUST I2: serialize(parse(file)) === normalize(file); normalizations are declared
   *   (params date, icon newline collapse).
   * MUST I8: canonical size; camera not persisted.
   * MUST I9: #ruler/#tradeAnimation cleared; .viewport-culled stripped; dynamic parts restored first.
   * MUST I12: refuse while customization is active (save.ts:15).
   */
  parseText(file: string): SceneDocument;
  serializeText(doc: SceneDocument): string;
  /** I14: equal to the text path at the model level. */
  parseBinary(buf: ArrayBuffer): SceneDocument;
  serializeBinary(doc: SceneDocument): ArrayBuffer;
}

/** P3 only: editors mutate via commands; undo becomes a command journal (replaces cultures markup undo). */
export interface Command {
  readonly kind: string;
  apply(doc: SceneDocument): SceneDocument;
  invert(doc: SceneDocument): Command;
}

/** Lazy SVG for save, export, migrations and legacy consumers. Export needs a live, styled transient clone. */
export interface SvgMaterializer {
  materialize(doc: SceneDocument, opts: { live: boolean; includeOverlays: boolean }): SVGSVGElement;
}

// ---------------------------------------------------------------- Frame graph and layers
export interface LayerRenderer {
  readonly id: LayerId;
  /** Re-tessellate only when the layer revision changes. Workers allowed. */
  build(doc: SceneDocument, dev: GpuDevice): Promise<void>;
  /**
   * Called per frame. MUST NOT touch the DOM, call getBBox/getScreenCTM, or allocate per feature.
   */
  draw(dev: GpuDevice, cam: CameraState, pass: PassContext): void;
  /** Zoom-dependent style (label size (d+d/k)/2, halo d/k^0.8, markers, coastline filter k 1.5/2.6). */
  styleTick?(cam: CameraState): void;
  dispose(): void;
}

export interface PassContext {
  readonly target: "screen" | "offscreen" | "minimap" | "mesh3d" | "preview4x";
  readonly includeOverlays: boolean; // false for the mesh3d texture (I13)
}

/** Exact, off-frame capture of the source SVG/Canvas2D renderer into a texture. */
export interface CompatLane {
  /** Called at style/detail tick or idle only. MUST NOT run inside the frame callback. */
  capture(layer: LayerId, worldRect: [number, number, number, number], k: number, dpr: number): Promise<void>;
  /** Hysteresis: re-capture if k > captured*1.2 or k < captured/1.5 (dense-zoom.ts:431). */
  needsRecapture(layer: LayerId, cam: CameraState): boolean;
}

// ---------------------------------------------------------------- Text
export interface GlyphKey {
  readonly font: string;
  readonly weight: string;
  readonly style: string;
  /** Quantized with steps <= 12.5%; not fixed 1x/2x/4x buckets. */
  readonly sizeBucket: number;
  readonly dpr: number;
  readonly halo: boolean;
}

export interface TextLayout {
  /** Atlas is built only after document.fonts.load resolves for every used font. */
  ensureFonts(fonts: readonly string[]): Promise<void>;
  /**
   * Curved: glyphs are placed along the textPath polyline using startOffset/letter-spacing.
   * Positions MUST be within 1 px of SVG getStartPositionOfChar for pinned fonts.
   */
  layout(label: LabelRecord, k: number): Float32Array;
}

// ---------------------------------------------------------------- Picking
export interface PickHit {
  readonly layer: LayerId;
  readonly id: ElementId | number;
  /** Model node, used by the P2 bridge for synthetic dispatch. */
  readonly modelNode?: Element;
}

export interface PickService {
  /** CPU only. MUST NOT call readPixels. p95 <= 1 ms. */
  hover(sx: number, sy: number): PickHit | null;
  /** May use a GPU ID pass only when CPU candidates overlap. */
  click(sx: number, sy: number): Promise<PickHit | null>;
}

// ---------------------------------------------------------------- Editor bridge (P2)
export interface EditorBridge {
  /**
   * Hidden live model: in-document, visibility:hidden, pointer-events:none (NOT detached, NOT display:none).
   */
  readonly modelRoot: SVGSVGElement;
  /** Editor overlay SVG above the canvas: transient handles only; one root transform write per frame. */
  readonly overlayRoot: SVGSVGElement;
  /**
   * Synthetic mousedown on the hit node with view: window, button 0 and real clientX/Y; move/up on window.
   * MUST NOT also forward the native click. On a miss, click goes to #viewbox.
   */
  dispatch(hit: PickHit | null, ev: PointerEvent): void;
  /** True in brush modes: suppress camera pan for the gesture. */
  brushActive(): boolean;
}

/** Replaces d3.mouse/d3.pointer: camera inverse x node world matrix (parseTransform chain). No CTM read. */
export type PointerShim = (node: Element, clientX: number, clientY: number) => [number, number];

// ---------------------------------------------------------------- Renderer flag
/** ?renderer=svg|gpu, default "svg" through P2. Does NOT exist in source today. */
export type RendererMode = "svg" | "gpu";
