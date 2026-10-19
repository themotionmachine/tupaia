// Curved <text><textPath><tspan> labels as instanced glyph quads. Metrics come from the actual loaded font via
// Canvas2D measureText of prefixes (kerning included); glyphs are rasterized into a shelf-packed alpha atlas.
import { cumulativeLengths, layoutOnPath } from "./geometry";
import { parseColor, type Rgba } from "./scene";
import { flattenPath } from "./svg-path";

export const GLYPH_FLOATS = 15; // cx cy angle lx ly w h u0 v0 u1 v1 r g b a
const ATLAS = 2048;
const PAD = 2;

interface Glyph {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  left: number; // px from pen origin to cell left
  top: number; // px from baseline to cell top (negative = above)
  width: number;
  height: number;
}

export class GlyphAtlas {
  readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly glyphs = new Map<string, Glyph>();
  private x = 0;
  private y = 0;
  private row = 0;
  dirty = true;
  // bumped by every clear(): a frame records the generation its glyph instances index (prepare.ts retainFrame)
  generation = 0;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvas.height = ATLAS;
    const context = this.canvas.getContext("2d", { willReadFrequently: false });
    if (!context) throw new Error("Canvas2D unavailable");
    this.context = context;
  }

  get size(): number {
    return this.glyphs.size;
  }

  // halo = 0 draws the fill mask; halo > 0 draws a stroke mask of that pixel width with the given SVG line join.
  glyph(font: string, char: string, halo: number, join: CanvasLineJoin = "round", miter = 4): Glyph | null {
    const key = halo > 0 ? `${font}|${halo}|${join}|${miter}|${char}` : `${font}|0|${char}`;
    const cached = this.glyphs.get(key);
    if (cached) return cached;
    const c = this.context;
    c.font = font;
    const m = c.measureText(char);
    // miter corners can reach miterLimit * half the stroke width past the outline
    const extra = ((join === "miter" ? Math.max(1, miter) : 1) * halo) / 2 + PAD;
    const left = Math.floor(-m.actualBoundingBoxLeft - extra);
    const top = Math.floor(-m.actualBoundingBoxAscent - extra);
    const width = Math.ceil(m.actualBoundingBoxRight + extra) - left;
    const height = Math.ceil(m.actualBoundingBoxDescent + extra) - top;
    if (width > ATLAS || height > ATLAS) return null;
    if (this.x + width > ATLAS) [this.x, this.y, this.row] = [0, this.y + this.row, 0];
    if (this.y + height > ATLAS) return null;
    c.save();
    c.translate(this.x - left, this.y - top);
    c.fillStyle = c.strokeStyle = "#fff";
    c.textBaseline = "alphabetic";
    if (halo > 0) {
      c.lineJoin = join;
      c.miterLimit = miter;
      c.lineWidth = halo;
      c.strokeText(char, 0, 0);
    } else c.fillText(char, 0, 0);
    c.restore();
    const glyph = {
      u0: this.x / ATLAS,
      v0: this.y / ATLAS,
      u1: (this.x + width) / ATLAS,
      v1: (this.y + height) / ATLAS,
      left,
      top,
      width,
      height
    };
    this.x += width + 1;
    this.row = Math.max(this.row, height + 1);
    this.glyphs.set(key, glyph);
    this.dirty = true;
    return glyph;
  }

  // Fonts a layout could not measure with their own face (fontReady reason), with a sample of the text: those labels
  // took the compat lane. Cleared with the atlas, i.e. per prepare.
  readonly fontIssues = new Map<string, string>();

  // A face the recorded labels were missing has arrived since (the renderer re-prepares on 'loadingdone').
  fontsArrived(fonts: FontFaceSet | undefined = globalThis.document?.fonts): boolean {
    if (!fonts) return false;
    for (const [font, text] of this.fontIssues) {
      if (slowLoads.has(font)) continue;
      try {
        if (fonts.check(font, text)) return true;
      } catch {
        // an unparsable font string never becomes measurable
      }
    }
    return false;
  }

  clear(): void {
    this.context.clearRect(0, 0, ATLAS, ATLAS);
    this.glyphs.clear();
    this.fontIssues.clear();
    this.x = this.y = this.row = 0;
    this.dirty = true;
    this.generation++;
  }
}

