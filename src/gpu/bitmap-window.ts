// Bounded viewport cache for immutable decoded images (cached path/relief PNGs): uploads only the source pixels around
// the visible camera, copied 1:1 (never resampled), so GPU memory stays bounded while pixels stay exact.
// Owns only the GPU textures it creates; source images and their world rects are never modified.
import { type Camera, type Viewport, visibleWorld } from "./camera";
import type { GpuDevice, TrackedTexture } from "./device";
import type { ImageBatch } from "./framegraph";

type Rect4 = [number, number, number, number];

// Integer source-pixel crop and the exact world rect those pixels occupy
export interface CropPlan {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  rect: Rect4; // [x, y, width, height]
}

interface Source {
  image: HTMLImageElement;
  rect: Rect4;
  slot: ImageBatch;
  texture: TrackedTexture | null;
}

const MAX_ATTEMPTS = 16; // margin halving: 640 css px reaches 0 in 11 steps

// Source pixels of an image laid out over world `rect` that intersect world box `view` ([x0, y0, x1, y1]),
// floored/ceiled plus a one-pixel gutter and clamped to the image. null when nothing intersects.
export function cropPlan(rect: Rect4, width: number, height: number, view: Rect4): CropPlan | null {
  const [rx, ry, rw, rh] = rect;
  if (!(width > 0 && height > 0 && rw > 0 && rh > 0)) return null;
  const px = width / rw,
    py = height / rh;
  const sx = Math.max(0, Math.floor((view[0] - rx) * px) - 1);
  const sy = Math.max(0, Math.floor((view[1] - ry) * py) - 1);
  const ex = Math.min(width, Math.ceil((view[2] - rx) * px) + 1);
  const ey = Math.min(height, Math.ceil((view[3] - ry) * py) + 1);
  if (!(ex > sx && ey > sy)) return null;
  return { sx, sy, sw: ex - sx, sh: ey - sy, rect: [rx + sx / px, ry + sy / py, (ex - sx) / px, (ey - sy) / py] };
}

export class BitmapWindows {
  private sources: Source[] = [];
  private window: Rect4 | null = null; // last committed capture box [x0, y0, x1, y1], unclipped
  private committedMargin = 0;
  private token = 0;
  private disposed = false;

  constructor(
    private device: GpuDevice,
    private marginCss = 640,
    private maxBytes = 80 << 20
  ) {}

  add(image: HTMLImageElement, rect: Rect4, opacity = 1): ImageBatch {
    if (this.disposed) throw new Error("BitmapWindows disposed");
    const slot: ImageBatch = { kind: "image", opacity, texture: null, rect: [...rect], screen: false, detail: null };
    this.sources.push({ image, rect: [...rect], slot, texture: null });
    this.token++; // an in-flight job never saw this source: supersede it
    this.window = null;
    return slot;
  }

  get bytes(): number {
    let total = 0;
    for (const source of this.sources) total += source.texture?.bytes ?? 0;
    return total;
  }

  get size(): number {
    return this.sources.length;
  }

  // CSS-pixel margin the committed window was captured with (0 when visible-only fit the budget, or none committed)
  get margin(): number {
    return this.window ? this.committedMargin : 0;
  }

  // Visible world grown by `margin` CSS px lies inside the committed window. Transparent area beyond the images is
  // covered too: the window is the unclipped capture box, slots outside it are known transparent.
  covers(camera: Camera, viewport: Viewport, margin = 0): boolean {
    const w = this.window;
    if (!w) return false;
    const [x0, y0, x1, y1] = visibleWorld(camera, viewport, margin);
    return x0 >= w[0] && y0 >= w[1] && x1 <= w[2] && y1 <= w[3];
  }

  // Resolves true once new crops are bound; false when stale, superseded or over budget (old bindings kept).
  // `limit` caps the new set's bytes on top of maxBytes (callers pass their old+new peak headroom).
  // Throws on canvas/upload failure after releasing every texture it created.
  async refresh(camera: Camera, viewport: Viewport, stale?: () => boolean, limit = Infinity): Promise<boolean> {
    if (this.disposed) return false;
    const token = ++this.token;
    const sources = [...this.sources];
    const chosen = this.choose(sources, camera, viewport, Math.min(this.maxBytes, limit));
    if (!chosen) return false;

    const canvases: (HTMLCanvasElement | null)[] = [];
    const created: TrackedTexture[] = [];
    const live = () => token === this.token && !this.disposed && !stale?.();
    try {
      for (let i = 0; i < sources.length; i++) {
        const plan = chosen.plans[i];
        canvases.push(plan && copyPixels(sources[i].image, plan));
      }
      await Promise.resolve(); // let a newer refresh/release supersede before allocating GPU memory
      if (!live()) return false;
      const textures = canvases.map((canvas, i) => {
        if (!canvas) return null;
        const texture = this.device.texture(`bitmap-window-${i}`, canvas);
        created.push(texture);
        return texture;
      });
      if (!live()) {
        for (const texture of created) this.device.release(texture);
        return false;
      }
      sources.forEach((source, i) => {
        const old = source.texture;
        source.texture = textures[i];
        source.slot.texture = textures[i];
        source.slot.rect = chosen.plans[i]?.rect ?? [...source.rect];
        if (old) this.device.release(old);
      });
      this.window = chosen.window;
      this.committedMargin = chosen.margin;
      return true;
    } catch (error) {
      for (const texture of created) this.device.release(texture);
      throw error;
    } finally {
      for (const canvas of canvases) if (canvas) canvas.width = canvas.height = 0;
    }
  }

  // Drops owned textures and coverage, keeps sources; supersedes any in-flight refresh. Idempotent.
  release(): void {
    this.token++;
    this.window = null;
    for (const source of this.sources) {
      this.device.release(source.texture);
      source.texture = source.slot.texture = null;
    }
  }

  dispose(): void {
    this.release();
    this.disposed = true;
    this.sources = [];
  }

  // Largest margin (halving down to 0) whose summed RGBA crop bytes fit `budget`; null when even visible-only doesn't.
  private choose(sources: Source[], camera: Camera, viewport: Viewport, budget: number) {
    const max = this.device.maxTextureSize;
    let margin = Math.max(0, this.marginCss);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const window = visibleWorld(camera, viewport, margin);
      const plans = sources.map(s => cropPlan(s.rect, s.image.naturalWidth, s.image.naturalHeight, window));
      let bytes = 0;
      let fits = true;
      for (const plan of plans) {
        if (!plan) continue;
        bytes += plan.sw * plan.sh * 4;
        if (plan.sw > max || plan.sh > max) fits = false;
      }
      if (fits && bytes <= budget) return { window, plans, margin };
      if (margin === 0) return null;
      margin = margin < 2 || attempt >= MAX_ATTEMPTS - 2 ? 0 : margin / 2;
    }
    return null;
  }
}

function copyPixels(image: HTMLImageElement, plan: CropPlan): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = plan.sw;
  canvas.height = plan.sh;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas2D unavailable");
  context.imageSmoothingEnabled = false;
  context.drawImage(image, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.sw, plan.sh);
  return canvas;
}
