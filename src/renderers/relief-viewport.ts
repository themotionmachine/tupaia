import { loadReliefSprite, peekReliefRasterSprite, peekReliefSprite } from "./relief-canvas";
import { createReliefWorkerPainter } from "./relief-raster-worker";
export interface RasterGlyph {
  x: number;
  y: number;
  radius: number;
  sourceId?: string;
}
type Bounds = [number, number, number, number];
type Request = { glyphs: RasterGlyph[]; bounds: Bounds; scale: number };
const svg = "http://www.w3.org/2000/svg";
export interface ReliefViewport {
  paint(glyphs: RasterGlyph[], bounds: Bounds, scale: number): boolean;
  covers(viewport: Bounds): boolean;
  readonly ready: boolean;
  readonly pending: boolean;
  readonly failed: boolean;
  dispose(): void;
}
export function createReliefViewport(
  overlay: SVGGElement,
  onChange: () => void = () => {}
): ReliefViewport | undefined {
  if (typeof document.createElement !== "function") return;
  const canvas = document.createElement("canvas"),
    context = canvas.getContext("2d");
  if (!context || typeof canvas.toBlob !== "function") return;
  const workerPainter = createReliefWorkerPainter();
  const drawContext = context,
    world = (window as unknown as { pack?: unknown }).pack;
  let image: SVGImageElement | undefined,
    url: string | undefined,
    busy = false,
    failed = false,
    disposed = false,
    generation = 0;
  let queued: Request | undefined, renderedBounds: Bounds | undefined;
  const urls = new Set<string>();
  const revoke = (value: string) => {
    URL.revokeObjectURL(value);
    urls.delete(value);
  };
  const covers = (outer: Bounds | undefined, inner: Bounds) =>
    !!outer && inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
  const coversViewport = (outer: Bounds | undefined, padded: Bounds) => {
    const dx = (padded[2] - padded[0]) / 7,
      dy = (padded[3] - padded[1]) / 7;
    return covers(outer, [padded[0] + dx, padded[1] + dy, padded[2] - dx, padded[3] - dy]);
  };
  const valid = (token: number) =>
    token === generation &&
    !disposed &&
    overlay.isConnected !== false &&
    (window as unknown as { pack?: unknown }).pack === world;
  function paint(glyphs: RasterGlyph[], bounds: Bounds, scale: number): boolean {
    if (disposed || failed) return false;
    const ids = [...new Set(glyphs.map(glyph => glyph.sourceId!))];
    if (ids.length > 48) return false;
    const atlas = new Map(ids.map(id => [id, peekReliefRasterSprite(id)]));
    const sources = glyphs.map(glyph => atlas.get(glyph.sourceId!));
    if (sources.some(source => !source)) {
      if (ids.some(id => peekReliefSprite(id) && !atlas.get(id))) return false;
      if (!busy) {
        busy = true;
        const token = generation;
        Promise.all(ids.map(loadReliefSprite)).then(
          () => {
            if (valid(token)) {
              busy = false;
              onChange();
            }
          },
          () => {
            if (valid(token)) {
              busy = false;
              failed = true;
              onChange();
            }
          }
        );
      }
      return false;
    }
    if (image && !coversViewport(renderedBounds, bounds)) {
      image.remove();
      image = undefined;
    }
    if (busy) {
      queued = { glyphs, bounds, scale };
      return !!image;
    }
    const [x0, y0, x1, y1] = bounds,
      width = x1 - x0,
      height = y1 - y0;
    const ratio = Math.min(scale * Math.max(1, window.devicePixelRatio || 1), 4096 / width, 4096 / height);
    if (!Number.isFinite(ratio) || ratio <= 0) return false;
    busy = true;
    const token = generation;
    const receiveBlob = (blob: Blob | null) => {
      if (!valid(token)) {
        busy = false;
        return;
      }
      if (!blob) {
        busy = false;
        failed = true;
        onChange();
        return;
      }
      const nextURL = URL.createObjectURL(blob),
        decoded = new Image();
      urls.add(nextURL);
      decoded.onload = () => {
        if (!valid(token)) {
          revoke(nextURL);
          busy = false;
          return;
        }
        const latest = queued;
        queued = undefined;
        if (!latest || coversViewport(bounds, latest.bounds)) {
          const next = document.createElementNS(svg, "image");
          next.setAttribute("data-relief-viewport", "");
          next.setAttribute("pointer-events", "none");
          next.setAttribute("x", String(x0));
          next.setAttribute("y", String(y0));
          next.setAttribute("width", String(width));
          next.setAttribute("height", String(height));
          next.setAttribute("href", nextURL);
          overlay.replaceChildren(next);
          image = next;
          renderedBounds = [...bounds];
          if (url) revoke(url);
          url = nextURL;
        } else revoke(nextURL);
        busy = false;
        if (latest) paint(latest.glyphs, latest.bounds, latest.scale);
        onChange();
      };
      decoded.onerror = () => {
        revoke(nextURL);
        if (valid(token)) {
          busy = false;
          failed = true;
          onChange();
        }
      };
      decoded.src = nextURL;
    };
    const renderMain = () => {
      try {
        canvas.width = Math.max(1, Math.ceil(width * ratio));
        canvas.height = Math.max(1, Math.ceil(height * ratio));
        drawContext.setTransform(ratio, 0, 0, ratio, -x0 * ratio, -y0 * ratio);
        glyphs.forEach((glyph, index) => {
          drawContext.drawImage(
            sources[index] as HTMLCanvasElement,
            glyph.x - glyph.radius / 2,
            glyph.y - glyph.radius / 2,
            glyph.radius,
            glyph.radius
          );
        });
      } catch {
        busy = false;
        failed = true;
        onChange();
        return;
      }

      try {
        canvas.toBlob(receiveBlob, "image/png");
      } catch {
        busy = false;
        failed = true;
        onChange();
      }
    };
    if (workerPainter.available) {
      void workerPainter
        .paint(
          glyphs,
          sources as HTMLCanvasElement[],
          bounds,
          ratio,
          Math.max(1, Math.ceil(width * ratio)),
          Math.max(1, Math.ceil(height * ratio))
        )
        .then(blob => {
          if (!valid(token)) {
            busy = false;
            return;
          }
          if (blob) receiveBlob(blob);
          else renderMain();
        });
    } else renderMain();
    return !!image;
  }
  return {
    paint,
    covers: viewport => !!image && covers(renderedBounds, viewport),
    get ready() {
      return !!image;
    },
    get pending() {
      return busy;
    },
    get failed() {
      return failed;
    },
    dispose() {
      disposed = true;
      workerPainter.dispose();
      generation++;
      busy = false;
      queued = undefined;
      image?.remove();
      image = undefined;
      if (url) revoke(url);
      url = undefined;
      for (const pendingURL of urls) revoke(pendingURL);
      canvas.width = canvas.height = 0;
    }
  };
}