// A label waits at most this long for its web font; a slower face is measured on a later prepare ('loadingdone').
export const FONT_LOAD_TIMEOUT = 3000;
// fonts whose load outlived FONT_LOAD_TIMEOUT and is still pending: later labels do not wait for them again
const slowLoads = new Set<string>();

export function fontFamily(font: string): string {
  return /\d(?:\.\d+)?px\s+(.*)$/.exec(font)?.[1]?.trim() || font;
}

// "" when the label's face is loaded and measurable; otherwise a named reason and the label takes the compat lane
// (whose clone falls back the way the SVG does). One rejected, unparsable or slow web font must never fail the whole
// prepare, which would send the entire GPU renderer back to SVG.
export async function fontReady(
  font: string,
  text: string,
  fonts: FontFaceSet | undefined = globalThis.document?.fonts,
  timeout = FONT_LOAD_TIMEOUT
): Promise<string> {
  if (!fonts) return "";
  const family = fontFamily(font);
  if (slowLoads.has(font)) return `font loading (${family})`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const load = fonts.load(font, text);
    const late = new Promise<"late">(resolve => {
      timer = setTimeout(() => resolve("late"), timeout);
    });
    if ((await Promise.race([load, late])) === "late") {
      slowLoads.add(font);
      load.then(
        () => slowLoads.delete(font),
        () => slowLoads.delete(font)
      );
      return `font load timeout (${family})`;
    }
    return fonts.check(font, text) ? "" : `font unavailable (${family})`;
  } catch {
    return `font load failed (${family})`;
  } finally {
    clearTimeout(timer);
  }
}

export interface LabelBatch {
  instances: Float32Array;
  count: number;
  // per laid-out glyph world quad corners for CPU picking: [id, x0,y0,x1,y1,x2,y2,x3,y3]
  boxes: { id: string; corners: number[] }[];
  failed: { element: SVGTextElement; reason: string }[];
}

let measure: CanvasRenderingContext2D | null = null;

export function prefixAdvances(text: string, width: (s: string) => number): number[] {
  const chars = [...text];
  const result: number[] = [];
  let previous = 0;
  let prefix = "";
  for (const char of chars) {
    prefix += char;
    const next = width(prefix);
    result.push(next - previous);
    previous = next;
  }
  return result;
}

export function cssFont(style: CSSStyleDeclaration, px: number): string {
  return `${style.fontStyle} ${style.fontWeight} ${px}px ${style.fontFamily}`;
}

const XLINK = "http://www.w3.org/1999/xlink";
const NUMBER = "([+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?)";
const LENGTH = new RegExp(`^\\s*${NUMBER}(px|em)?\\s*$`, "i");
const PERCENT = new RegExp(`^\\s*${NUMBER}%\\s*$`, "i");
const PX = new RegExp(`^\\s*${NUMBER}(px)?\\s*$`, "i");

interface Attributes {
  getAttribute(name: string): string | null;
  getAttributeNS?(namespace: string, name: string): string | null;
}

// SVG 2: `href` wins over legacy `xlink:href`; only same-document "#id" references resolve.
export function textPathTargetId(textPath: Attributes): string | null {
  const href =
    textPath.getAttribute("href") ?? textPath.getAttributeNS?.(XLINK, "href") ?? textPath.getAttribute("xlink:href");
  return /^\s*#([^\s#]+)\s*$/.exec(href ?? "")?.[1] ?? null;
}

export function presentAttribute(element: Attributes, names: string[]): string {
  return names.find(name => element.getAttribute(name) !== null) ?? "";
}

// A single user-unit, px or em length (dy, x). Lists and other units are null: they mean per-glyph positioning.
export function parseLength(value: string, em: number): number | null {
  const match = LENGTH.exec(value);
  if (!match) return null;
  const n = Number(match[1]) * (match[2]?.toLowerCase() === "em" ? em : 1);
  return Number.isFinite(n) ? n : null;
}

