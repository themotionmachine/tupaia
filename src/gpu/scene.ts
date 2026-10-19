// Read-only extraction of the canonical #viewbox into native GPU draws (DOM order) and explicit compat runs.
// Nothing here writes to the live SVG; computed styles are read, never set.
import type { ReliefSprite } from "../renderers/relief-canvas";
import { withCanonicalEmblemPaint } from "./emblem-paint";
import { TRADE_LAYER } from "./markers";
import { flattenPath, type Subpath } from "./svg-path";

export type Rgba = [number, number, number, number];
export interface ShapeStyle {
  fill: Rgba | null;
  pattern: string | null;
  evenOdd: boolean;
  stroke: Rgba | null;
  width: number;
  dashes: number[];
  dashOffset: number;
  lineJoin?: string;
  lineCap?: string;
}
interface Base {
  element: Element;
  layer: string;
}
export type Draw =
  | (Base & { kind: "shape"; subpaths: Subpath[]; style: ShapeStyle; d: string })
  | (Base & { kind: "cells"; stroke: Rgba; width: number })
  | (Base & { kind: "relief"; icons: ReliefSprite[] })
  | (Base & { kind: "label"; element: SVGTextElement })
  | (Base & { kind: "cachedPaths"; paths: Draw[]; opacity: number })
  | (Base & { kind: "group"; opacity: number; mask: Draw[] | null; children: Draw[] })
  | (Base & { kind: "compat"; elements: Element[]; reason: string })
  | (Base & { kind: "trade"; opacity: number; children: Draw[]; unsupported: string });
export interface LayerReport {
  source?: "canonical-raster-cache" | "instanced-atlas";
  native: number;
  compat: number;
  reasons: string[];
}
export interface Scene {
  draws: Draw[];
  layers: Record<string, LayerReport>;
}

const skipped = new Set([
  "defs",
  "style",
  "title",
  "desc",
  "clipPath",
  "mask",
  "pattern",
  "symbol",
  "marker",
  "script"
]);
let colorContext: CanvasRenderingContext2D | null | undefined;

