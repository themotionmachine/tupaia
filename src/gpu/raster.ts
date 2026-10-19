// Rasterizes canonical <pattern> tiles and relief <symbol> sprites for native GPU sampling.
import { loadReliefSprite } from "../renderers/relief-canvas";
import { invertAffine } from "./camera";

export type Affine = [number, number, number, number, number, number];
const identity: Affine = [1, 0, 0, 1, 0, 0];
const svgNs = "http://www.w3.org/2000/svg";

export function multiply(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5]
  ];
}

// SVG transform lists (translate/scale/rotate/skewX/skewY/matrix); null when unparseable.
export function parseTransform(value: string | null | undefined): Affine | null {
  let result: Affine = [...identity];
  const text = (value || "").trim();
  const re = /(\w+)\s*\(([^)]*)\)[\s,]*/y;
  while (re.lastIndex < text.length) {
    const match = re.exec(text);
    if (!match) return null;
    const a = match[2]
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (a.some(n => !Number.isFinite(n))) return null;
    let m: Affine;
    const rad = ((a[0] ?? 0) * Math.PI) / 180;
    if (match[1] === "translate" && a.length >= 1 && a.length <= 2) m = [1, 0, 0, 1, a[0], a[1] ?? 0];
    else if (match[1] === "scale" && a.length >= 1 && a.length <= 2) m = [a[0], 0, 0, a[1] ?? a[0], 0, 0];
    else if (match[1] === "matrix" && a.length === 6) m = a as Affine;
    else if (match[1] === "skewX" && a.length === 1) m = [1, 0, Math.tan(rad), 1, 0, 0];
    else if (match[1] === "skewY" && a.length === 1) m = [1, Math.tan(rad), 0, 1, 0, 0];
    else if (match[1] === "rotate" && (a.length === 1 || a.length === 3)) {
      const [c, s] = [Math.cos(rad), Math.sin(rad)];
      const [cx, cy] = [a[1] ?? 0, a[2] ?? 0];
      m = [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
    } else return null;
    result = multiply(result, m);
  }
  return re.lastIndex === text.length || !text ? result : null;
}

export function scaleBucket(scale: number, max = 16): number {
  return Math.min(max, 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(1, scale)))));
}

export function decodeSvg(markup: string, width: number, height: number): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
  return new Promise<HTMLCanvasElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return reject(new Error("Canvas2D unavailable"));
      context.drawImage(image, 0, 0, width, height);
      resolve(canvas);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Pattern tile decode failed"));
    };
    image.src = url;
  });
}

export interface PatternTile {
  canvas: HTMLCanvasElement;
  // world (user space) -> tile UV in [0,1) repeat space
  worldToUv: Affine;
  referenceZoom?: number;
}

const inherited = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "opacity", "style"];

// Only userSpaceOnUse patterns without viewBox/href/images/filters are native; others return a reason.
export async function rasterizePattern(pattern: Element, scale: number): Promise<PatternTile | string> {
  const width = Number(pattern.getAttribute("width"));
  const height = Number(pattern.getAttribute("height"));
  if (pattern.getAttribute("patternUnits") !== "userSpaceOnUse") return "pattern units";
  if (pattern.hasAttribute("href") || pattern.hasAttribute("xlink:href") || pattern.hasAttribute("viewBox"))
    return "pattern href/viewBox";
  if (!(width > 0 && height > 0)) return "pattern size";
  if (pattern.querySelector("image,use,filter,[filter],[mask],[clip-path],text,foreignObject"))
    return "pattern content";
  const patternTransform = pattern.getAttribute("patternTransform");
  const transform = parseTransform(patternTransform);
  if (!transform) return "patternTransform";
  let referenceZoom: number | undefined;
  if (pattern.hasAttribute("data-zone-hatch-clone")) {
    const match = /^scale\(\s*([+\-\d.eE]+)\s*\)/.exec(patternTransform || "");
    const inverse = Number(match?.[1]);
    if (!Number.isFinite(inverse) || inverse <= 0) return "zone hatch scale";
    referenceZoom = 1 / inverse;
  }
  const x = Number(pattern.getAttribute("x") || 0);
  const y = Number(pattern.getAttribute("y") || 0);
  const pixels = Math.min(512, Math.max(4, Math.ceil(Math.max(width, height) * scale)));
  const ratio = pixels / Math.max(width, height);
  const [tw, th] = [Math.max(1, Math.round(width * ratio)), Math.max(1, Math.round(height * ratio))];
  const wrapper = document.createElementNS(svgNs, "g");
  for (const name of inherited) if (pattern.hasAttribute(name)) wrapper.setAttribute(name, pattern.getAttribute(name)!);
  wrapper.innerHTML = pattern.innerHTML;
  const markup = `<svg xmlns="${svgNs}" width="${tw}" height="${th}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${wrapper.outerHTML}</svg>`;
  try {
    const canvas = await decodeSvg(markup, tw, th);
    const tileToWorld = multiply(multiply(transform, [1, 0, 0, 1, x, y]), [width, 0, 0, height, 0, 0]);
    return { canvas, worldToUv: invertAffine(tileToWorld), referenceZoom };
  } catch (error) {
    return String((error as Error).message || error);
  }
}