// startOffset as a distance along the path: percentages of the path length, or a user-unit/px length.
export function startOffsetLength(value: string | null, total: number): number | null {
  if (value === null) return 0;
  const percent = PERCENT.exec(value);
  if (percent) return (Number(percent[1]) / 100) * total;
  return parseLength(value, Number.NaN);
}

// Computed letter-spacing in px ("normal" = 0); anything not resolved to px is null.
export function letterSpacingPx(computed: string | undefined): number | null {
  if (!computed || computed === "normal") return 0;
  const match = PX.exec(computed);
  return match && (match[2] || Number(match[1]) === 0) ? Number(match[1]) : null;
}

// letter-spacing is added after every character, the last included (Chromium/Firefox SVG text), so it also enters
// the text-anchor extent and the advance whose midpoint sits on the path. Null when an advance would go negative.
export function spacedAdvances(advances: number[], spacing: number): number[] | null {
  const result = advances.map(advance => advance + spacing);
  return result.some(advance => advance < 0) ? null : result;
}

// Glyphs are rasterized per code point, so shaping-dependent text (combining marks, joiners, RTL joining scripts)
// cannot be reproduced. SVG's default white-space collapsing only leaves text without runs or edge spaces unchanged.
export function unsupportedContent(content: string): string {
  if (
    /(?:\u200c|\u200d|[\p{M}\u{1F1E6}-\u{1F1FF}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}])/u.test(
      content
    )
  )
    return "complex text";
  if (/[\t\n\r]| {2}|^ | $/.test(content)) return "whitespace";
  return "";
}

export function strokeBeforeFill(paintOrder: string | undefined): boolean {
  const tokens = (paintOrder || "normal").trim().split(/\s+/);
  if (tokens[0] === "normal") return false;
  const order = [...tokens, "fill", "stroke"]; // unlisted layers follow in default order
  return order.indexOf("stroke") < order.indexOf("fill");
}

type TextStyle = Partial<Record<string, string>>;

// Computed properties whose non-default values change glyph shape or placement in ways this path does not model.
// Empty/missing values (unsupported by the engine) count as default.
const STYLE_DEFAULTS: [string, string[], string][] = [
  ["textShadow", ["none"], "text-shadow"],
  ["wordSpacing", ["normal", "0px", "0"], "word-spacing"],
  ["textTransform", ["none"], "text-transform"],
  ["fontVariantCaps", ["normal"], "font-variant"],
  ["fontFeatureSettings", ["normal"], "font-feature-settings"],
  ["fontKerning", ["auto", "normal"], "font-kerning"],
  ["fontStretch", ["normal", "100%"], "font-stretch"],
  ["direction", ["ltr"], "direction"],
  ["writingMode", ["horizontal-tb", "lr", "lr-tb"], "writing-mode"],
  ["dominantBaseline", ["auto", "central"], "baseline"],
  ["alignmentBaseline", ["auto", "baseline"], "baseline"],
  ["baselineShift", ["0px", "0", "baseline"], "baseline"],
  ["textDecorationLine", ["none"], "text-decoration"],
  ["visibility", ["visible"], "visibility"]
];

export function unsupportedStyle(style: TextStyle): string {
  for (const [property, defaults, reason] of STYLE_DEFAULTS) {
    const value = style[property];
    if (value && !defaults.includes(value)) return reason;
  }
  if (style.fill?.startsWith("url") || style.stroke?.startsWith("url")) return "paint server text";
  return "";
}

// Stroke-only properties, checked when a halo is actually drawn.
export function unsupportedStroke(style: TextStyle): string {
  if (style.strokeDasharray && style.strokeDasharray !== "none") return "stroke-dasharray";
  if (style.vectorEffect && style.vectorEffect !== "none") return "vector-effect";
  if (style.strokeLinejoin && !["miter", "round", "bevel"].includes(style.strokeLinejoin)) return "stroke-linejoin";
  return "";
}

