// Curved <text><textPath><tspan> labels (and plain straight <text>) as instanced glyph quads. Each character sits where
// the SVG's own layout puts it (getStartPositionOfChar...: the hidden SVG is the model and the reference); a text the
// SVG has not laid out (viewport-culled, display:none) is measured with Canvas2D instead (kerned prefix widths of the
// loaded font). Glyphs are rasterized, in their own paint colour, into a shelf-packed alpha atlas.
import { cumulativeLengths, layoutOnPath } from "./geometry";
import { parseColor, type Rgba } from "./scene";
import { SHADOW_MASK_SIGMA } from "./shaders";
import { flattenPath } from "./svg-path";

// cx cy angle lx ly w h u0 v0 u1 v1 r g b a ascent descent baseline. A soft (shadow) cell, alpha < 0, has cx cy = its
// top-left corner, angle = the shadow sigma in device px and lx ly = its offset in CSS px (layoutStraight). `baseline`
// 1 or 2 means a central baseline the glyph shader computes per frame from ascent and descent (user units per CSS px
// of zoom, centralShiftAt), 2 nested; 0 means any baseline shift is already in ly (shaders.ts glyph).
export const GLYPH_FLOATS = 18;
const ATLAS = 2048;
export const GLYPH_ATLAS = ATLAS; // atlas edge in px; glyph uvs are normalized by it
const PAD = 3; // transparent margin per cell: the glyph shader's Lanczos-3 kernel reads 3 texels past a quad edge