export interface SpriteAtlas {
  canvas: HTMLCanvasElement;
  // sprite id -> [u0, v0, u1, v1]
  uv: Map<string, [number, number, number, number]>;
  failed: string[];
}

// Same draw contract as renderReliefCanvas: drawImage(sprite, x, y, s, s).
export async function buildReliefAtlas(ids: string[], maxTexture: number, cell = 256): Promise<SpriteAtlas> {
  const results = await Promise.allSettled(ids.map(id => loadReliefSprite(id)));
  const failed = ids.filter((_, i) => results[i].status === "rejected");
  const loaded = ids.flatMap((id, i) => {
    const result = results[i];
    return result.status === "fulfilled" ? [[id, result.value] as const] : [];
  });
  const columns = Math.max(1, Math.ceil(Math.sqrt(loaded.length)));
  const rows = Math.max(1, Math.ceil(loaded.length / columns));
  const size = Math.min(cell, Math.floor(maxTexture / Math.max(columns, rows)));
  const canvas = document.createElement("canvas");
  canvas.width = columns * size;
  canvas.height = rows * size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas2D unavailable");
  const uv = new Map<string, [number, number, number, number]>();
  loaded.forEach(([id, image], index) => {
    const [cx, cy] = [(index % columns) * size, Math.floor(index / columns) * size];
    context.drawImage(image, cx + 1, cy + 1, size - 2, size - 2);
    uv.set(id, [
      (cx + 1) / canvas.width,
      (cy + 1) / canvas.height,
      (cx + size - 1) / canvas.width,
      (cy + size - 1) / canvas.height
    ]);
  });
  return { canvas, uv, failed };
}

// Reuse an existing canonical relief bitmap without a second sprite-rasterization/filtering step.
// Only local blob or embedded image assets qualify; arbitrary external images retain the existing fallback path.
export async function cachedReliefImage(element: Element, maxTexture: number): Promise<HTMLImageElement | null> {
  const href = element.getAttribute("href") || element.getAttribute("xlink:href");
  if (!href) return null;
  const url = new URL(href, location.href);
  if (!((url.protocol === "blob:" && url.origin === location.origin) || /^data:image\/(png|webp|jpeg)[;,]/.test(href)))
    return null;
  const image = new Image();
  image.src = href;
  try {
    await image.decode();
  } catch {
    return null;
  }
  return image.naturalWidth > 0 &&
    image.naturalHeight > 0 &&
    image.naturalWidth <= maxTexture &&
    image.naturalHeight <= maxTexture
    ? image
    : null;
}

// SVG image defaults to xMidYMid meet. Rounded cached bitmap dimensions can differ slightly in aspect ratio from
// the world rectangle; stretching that bitmap shifts small relief icons by a device pixel on Retina displays.
export function meetImageRect(
  rect: [number, number, number, number],
  naturalWidth: number,
  naturalHeight: number
): [number, number, number, number] {
  const scale = Math.min(rect[2] / naturalWidth, rect[3] / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return [rect[0] + (rect[2] - width) / 2, rect[1] + (rect[3] - height) / 2, width, height];
}

// Zone hatch clones prepend S(1/k) to the original pattern transform. Its inverse is B*S(k), so changing the
// camera scales the linear columns, while the pattern-origin translation stays fixed. Panning remains world-anchored.
export function hatchUvAtZoom(
  matrix: Float32Array,
  referenceZoom: number | undefined,
  zoom: number,
  out: Float32Array
): Float32Array {
  out.set(matrix);
  const ratio = referenceZoom && referenceZoom > 0 ? zoom / referenceZoom : 1;
  out[0] *= ratio;
  out[1] *= ratio;
  out[3] *= ratio;
  out[4] *= ratio;
  return out;
}
