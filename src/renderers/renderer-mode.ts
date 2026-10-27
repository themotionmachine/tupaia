// Renderer routing behind ?renderer=svg|gpu. GPU is the default display (W5); the hidden SVG stays the editable model
// (D9). ?renderer=svg opts out: it never probes WebGL, loads GPU code or allocates GPU resources, and an unknown or
// conflicting value is treated the same way, with a warning. A gpu request (default or explicit) is probed, then the
// P1 backend module is loaded lazily; no WebGL2, or any init, load, prepare or restore failure, falls back to the
// canonical SVG, which save/export always use.
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

// The probe context is released immediately; the canvas is never attached to the document.
export function probeWebGL2(createCanvas?: () => HTMLCanvasElement | OffscreenCanvas): RendererCapabilities {
  try {
    const canvas =
      createCanvas?.() ??
      (typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(1, 1)
        : typeof document !== "undefined"
          ? document.createElement("canvas")
          : null);
    if (!canvas) return { webgl2: false, reason: "No canvas implementation" };
    const gl = (canvas as { getContext(id: "webgl2"): unknown }).getContext("webgl2") as WebGL2RenderingContext | null;
    if (!gl) return { webgl2: false, reason: "WebGL2 context unavailable" };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { webgl2: true };
  } catch (error) {
    return { webgl2: false, reason: `WebGL2 probe failed: ${errorText(error)}` };
  }
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
  probe?: () => RendererCapabilities;
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
    const capabilities = (this.options.probe ?? probeWebGL2)();
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

declare global {
  interface Window {
    rendererStatus: typeof rendererStatus;
  }
}
window.rendererStatus = rendererStatus;
