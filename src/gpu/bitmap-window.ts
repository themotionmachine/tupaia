// Bounded viewport cache for immutable decoded images (cached path/relief PNGs): uploads only the source pixels around
// the visible camera, copied 1:1 (never resampled), so GPU memory stays bounded while pixels stay exact.
// Owns only the GPU textures it creates; source images and their world rects are never modified.
// A source may carry a sharper detail image over part of it (the dense-zoom relief viewport): it is cropped to the same
// window and counted in the same budget, and the slot's detail covers only the cropped part (framegraph imageSource).
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

// A sharper image over part of a source: drawn instead of the source where it covers the whole view.
export interface WindowDetail {
  image: HTMLImageElement;
  rect: Rect4; // world rect its pixels are laid out over
  covers: Rect4; // world rect in which it stands in for the source (its element's box: beyond `rect` is transparent)
}

interface Source {
  image: HTMLImageElement;
  rect: Rect4;
  slot: ImageBatch;
  texture: TrackedTexture | null;
  detail: WindowDetail | null;
  detailTexture: TrackedTexture | null;
}

// The part of `detail.covers` a crop of its image stands in for: the crop's rect, except on a side where the crop
// reaches the image edge, which extends to the covered box's edge (the element's transparent margin is still covered).
export function detailCovers(detail: WindowDetail, plan: CropPlan): Rect4 {
  const { naturalWidth: width, naturalHeight: height } = detail.image;
  const [cx, cy, cw, ch] = detail.covers;
  const [px, py, pw, ph] = plan.rect;
  const x0 = plan.sx === 0 ? Math.min(cx, px) : px;
  const y0 = plan.sy === 0 ? Math.min(cy, py) : py;
  const x1 = plan.sx + plan.sw >= width ? Math.max(cx + cw, px + pw) : px + pw;
  const y1 = plan.sy + plan.sh >= height ? Math.max(cy + ch, py + ph) : py + ph;
  return [x0, y0, x1 - x0, y1 - y0];
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

  add(image: HTMLImageElement, rect: Rect4, opacity = 1, detail: WindowDetail | null = null): ImageBatch {
    if (this.disposed) throw new Error("BitmapWindows disposed");
    const slot: ImageBatch = { kind: "image", opacity, texture: null, rect: [...rect], screen: false, detail: null };
    const copy = detail && {
      image: detail.image,
      rect: [...detail.rect] as Rect4,
      covers: [...detail.covers] as Rect4
    };
    this.sources.push({ image, rect: [...rect], slot, texture: null, detail: copy, detailTexture: null });
    this.token++; // an in-flight job never saw this source: supersede it
    this.window = null;
    return slot;
  }

  get bytes(): number {
    let total = 0;
    for (const source of this.sources) total += (source.texture?.bytes ?? 0) + (source.detailTexture?.bytes ?? 0);
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
  // `limit` is the caller's memory allowance for the new set (old+new peak headroom, steady share). A margin around the
  // view must also fit maxBytes; the visible-only crops need only fit `limit` (visible first: a 1512x982 world at k 1
  // needs ~68 MiB of visible crops for its three canonical bitmaps, over the 64 MiB margin cap, and showed the SVG).
  // Measured (RES2, ~/.tupaia-gates/w3b-res2/win-*-10k-hrb.log): a generated 10k-cell 1512x982 world in a 1512x982
  // window at DPR 2, heightmap, biomes and relief on, vignette off: 68.0 MiB of visible crops, covered at load; with
  // the visible crops held to the cap, "GPU window miss at k=1" and the SVG shows. The parity world (1280x720) needs
  // 42.3 MiB at any window size, so only worlds larger than the window bind.
  // Throws on canvas/upload failure after releasing every texture it created.
  async refresh(camera: Camera, viewport: Viewport, stale?: () => boolean, limit = Infinity): Promise<boolean> {
    if (this.disposed) return false;
    const token = ++this.token;
    const sources = [...this.sources];
    const visibleBudget = Number.isFinite(limit) ? Math.max(0, limit) : this.maxBytes;
    const chosen = this.choose(sources, camera, viewport, Math.min(this.maxBytes, limit), visibleBudget);
    if (!chosen) return false;

    const canvases: (HTMLCanvasElement | null)[] = [];
    const detailCanvases: (HTMLCanvasElement | null)[] = [];
    const created: TrackedTexture[] = [];
    const live = () => token === this.token && !this.disposed && !stale?.();
    try {
      for (let i = 0; i < sources.length; i++) {
        const plan = chosen.plans[i];
        canvases.push(plan && copyPixels(sources[i].image, plan));
        const detailPlan = chosen.details[i];
        detailCanvases.push(detailPlan && copyPixels(sources[i].detail!.image, detailPlan));
      }
      await Promise.resolve(); // let a newer refresh/release supersede before allocating GPU memory
      if (!live()) return false;
      const upload = (canvas: HTMLCanvasElement | null, label: string) => {
        if (!canvas) return null;
        const texture = this.device.texture(label, canvas);
        created.push(texture);
        return texture;
      };
      const textures = canvases.map((canvas, i) => upload(canvas, `bitmap-window-${i}`));
      const details = detailCanvases.map((canvas, i) => upload(canvas, `bitmap-window-${i} detail`));
      if (!live()) {
        for (const texture of created) this.device.release(texture);
        return false;
      }
      sources.forEach((source, i) => {
        const old = [source.texture, source.detailTexture];
        source.texture = textures[i];
        source.slot.texture = textures[i];
        source.slot.rect = chosen.plans[i]?.rect ?? [...source.rect];
        // no detail crop (none, outside the window or dropped to fit): the source alone, as before the detail existed
        const detailPlan = chosen.details[i];
        source.detailTexture = details[i];
        source.slot.detail =
          detailPlan && details[i]
            ? { texture: details[i], rect: detailPlan.rect, covers: detailCovers(source.detail!, detailPlan) }
            : null;
        for (const texture of old) if (texture) this.device.release(texture);
      });
      this.window = chosen.window;
      this.committedMargin = chosen.margin;
      return true;
    } catch (error) {
      for (const texture of created) this.device.release(texture);
      throw error;
    } finally {
      for (const canvas of [...canvases, ...detailCanvases]) if (canvas) canvas.width = canvas.height = 0;
    }
  }

  // Drops owned textures and coverage, keeps sources; supersedes any in-flight refresh. Idempotent.
  release(): void {
    this.token++;
    this.window = null;
    for (const source of this.sources) {
      this.device.release(source.texture);
      this.device.release(source.detailTexture);
      source.texture = source.slot.texture = source.detailTexture = null;
      source.slot.detail = null;
    }
  }

  dispose(): void {
    this.release();
    this.disposed = true;
    this.sources = [];
  }

  // Largest margin (halving down to 0) whose summed RGBA crop bytes, details included, fit `budget` (`visibleBudget`
  // for the visible-only crops). When even the visible-only crops do not fit with their details, the visible-only crops
  // without details (each slot draws its source, as it does before a detail image exists); null when those do not fit
  // either.
  private choose(sources: Source[], camera: Camera, viewport: Viewport, budget: number, visibleBudget = budget) {
    const max = this.device.maxTextureSize;
    const plan = (image: HTMLImageElement, rect: Rect4, window: Rect4) =>
      cropPlan(rect, image.naturalWidth, image.naturalHeight, window);
    const crops = (window: Rect4, margin: number, withDetails: boolean) => {
      const plans = sources.map(s => plan(s.image, s.rect, window));
      const details = sources.map(s => (withDetails && s.detail ? plan(s.detail.image, s.detail.rect, window) : null));
      let bytes = 0;
      for (const item of [...plans, ...details]) {
        if (!item) continue;
        bytes += item.sw * item.sh * 4;
        if (item.sw > max || item.sh > max) return null;
      }
      return bytes <= (margin > 0 ? budget : Math.max(budget, visibleBudget))
        ? { window, plans, details, margin }
        : null;
    };
    let margin = Math.max(0, this.marginCss);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const window = visibleWorld(camera, viewport, margin);
      const chosen = crops(window, margin, true);
      if (chosen) return chosen;
      if (margin === 0) return sources.some(s => s.detail) ? crops(window, 0, false) : null;
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