// Chromium SVG central aligns the font ascent/descent centre to the path. Its glyph start-position API
// remains on the nominal path; the baseline shift is visible in getExtentOfChar instead (host probe verifies it).
export function centralBaselineShift(
  baseline: string,
  metrics: { fontBoundingBoxAscent: number; fontBoundingBoxDescent: number },
  scale: number
): number | null {
  if (baseline === "auto" || !baseline) return 0;
  if (
    baseline !== "central" ||
    !(scale > 0) ||
    !Number.isFinite(metrics.fontBoundingBoxAscent) ||
    !Number.isFinite(metrics.fontBoundingBoxDescent)
  )
    return null;
  return (metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / (2 * scale);
}

// Raster scale is bucketed (power of two) so zooming within a bucket reuses the atlas.
export async function layoutLabels(
  elements: SVGTextElement[],
  rasterScale: number,
  atlas: GlyphAtlas
): Promise<LabelBatch> {
  measure ??= document.createElement("canvas").getContext("2d");
  const out: number[] = [];
  const boxes: LabelBatch["boxes"] = [];
  const failed: LabelBatch["failed"] = [];
  for (const element of elements) {
    const [instances, picked] = [out.length, boxes.length];
    const reason = await layoutLabel(element, rasterScale, atlas, out, boxes);
    if (!reason) continue;
    // a label is either fully native or fully compat, never half drawn
    out.length = instances;
    boxes.length = picked;
    failed.push({ element, reason });
  }
  return { instances: new Float32Array(out), count: out.length / GLYPH_FLOATS, boxes, failed };
}

async function layoutLabel(
  text: SVGTextElement,
  scale: number,
  atlas: GlyphAtlas,
  out: number[],
  boxes: LabelBatch["boxes"]
): Promise<string> {
  if (!measure) return "textPath reference";
  // exactly <text><textPath><tspan>…</tspan>…</textPath></text>; stray text would render outside the modelled chunks
  const textPath = text.querySelector("textPath");
  if (!textPath || textPath.parentNode !== text) return "textPath reference";
  const lines = [...textPath.children];
  const outside = [...text.childNodes].some(node =>
    isText(node) ? node.data.trim() : isElement(node) && node !== textPath
  );
  // even whitespace between tspans collapses to an addressable space that joins the previous chunk's anchor extent
  const inside = [...textPath.childNodes].some(node => (isText(node) ? node.data : false));
  if (outside || inside || lines.some(line => line.tagName !== "tspan" || line.children.length))
    return "tspan structure";
  if (!lines.length) return "tspan structure";
  if (presentAttribute(text, ["x", "y", "dx", "dy", "rotate", "textLength"])) return "text positioning";
  if (text.getAttribute("transform") !== null) return "text transform";
  if (presentAttribute(textPath, ["path", "method", "spacing", "side", "textLength", "lengthAdjust"]))
    return "textPath attributes";
  const id = textPathTargetId(textPath);
  const path = id ? text.ownerDocument.getElementById(id) : null;
  if (!path || path.tagName !== "path") return "textPath reference";
  if (path.getAttribute("transform") !== null || path.getAttribute("pathLength") !== null) return "textPath geometry";
  const subpaths = flattenPath(path.getAttribute("d") || "", 0.1);
  const points = subpaths[0]?.points;
  if (subpaths.length !== 1 || !points || points.length < 4) return "textPath geometry";
  const lengths = cumulativeLengths(points);
  const total = lengths[lengths.length - 1];
  const start = startOffsetLength(textPath.getAttribute("startOffset"), total);
  if (!(total > 0)) return "textPath geometry";
  if (start === null) return "startOffset";
  let dy = 0;
  for (const [index, line] of lines.entries()) {
    const style = getComputedStyle(line);
    const unsupported = unsupportedStyle(style as unknown as Record<string, string>);
    if (unsupported) return unsupported;
    if (presentAttribute(line, ["y", "dx", "rotate", "textLength", "lengthAdjust"])) return "tspan positioning";
    const px = Number.parseFloat(style.fontSize);
    if (!(px > 0)) return "font-size/dy";
    const shift = parseLength(line.getAttribute("dy") ?? "0", px);
    if (shift === null) return "font-size/dy";
    dy += shift;
    // x on a glyph inside textPath starts a new anchored chunk at startOffset + x; without it, a later tspan would
    // continue the previous chunk, which per-line layout does not model
    const xAttribute = line.getAttribute("x");
    const x = xAttribute === null ? (index === 0 ? 0 : null) : parseLength(xAttribute, px);
    if (x === null) return "tspan x";
    const spacing = letterSpacingPx(style.letterSpacing);
    if (spacing === null) return "letter-spacing";
    const content = line.textContent || "";
    const contentReason = unsupportedContent(content);
    if (contentReason) return contentReason;
    const fill = parseColor(style.fill, Number.parseFloat(style.fillOpacity) * Number.parseFloat(style.opacity));
    const stroke = parseColor(style.stroke, Number.parseFloat(style.strokeOpacity) * Number.parseFloat(style.opacity));
    const strokeWidth = stroke ? Number.parseFloat(style.strokeWidth) || 0 : 0;
    const strokeReason = strokeWidth > 0 ? unsupportedStroke(style as unknown as Record<string, string>) : "";
    if (strokeReason) return strokeReason;
    const join = (style.strokeLinejoin || "miter") as CanvasLineJoin;
    const miter = Number.parseFloat(style.strokeMiterlimit) || 4;
    const font = cssFont(style, px);
    const fontIssue = await fontReady(font, content);
    if (fontIssue) {
      atlas.fontIssues.set(font, content);
      return fontIssue;
    }
    const rasterFont = cssFont(style, px * scale);
    measure.font = rasterFont;
    measure.fontKerning = style.textRendering === "optimizeSpeed" ? "none" : "auto";
    const baselineShift = centralBaselineShift(style.dominantBaseline, measure.measureText(content), scale);
    if (baselineShift === null) return "central baseline metrics";
    const advances = spacedAdvances(
      prefixAdvances(content, s => measure!.measureText(s).width / scale),
      spacing
    );
    if (!advances) return "letter-spacing";
    const anchor = style.textAnchor === "middle" ? "middle" : style.textAnchor === "end" ? "end" : "start";
    const placed = layoutOnPath(points, advances, (start + x) / total, anchor);
    const passes: [number, Rgba | null][] = [
      [0, fill],
      [strokeWidth * scale, strokeWidth > 0 ? stroke : null]
    ];
    if (strokeBeforeFill(style.paintOrder)) passes.reverse();
    const chars = [...content];
    let picked = false;
    for (const [halo, color] of passes) {
      if (!color) continue;
      for (let i = 0; i < chars.length; i++) {
        const at = placed[i];
        if (!at.visible || !chars[i].trim()) continue;
        const glyph = atlas.glyph(rasterFont, chars[i], halo, join, miter);
        if (!glyph) return "glyph atlas full";
        // the pen origin sits half the (spaced) advance before the path sample, as in SVG textPath layout
        const lx = -advances[i] / 2 + glyph.left / scale;
        const ly = dy + baselineShift + glyph.top / scale;
        const [w, h] = [glyph.width / scale, glyph.height / scale];
        out.push(at.x, at.y, at.angle, lx, ly, w, h, glyph.u0, glyph.v0, glyph.u1, glyph.v1, ...color);
        if (!picked) boxes.push({ id: text.id, corners: quad(at.x, at.y, at.angle, lx, ly, w, h) });
      }
      picked = true; // one pick box per glyph, from the first painted pass
    }
  }
  return "";
}

const isText = (node: Node): node is Text => node.nodeType === 3;
const isElement = (node: Node): node is Element => node.nodeType === 1;

export function quad(cx: number, cy: number, angle: number, lx: number, ly: number, w: number, h: number): number[] {
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const corners: number[] = [];
  for (const [x, y] of [
    [lx, ly],
    [lx + w, ly],
    [lx + w, ly + h],
    [lx, ly + h]
  ])
    corners.push(cx + c * x - s * y, cy + s * x + c * y);
  return corners;
}
