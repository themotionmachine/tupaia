// Renderer routing behind ?renderer=svg|gpu. GPU is the default display (W5); the hidden SVG stays the editable model
// (D9). ?renderer=svg opts out: it never probes WebGL, loads GPU code or allocates GPU resources, and an unknown or
// conflicting value is treated the same way, with a warning. A gpu request (default or explicit) is probed, then the
// P1 backend module is loaded lazily; no WebGL2 (for the default, no hardware WebGL2: a software rasterizer is refused
// unless ?renderer=gpu names it), or any init, load, prepare or restore failure, falls back to the canonical SVG, which
// save/export always use.
import type { GpuRenderer } from "../gpu/renderer";

export type RendererKind = "svg" | "gpu";

export interface RendererPreference {
  requested: RendererKind;
  source: "default" | "query";
  raw: string | null;
  warning?: string;
}

export interface RendererCapabilities {
  webgl2: boolean;
  reason?: string;
}

export interface RendererBackend {
  readonly kind: RendererKind;
  worldReplaced(world: number): void;
  dispose(): void;
  telemetry?(): unknown;
}

export interface RendererHost {
  // asynchronous backend failures (lazy load, prepare, context restore)
  fallBack(reason: string): void;
}

export type RendererBackendFactory = (host: RendererHost) => RendererBackend;

export interface RendererStatus {
  requested: RendererKind;
  active: RendererKind;
  fallbackReason: string;
  warnings: string[];
  capabilities: RendererCapabilities | null;
  world: number;
  started: boolean;
  disposed: boolean;
  gpu?: unknown; // backend telemetry: state, memory, pending work, compat report
}

export const GPU_UNAVAILABLE_REASON = "No GPU backend registered";

export function parseRendererPreference(search: string): RendererPreference {
  const values = new URLSearchParams(search).getAll("renderer");
  if (!values.length) return { requested: "gpu", source: "default", raw: null };
  const raw = values[values.length - 1],
    normalized = new Set(values.map(value => value.trim().toLowerCase()));
  if (normalized.size > 1)
    return { requested: "svg", source: "query", raw, warning: `Conflicting renderer values: ${values.join(", ")}` };
  const [value] = normalized;
  if (value === "svg" || value === "gpu") return { requested: value, source: "query", raw };
  return { requested: "svg", source: "query", raw, warning: `Unknown renderer "${raw}"; using svg` };
}

export interface ProbeOptions {
  // W5 default display only: a software WebGL2 (SwiftShader, llvmpipe, Microsoft Basic Render Driver...) would make the
  // default map slower than the SVG it replaces, so it is refused. An explicit ?renderer=gpu skips this guard: the
  // bench and headless harnesses (some on SwiftShader) name it on purpose.
  hardwareOnly?: boolean;
}

// Renderer names (WEBGL_debug_renderer_info) of software rasterizers.
export const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i;
const UNMASKED_RENDERER_WEBGL = 0x9246; // WEBGL_debug_renderer_info.UNMASKED_RENDERER_WEBGL

// The probe context is released immediately; the canvas is never attached to the document.
export function probeWebGL2(
  createCanvas?: () => HTMLCanvasElement | OffscreenCanvas,
  { hardwareOnly = false }: ProbeOptions = {}
): RendererCapabilities {
  try {
    const canvas =
      createCanvas?.() ??
      (typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(1, 1)
        : typeof document !== "undefined"
          ? document.createElement("canvas")
          : null);
    if (!canvas) return { webgl2: false, reason: "No canvas implementation" };
    // failIfMajorPerformanceCaveat: the browser itself reports a software or blocklisted-GPU context as unavailable
    const gl = (canvas as { getContext(id: "webgl2", options?: WebGLContextAttributes): unknown }).getContext(
      "webgl2",
      hardwareOnly ? { failIfMajorPerformanceCaveat: true } : undefined
    ) as WebGL2RenderingContext | null;
    if (!gl)
      return {
        webgl2: false,
        reason: hardwareOnly
          ? "WebGL2 unavailable without a major performance caveat (no hardware GPU)"
          : "WebGL2 context unavailable"
      };
    // Browsers that do not flag the caveat still name the rasterizer, when they expose the (deprecated) extension.
    const software = hardwareOnly ? softwareRenderer(gl) : "";
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    if (software)
      return { webgl2: false, reason: `Software WebGL renderer (${software}); add ?renderer=gpu to force it` };
    return { webgl2: true };
  } catch (error) {
    return { webgl2: false, reason: `WebGL2 probe failed: ${errorText(error)}` };
  }
}

// The unmasked renderer name when it is a software rasterizer, else "" (also when the extension is absent).
function softwareRenderer(gl: WebGL2RenderingContext): string {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  if (!info) return "";
  const name = gl.getParameter(UNMASKED_RENDERER_WEBGL);
  return typeof name === "string" && SOFTWARE_RENDERER.test(name) ? name : "";
}

const svgBackend = (): RendererBackend => ({
  kind: "svg",
  worldReplaced: () => undefined,
  dispose: () => undefined
});
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function disposeQuietly(backend: RendererBackend | null): string {
  try {
    backend?.dispose();
    return "";
  } catch (error) {
    return `Dispose failed: ${errorText(error)}`;
  }
}

export interface RendererRouterOptions {
  search: string;
  probe?: (options: ProbeOptions) => RendererCapabilities;
  gpuBackend?: RendererBackendFactory;
}

export class RendererRouter {
  private preference: RendererPreference;
  private backend: RendererBackend | null = null;
  private status: RendererStatus;