export function parseColor(value: string | null | undefined, opacity = 1): Rgba | null {
  if (!value || value === "none" || value === "transparent") return null;
  let text = value.trim();
  if (!/^(#|rgba?\()/i.test(text)) {
    if (colorContext === undefined)
      colorContext = globalThis.document?.createElement("canvas").getContext("2d") ?? null;
    if (!colorContext) return null;
    colorContext.fillStyle = "#010203";
    colorContext.fillStyle = text;
    if (colorContext.fillStyle === "#010203" && !/^#010203$/i.test(text)) return null;
    text = String(colorContext.fillStyle);
  }
  const hex = /^#([\da-f]{3,8})$/i.exec(text)?.[1];
  if (hex) {
    const full = hex.length < 6 ? [...hex].map(c => c + c).join("") : hex;
    if (full.length !== 6 && full.length !== 8) return null;
    const n = (i: number) => Number.parseInt(full.slice(i, i + 2), 16);
    return [n(0) / 255, n(2) / 255, n(4) / 255, (full.length === 8 ? n(6) / 255 : 1) * opacity];
  }
  const parts = /^rgba?\(([^)]+)\)$/i
    .exec(text)?.[1]
    .split(/[\s,/]+/)
    .filter(Boolean);
  if (!parts || parts.length < 3) return null;
  const channel = (v: string) => (v.endsWith("%") ? Number.parseFloat(v) / 100 : Number.parseFloat(v) / 255);
  const alpha = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? Number.parseFloat(parts[3]) / 100 : +parts[3];
  const rgba: Rgba = [channel(parts[0]), channel(parts[1]), channel(parts[2]), alpha * opacity];
  return rgba.every(Number.isFinite) ? rgba : null;
}

export function parseDashes(value: string | null | undefined): number[] | null {
  if (!value || value === "none") return [];
  const list = value.split(/[\s,]+/).filter(Boolean);
  if (list.some(item => item.endsWith("%"))) return null;
  const numbers = list.map(item => Number.parseFloat(item));
  return numbers.every(n => Number.isFinite(n) && n >= 0) ? numbers : null;
}

export function pointsToPath(points: string): string {
  const numbers = points
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  let d = "";
  for (let i = 0; i + 1 < numbers.length; i += 2) d += `${i ? "L" : "M"}${numbers[i]},${numbers[i + 1]}`;
  return d;
}

export function urlId(value: string | null | undefined): string | null {
  return /^url\(\s*["']?#([^"')]+)["']?\s*\)$/.exec(value?.trim() || "")?.[1] ?? null;
}

function number(value: string | null | undefined, fallback: number): number {
  const n = Number.parseFloat(value ?? "");
  return Number.isFinite(n) ? n : fallback;
}

type Styles = Pick<
  CSSStyleDeclaration,
  "fill" | "fillOpacity" | "fillRule" | "stroke" | "strokeOpacity" | "strokeWidth" | "strokeDasharray" | "opacity"
> & {
  strokeDashoffset: string;
  filter: string;
  clipPath: string;
  mask: string;
  vectorEffect?: string;
  strokeLinejoin?: string;
  strokeLinecap?: string;
  display?: string;
  visibility?: string;
};

// Detached elements (restored data-path-vectors markup) have no computed style: own attributes over parent style.
function attributeStyles(element: Element, parent: Styles): Styles {
  const own = (name: string, fallback: string) => element.getAttribute(name) ?? fallback;
  return {
    fill: own("fill", parent.fill),
    fillOpacity: own("fill-opacity", parent.fillOpacity),
    fillRule: own("fill-rule", parent.fillRule),
    stroke: own("stroke", parent.stroke),
    strokeOpacity: own("stroke-opacity", parent.strokeOpacity),
    strokeWidth: own("stroke-width", parent.strokeWidth),
    strokeDasharray: own("stroke-dasharray", parent.strokeDasharray),
    strokeDashoffset: own("stroke-dashoffset", parent.strokeDashoffset),
    strokeLinejoin: own("stroke-linejoin", parent.strokeLinejoin || "miter"),
    strokeLinecap: own("stroke-linecap", parent.strokeLinecap || "butt"),
    opacity: own("opacity", "1"),
    filter: own("filter", "none"),
    clipPath: own("clip-path", "none"),
    mask: own("mask", "none")
  };
}

function shapeStyle(cs: Styles): ShapeStyle | string {
  const opacity = number(cs.opacity, 1);
  const pattern = urlId(cs.fill);
  const fill = pattern ? null : parseColor(cs.fill, number(cs.fillOpacity, 1) * opacity);
  if (!pattern && !fill && cs.fill && cs.fill !== "none") return `fill ${cs.fill}`;
  const width = cs.strokeWidth.endsWith("%") ? Number.NaN : number(cs.strokeWidth, 1);
  let stroke = parseColor(cs.stroke, number(cs.strokeOpacity, 1) * opacity);
  if (urlId(cs.stroke) || (!stroke && cs.stroke && cs.stroke !== "none")) return `stroke ${cs.stroke}`;
  if (!Number.isFinite(width)) return "stroke-width";
  if (width <= 0) stroke = null;
  if (opacity < 1 && (fill || pattern) && stroke) return "opacity over fill and stroke";
  if (pattern && opacity < 1) return "opacity over pattern";
  const dashes = parseDashes(cs.strokeDasharray);
  if (!dashes) return "stroke-dasharray";
  if (cs.vectorEffect && cs.vectorEffect !== "none") return "vector-effect";
  const evenOdd = cs.fillRule === "evenodd";
  return {
    fill,
    pattern,
    evenOdd,
    stroke,
    width,
    dashes,
    dashOffset: number(cs.strokeDashoffset, 0),
    lineJoin: cs.strokeLinejoin || "miter",
    lineCap: cs.strokeLinecap || "butt"
  };
}

function geometry(element: Element): string | null {
  const tag = element.tagName;
  if (tag === "path") return element.getAttribute("d") || "";
  if (tag === "polygon" || tag === "polyline")
    return pointsToPath(element.getAttribute("points") || "") + (tag === "polygon" ? "Z" : "");
  if (tag === "rect" && !element.getAttribute("rx") && !element.getAttribute("ry")) {
    const values = ["x", "y", "width", "height"].map(name => element.getAttribute(name) || "0");
    if (values.some(v => v.endsWith("%"))) return null;
    const [x, y, w, h] = values.map(Number);
    return [x, y, w, h].every(Number.isFinite) ? `M${x},${y}h${w}v${h}h${-w}Z` : null;
  }
  return null;
}

function reliefIcons(value: string | null): ReliefSprite[] | null {
  try {
    const data: unknown = JSON.parse(value || "");
    if (!Array.isArray(data)) return null;
    const valid = data.every(r => r && typeof r.i === "string" && [r.x, r.y, r.s].every(Number.isFinite) && r.s > 0);
    return valid ? (data as ReliefSprite[]) : null;
  } catch {
    return null;
  }
}

// Materialized relief (prepareReliefIcons) is the compact data written as `<use href x y width height>`: the same
// sprites, so it takes the instanced lane. Otherwise each offset <use> is a compat element, and that run never
// finished preparing. Any glyph compactRelief would keep as SVG (custom style/transform/id) keeps the whole group exact.
const plainGlyphAttributes = new Set(["href", "xlink:href", "xmlns:xlink", "x", "y", "width", "height"]);
export function materializedIcons(group: Element): ReliefSprite[] | null {
  const doc = group.ownerDocument;
  const icons: ReliefSprite[] = [];
  for (const element of group.children) {
    if (element.tagName !== "use") return null;
    for (const { name, value } of Array.from(element.attributes)) {
      if (plainGlyphAttributes.has(name)) continue;
      if (name === "class" && value.split(/\s+/).every(c => !c || c === "draggable" || c === "viewport-culled"))
        continue;
      const inert = (rule: string) =>
        !rule.trim() || ["touch-action", "-webkit-tap-highlight-color"].includes(rule.split(":")[0].trim());
      if (name === "style" && value.split(";").every(inert)) continue;
      return null;
    }
    const i = element.getAttribute("href") || element.getAttribute("xlink:href") || "";
    const [x, y, s, h] = ["x", "y", "width", "height"].map(name => Number(element.getAttribute(name)));
    if (!i.startsWith("#") || !doc.getElementById(i.slice(1))) return null;
    if (![x, y, s, h].every(Number.isFinite) || s <= 0 || s !== h) return null;
    icons.push({ i, x, y, s });
  }
  return icons.length ? icons : null;
}

export function buildScene(viewbox: Element, curveTolerance = 0.2): Scene {
  return withCanonicalEmblemPaint(() => canonicalBuildScene(viewbox, curveTolerance));
}

function canonicalBuildScene(viewbox: Element, curveTolerance: number): Scene {
  const layers: Record<string, LayerReport> = {};
  const report = (layer: string, native: boolean, reason = "") => {
    layers[layer] ??= { native: 0, compat: 0, reasons: [] };
    const entry = layers[layer];
    if (native) entry.native++;
    else {
      entry.compat++;
      if (reason && entry.reasons.length < 8 && !entry.reasons.includes(reason)) entry.reasons.push(reason);
    }
  };
  const doc = viewbox.ownerDocument;
  const computed = (element: Element) => getComputedStyle(element) as unknown as Styles;

  const compat = (element: Element, layer: string, reason: string, out: Draw[]) => {
    report(layer, false, reason);
    const last = out[out.length - 1];
    if (last?.kind === "compat" && last.layer === layer) {
      last.elements.push(element);
      if (!last.reason.includes(reason)) last.reason += `; ${reason}`;
    } else out.push({ kind: "compat", element, elements: [element], layer, reason });
  };

  const shape = (element: Element, source: Element, cs: Styles, layer: string, out: Draw[]) => {
    const d = geometry(source);
    const style = shapeStyle(cs);
    if (d === null) return compat(element, layer, `<${source.tagName}>`, out);
    if (typeof style === "string") return compat(element, layer, style, out);
    if (!style.fill && !style.pattern && !style.stroke) return;
    report(layer, true);
    out.push({ kind: "shape", element, layer, subpaths: flattenPath(d, curveTolerance), style, d });
  };

  // Binary luminance masks (white/black fills of plain shapes) become stencil writes; anything else is unsupported.
  const maskDraws = (id: string, layer: string): Draw[] | null => {
    const mask = doc.getElementById(id);
    if (!mask || mask.hasAttribute("maskUnits") || mask.hasAttribute("maskContentUnits")) return null;
    const out: Draw[] = [];
    for (const child of mask.children) {
      const source = child.tagName === "use" ? doc.getElementById(child.getAttribute("href")?.slice(1) || "") : child;
      if (!source || child.getAttribute("x") || child.getAttribute("y")) return null;
      shape(child, source, computed(child), layer, out);
      const last = out[out.length - 1];
      if (last?.kind !== "shape" || last.style.stroke || !last.style.fill) return null;
      const [r, g, b, a] = last.style.fill;
      if (a !== 1 || !((r === 1 && g === 1 && b === 1) || (r === 0 && g === 0 && b === 0))) return null;
    }
    return out;
  };

  const walk = (element: Element, layer: string, out: Draw[], depth: number, inGroup: boolean) => {
    const tag = element.tagName;
    if (skipped.has(tag) || element.hasAttribute("data-dense-zoom")) return;
    const cs = computed(element);
    const culled = element.classList.contains("viewport-culled");
    if (cs.display === "none" && !culled) return;
    const zoomHidden = element.hasAttribute("data-zoom-hidden");
    if ((cs.visibility === "hidden" || cs.visibility === "collapse") && !zoomHidden) return;
    const transform = element.getAttribute("transform");
    const effects =
      (cs.filter && cs.filter !== "none" && "filter") ||
      (cs.clipPath && cs.clipPath !== "none" && "clip-path") ||
      (transform && !/^\s*(translate\(\s*0[\s,]+0\s*\))?\s*$/.test(transform) && "transform") ||
      "";
    // Live trade markers are mirrored per frame (markers.ts); only their static siblings (highlight) are prepared here.
    if (depth === 0 && element.id === TRADE_LAYER) {
      const opacity = number(cs.opacity, 1);
      const rootEffect = effects || (cs.mask && cs.mask !== "none" ? "mask" : "");
      const children: Draw[] = [];
      for (const child of element.children) {
        if (child.tagName === "g") continue;
        if (rootEffect) compat(child, layer, `trade ${rootEffect}`, children);
        else walk(child, layer, children, depth + 1, opacity < 1);
      }
      // Markers cannot carry a layer filter/clip/mask: the frame refuses (SVG viewport shown) instead of dropping it.
      const unsupported =
        (cs.filter && cs.filter !== "none" && "filter") ||
        (cs.clipPath && cs.clipPath !== "none" && "clip-path") ||
        (cs.mask && cs.mask !== "none" && "mask") ||
        "";
      report(layer, !unsupported, unsupported && `trade layer ${unsupported}`);
      out.push({ kind: "trade", element, layer, opacity, children, unsupported });
      return;
    }
    if (tag === "g" || tag === "a") {
      // Export materializes compact burg images into circles. Capture their stable parent,
      // because the transient image itself deliberately has no counterpart in that clone.
      if (element.querySelector(":scope > image[data-burg-vectors]"))
        return compat(element, layer, "restored burg vectors", out);
      const opacity = number(cs.opacity, 1);
      const maskId = cs.mask && cs.mask !== "none" ? urlId(cs.mask) : null;
      if (depth === 0 && element.id === "terrain" && !effects && !(cs.mask && cs.mask !== "none") && opacity === 1) {
        const icons = materializedIcons(element);
        if (icons) {
          report(layer, true);
          out.push({ kind: "relief", element, layer, icons });
          return;
        }
      }
      if (effects) return compat(element, layer, `group ${effects}`, out);
      if (cs.mask && cs.mask !== "none" && !maskId) return compat(element, layer, "group mask", out);
      if (opacity < 1 || maskId) {
        if (inGroup) return compat(element, layer, "nested group opacity/mask", out);
        const mask = maskId ? maskDraws(maskId, layer) : null;
        if (maskId && !mask) return compat(element, layer, `mask #${maskId}`, out);
        const children: Draw[] = [];
        for (const child of element.children) walk(child, layer, children, depth + 1, true);
        out.push({ kind: "group", element, layer, opacity, mask, children });
        return;
      }
      for (const child of element.children) walk(child, depth ? layer : element.id || tag, out, depth + 1, inGroup);
      return;
    }
    if (effects || (cs.mask && cs.mask !== "none")) return compat(element, layer, effects || "mask", out);
    if (tag === "image") {
      if (element.hasAttribute("data-cell-mesh")) {
        const parent = computed(element.parentElement!);
        const stroke = parseColor(parent.stroke, number(parent.strokeOpacity, 1));
        const width = number(parent.strokeWidth, 1);
        if (stroke && width > 0) out.push({ kind: "cells", element, layer, stroke, width });
        return report(layer, true);
      }
      const icons = element.hasAttribute("data-relief") ? reliefIcons(element.getAttribute("data-relief")) : null;
      if (icons && number(cs.opacity, 1) === 1) {
        report(layer, true);
        out.push({ kind: "relief", element, layer, icons });
        return;
      }
      const vectors = element.getAttribute("data-path-vectors");
      if (vectors !== null) {
        // The canonical SVG displays this bitmap, not its retained edit vectors. Reconstructing those vectors
        // changes raster sampling and strokes; preserve the displayed asset and retain the metadata for CPU hits.
        const previous = layers[layer]
          ? { ...layers[layer], reasons: [...layers[layer].reasons] }
          : { native: 0, compat: 0, reasons: [] };
        const holder = doc.createElementNS("http://www.w3.org/2000/svg", "g");
        holder.innerHTML = vectors;
        const parent = computed(element.parentElement!);
        const parsed: Draw[] = [];
        for (const child of holder.children) shape(child, child, attributeStyles(child, parent), layer, parsed);
        layers[layer] = previous;
        report(layer, true);
        layers[layer].source = "canonical-raster-cache";
        out.push({ kind: "cachedPaths", element, layer, paths: parsed, opacity: number(cs.opacity, 1) });
        return;
      }
      return compat(element, layer, "image", out);
    }
    if (tag === "use") {
      const source = doc.getElementById(element.getAttribute("href")?.slice(1) || "");
      if (!source || number(element.getAttribute("x"), 0) || number(element.getAttribute("y"), 0))
        return compat(element, layer, "use", out);
      return shape(element, source, cs, layer, out);
    }
    if (tag === "text") {
      const shadow = (cs as unknown as CSSStyleDeclaration).textShadow;
      if (element.querySelector("textPath") && (!shadow || shadow === "none") && layer === "labels") {
        report(layer, true);
        out.push({ kind: "label", element: element as SVGTextElement, layer });
        return;
      }
      return compat(element, layer, "text", out);
    }
    shape(element, element, cs, layer, out);
  };

  const draws: Draw[] = [];
  for (const child of viewbox.children) walk(child, child.id || child.tagName, draws, 0, false);
  return { draws, layers };
}
