// Per-instance hit testing of materialized relief glyphs (#terrain > <use href x y width height>). Each <use> keeps its
// sprite box in the PickIndex as the broadphase; this narrowphase maps the world point into the referenced <symbol>'s
// user space (viewBox, default xMidYMid meet) and tests the symbol's painted primitives as SVG hit testing does
// (SVG2 §15.6): fill area when the fill is pointer-sensitive, stroke outline (width, dashes, caps) when the stroke is,
// clipped to the <use> viewport (symbols are overflow:hidden).
//
// DOM dependency (prepare-time only, cached per href per prepare): the <symbol> attributes, its descendants' geometry
// attributes and computed style. Supported subset, anything else makes the href unsupported (box hit, reported
// terrain-unsupported with readGlyphReport's reason, never transparent): a viewBox with no other preserveAspectRatio
// and no symbol x/y/width/height; path/polygon/polyline/rect/circle/ellipse/line leaves, directly or inside plain <g>
// groups, with affine `transform` attributes on leaves and groups (rings are mapped to symbol space; a stroked leaf
// needs a similarity transform so its width stays uniform); no marker, clip-path, mask, filter, vector-effect, CSS
// transform or currentColor/inherit paint anywhere. Inherited properties are resolved as in the <use> shadow tree:
// the leaf's own attribute/inline value, else its nearest group's, else the symbol's, else #terrain's (the <use>
// computes like #terrain: its only classes are draggable/viewport-culled). Stylesheet rules aimed at symbol content
// are not modelled. Joins are round (a subset of the default miter outline), as in the rest of the index.
import type { ReliefSprite } from "../renderers/relief-canvas";
import { sensitivity, shapePath } from "./compat-pick";
import { capCode, normalizeDashes } from "./geometry";
import { insideRings, polylineDistance, strokeCovers } from "./pick";
import { parseDashes } from "./scene";
import { flattenPath } from "./svg-path";

export interface GlyphPrimitive {
  rings: number[][];
  closed: boolean[];
  fill: { evenOdd: boolean } | null;
  stroke: { halfWidth: number; dashes: number[]; offset: number; cap: number } | null;
}

export interface GlyphHits {
  viewBox: [number, number, number, number];
  primitives: GlyphPrimitive[];
}

// Whether world point (px, py) is in the painted hit area of glyph instance `icon` (tolerance in world units).
export function glyphCovers(glyph: GlyphHits, icon: Pick<ReliefSprite, "x" | "y" | "s">, px: number, py: number, tolerance: number) {
  const { x, y, s } = icon;
  // the <use> viewport clips exactly: no tolerance band outside it
  if (px < x || px > x + s || py < y || py > y + s) return false;
  const [vx, vy, vw, vh] = glyph.viewBox;
  const scale = Math.min(s / vw, s / vh);
  const lx = (px - (x + (s - vw * scale) / 2 - vx * scale)) / scale;
  const ly = (py - (y + (s - vh * scale) / 2 - vy * scale)) / scale;
  const t = tolerance / scale;
  for (const p of glyph.primitives) {
    if (p.fill && (insideRings(lx, ly, p.rings, p.fill.evenOdd) || p.rings.some(r => polylineDistance(lx, ly, r, true) <= t)))
      return true;
    const stroke = p.stroke;
    if (
      stroke &&
      p.rings.some((r, k) =>
        strokeCovers(lx, ly, r, p.closed[k], stroke.halfWidth + t, stroke.dashes, stroke.offset, stroke.cap)
      )
    )
      return true;
  }
  return false;
}

const LEAF_TAGS = new Set(["path", "polygon", "polyline", "rect", "circle", "ellipse", "line"]);
// markers paint extra hit geometry and inherit through groups; clip/mask/filter reshape the hit area
const BLOCKING_ATTRIBUTES = ["marker-start", "marker-mid", "marker-end", "marker", "clip-path", "mask", "filter"];
// inherited properties that decide a leaf's hit area: [computed style key, presentation attribute]
const INHERITED: [keyof CSSStyleDeclaration & string, string][] = [
  ["fill", "fill"],
  ["fillRule", "fill-rule"],
  ["stroke", "stroke"],
  ["strokeWidth", "stroke-width"],
  ["strokeDasharray", "stroke-dasharray"],
  ["strokeDashoffset", "stroke-dashoffset"],
  ["strokeLinecap", "stroke-linecap"],
  ["pointerEvents", "pointer-events"],
  ["visibility", "visibility"]
];
const SYMBOL_UNITS_TOLERANCE = 0.05;

// 2D affine [a b c d e f] (SVG matrix order): x' = a x + c y + e, y' = b x + d y + f
export type Affine = [number, number, number, number, number, number];
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

export function multiplyAffine([a1, b1, c1, d1, e1, f1]: Affine, [a2, b2, c2, d2, e2, f2]: Affine): Affine {
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1
  ];
}

