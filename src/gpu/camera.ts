export interface Camera {
  k: number;
  x: number;
  y: number;
}

// CSS size plus device pixel ratio used for the backing store
export interface Viewport {
  width: number;
  height: number;
  dpr: number;
}

const IDENTITY: Camera = { k: 1, x: 0, y: 0 };
const NUMBER_RE = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

export function worldToScreen(c: Camera, wx: number, wy: number): [number, number] {
  return [c.k * wx + c.x, c.k * wy + c.y];
}

export function screenToWorld(c: Camera, sx: number, sy: number): [number, number] {
  return [(sx - c.x) / c.k, (sy - c.y) / c.k];
}

// Column-major 3x3 world -> clip. Clip x is right, clip y is up, screen y is down.
export function worldToClip(c: Camera, v: Viewport, out: Float32Array = new Float32Array(9)): Float32Array {
  const sx = 2 / v.width;
  const sy = 2 / v.height;
  out[0] = c.k * sx;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = -c.k * sy;
  out[5] = 0;
  out[6] = c.x * sx - 1;
  out[7] = 1 - c.y * sy;
  out[8] = 1;
  return out;
}

// Column-major 3x3 screen CSS px -> clip.
export function screenToClip(v: Viewport, out: Float32Array = new Float32Array(9)): Float32Array {
  out[0] = 2 / v.width;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = -2 / v.height;
  out[5] = 0;
  out[6] = -1;
  out[7] = 1;
  out[8] = 1;
  return out;
}

export function backingSize(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  maxTextureSize: number,
  maxDpr = 2
): { width: number; height: number; dpr: number } {
  const w = Math.max(cssWidth, 0);
  const h = Math.max(cssHeight, 0);
  let d = Math.min(dpr > 0 ? dpr : 1, maxDpr);
  if (w * d > maxTextureSize) d = Math.min(d, maxTextureSize / w);
  if (h * d > maxTextureSize) d = Math.min(d, maxTextureSize / h);
  // small epsilon guards against float error such as 1000 * 1.024 = 1023.9999...
  const width = Math.min(maxTextureSize, Math.max(1, Math.floor(w * d + 1e-6)));
  const height = Math.min(maxTextureSize, Math.max(1, Math.floor(h * d + 1e-6)));
  return { width, height, dpr: d };
}

// World rectangle visible in the viewport, expanded by margin CSS px on every side
export function visibleWorld(c: Camera, v: Viewport, margin = 0): [number, number, number, number] {
  return [
    (-margin - c.x) / c.k,
    (-margin - c.y) / c.k,
    (v.width + margin - c.x) / c.k,
    (v.height + margin - c.y) / c.k
  ];
}

// Rects are [x0, y0, x1, y1]. Touching edges count as intersecting.
export function intersects(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

// Parses "translate(x y) scale(k)", "translate(x,y) scale(k)", or "" / null (identity).
// Missing or invalid components fall back to identity values.
export function parseViewboxTransform(value: string | null): Camera {
  if (!value) return { ...IDENTITY };
  let x = IDENTITY.x;
  let y = IDENTITY.y;
  let k = IDENTITY.k;
  const t = /translate\(([^)]*)\)/.exec(value);
  if (t) {
    const n = t[1].match(NUMBER_RE)?.map(Number) ?? [];
    if (Number.isFinite(n[0])) x = n[0];
    if (Number.isFinite(n[1])) y = n[1];
  }
  const s = /scale\(([^)]*)\)/.exec(value);
  if (s) {
    const n = Number((s[1].match(NUMBER_RE) ?? [])[0]);
    if (Number.isFinite(n) && n > 0) k = n;
  }
  return { k, x, y };
}

export function cameraEquals(a: Camera, b: Camera, epsilon = 1e-6): boolean {
  return Math.abs(a.k - b.k) <= epsilon && Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
}

// Estimate only: worst-case screen-pixel error of float32 world coordinates at zoom k.
// Camera math runs in float64 on the CPU; only the resulting uniforms are float32.
export function float32PixelError(k: number, size: number): number {
  return k * size * 2 ** -24;
}

// Inverts [a, b, c, d, e, f] (SVG matrix order). Returns identity if singular.
export function invertAffine(m: ArrayLike<number>): [number, number, number, number, number, number] {
  const [a, b, c, d, e, f] = [m[0], m[1], m[2], m[3], m[4], m[5]];
  const det = a * d - b * c;
  if (det === 0 || !Number.isFinite(det)) return [1, 0, 0, 1, 0, 0];
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

// Device-pixel scissor enclosing a world rectangle, padded by one CSS pixel for hairlines and AA.
// Backing dimensions are explicit: MAX_TEXTURE_SIZE may cap them independently of the requested DPR.
export function worldScissor(
  bounds: [number, number, number, number],
  camera: Camera,
  viewport: Viewport,
  backingWidth: number,
  backingHeight: number
): [number, number, number, number] | null {
  const sx = backingWidth / viewport.width,
    sy = backingHeight / viewport.height;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  const x0 = clamp(Math.floor((bounds[0] * camera.k + camera.x - 1) * sx), backingWidth);
  const x1 = clamp(Math.ceil((bounds[2] * camera.k + camera.x + 1) * sx), backingWidth);
  const y0 = clamp(backingHeight - Math.ceil((bounds[3] * camera.k + camera.y + 1) * sy), backingHeight);
  const y1 = clamp(backingHeight - Math.floor((bounds[1] * camera.k + camera.y - 1) * sy), backingHeight);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null;
}