// Atlas rows the glyph instances sample: the shelves fill from the top, so everything below the lowest cell bottom
// (v1) is empty. One more row keeps the transparent gutter under that cell, so linear filtering at the cell edge reads
// what it reads in the full atlas. The GPU copy holds only these rows (a 2048 x 2048 RGBA atlas is 16 MiB whatever its
// glyph count) and the shader rescales v by GLYPH_ATLAS / rows.
export function glyphAtlasRows(
  instances: ArrayLike<number>,
  count = Math.floor(instances.length / GLYPH_FLOATS)
): number {
  let bottom = 0;
  for (let i = 0; i < count; i++) bottom = Math.max(bottom, instances[i * GLYPH_FLOATS + 10]);
  return count ? Math.min(ATLAS, Math.max(1, Math.ceil(bottom * ATLAS - 1e-6) + 1)) : 0;
}

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
  // `ink` is the opaque colour the text paints with (inkColor): Skia's glyph masks depend on the paint's luminance
  // (contrast and gamma "preblend"), so a mask cut in white is visibly heavier than the dark text SVG draws. The
  // coverage read from the atlas is the one SVG paints only when the mask is cut in (the luminance of) its own colour.
  glyph(
    font: string,
    char: string,
    halo: number,
    join: CanvasLineJoin = "round",
    miter = 4,
    ink = "#fff"
  ): Glyph | null {
    const key = halo > 0 ? `${font}|${halo}|${join}|${miter}|${ink}|${char}` : `${font}|0|${ink}|${char}`;
    // miter corners can reach miterLimit * half the stroke width past the outline
    const extra = ((join === "miter" ? Math.max(1, miter) : 1) * halo) / 2 + PAD;
    return this.entry(key, font, char, extra, "auto", ink, "auto", c => {
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
  shadow(
    font: string,
    text: string,
    blur: number,
    kerning: CanvasFontKerning,
    ink = "#fff",
    rendering: "auto" | "optimizeSpeed" = "auto"
  ): Glyph | null {
    const key = `${font}|shadow|${blur}|${kerning}|${rendering}|${ink}|${text}`;
    // a Gaussian of sigma = blur/2 is negligible past 3 sigma; the glyph shader widens the blur on screen by up to 2x
    // (a camera just above a power of two: shaders.ts glyph), so the cell keeps 6 sigma
    const extra = Math.ceil(3 * blur) + PAD;
    return this.entry(key, font, text, extra, kerning, ink, rendering, (c, cell) => {
      // only the shadow lands in the cell: the text itself is drawn off the canvas and its shadow offset back
      c.beginPath();
      c.rect(cell.x, cell.y, cell.width, cell.height);
      c.clip();
      const away = 4 * ATLAS;
      c.shadowColor = ink;
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
    ink: string,
    rendering: "auto" | "optimizeSpeed",
    paint: (c: CanvasRenderingContext2D, cell: { x: number; y: number; width: number; height: number }) => void
  ): Glyph | null {
    const cached = this.glyphs.get(key);
    if (cached) return cached;
    const c = this.context;
    c.font = font;
    c.fontKerning = kerning;
    c.textRendering = rendering;
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
    c.fillStyle = c.strokeStyle = ink;
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

  // The compat routing of text.ts's shaping check (shapingReason), reachable from the page for the label harness's
  // advance step (bench/host/labels.ts), which judges only the strings the GPU draws natively.
  shaping(rasterFont: string, content: string, rendering?: string, spacing = 0): string {
    return shapingReason(rasterFont, content, rendering, spacing);
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

// SVG character start positions from Canvas2D widths, when the SVG's own layout cannot be read (svgCharPositions):
// character i starts at width(prefix(i+1)) - width(char i). A kern pair moves the second character (HarfBuzz adds it to
// the first one's advance), so width(prefix(i)) alone would leave out the kern between characters i-1 and i. Returns
// each character's advance as SVG paints it (start(i+1) - start(i); the last one its own width), code point by code
// point. Pass the width through wholeRunWidth so kern pairs across a space count too.
export function kernedAdvances(text: string, width: (s: string) => number): number[] {
  const chars = [...text];
  const starts: number[] = [];
  let prefix = "";
  for (const [i, char] of chars.entries()) {
    prefix += char;
    starts.push(i ? width(prefix) - width(char) : 0);
  }
  const total = chars.length ? width(prefix) : 0;
  return starts.map((start, i) => (i + 1 < starts.length ? starts[i + 1] : total) - start);
}

// Canvas2D shapes a string word by word (its word cache splits at spaces), so a kern pair across a space (Times kerns
// " W", "y." and " T") is lost; SVG shapes the whole run. A no-break space is the space glyph in most fonts and does not
// split the run, so measuring with it keeps those pairs. Used only when the font gives the two the same width.
export function wholeRun(text: string, width: (s: string) => number): string {
  return text.includes(" ") && Math.abs(width(" ") - width("\u00a0")) <= 1e-6 ? text.replaceAll(" ", "\u00a0") : text;
}

export function wholeRunWidth(width: (s: string) => number): (s: string) => number {
  return text => width(wholeRun(text, width));
}

// The kern before each code point (between it and the previous one; 0 for the first), from the same widths as
// kernedAdvances: width(prefix(i+1)) - width(prefix(i)) - width(char i).
export function kernsBefore(text: string, width: (s: string) => number): number[] {
  const kerns: number[] = [];
  let prefix = "";
  let previous = 0;
  for (const char of text) {
    const next = width(prefix + char);
    kerns.push(prefix ? next - previous - width(char) : 0);
    prefix += char;
    previous = next;
  }
  return kerns;
}

// How far each character's painted pen origin lies past the start Chromium's SVG query API reports for it
// (getStartPositionOfChar), along the baseline. HarfBuzz applies a legacy 'kern' table pair by splitting it: half to
// the first glyph's advance, half to the second's advance plus the same half to its x offset, so the second glyph
// paints where the whole kern puts it while its character is reported to start half the kern earlier. GPOS kerning
// (most web fonts) moves the first advance only, so the reported start is the painted origin. W3 GLYPH probes
// (tspan-isolated ink centroids at 80 px): Times "AVA" reported 5.1 px off its paint, Verdana and Impact up to 4.3 px,
// on <text> and <textPath> alike; Cinzel, Arial and other GPOS fonts 0. The font does not say which it uses, so the
// SVG's own per-character advances decide (`reported`, null where unknown): a split pair reports
// own(i) + (kern(i) + kern(i+1))/2, a GPOS one own(i) + kern(i+1), letter-spacing added to both. Returns kern(i)/2 per
// code point when the split reading fits better, else zeros (also when nothing kerns).
export function kernOffsets(reported: (number | null)[], own: number[], kerns: number[], spacing = 0): number[] {
  let split = 0;
  let gpos = 0;
  for (const [i, advance] of reported.entries()) {
    if (advance === null) continue;
    const next = kerns[i + 1] ?? 0;
    split += Math.abs(advance - (own[i] + spacing + (kerns[i] + next) / 2));
    gpos += Math.abs(advance - (own[i] + spacing + next));
  }
  return kerns.map(kern => (split < gpos ? kern / 2 : 0));
}

// kernOffsets for the code points `chars` of a run whose first UTF-16 unit is `unit` in the SVG positions.
function reportedOffsets(
  svg: (CharPosition | null)[],
  unit: number,
  chars: string[],
  width: (s: string) => number,
  spacing: number
): number[] {
  const reported: (number | null)[] = [];
  for (const char of chars) {
    reported.push(svg[unit]?.advance ?? null);
    unit += char.length;
  }
  return kernOffsets(
    reported,
    chars.map(char => width(char)),
    kernsBefore(chars.join(""), width),
    spacing
  );
}

// ---------------------------------------------------------------- shaping (W3b GLYPH2)
// The GPU draws a label as one atlas glyph per code point, each cut alone, at pens from kerned Canvas2D prefix widths
// (or the SVG's own character positions). SVG shapes the whole run. The two agree unless the run's shaping depends on
// more than pair kerning, which the GLYPH advance probes found in two forms:
// - substitution: ligatures (fi, ff, Th; liga/clig) and contextual alternates (calt: Dancing Script, Henny Penny,
//   Lobster Two, UnifrakturMaguntia) change glyph shapes, and often advances, with their neighbours. A glyph cut alone
//   cannot follow; under text-rendering: optimizeSpeed or a non-zero letter-spacing Chromium turns liga, clig and calt
//   off in SVG text (and in Canvas2D with the same textRendering), so the composition then matches again.
// - advances Canvas2D cannot measure: kern pairs with the space (Brush Script MT ". W", Herculanum " Ve", Eagle Lake).
//   Canvas2D shapes word by word and a no-break space kerns differently, so the measured pens miss them.
// Neither shows in the font's name, so it is detected per (font, string) and the label takes the compat lane
// ("shaping"). A font is first profiled on SHAPING_PROBE (ligature triggers, a pangram in both cases, every letter
// beside a space): only a font that mismatches there pays for the per-string checks.
// - ink: the run filled whole against its code points filled one by one at the measured pens (Canvas2D, at
//   SHAPING_PX). Identical shaping gives identical pixels (0 on every font of the W3b probe without substitutions);
//   any substitution changes ink.
// - advance: where the SVG reports each character of the run (a hidden probe <text>, SHAPING_PX) against where the
//   measured model predicts it reports it (the painted pen, less half the leading kern when HarfBuzz split a legacy
//   kern pair, kernOffsets). Scaled to the label's raster px, an error above SHAPING_TOLERANCE.rasterPx is a mismatch.
export const SHAPING_PX = 48;
export const SHAPING_TOLERANCE = {
  inkShare: 0.002, // differing coverage over the run's coverage: 0 without substitution, >= 0.0023 with one (W3b probe)
  rasterPx: 0.5, // advance error at the label's raster size; the gate is 1 device px and device px <= raster px
  profilePx: 0.1 // advance error on the profile probe at SHAPING_PX that makes a font worth per-string checks
} as const;
export const SHAPING_PROBE = [
  "Office fluff, affine flight. The Thistle; Strait act.",
  "The quick brown fox jumps over the lazy dog.",
  "SPHINX OF BLACK QUARTZ, JUDGE MY VOW!",
  "A B C D E F G H I J K L M N O P Q R S T U V W X Y Z",
  "a b c d e f g h i j k l m n o p q r s t u v w x y z",
  "St. Wynn, Mt. Vale. A. T. V. W. Y. (Ty) 'Wa' \"Yo\" 1 2 3 4"
];

// The font features a text's computed text-rendering and letter-spacing leave on: "optimizeSpeed" when Chromium turns
// liga, clig and calt off (it keeps kerning), else "auto". Canvas2D's textRendering applies the same rule.
export function shapingFeatures(rendering: string | undefined, spacing = 0): "auto" | "optimizeSpeed" {
  return rendering === "optimizeSpeed" || spacing !== 0 ? "optimizeSpeed" : "auto";
}

// Largest error, in the width's units, between where the SVG reports each code point's start (relative to the first;
// null where it renders none) and run end, and where the measured model predicts them: the painted pen (kerned prefix
// widths, kernedAdvances) less half the leading kern when the reported advances show a split legacy kern pair.
export function shapingAdvanceError(
  chars: string[],
  width: (s: string) => number,
  reported: ({ start: number; advance: number } | null)[],
  end: number | null
): number {
  const content = chars.join("");
  const advances = kernedAdvances(content, width);
  const offsets = kernOffsets(
    reported.map(r => r?.advance ?? null),
    chars.map(char => width(char)),
    kernsBefore(content, width)
  );
  const origin = reported[0]?.start;
  if (origin === undefined) return 0;
  let pen = 0;
  let error = 0;
  for (const [i, advance] of advances.entries()) {
    const at = reported[i];
    if (at) error = Math.max(error, Math.abs(pen - offsets[i] - (at.start - origin)));
    pen += advance;
  }
  return end === null ? error : Math.max(error, Math.abs(pen - (end - origin)));
}

// Differing coverage between two RGBA captures, as a share of the first one's coverage (alpha channel).
export function inkMismatch(whole: ArrayLike<number>, composed: ArrayLike<number>): number {
  let ink = 0;
  let diff = 0;
  for (let i = 3; i < whole.length; i += 4) {
    ink += whole[i];
    diff += Math.abs(whole[i] - composed[i]);
  }
  return ink ? diff / ink : 0;
}

interface ShapingSignals {
  ink: number; // inkMismatch at SHAPING_PX
  advance: number; // shapingAdvanceError at SHAPING_PX, px
}

// Process-wide: shaping depends on the face only. Emptied when the document's font set changes (a face added or
// replaced under a family name).
const shapingProfiles = new Map<string, boolean>();
const shapingStrings = new Map<string, ShapingSignals>();
let shapingFontCount = -1;
let shapingCanvas: CanvasRenderingContext2D | null | undefined;

// "" when the GPU's per-code-point composition of `content` matches how SVG shapes it at this raster font, else
// "shaping" (the label takes the compat lane). `rasterFont` is cssFont at the raster px; `rendering` the computed
// text-rendering and `spacing` the letter-spacing px of the text. Measurements that cannot run (no SVG text layout or
// no readable 2D canvas, e.g. a test DOM) find no mismatch.
export function shapingReason(rasterFont: string, content: string, rendering?: string, spacing = 0): string {
  const font = /^(.*?)(\d+(?:\.\d+)?)px\s+(.+)$/.exec(rasterFont);
  if (!font || !content.trim()) return "";
  const [, prefix, size, family] = font;
  const features = shapingFeatures(rendering, spacing);
  const fonts = globalThis.document?.fonts?.size ?? 0;
  if (fonts !== shapingFontCount) {
    shapingFontCount = fonts;
    shapingProfiles.clear();
    shapingStrings.clear();
  }
  const reference = `${prefix}${SHAPING_PX}px ${family}`;
  const base = `${reference}|${features}`;
  let flagged = shapingProfiles.get(base);
  if (flagged === undefined) {
    flagged = SHAPING_PROBE.some(probe => {
      const s = shapingSignals(reference, family, features, probe);
      return s.ink > SHAPING_TOLERANCE.inkShare || s.advance > SHAPING_TOLERANCE.profilePx;
    });
    shapingProfiles.set(base, flagged);
  }
  if (!flagged) return "";
  const key = `${base}|${content}`;
  let signals = shapingStrings.get(key);
  if (!signals) {
    signals = shapingSignals(reference, family, features, content);
    if (shapingStrings.size > 20000) shapingStrings.clear();
    shapingStrings.set(key, signals);
  }
  const rasterPx = Number(size);
  return signals.ink > SHAPING_TOLERANCE.inkShare ||
    (signals.advance * rasterPx) / SHAPING_PX > SHAPING_TOLERANCE.rasterPx
    ? "shaping"
    : "";
}

function shapingContext(): CanvasRenderingContext2D | null {
  if (shapingCanvas === undefined) {
    try {
      shapingCanvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    } catch {
      shapingCanvas = null; // no DOM canvas (a test environment)
    }
  }
  return shapingCanvas;
}

function shapingSignals(
  font: string,
  family: string,
  features: "auto" | "optimizeSpeed",
  content: string
): ShapingSignals {
  const c = shapingContext();
  if (!c) return { ink: 0, advance: 0 };
  const setup = () => {
    c.font = font;
    c.fontKerning = "auto";
    c.textRendering = features;
  };
  setup();
  const width = wholeRunWidth(s => c.measureText(s).width);
  const chars = [...content];
  const advances = kernedAdvances(content, width);
  let ink = 0;
  try {
    const run = wholeRun(content, s => c.measureText(s).width);
    const pad = SHAPING_PX;
    const w = Math.ceil(advances.reduce((sum, a) => sum + a, 0) + 2 * pad);
    const h = Math.ceil(2 * SHAPING_PX);
    if (c.canvas.width < w || c.canvas.height < h) {
      c.canvas.width = Math.max(c.canvas.width, w);
      c.canvas.height = Math.max(c.canvas.height, h);
    }
    const baseline = Math.round(1.25 * SHAPING_PX);
    c.clearRect(0, 0, w, h);
    setup();
    c.fillStyle = "#000";
    c.fillText(run, pad, baseline);
    const whole = c.getImageData(0, 0, w, h).data;
    c.clearRect(0, 0, w, h);
    let pen = pad;
    for (const [i, char] of chars.entries()) {
      if (char.trim()) c.fillText(char, pen, baseline);
      pen += advances[i];
    }
    ink = inkMismatch(whole, c.getImageData(0, 0, w, h).data);
  } catch {
    ink = 0;
  }
  const svg = svgRunPositions(font, family, features, content);
  const advance = svg ? shapingAdvanceError(chars, width, svg.chars, svg.end) : 0;
  return { ink: Number.isFinite(ink) ? ink : 0, advance: Number.isFinite(advance) ? advance : 0 };
}

// Where the SVG puts each code point of `content` laid out straight in the probe <svg> (start relative to nothing in
// particular, advance), and the end of the last rendered one; null without SVG text layout.
function svgRunPositions(
  font: string,
  family: string,
  features: string,
  content: string
): { chars: ({ start: number; advance: number } | null)[]; end: number | null } | null {
  const probe = centralProbeElements();
  if (!probe) return null;
  try {
    const text = probe.run;
    const size = /(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? String(SHAPING_PX);
    const [style = "normal", weight = "normal"] = font
      .slice(0, font.indexOf(`${size}px`))
      .trim()
      .split(/\s+/);
    // inline style wins over any stylesheet rule that matches svg text
    text.setAttribute(
      "style",
      `font-family:${family};font-size:${size}px;font-style:${style};font-weight:${weight};text-rendering:${features};` +
        "letter-spacing:0;word-spacing:0;font-kerning:auto;font-variant:normal;font-feature-settings:normal;white-space:pre"
    );
    text.textContent = content;
    if (text.getNumberOfChars() !== content.length) return null;
    const chars: ({ start: number; advance: number } | null)[] = [];
    let end: number | null = null;
    let unit = 0;
    for (const char of content) {
      const start = text.getStartPositionOfChar(unit);
      const stop = text.getEndPositionOfChar(unit);
      unit += char.length;
      if (start.x === 0 && start.y === 0 && stop.x === 0 && stop.y === 0) {
        chars.push(null);
        continue;
      }
      chars.push({ start: start.x, advance: stop.x - start.x });
      end = stop.x;
    }
    return chars.some(Boolean) ? { chars, end } : null;
  } catch {
    return null;
  }
}

// The opaque colour a glyph mask is cut in (GlyphAtlas.glyph `ink`): the paint colour without its alpha, which the
// instance colour carries.
export function inkColor(color: Rgba): string {
  const [r, g, b] = color.map(channel => Math.round(Math.min(1, Math.max(0, channel)) * 255));
  return `rgb(${r},${g},${b})`;
}

// Where the SVG itself puts each addressable character (UTF-16 unit) of a laid-out <text>, in its user space:
// getStartPositionOfChar / getEndPositionOfChar / getRotationOfChar, which include kerning (across spaces too; a
// start may sit half its leading kern before the painted origin, kernOffsets), letter-spacing, text-anchor, startOffset,
// dy and the path. Null when the element is not laid out (display:none, a test DOM), has a different character count
// than expected, or the API throws. An entry is null for a character the SVG does not render (past the end of its
// path: Chromium reports it at the origin with no advance).
export interface CharPosition {
  x: number; // start of the character on its (dy-shifted) baseline
  y: number;
  ex: number; // end
  ey: number;
  advance: number; // distance from start to end
  angle: number; // radians
}

export function svgCharPositions(text: SVGTextElement, expected: number): (CharPosition | null)[] | null {
  if (typeof text.getNumberOfChars !== "function" || typeof text.getStartPositionOfChar !== "function") return null;
  try {
    const count = text.getNumberOfChars();
    if (count !== expected) return null;
    const out: (CharPosition | null)[] = [];
    for (let i = 0; i < count; i++) {
      const start = text.getStartPositionOfChar(i);
      const end = text.getEndPositionOfChar(i);
      if (!start || !end) return null;
      if (start.x === 0 && start.y === 0 && end.x === 0 && end.y === 0) {
        out.push(null);
        continue;
      }
      const angle = (text.getRotationOfChar(i) * Math.PI) / 180;
      const advance = Math.hypot(end.x - start.x, end.y - start.y);
      if (![start.x, start.y, advance, angle].every(Number.isFinite)) return null;
      out.push({ x: start.x, y: start.y, ex: end.x, ey: end.y, advance, angle });
    }
    // nothing placed at all: a DOM without SVG text layout, not a text the SVG hides entirely
    return out.some(Boolean) ? out : null;
  } catch {
    return null;
  }
}

// The dominant-baseline:central shift as the SVG applies it, in user units at a CTM scale. Chromium lays SVG text out
// with a font scaled to the screen and rounds that font's ascent and descent, so the shift depends on the scale in a
// way the canvas font box at the raster bucket does not reproduce (it differs by up to half a device px per glyph).
// One hidden probe <svg> outside svg#map measures it: the extent of "H" under central minus under auto, at the
// label's CTM scale. Null when the probe cannot be laid out (no SVG text API, e.g. a test DOM).
let centralProbe:
  | { group: SVGGElement; auto: SVGTextElement; central: SVGTextElement; run: SVGTextElement }
  | null
  | undefined;
const centralShifts = new Map<string, number | null>();

export function svgCentralShift(style: TextStyle, px: number, scale: number): number | null {
  if (!(scale > 0) || !(px > 0)) return null;
  const key = `${style.fontStyle} ${style.fontWeight} ${px}px ${style.fontFamily}|${style.textRendering}|${scale}`;
  if (centralShifts.has(key)) return centralShifts.get(key)!;
  const probe = centralProbeElements();
  let shift: number | null = null;
  if (probe) {
    try {
      probe.group.setAttribute("transform", `scale(${scale})`);
      for (const text of [probe.auto, probe.central]) {
        text.setAttribute("font-family", style.fontFamily || "");
        text.setAttribute("font-size", String(px));
        text.setAttribute("font-style", style.fontStyle || "normal");
        text.setAttribute("font-weight", style.fontWeight || "normal");
        text.setAttribute("text-rendering", style.textRendering || "auto");
      }
      const value = probe.central.getExtentOfChar(0).y - probe.auto.getExtentOfChar(0).y;
      shift = Number.isFinite(value) ? value : null;
    } catch {
      shift = null;
    }
  }
  if (centralShifts.size > 512) centralShifts.clear();
  centralShifts.set(key, shift);
  return shift;
}

function centralProbeElements() {
  if (centralProbe !== undefined) return centralProbe;
  centralProbe = null;
  const doc = globalThis.document;
  if (!doc?.body || typeof doc.createElementNS !== "function") return null;
  const ns = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(ns, "svg");
  svg.setAttribute("width", "1");
  svg.setAttribute("height", "1");
  svg.setAttribute("aria-hidden", "true");
  svg.id = "gpuTextProbe";
  // laid out but never painted or hit (visibility, not display: a display:none text has no layout to query)
  svg.setAttribute(
    "style",
    "position:fixed;left:-100px;top:-100px;overflow:hidden;visibility:hidden;pointer-events:none"
  );
  const group = doc.createElementNS(ns, "g");
  const auto = doc.createElementNS(ns, "text") as SVGTextElement;
  const central = doc.createElementNS(ns, "text") as SVGTextElement;
  central.setAttribute("dominant-baseline", "central");
  for (const text of [auto, central]) text.textContent = "H";
  group.append(auto, central);
  // shapingReason's straight run, outside the scaled group (its positions are read in its own user space)
  const run = doc.createElementNS(ns, "text") as SVGTextElement;
  svg.append(group, run);
  doc.body.append(svg);
  // a DOM without SVG text layout (a test DOM) reports no extent: the canvas font box stands in
  let laidOut = false;
  try {
    auto.setAttribute("font-size", "16");
    laidOut = typeof auto.getExtentOfChar === "function" && auto.getExtentOfChar(0).height > 0;
  } catch {
    laidOut = false;
  }
  if (!laidOut) {
    svg.remove();
    return null;
  }
  centralProbe = { group, auto, central, run };
  return centralProbe;
}

// CSS px per user unit of an element's coordinate system (its screen CTM), or null.
function screenScale(element: SVGGraphicsElement): number | null {
  try {
    const m = element.getScreenCTM?.();
    const scale = m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) : Number.NaN;
    return scale > 0 && Number.isFinite(scale) ? scale : null;
  } catch {
    return null;
  }
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
  // The SVG's own character positions (kerning, letter-spacing, anchor, startOffset, dy and the path included) when the
  // label is laid out; otherwise (a viewport-culled label is display:none) the measured layout below.
  const svg = svgCharPositions(
    text,
    lines.reduce((sum, line) => sum + (line.textContent || "").length, 0)
  );
  const ctmScale = screenScale(text);
  const worldScale = viewboxScale(text);
  // the <text>'s own baseline: a central one makes every tspan's central baseline a nested one (baselineShiftFor)
  const rootBaseline = getComputedStyle(text).dominantBaseline;
  let dy = 0;
  let unit = 0; // the line's first addressable character (UTF-16 unit) in the whole text
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
    const shaping = shapingReason(rasterFont, content, style.textRendering, spacing);
    if (shaping) return shaping;
    measure.font = rasterFont;
    // SVG text keeps kerning under text-rendering: optimizeSpeed (Chromium lays out auto, optimizeSpeed and
    // geometricPrecision alike), so the measured layout always kerns; ligatures and contextual alternates follow
    // text-rendering and letter-spacing as in SVG (shapingFeatures)
    measure.fontKerning = "auto";
    measure.textRendering = shapingFeatures(style.textRendering, spacing);
    // a tspan that leaves its central <text> for another baseline aligns in ways not modelled here
    if (rootBaseline === "central" && style.dominantBaseline !== "central") return "baseline";
    const baseline = baselineShiftFor(
      style,
      px,
      ctmScale,
      measure.measureText(content),
      scale,
      rootBaseline === "central",
      worldScale
    );
    if (baseline === null) return "central baseline metrics";
    const width = wholeRunWidth(s => measure!.measureText(s).width / scale);
    const advances = spacedAdvances(kernedAdvances(content, width), spacing);
    if (!advances) return "letter-spacing";
    const anchor = style.textAnchor === "middle" ? "middle" : style.textAnchor === "end" ? "end" : "start";
    const chars = [...content];
    const offsets = svg ? reportedOffsets(svg, unit, chars, width, spacing) : [];
    // per character: the advance midpoint on the (dy-shifted) baseline, the angle there, the pen origin's offset from
    // the midpoint along the baseline, and the dy the instance still has to apply along the normal (0 when the SVG's
    // position already includes it)
    const placed: ({ x: number; y: number; angle: number; origin: number; dy: number } | null)[] = [];
    if (svg) {
      let at = unit;
      for (const [i, char] of chars.entries()) {
        const p = svg[at];
        at += char.length;
        placed.push(
          p && {
            x: (p.x + p.ex) / 2,
            y: (p.y + p.ey) / 2,
            angle: p.angle,
            // the painted origin: the reported start, moved by a split kern (kernOffsets)
            origin: -p.advance / 2 + offsets[i],
            dy: 0
          }
        );
      }
    } else
      for (const [i, p] of layoutOnPath(points, advances, (start + x) / total, anchor).entries())
        placed.push(p.visible ? { x: p.x, y: p.y, angle: p.angle, origin: -advances[i] / 2, dy } : null);
    unit += content.length;
    const passes: [number, Rgba | null][] = [
      [0, fill],
      [strokeWidth * scale, strokeWidth > 0 ? stroke : null]
    ];
    if (strokeBeforeFill(style.paintOrder)) passes.reverse();
    let picked = false;
    for (const [halo, color] of passes) {
      if (!color) continue;
      const ink = inkColor(color);
      for (let i = 0; i < chars.length; i++) {
        const at = placed[i];
        if (!at || !chars[i].trim()) continue;
        const glyph = atlas.glyph(rasterFont, chars[i], halo, join, miter, ink);
        if (!glyph) return "glyph atlas full";
        // the pen origin sits about half the (spaced) advance before the path sample, as in SVG textPath layout
        const lx = at.origin + glyph.left / scale;
        const ly = at.dy + baseline.baked + glyph.top / scale;
        const [w, h] = [glyph.width / scale, glyph.height / scale];
        out.push(
          at.x,
          at.y,
          at.angle,
          lx,
          ly,
          w,
          h,
          glyph.u0,
          glyph.v0,
          glyph.u1,
          glyph.v1,
          ...color,
          ...baseline.dynamic
        );
        if (!picked)
          boxes.push({ id: text.id, corners: quad(at.x, at.y, at.angle, lx, ly + baseline.atPrepare, w, h) });
      }
      picked = true; // one pick box per glyph, from the first painted pass
    }
  }
  return "";
}

// dominant-baseline shift of a label, in user units. Chromium lays SVG text out with the font scaled by the text's
// CTM scale k (CSS px per user unit) and rounds that font's ascent and descent to whole CSS px, so the central shift
// is (round(A·px·k) - round(D·px·k)) / 2 CSS px: it changes with k inside one raster bucket (W3b GLYPH2 probe: up to
// 2 device px, 3.5 with the nested ceil below, against the shift baked at the prepare's zoom). The glyph shader
// therefore computes it per frame (centralShiftAt) from the face's ascent and descent per px (fontBoxPerPx; the
// formula matched getExtentOfChar on 6759 of 6759 (k, px) samples per face up to the metrics' 1e-3 em rounding).
// `nested`: the characters sit in a child inline box (textPath, tspan) of a <text> whose own dominant baseline is
// central too (#labels sets it on the group, so every label inherits it). Chromium then paints the child's central
// baseline rounded up to a whole CSS px, while getExtentOfChar and a direct text child keep the half px (W3 GLYPH:
// Almendra SC 14-27.7 px at k 1-2, painted minus API 0 or exactly 1 device px at dpr 2).
// When the face's box cannot be read, or the text's user space is not the world's (a scaled ancestor), the shift is
// baked as before: the SVG's own (svgCentralShift at the element's CTM scale), else the canvas font box at the raster
// scale. Null for an unsupported baseline or unreadable metrics.
export interface Baseline {
  baked: number; // in ly
  dynamic: [number, number, number]; // ascent, descent (user units at k 1), mode: the instance's last three floats
  atPrepare: number; // the dynamic shift at the prepare's zoom (pick boxes)
}

function baselineShiftFor(
  style: TextStyle | CSSStyleDeclaration,
  px: number,
  ctmScale: number | null,
  metrics: { fontBoundingBoxAscent: number; fontBoundingBoxDescent: number },
  scale: number,
  nested = false,
  worldScale: number | null = null
): Baseline | null {
  const baseline = (style as TextStyle).dominantBaseline ?? "";
  const fallback = centralBaselineShift(baseline === "alphabetic" ? "auto" : baseline, metrics, scale);
  const baked = (shift: number): Baseline => ({ baked: shift, dynamic: [0, 0, 0], atPrepare: 0 });
  if (fallback === null || baseline !== "central") return fallback === null ? null : baked(fallback);
  const box = fontBoxPerPx(style as TextStyle);
  const world = !ctmScale || !worldScale || Math.abs(ctmScale / worldScale - 1) < 1e-4;
  if (box && world) {
    const mode = nested ? 2 : 1;
    const [ascent, descent] = [box.ascent * px, box.descent * px];
    const k = ctmScale ?? scale / devicePixelRatio();
    return { baked: 0, dynamic: [ascent, descent, mode], atPrepare: centralShiftAt(ascent, descent, mode, k) };
  }
  if (!ctmScale) return baked(fallback);
  const shift = svgCentralShift(style as TextStyle, px, ctmScale);
  if (shift === null) return baked(fallback);
  return baked(nested ? centralNestedShift(shift, ctmScale) : shift);
}

// The central baseline shift, user units, at CSS px per user unit k (the glyph shader's copy is in shaders.ts glyph):
// ascent and descent rounded at the scaled font (Skia rounds half up), halved, and for a nested box rounded up to a
// whole CSS px. 0 for mode 0.
export function centralShiftAt(ascent: number, descent: number, mode: number, k: number): number {
  if (!mode || !(k > 0)) return 0;
  const css = (Math.floor(ascent * k + 0.5) - Math.floor(descent * k + 0.5)) / 2;
  return (mode === 2 ? Math.ceil(css - 1e-3) : css) / k;
}

// A face's ascent and descent (font box) per px of font size, measured once at a large size; null when unreadable.
const FONT_BOX_PX = 2000;
const fontBoxes = new Map<string, { ascent: number; descent: number } | null>();
function fontBoxPerPx(style: TextStyle): { ascent: number; descent: number } | null {
  const key = `${style.fontStyle} ${style.fontWeight} ${style.fontFamily}`;
  if (fontBoxes.has(key)) return fontBoxes.get(key)!;
  let box: { ascent: number; descent: number } | null = null;
  const c = shapingContext();
  if (c) {
    try {
      c.font = `${style.fontStyle} ${style.fontWeight} ${FONT_BOX_PX}px ${style.fontFamily}`;
      const m = c.measureText("H");
      const [ascent, descent] = [m.fontBoundingBoxAscent / FONT_BOX_PX, m.fontBoundingBoxDescent / FONT_BOX_PX];
      if (Number.isFinite(ascent) && Number.isFinite(descent) && ascent > 0) box = { ascent, descent };
    } catch {
      box = null;
    }
  }
  if (fontBoxes.size > 256) fontBoxes.clear();
  fontBoxes.set(key, box);
  return box;
}

// CSS px per world unit (the #viewbox group's screen CTM scale), or null outside a laid-out map.
function viewboxScale(element: Element): number | null {
  const viewbox = element.closest?.("#viewbox") as SVGGraphicsElement | null;
  return viewbox ? screenScale(viewbox) : null;
}

// A nested central baseline as Chromium paints it: the shift in CSS px (a multiple of half a px) rounded up to a whole
// CSS px, back in user units.
export function centralNestedShift(shift: number, ctmScale: number): number {
  return Math.ceil(shift * ctmScale - 1e-3) / ctmScale;
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

// A text-shadow is in screen space (CSS px). Its mask is blurred at the raster bucket (device px per world unit =
// scale), at a lower resolution where its sigma allows (a blur of sigma >= SHADOW_MASK_SIGMA px loses nothing to
// bilinear upsampling) to save atlas room; the glyph shader then applies the offset in device px and adds the blur
// the mask lacks when the camera's k·dpr is below the bucket (W3b GLYPH2; before, both shrank by up to 2x there).
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
  const shaping = shapingReason(rasterFont, content, style.textRendering);
  if (shaping) return shaping;
  measure!.font = rasterFont;
  measure!.fontKerning = kerning;
  measure!.textRendering = shapingFeatures(style.textRendering);
  const metrics = measure!.measureText(content);
  const baseline = baselineShiftFor(
    { ...(style as unknown as TextStyle), dominantBaseline: plan.baseline },
    px,
    screenScale(text),
    metrics,
    scale,
    false,
    viewboxScale(text)
  );
  if (baseline === null) return "central baseline metrics";
  const runWidth = wholeRunWidth(s => measure!.measureText(s).width / scale);
  const advances = kernedAdvances(content, runWidth);
  const width = advances.reduce((sum, advance) => sum + advance, 0);
  const chars = [...content];
  // each character's pen origin: the SVG's own layout when the text is laid out (its reported start moved by a split
  // kern, kernOffsets), else the measured advances from the anchored start. A straight text the SVG lays out reports
  // every character; one it reports none for (start and end at the origin) is not one this layout can anchor, so
  // the whole text then takes the measured pens rather than stacking that glyph on another one.
  const svg = svgCharPositions(text, content.length);
  const pens: [number, number][] = [];
  if (svg?.every(Boolean)) {
    const offsets = reportedOffsets(svg, 0, chars, runWidth, 0);
    let unit = 0;
    for (const [i, char] of chars.entries()) {
      const p = svg[unit]!;
      const along = offsets[i];
      pens.push([p.x + along * Math.cos(p.angle), p.y + along * Math.sin(p.angle)]);
      unit += char.length;
    }
  } else {
    let pen = plan.x - (plan.anchor === "middle" ? width / 2 : plan.anchor === "end" ? width : 0);
    for (const advance of advances) {
      pens.push([pen, plan.y]);
      pen += advance;
    }
  }
  const [x0, y0] = pens[0] ?? [plan.x, plan.y];
  const instances: number[] = [];
  const push = (cx: number, cy: number, glyph: Glyph, glyphScale: number, color: Rgba) =>
    instances.push(
      cx,
      cy,
      0,
      glyph.left / glyphScale,
      baseline.baked + glyph.top / glyphScale,
      glyph.width / glyphScale,
      glyph.height / glyphScale,
      glyph.u0,
      glyph.v0,
      glyph.u1,
      glyph.v1,
      ...color,
      ...baseline.dynamic
    );
  const dpr = devicePixelRatio();
  if (plan.shadows.length && !offCanvasShadowPaints()) return "text-shadow (canvas culls off-canvas shadow)";
  // CSS paints the first shadow on top: the last one goes down first
  for (const shadow of [...plan.shadows].reverse()) {
    const sigma = (shadow.blur * dpr) / 2; // device px
    const reduce = sigma > SHADOW_MASK_SIGMA ? SHADOW_MASK_SIGMA / sigma : 1;
    const shadowScale = scale * reduce;
    const glyph = atlas.shadow(
      cssFont(style, px * shadowScale),
      wholeRun(content, s => measure!.measureText(s).width),
      shadow.blur * dpr * reduce,
      kerning,
      inkColor(shadow.color),
      shapingFeatures(style.textRendering)
    );
    if (!glyph) return "glyph atlas full";
    // a soft cell (negative alpha: no coverage floor, the blur's faint tail is real) anchors its top-left corner at the
    // pen and carries the shadow's sigma (device px) and offset (CSS px) in the angle and (lx, ly) slots
    const [r, g, b, a] = shadow.color;
    instances.push(
      x0 + glyph.left / shadowScale,
      y0 + baseline.baked + glyph.top / shadowScale,
      sigma,
      shadow.x,
      shadow.y,
      glyph.width / shadowScale,
      glyph.height / shadowScale,
      glyph.u0,
      glyph.v0,
      glyph.u1,
      glyph.v1,
      r,
      g,
      b,
      -a,
      ...baseline.dynamic
    );
  }
  const passes: [number, Rgba | null][] = [
    [0, plan.fill],
    [plan.strokeWidth * scale, plan.stroke]
  ];
  if (strokeBeforeFill(style.paintOrder)) passes.reverse();
  let box: number[] | null = null;
  for (const [halo, color] of passes) {
    if (!color) continue;
    const ink = inkColor(color);
    for (let i = 0; i < chars.length; i++) {
      if (!chars[i].trim()) continue;
      const glyph = atlas.glyph(rasterFont, chars[i], halo, plan.join, plan.miter, ink);
      if (!glyph) return "glyph atlas full";
      push(pens[i][0], pens[i][1], glyph, scale, color);
    }
    box ??= [
      x0,
      y0 + baseline.baked + baseline.atPrepare - metrics.fontBoundingBoxAscent / scale,
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