// The SVG `transform` attribute (transform-list grammar) as one affine; null when it does not parse.
export function parseTransform(value: string | null): Affine | null {
  if (value === null || !value.trim()) return IDENTITY;
  let m = IDENTITY;
  const call = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)\s*,?/y;
  let at = 0;
  while (at < value.length) {
    if (!value.slice(at).trim()) break;
    call.lastIndex = at;
    const found = call.exec(value);
    if (!found) return null;
    at = call.lastIndex;
    const raw = found[2].trim();
    const n = raw ? raw.split(/\s*,\s*|\s+/).map(Number) : [];
    if (!n.every(Number.isFinite)) return null;
    const rad = (n[0] * Math.PI) / 180;
    let step: Affine | null = null;
    if (found[1] === "matrix" && n.length === 6) step = n as Affine;
    else if (found[1] === "translate" && (n.length === 1 || n.length === 2)) step = [1, 0, 0, 1, n[0], n[1] ?? 0];
    else if (found[1] === "scale" && (n.length === 1 || n.length === 2)) step = [n[0], 0, 0, n[1] ?? n[0], 0, 0];
    else if (found[1] === "rotate" && (n.length === 1 || n.length === 3)) {
      const [cx, cy] = [n[1] ?? 0, n[2] ?? 0];
      step = multiplyAffine(
        multiplyAffine([1, 0, 0, 1, cx, cy], [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0]),
        [1, 0, 0, 1, -cx, -cy]
      );
    } else if (found[1] === "skewX" && n.length === 1) step = [1, 0, Math.tan(rad), 1, 0, 0];
    else if (found[1] === "skewY" && n.length === 1) step = [1, Math.tan(rad), 0, 1, 0, 0];
    if (!step) return null;
    m = multiplyAffine(m, step);
  }
  return m;
}

// The uniform scale of a similarity transform (rotation/reflection, translation, equal scale), else null: a stroke
// under a non-uniform transform has a varying width this primitive model cannot represent.
function uniformScale([a, b, c, d]: Affine): number | null {
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  const dot = a * c + b * d;
  return Math.abs(sx - sy) <= 1e-9 * Math.max(sx, sy, 1) && Math.abs(dot) <= 1e-9 * Math.max(sx * sy, 1) ? sx : null;
}

export interface GlyphRead {
  glyph: GlyphHits | null;
  reason: string | null; // why the href is outside the supported subset (null when supported)
}

// The hit primitives of `#href`'s <symbol> as it renders inside `group`, or null when outside the supported subset.
export function readGlyph(group: Element, href: string): GlyphHits | null {
  return readGlyphReport(group, href).glyph;
}

