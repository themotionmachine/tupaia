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
    // miter corners can reach miterLimit * half the stroke width past the outline
    const extra = ((join === "miter" ? Math.max(1, miter) : 1) * halo) / 2 + PAD;
    return this.entry(key, font, char, extra, "auto", c => {
      if (halo > 0) {
        c.lineJoin = join;
        c.miterLimit = miter;
        c.lineWidth = halo;
        c.strokeText(char, 0, 0);
      } else c.fillText(char, 0, 0);
    });
  }

  // The blurred coverage of a whole string (a CSS text-shadow is the blur of the text's union, not of each glyph):
  // `blur` is the shadow blur in this raster's pixels (canvas shadowBlur and CSS blur radius both mean sigma = blur/2).
  shadow(font: string, text: string, blur: number, kerning: CanvasFontKerning): Glyph | null {
    const key = `${font}|shadow|${blur}|${kerning}|${text}`;
    // a Gaussian of sigma = blur/2 is negligible past 3 sigma
    const extra = Math.ceil(1.5 * blur) + PAD;
    return this.entry(key, font, text, extra, kerning, (c, cell) => {
      // only the shadow lands in the cell: the text itself is drawn off the canvas and its shadow offset back
      c.beginPath();
      c.rect(cell.x, cell.y, cell.width, cell.height);
      c.clip();
      const away = 4 * ATLAS;
      c.shadowColor = "#fff";
      c.shadowBlur = blur;
      c.shadowOffsetX = away;
      c.fillText(text, -away, 0);
    });
  }

  private entry(
    key: string,
    font: string,
    text: string,
    extra: number,
    kerning: CanvasFontKerning,
    paint: (c: CanvasRenderingContext2D, cell: { x: number; y: number; width: number; height: number }) => void
  ): Glyph | null {
    const cached = this.glyphs.get(key);
    if (cached) return cached;
    const c = this.context;
    c.font = font;
    c.fontKerning = kerning;
    const m = c.measureText(text);
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
    paint(c, { x: left, y: top, width, height });
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

// The atlas cuts a text-shadow alone by drawing the text far off the canvas and offsetting only its shadow back in
// (GlyphAtlas.shadow). Chromium paints that shadow; a browser that culled the off-canvas draw before its shadow would
// leave the cell empty and the text shadowless. One probe per process: when it finds no ink, shadowed text stays on
// the compat lane under a named reason instead.
let offCanvasShadow: boolean | undefined;
export function offCanvasShadowPaints(context?: CanvasRenderingContext2D | null): boolean {
  offCanvasShadow ??= probeOffCanvasShadow(context === undefined ? probeContext() : context);
  return offCanvasShadow;
}

function probeOffCanvasShadow(c: CanvasRenderingContext2D | null): boolean {
  if (!c) return false;
  try {
    const away = 4 * ATLAS;
    c.font = "24px sans-serif";
    c.fillStyle = "#fff";
    c.shadowColor = "#fff";
    c.shadowBlur = 2;
    c.shadowOffsetX = away;
    c.fillText("H", 4 - away, 26);
    const { data } = c.getImageData(0, 0, 32, 32);
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  } catch {
    return false;
  }
}

function probeContext(): CanvasRenderingContext2D | null {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  return canvas.getContext("2d", { willReadFrequently: true });
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
  if (!textPath && !text.children.length) return layoutStraight(text, scale, atlas, out, boxes);
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

// ---------------------------------------------------------------- straight text (outside #labels)
// A plain <text x y [dx dy]>content</text>: one horizontal line from (x+dx, y+dy), anchored as text-anchor says. The
// overlay layers draw their small text this way (temperature, regiment numbers, coordinates, wind arrows, rulers).

// Color glyphs: the atlas stores coverage only, so an emoji would come out as a tinted silhouette. Conservative:
// some symbols (©, ™, ↔) that usually render as text are kept on the compat lane too.
export function emojiContent(content: string): boolean {
  return /\p{Extended_Pictographic}|\u{FE0F}|\u{20E3}/u.test(content);
}

export interface TextShadow {
  color: Rgba;
  x: number; // CSS px: Chromium paints an SVG text-shadow in CSS pixels, independent of the user-space transform
  y: number;
  blur: number;
}

const SHADOW_LENGTH = "(-?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?)px";
const SHADOW = new RegExp(`^(.+?)\\s+${SHADOW_LENGTH}\\s+${SHADOW_LENGTH}(?:\\s+${SHADOW_LENGTH})?$`, "i");

// Computed text-shadow ("rgb(…) 0px 0px 10px, …"): [] for none, null when it cannot be read exactly. Fully
// transparent shadows paint nothing and are dropped.
export function parseTextShadows(value: string | undefined): TextShadow[] | null {
  if (!value || value === "none") return [];
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")") depth--;
    else if (value[i] === "," && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  const shadows: TextShadow[] = [];
  for (const part of parts) {
    const match = SHADOW.exec(part.trim());
    if (!match) return null;
    const color = parseColor(match[1]);
    const [x, y, blur] = [Number(match[2]), Number(match[3]), Number(match[4] ?? 0)];
    if (!color || ![x, y, blur].every(Number.isFinite) || blur < 0) return null;
    if (color[3] > 0) shadows.push({ color, x, y, blur });
  }
  return shadows;
}

// Device pixels per CSS pixel as the renderer sizes its canvas (renderer.ts caps the DPR at 2).
function devicePixelRatio(): number {
  const dpr = Number(globalThis.devicePixelRatio) || 1;
  return Math.min(Math.max(dpr, 1), 2);
}

// Text style as getComputedStyle exposes it (a plain record in tests).
type StraightStyle = Partial<Record<string, string>>;

interface StraightPlan {
  content: string;
  px: number;
  x: number;
  y: number;
  fill: Rgba | null;
  stroke: Rgba | null;
  strokeWidth: number;
  join: CanvasLineJoin;
  miter: number;
  shadows: TextShadow[];
  baseline: "auto" | "central";
  anchor: "start" | "middle" | "end";
}

// Everything about a straight <text> that does not need fonts: a reason it must stay compat, or the plan to lay it out.
export function planStraightText(text: Element, style: StraightStyle): StraightPlan | string {
  if ([...text.childNodes].some(node => !isText(node))) return "tspan structure";
  if (text.getAttribute("transform") !== null) return "text transform";
  if (presentAttribute(text, ["rotate", "textLength", "lengthAdjust"])) return "text positioning";
  const content = text.textContent || "";
  if (emojiContent(content)) return "emoji";
  const contentReason = unsupportedContent(content);
  if (contentReason) return contentReason;
  const baselineValue = style.dominantBaseline === "alphabetic" ? "auto" : style.dominantBaseline || "auto";
  const checked: StraightStyle = { textShadow: "none", dominantBaseline: baselineValue };
  for (const [property] of STYLE_DEFAULTS) if (!(property in checked)) checked[property] = style[property];
  checked.fill = style.fill;
  checked.stroke = style.stroke;
  const unsupported = unsupportedStyle(checked);
  if (unsupported) return unsupported;
  const px = Number.parseFloat(style.fontSize || "");
  // browsers compute font-size in px; a bare number (presentation attribute, as in the test stub) means px too
  if (!(px > 0) || !PX.test(style.fontSize || "")) return "font-size";
  const length = (name: string) => parseLength(text.getAttribute(name) ?? "0", px);
  const [x, y, dx, dy] = ["x", "y", "dx", "dy"].map(length);
  if (x === null || y === null || dx === null || dy === null) return "text positioning";
  if (letterSpacingPx(style.letterSpacing) !== 0) return "letter-spacing";
  const opacity = Number.parseFloat(style.opacity ?? "1");
  const fillOpacity = Number.parseFloat(style.fillOpacity ?? "1");
  const fill = parseColor(style.fill, fillOpacity * opacity);
  if (!fill && style.fill && style.fill !== "none") return `fill ${style.fill}`;
  const strokeColor = parseColor(style.stroke, Number.parseFloat(style.strokeOpacity ?? "1") * opacity);
  if (!strokeColor && style.stroke && style.stroke !== "none") return `stroke ${style.stroke}`;
  const strokeWidth = strokeColor ? Number.parseFloat(style.strokeWidth || "1") || 0 : 0;
  const stroke = strokeWidth > 0 ? strokeColor : null;
  if (stroke) {
    const strokeReason = unsupportedStroke(style);
    if (strokeReason) return strokeReason;
  }
  const shadows = parseTextShadows(style.textShadow);
  if (!shadows) return "text-shadow";
  if (shadows.length) {
    // the shadow is the blur of everything the text paints; only a plain opaque fill is modelled
    if (stroke) return "text-shadow over stroke";
    if (!fill || fillOpacity * opacity < 1) return "text-shadow over translucent fill";
  }
  // per-pass alpha would show the overlap that group opacity hides
  if (opacity < 1 && fill && stroke) return "opacity over fill and stroke";
  const anchor = style.textAnchor === "middle" ? "middle" : style.textAnchor === "end" ? "end" : "start";
  return {
    content,
    px,
    x: x + dx,
    y: y + dy,
    fill,
    stroke,
    strokeWidth,
    join: (style.strokeLinejoin || "miter") as CanvasLineJoin,
    miter: Number.parseFloat(style.strokeMiterlimit || "4") || 4,
    shadows,
    baseline: baselineValue as "auto" | "central",
    anchor
  };
}

// The scene's routing check: "" when the text can be drawn natively (fonts are checked at layout).
export function straightTextReason(text: Element, style: StraightStyle): string {
  const plan = planStraightText(text, style);
  return typeof plan === "string" ? plan : "";
}

// Shadows are sized for the raster bucket (device px per world unit = scale): exact when the camera's k·dpr equals it
// (k·dpr a power of two up to 16), smaller than SVG's by up to 2x in between. The blurred mask is cut at a lower
// resolution where its sigma allows (a blur of sigma ≥ 2 px loses nothing to bilinear upsampling) to save atlas room.
async function layoutStraight(
  text: SVGTextElement,
  scale: number,
  atlas: GlyphAtlas,
  out: number[],
  boxes: LabelBatch["boxes"]
): Promise<string> {
  const style = getComputedStyle(text);
  const plan = planStraightText(text, style as unknown as StraightStyle);
  if (typeof plan === "string") return plan;
  const { content, px } = plan;
  const font = cssFont(style, px);
  const fontIssue = await fontReady(font, content);
  if (fontIssue) {
    atlas.fontIssues.set(font, content);
    return fontIssue;
  }
  // SVG text stays kerned under text-rendering: optimizeSpeed (Chromium getComputedTextLength is the same for auto,
  // optimizeSpeed and geometricPrecision), so the layout always measures with kerning
  const kerning: CanvasFontKerning = "auto";
  const rasterFont = cssFont(style, px * scale);
  measure!.font = rasterFont;
  measure!.fontKerning = kerning;
  const metrics = measure!.measureText(content);
  const baselineShift = centralBaselineShift(plan.baseline, metrics, scale);
  if (baselineShift === null) return "central baseline metrics";
  const advances = prefixAdvances(content, s => measure!.measureText(s).width / scale);
  const width = advances.reduce((sum, advance) => sum + advance, 0);
  const x0 = plan.x - (plan.anchor === "middle" ? width / 2 : plan.anchor === "end" ? width : 0);
  const y0 = plan.y;
  const instances: number[] = [];
  const push = (cx: number, cy: number, glyph: Glyph, glyphScale: number, color: Rgba) =>
    instances.push(
      cx,
      cy,
      0,
      glyph.left / glyphScale,
      baselineShift + glyph.top / glyphScale,
      glyph.width / glyphScale,
      glyph.height / glyphScale,
      glyph.u0,
      glyph.v0,
      glyph.u1,
      glyph.v1,
      ...color
    );
  const dpr = devicePixelRatio();
  if (plan.shadows.length && !offCanvasShadowPaints()) return "text-shadow (canvas culls off-canvas shadow)";
  // CSS paints the first shadow on top: the last one goes down first
  for (const shadow of [...plan.shadows].reverse()) {
    const sigma = (shadow.blur * dpr) / 2; // device px
    const reduce = sigma > 2 ? 2 / sigma : 1;
    const shadowScale = scale * reduce;
    const glyph = atlas.shadow(cssFont(style, px * shadowScale), content, shadow.blur * dpr * reduce, kerning);
    if (!glyph) return "glyph atlas full";
    push(x0 + (shadow.x * dpr) / scale, y0 + (shadow.y * dpr) / scale, glyph, shadowScale, shadow.color);
  }
  const passes: [number, Rgba | null][] = [
    [0, plan.fill],
    [plan.strokeWidth * scale, plan.stroke]
  ];
  if (strokeBeforeFill(style.paintOrder)) passes.reverse();
  const chars = [...content];
  let box: number[] | null = null;
  for (const [halo, color] of passes) {
    if (!color) continue;
    let pen = x0;
    for (let i = 0; i < chars.length; i++) {
      const advance = advances[i];
      if (chars[i].trim()) {
        const glyph = atlas.glyph(rasterFont, chars[i], halo, plan.join, plan.miter);
        if (!glyph) return "glyph atlas full";
        push(pen, y0, glyph, scale, color);
      }
      pen += advance;
    }
    box ??= [
      x0,
      y0 + baselineShift - metrics.fontBoundingBoxAscent / scale,
      width,
      (metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent) / scale
    ];
  }
  out.push(...instances);
  if (box) {
    const [bx, by, bw, bh] = box;
    boxes.push({ id: text.id, corners: [bx, by, bx + bw, by, bx + bw, by + bh, bx, by + bh] });
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