  constructor(private options: RendererRouterOptions) {
    this.preference = parseRendererPreference(options.search);
    this.status = {
      requested: this.preference.requested,
      active: "svg",
      fallbackReason: "",
      warnings: this.preference.warning ? [this.preference.warning] : [],
      capabilities: null,
      world: 0,
      started: false,
      disposed: false
    };
  }

  start(): RendererStatus {
    if (this.status.started || this.status.disposed) return this.snapshot();
    this.status.started = true;
    if (this.preference.requested === "gpu") this.backend = this.tryGpu();
    this.backend ??= svgBackend();
    this.status.active = this.backend.kind;
    return this.snapshot();
  }

  // Called after generate/load/resample replaced pack/grid and the #map DOM. Backend failures fall back to SVG.
  worldReplaced(): number {
    if (!this.status.started || this.status.disposed || !this.backend) return this.status.world;
    const world = ++this.status.world;
    try {
      this.backend.worldReplaced(world);
    } catch (error) {
      this.fallBack(`World replace failed: ${errorText(error)}`);
    }
    return world;
  }

  dispose(): void {
    if (this.status.disposed) return;
    this.status.disposed = true;
    const warning = disposeQuietly(this.backend);
    this.backend = null;
    if (warning) this.status.warnings.push(warning);
  }

  snapshot(): RendererStatus {
    const snapshot: RendererStatus = { ...this.status, warnings: [...this.status.warnings] };
    if (this.backend?.telemetry) snapshot.gpu = this.backend.telemetry();
    return snapshot;
  }

  private tryGpu(): RendererBackend | null {
    // the default display refuses software WebGL; an explicit ?renderer=gpu takes whatever WebGL2 there is
    const options: ProbeOptions = { hardwareOnly: this.preference.source === "default" };
    const capabilities = this.options.probe ? this.options.probe(options) : probeWebGL2(undefined, options);
    this.status.capabilities = capabilities;
    if (!capabilities.webgl2) {
      this.status.fallbackReason = capabilities.reason || "WebGL2 unavailable";
      return null;
    }
    if (!this.options.gpuBackend) {
      this.status.fallbackReason = GPU_UNAVAILABLE_REASON;
      return null;
    }
    let backend: RendererBackend | null = null;
    const host: RendererHost = {
      fallBack: reason => {
        if (backend && this.backend === backend && !this.status.disposed) this.fallBack(reason);
      }
    };
    try {
      backend = this.options.gpuBackend(host);
      if (backend.kind !== "gpu") throw new Error(`Backend reported ${backend.kind}`);
      return backend;
    } catch (error) {
      this.status.fallbackReason = `GPU init failed: ${errorText(error)}`;
      const warning = disposeQuietly(backend);
      if (warning) this.status.warnings.push(warning);
      return null;
    }
  }

  private fallBack(reason: string): void {
    const failed = this.backend;
    this.backend = svgBackend();
    this.status.active = "svg";
    this.status.fallbackReason = reason;
    console.warn(`Renderer fallback: ${reason}`);
    const warning = disposeQuietly(failed);
    if (warning) this.status.warnings.push(warning);
  }
}

// The GPU module is imported only here, on demand; type-only imports keep it out of the default bundle path.
export const lazyGpuBackend: RendererBackendFactory = host => {
  let renderer: GpuRenderer | null = null;
  let release: (renderer: GpuRenderer) => void = () => undefined;
  let disposed = false;
  let world = 0;
  const destroy = () => {
    const current = renderer;
    renderer = null;
    if (!current) return;
    release(current);
    current.dispose();
  };
  import("../gpu/renderer")
    .then(module => {
      if (disposed) return;
      release = module.detachGpuGlobals;
      renderer = module.createGpuRenderer(host.fallBack);
      // a fallback raised during construction disposed this shell before the renderer was assigned
      if (disposed) return destroy();
      if (world) renderer.worldReplaced(world);
    })
    .catch(error => host.fallBack(`GPU load failed: ${errorText(error)}`));
  return {
    kind: "gpu",
    worldReplaced(next) {
      world = next;
      renderer?.worldReplaced(next);
    },
    telemetry: () => renderer?.telemetry() ?? { state: disposed ? "disposed" : "loading" },
    dispose() {
      disposed = true;
      destroy();
    }
  };
};

const router = new RendererRouter({
  search: typeof location === "undefined" ? "" : location.search,
  gpuBackend: lazyGpuBackend
});
const status = router.start();
// Diagnostics only when something did not go as asked: a GPU request that fell back at start, or a warning (an unknown
// or conflicting ?renderer=). The normal default-GPU load and an explicit ?renderer=svg log nothing. Later fallbacks
// (load, prepare, restore) are logged by RendererRouter.fallBack.
if (status.active !== status.requested || status.warnings.length)
  console.warn("Renderer:", status.active, status.fallbackReason, ...status.warnings);
if (typeof window.addEventListener === "function")
  for (const event of ["map:generated", "map:loaded", "map:resampled"])
    window.addEventListener(event, () => router.worldReplaced());

export function rendererStatus(): RendererStatus {
  return router.snapshot();
}

// Whether the page gets the Navigate/Edit mode controller (controllers/index.ts): GPU requested and active, read at
// start-up, after the router's synchronous start. A start-time fallback (no hardware WebGL2, init failure) means none.
export function renderModeWanted(status: Pick<RendererStatus, "requested" | "active">): boolean {
  return status.requested === "gpu" && status.active === "gpu";
}

declare global {
  interface Window {
    rendererStatus: typeof rendererStatus;
  }
}
window.rendererStatus = rendererStatus;