// readGlyph with the reason an unsupported href is boxed, for the per-href support tally.
export function readGlyphReport(group: Element, href: string): GlyphRead {
  const no = (reason: string): GlyphRead => ({ glyph: null, reason });
  const doc = group.ownerDocument;
  const view = doc.defaultView;
  const symbol = href.startsWith("#") ? doc.getElementById(href.slice(1)) : null;
  if (!view) return no("no-view");
  if (!symbol || symbol.tagName.toLowerCase() !== "symbol") return no("no-symbol");
  if (["x", "y", "width", "height"].some(name => symbol.hasAttribute(name))) return no("symbol-viewport-attributes");
  const aspect = (symbol.getAttribute("preserveAspectRatio") ?? "xMidYMid meet").trim();
  if (aspect !== "xMidYMid meet" && aspect !== "xMidYMid") return no("preserveAspectRatio");
  const viewBox = (symbol.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2] <= 0 || viewBox[3] <= 0)
    return no("viewBox");
  const outer = view.getComputedStyle(group);
  const sets = (element: Element, attribute: string) =>
    element.hasAttribute(attribute) || !!(element as SVGElement).style?.getPropertyValue(attribute);
  const keyword = (element: Element) =>
    INHERITED.some(([, attribute]) =>
      /currentcolor|inherit/i.test(
        (element.getAttribute(attribute) ?? "") + ((element as SVGElement).style?.getPropertyValue(attribute) ?? "")
      )
    );
  if (keyword(symbol)) return no("currentColor/inherit on <symbol>");
  const primitives: GlyphPrimitive[] = [];
  const computedOf = new Map<Element, CSSStyleDeclaration>([[symbol, view.getComputedStyle(symbol)]]);
  const computed = (element: Element) => {
    let style = computedOf.get(element);
    if (!style) computedOf.set(element, (style = view.getComputedStyle(element)));
    return style;
  };
  // Depth-first in document order (paint order); `chain` is the leaf's ancestors up to the symbol, nearest first, and
  // `ctm` maps the element's user space to symbol user space.
  const walk = (parent: Element, chain: Element[], ctm: Affine): string | null => {
    for (const node of Array.from(parent.children)) {
      const tag = node.tagName.toLowerCase();
      if (tag === "title" || tag === "desc") continue;
      if (tag !== "g" && !LEAF_TAGS.has(tag)) return `element <${tag}>`;
      const blocking = BLOCKING_ATTRIBUTES.find(name => sets(node, name));
      if (blocking) return `${blocking} on <${tag}>`;
      if (keyword(node)) return `currentColor/inherit on <${tag}>`;
      if ((node as SVGElement).style?.getPropertyValue("transform")) return `css transform on <${tag}>`;
      const own = parseTransform(node.getAttribute("transform"));
      if (!own) return `unparsed transform on <${tag}>`;
      const style0 = computed(node);
      if (style0.display === "none") continue;
      const local = multiplyAffine(ctm, own);
      if (tag === "g") {
        const failed = walk(node, [node, ...chain], local);
        if (failed) return failed;
        continue;
      }
      // In the <use> shadow tree a property the leaf does not set comes from its nearest group or the symbol that
      // does, else from the <use> (as #terrain); the leaf's own computed value in <defs> would inherit from the defs
      // ancestry instead.
      const style = { display: style0.display, vectorEffect: style0.vectorEffect } as Record<string, string>;
      for (const [key, attribute] of INHERITED) {
        const from = [node, ...chain, symbol].find(element => sets(element, attribute));
        style[key] = (from ? computed(from) : outer)[key] as string;
      }
      if (style.vectorEffect && style.vectorEffect !== "none") return `vector-effect on <${tag}>`;
      const sense = sensitivity(style as unknown as CSSStyleDeclaration);
      if (!sense) continue;
      if (sense.box) return `bounding-box pointer-events on <${tag}>`;
      const d = shapePath(node as never);
      if (!d) continue;
      const subpaths = flattenPath(d, SYMBOL_UNITS_TOLERANCE);
      if (!subpaths.length) continue;
      const width = Number.parseFloat(style.strokeWidth || "1");
      const dashes = parseDashes(style.strokeDasharray);
      const stroked = sense.stroke && width > 0;
      if (stroked && dashes === null) return `unparsed stroke-dasharray on <${tag}>`;
      const scale = stroked ? uniformScale(local) : 1;
      if (scale === null) return `stroke under non-uniform transform on <${tag}>`;
      const [a, b, c, dd, e, f] = local;
      const identity = local.every((v, i) => v === IDENTITY[i]);
      primitives.push({
        // flattened in the leaf's user space, then mapped to symbol space: exact for affine maps of polylines
        rings: subpaths.map(sub => {
          if (identity) return sub.points;
          const out = new Array<number>(sub.points.length);
          for (let i = 0; i < sub.points.length; i += 2) {
            const [x, y] = [sub.points[i], sub.points[i + 1]];
            out[i] = a * x + c * y + e;
            out[i + 1] = b * x + dd * y + f;
          }
          return out;
        }),
        closed: subpaths.map(sub => sub.closed),
        // a line has no fill area
        fill: sense.fill && tag !== "line" ? { evenOdd: style.fillRule === "evenodd" } : null,
        stroke: stroked
          ? {
              halfWidth: (width / 2) * scale,
              dashes: normalizeDashes(dashes ?? []).map(dash => dash * scale),
              offset: (Number.parseFloat(style.strokeDashoffset || "0") || 0) * scale,
              cap: capCode(style.strokeLinecap || "butt")
            }
          : null
      });
    }
    return null;
  };
  const failed = walk(symbol, [], IDENTITY);
  if (failed) return no(failed);
  return { glyph: { viewBox: viewBox as GlyphHits["viewBox"], primitives }, reason: null };
}

// The live <use> for glyph instance k, or null when the index no longer describes the DOM: a detached group, another
// child count, or a child whose href/x/y/size differ from what was indexed. A culled <use> (display:none) is not hit
// by SVG either. One per-click read of the group's children; never per frame.
export function glyphTarget(group: Element, icons: ReliefSprite[], k: number): Element | null {
  if (!group.isConnected || group.children.length !== icons.length) return null;
  const use = group.children[k];
  const icon = icons[k];
  if (!use || !icon || use.tagName !== "use" || use.classList.contains("viewport-culled")) return null;
  const href = use.getAttribute("href") || use.getAttribute("xlink:href");
  const [x, y, s, h] = ["x", "y", "width", "height"].map(name => Number(use.getAttribute(name)));
  return href === icon.i && x === icon.x && y === icon.y && s === icon.s && h === icon.s ? use : null;
}

// editReliefIcon's instance key, as the parity oracle records it: "(id)|href@x,y" from the attributes.
export const glyphKey = (use: Element) =>
  `${use.id || ""}|${use.getAttribute("href") || use.getAttribute("xlink:href")}@${use.getAttribute("x")},${use.getAttribute("y")}`;
