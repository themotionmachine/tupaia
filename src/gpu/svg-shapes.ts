// SVG basic shapes (rect with rx/ry, circle, ellipse, line) as path data, per the SVG2 path equivalents (§10), and the
// identity-transform test for scene.ts. Anything this cannot reproduce exactly returns null so the caller keeps the
// element compat (exact by construction): non-px units, negative sizes, auto radii, percentages outside a viewport.

export interface Viewport {
  width: number;
  height: number;
}

type Axis = "x" | "y" | "r";

const PLAIN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:px)?$/i;
const PERCENT = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)%$/i;

// A length attribute in user units; `fallback` when absent, NaN when it cannot be resolved here. Percentages resolve
// against the nearest viewport only when one is given (SVG2 §8.9: x/width by width, y/height by height, radii by
// the normalized diagonal).
function length(element: Element, name: string, axis: Axis, viewport: Viewport | null, fallback = 0): number {
  const raw = element.getAttribute(name);
  if (raw === null) return fallback;
  const text = raw.trim();
  if (!text) return fallback;
  if (PLAIN.test(text)) return Number.parseFloat(text);
  const percent = PERCENT.exec(text);
  if (!percent || !viewport) return Number.NaN;
  const { width, height } = viewport;
  const basis = axis === "x" ? width : axis === "y" ? height : Math.sqrt((width * width + height * height) / 2);
  return (Number.parseFloat(percent[1]) * basis) / 100;
}

const finite = (...values: number[]) => values.every(Number.isFinite);

// The full ellipse as eight arcs (sweep 1) from (cx + rx, cy), the SVG2 start point and direction, so dash phase
// matches. Eight arcs rather than four keep at least an octagon after flattening when the radius is far below the
// curve tolerance (svg-path.ts arcTo emits at least one chord per arc).
function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  let d = `M${cx + rx},${cy}`;
  for (let k = 1; k <= 8; k++) {
    const angle = (k * Math.PI) / 4;
    const x = k === 8 ? cx + rx : cx + rx * Math.cos(angle);
    const y = k === 8 ? cy : cy + ry * Math.sin(angle);
    d += `A${rx},${ry} 0 0 1 ${x},${y}`;
  }
  return `${d}Z`;
}

// Radius attribute: undefined when absent or `auto` (SVG2), null when invalid.
function radius(element: Element, name: string, axis: Axis, viewport: Viewport | null): number | undefined | null {
  const raw = element.getAttribute(name);
  if (raw === null || raw.trim() === "auto") return undefined;
  const value = length(element, name, axis, viewport);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Path data for <rect>, <circle>, <ellipse> and <line>; "" when the shape renders nothing (zero size) and null when
 * it cannot be expressed exactly. `viewport` enables percentage lengths (mask geometry only, see scene.ts).
 */
export function basicShapePath(element: Element, viewport: Viewport | null = null): string | null {
  switch (element.tagName) {
    case "rect": {
      const x = length(element, "x", "x", viewport);
      const y = length(element, "y", "y", viewport);
      const w = length(element, "width", "x", viewport);
      const h = length(element, "height", "y", viewport);
      if (!finite(x, y, w, h) || w < 0 || h < 0) return null;
      const rxValue = radius(element, "rx", "x", viewport);
      const ryValue = radius(element, "ry", "y", viewport);
      if (rxValue === null || ryValue === null) return null;
      // SVG2 §10.2: an auto radius takes the other one; both are clamped to half the side
      const rx = Math.min(rxValue ?? ryValue ?? 0, w / 2);
      const ry = Math.min(ryValue ?? rxValue ?? 0, h / 2);
      if (!(rx > 0 && ry > 0)) return `M${x},${y}h${w}v${h}h${-w}Z`;
      const arc = `A${rx},${ry} 0 0 1`;
      return (
        `M${x + rx},${y}H${x + w - rx}${arc} ${x + w},${y + ry}V${y + h - ry}${arc} ${x + w - rx},${y + h}` +
        `H${x + rx}${arc} ${x},${y + h - ry}V${y + ry}${arc} ${x + rx},${y}Z`
      );
    }
    case "circle": {
      const cx = length(element, "cx", "x", viewport);
      const cy = length(element, "cy", "y", viewport);
      const r = radius(element, "r", "r", viewport);
      if (!finite(cx, cy) || r === null) return null;
      return r ? ellipsePath(cx, cy, r, r) : "";
    }
    case "ellipse": {
      const cx = length(element, "cx", "x", viewport);
      const cy = length(element, "cy", "y", viewport);
      const rx = radius(element, "rx", "x", viewport);
      const ry = radius(element, "ry", "y", viewport);
      // auto radii are SVG2-only (engine support varies): leave them to the browser
      if (!finite(cx, cy) || rx == null || ry == null) return null;
      return rx && ry ? ellipsePath(cx, cy, rx, ry) : "";
    }
    case "line": {
      const x1 = length(element, "x1", "x", viewport);
      const y1 = length(element, "y1", "y", viewport);
      const x2 = length(element, "x2", "x", viewport);
      const y2 = length(element, "y2", "y", viewport);
      return finite(x1, y1, x2, y2) ? `M${x1},${y1}L${x2},${y2}` : null;
    }
    default:
      return null;
  }
}

const TRANSFORM_ITEM = /^\s*([a-zA-Z]+)\s*\(([^()]*)\)\s*,?/;
const IDENTITY: Record<string, (args: number[]) => boolean> = {
  translate: a => (a.length === 1 || a.length === 2) && a.every(v => v === 0),
  // rotate(0 cx cy) = translate(cx cy) rotate(0) translate(-cx -cy)
  rotate: a => (a.length === 1 || a.length === 3) && a[0] === 0,
  scale: a => (a.length === 1 || a.length === 2) && a.every(v => v === 1),
  skewX: a => a.length === 1 && a[0] === 0,
  skewY: a => a.length === 1 && a[0] === 0,
  matrix: a => a.length === 6 && a.every((v, i) => v === (i === 0 || i === 3 ? 1 : 0))
};

/** True for a `transform` attribute that is empty or a list of identity functions only (`rotate(0)`, `translate(0 0)`). */
export function isIdentityTransform(transform: string | null): boolean {
  let rest = transform ?? "";
  while (rest.trim()) {
    const match = TRANSFORM_ITEM.exec(rest);
    if (!match) return false;
    const args = match[2].trim()
      ? match[2]
          .trim()
          .split(/\s*,\s*|\s+/)
          .map(Number)
      : [];
    const identity = IDENTITY[match[1]];
    if (!identity || !args.every(Number.isFinite) || !identity(args)) return false;
    rest = rest.slice(match[0].length);
  }
  return true;
}

/** The size percentages resolve against for content of `element`: its nearest <svg> viewport, or null if unknown. */
export function nearestViewport(element: Element): Viewport | null {
  const svg = element.closest("svg");
  if (!svg) return null;
  const box = svg
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (box?.length === 4 && finite(...box) && box[2] > 0 && box[3] > 0) return { width: box[2], height: box[3] };
  // No viewBox: user units are CSS px of the element's own box; layout size first (CSS can override the attributes)
  const size = (name: "width" | "height", client: number) => {
    if (client > 0) return client;
    const raw = svg.getAttribute(name)?.trim() ?? "";
    return PLAIN.test(raw) ? Number.parseFloat(raw) : Number.NaN;
  };
  const width = size("width", svg.clientWidth);
  const height = size("height", svg.clientHeight);
  return finite(width, height) && width > 0 && height > 0 ? { width, height } : null;
}
