import { withCanonicalEmblemPaint } from "./emblem-paint";
// CPU hit-test geometry for compat-rasterized and DOM-laid-out world elements (text labels, marker <svg>, restored
// burg vectors). The raster has no geometry, so each painted leaf is snapshotted once per prepare, in world space,
// following SVG hit testing (SVG2 §15.6 pointer-events): the fill area when fill is pointer-sensitive, the stroke area
// when stroke is, the character cells of text (advance × font ascent/descent, not glyph ink), the rect of an image.
// Content of a nested <svg> is clipped to its viewport when overflow is not visible; display:none ancestors and
// unpainted containers (defs, clipPath, mask, …) contribute nothing.
//
// DOM dependency (transitional, prepare-time only): computed style, getScreenCTM, path/shape attributes and the
// SVGTextContentElement character API are read when the scene is prepared, never per query or per camera frame.
// Known approximations: <use> is its bbox, clip-path/mask are ignored, strokes use round joins, per-tspan paint
// is taken from the <text>, non-scaling-stroke widths are not compensated.
import { type HitShape, leafPath } from "./pick";
import { emblemSourceClass } from "../renderers/emblems/transient-classes";
import { dashPieces, measureContour, parseContours } from "./dash-measure";
import { normalizeDashes } from "./geometry";
import { parseDashes, pointsToPath } from "./scene";
import { flattenPath, type Subpath } from "./svg-path";

export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

type Style = Pick<CSSStyleDeclaration, "pointerEvents" | "visibility" | "display" | "fill" | "stroke" | "strokeWidth"> &
  Partial<
    Pick<CSSStyleDeclaration, "fillRule" | "overflow" | "strokeDasharray" | "strokeDashoffset" | "strokeLinecap">
  >;

interface Node {
  tagName: string;
  id: string;
  parentElement: Node | null;
  closest(selector: string): Node | null;
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
  removeAttribute?(name: string): void;
  getBBox?(): { x: number; y: number; width: number; height: number };
  getScreenCTM?(): Affine | null;
  ownerSVGElement?: unknown;
}

export const pickId = (element: {
  id: string;
  parentElement: { closest(selector: string): { id: string } | null } | null;
}) => element.id || element.parentElement?.closest("[id]")?.id || "";

// Steps from an anonymous leaf up to the [id] ancestor pickId names (0 when the leaf has its own id): the leaf's branch
// is decided by its own ancestry (an anonymous #ice polygon or coastline path), not by the named group's.
type Ancestry = { id: string; parentElement: Ancestry | null };
export function pickDepth(element: { id: string; parentElement: unknown }): number {
  if (element.id) return 0;
  let depth = 1;
  for (let node = element.parentElement as Ancestry | null; node; node = node.parentElement, depth++)
    if (node.id) return depth;
  return 0;
}

// Painted leaves as elementFromPoint can return them. <text> is the leaf for its tspans.
const LEAVES = "path,circle,ellipse,rect,line,polyline,polygon,text,use,image";
const UNPAINTED = "defs,clipPath,mask,pattern,symbol,marker";
// world-space flattening tolerance (map units); the pick gate allows only a 1 css px edge band at zoom ≤ 8
const WORLD_TOLERANCE = 0.01;
export const PICK_TOLERANCE = WORLD_TOLERANCE;

// Stroke hit rings: fine for distance. A dashed stroke takes its on-dashes from the Skia-style chordal measure of the
// true curve (dash-measure.ts), since Chrome's dash phase follows that measure (P3-SELECTION-GUARDS-AND-LAYERS.md).
export function strokeHitRings<T>(dashed: (() => T[]) | null, fine: () => T[]): T[] {
  return dashed ? dashed() : fine();
}

// Device px per world unit of the viewbox (its screen CTM's area scale, sqrt|det|); 1 without a transform.
export function resScale(viewbox: { getScreenCTM?(): Affine | null }): number {
  const m = viewbox.getScreenCTM?.();
  const scale = m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) : 0;
  return scale > 0 ? scale : 1;
}

// On-dashes of a dashed stroke as open polylines on the true curve, in the path's user space; each dash keeps its own
// caps, so a dash end is tested as a stroke end (on-edge inclusion for butt). Empty without a usable pattern.
export function dashHitRings(d: string, dashes: number[], dashOffset: number, scale: number): Subpath[] {
  const out: Subpath[] = [];
  for (const contour of parseContours(d)) {
    const measure = measureContour(contour, scale);
    for (const points of dashPieces(measure, dashes, dashOffset))
      if (points.length >= 2) out.push({ points, closed: false });
  }
  return out;
}

// outer⁻¹ · inner: maps the leaf's user space into the space of `outer` (the #viewbox world)
export function relative(outer: Affine, inner: Affine): Affine {
  const det = outer.a * outer.d - outer.b * outer.c;
  const ia = outer.d / det,
    ib = -outer.b / det,
    ic = -outer.c / det,
    id = outer.a / det;
  const ie = -(ia * outer.e + ic * outer.f),
    iF = -(ib * outer.e + id * outer.f);
  return {
    a: ia * inner.a + ic * inner.b,
    b: ib * inner.a + id * inner.b,
    c: ia * inner.c + ic * inner.d,
    d: ib * inner.c + id * inner.d,
    e: ia * inner.e + ic * inner.f + ie,
    f: ib * inner.e + id * inner.f + iF
  };
}

export function boxCorners(m: Affine, x: number, y: number, width: number, height: number): number[] {
  const out: number[] = [];
  for (const [px, py] of [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height]
  ])
    out.push(m.a * px + m.c * py + m.e, m.b * px + m.d * py + m.f);
  return out;
}

const num = (node: Node, name: string) => Number.parseFloat(node.getAttribute?.(name) ?? "") || 0;

// Basic shapes as path data (SVG2 §10), in the element's user space; null when the shape renders nothing.
export function shapePath(node: Node): string | null {
  switch (node.tagName.toLowerCase()) {
    case "path":
      return node.getAttribute?.("d") || null;
    case "polyline":
    case "polygon": {
      const d = pointsToPath(node.getAttribute?.("points") ?? "");
      return d ? (node.tagName.toLowerCase() === "polygon" ? `${d}Z` : d) : null;
    }
    case "line":
      return `M${num(node, "x1")},${num(node, "y1")}L${num(node, "x2")},${num(node, "y2")}`;
    case "circle":
    case "ellipse": {
      const cx = num(node, "cx");
      const cy = num(node, "cy");
      const circle = node.tagName.toLowerCase() === "circle";
      const rx = circle ? num(node, "r") : num(node, "rx");
      const ry = circle ? rx : num(node, "ry");
      if (!(rx > 0 && ry > 0)) return null;
      return `M${cx - rx},${cy}A${rx},${ry} 0 1 0 ${cx + rx},${cy}A${rx},${ry} 0 1 0 ${cx - rx},${cy}Z`;
    }
    case "rect": {
      const x = num(node, "x");
      const y = num(node, "y");
      const w = num(node, "width");
      const h = num(node, "height");
      if (!(w > 0 && h > 0)) return null;
      const rxAttr = node.getAttribute?.("rx");
      const ryAttr = node.getAttribute?.("ry");
      let rx = rxAttr != null ? num(node, "rx") : ryAttr != null ? num(node, "ry") : 0;
      let ry = ryAttr != null ? num(node, "ry") : rx;
      rx = Math.min(Math.max(rx, 0), w / 2);
      ry = Math.min(Math.max(ry, 0), h / 2);
      if (!rx || !ry) return `M${x},${y}H${x + w}V${y + h}H${x}Z`;
      return (
        `M${x + rx},${y}H${x + w - rx}A${rx},${ry} 0 0 1 ${x + w},${y + ry}V${y + h - ry}` +
        `A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + h - ry}` +
        `V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`
      );
    }
    default:
      return null;
  }
}

function transform(m: Affine, points: ArrayLike<number>): number[] {
  const out = new Array<number>(points.length);
  for (let k = 0; k < points.length; k += 2) {
    out[k] = m.a * points[k] + m.c * points[k + 1] + m.e;
    out[k + 1] = m.b * points[k] + m.d * points[k + 1] + m.f;
  }
  return out;
}

interface TextApi {
  getNumberOfChars(): number;
  getExtentOfChar(i: number): { x: number; y: number; width: number; height: number };
  getStartPositionOfChar(i: number): { x: number; y: number };
  getEndPositionOfChar(i: number): { x: number; y: number };
}

// A cell quad [x0,y0, x1,y1, x2,y2, x3,y3] whose edges run along the axes (horizontal text, no rotation).
export const axisAligned = (q: number[]) =>
  Math.abs(q[1] - q[3]) < 1e-6 && Math.abs(q[2] - q[4]) < 1e-6 && Math.abs(q[5] - q[7]) < 1e-6;

// Chrome hit-tests an axis-aligned glyph box as a LayoutUnit (1/64) rect in the text's user space: grow it outward to
// that grid (P3-TEXT-MARKER-PICKING.md: points 0.010-0.012 units past the reported extent still hit).
export function layoutSnap(q: number[]): number[] {
  const x0 = Math.floor(Math.min(q[0], q[2]) * 64) / 64;
  const x1 = Math.ceil(Math.max(q[0], q[2]) * 64) / 64;
  const y0 = Math.floor(Math.min(q[1], q[5]) * 64) / 64;
  const y1 = Math.ceil(Math.max(q[1], q[5]) * 64) / 64;
  return [x0, y0, x1, y0, x1, y1, x0, y1];
}

// One user-space quad per addressable character: the cell from start to end position along the advance, with the
// font's ascent/descent across it. Browsers report the cell's axis-aligned extent, so for rotated characters (text on
// a path) the across-advance span and its offset from the baseline are recovered from that extent.
export function textCells(text: TextApi): number[][] {
  const cells: number[][] = [];
  let n = 0;
  try {
    n = text.getNumberOfChars();
  } catch {
    return cells;
  }
  for (let i = 0; i < n; i++) {
    let box, start, end;
    try {
      box = text.getExtentOfChar(i);
      start = text.getStartPositionOfChar(i);
      end = text.getEndPositionOfChar(i);
    } catch {
      continue;
    }
    if (!(box.width > 0 && box.height > 0)) continue;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const L = Math.hypot(dx, dy);
    const tx = L > 0 ? dx / L : 1;
    const ty = L > 0 ? dy / L : 0;
    // axis-aligned (or unknown direction): the extent is the cell
    if (!(L > 0) || Math.abs(ty) < 1e-6 || Math.abs(tx) < 1e-6) {
      cells.push([
        box.x,
        box.y,
        box.x + box.width,
        box.y,
        box.x + box.width,
        box.y + box.height,
        box.x,
        box.y + box.height
      ]);
      continue;
    }
    // n is the advance normal pointing to the descent side (y-down)
    const nx = -ty;
    const ny = tx;
    let H: number;
    let m: number;
    let nn: number;
    if (Math.abs(ny) >= Math.abs(nx)) {
      H = (box.height - L * Math.abs(ty)) / Math.abs(ny);
      m = box.y - start.y - Math.min(0, L * ty);
      nn = ny;
    } else {
      H = (box.width - L * Math.abs(tx)) / Math.abs(nx);
      m = box.x - start.x - Math.min(0, L * tx);
      nn = nx;
    }
    if (!(H > 0) || !Number.isFinite(H)) {
      cells.push([
        box.x,
        box.y,
        box.x + box.width,
        box.y,
        box.x + box.width,
        box.y + box.height,
        box.x,
        box.y + box.height
      ]);
      continue;
    }
    const ascent = Math.min(H, Math.max(0, nn > 0 ? -m / nn : H - m / nn));
    const descent = H - ascent;
    const corner = (u: number, v: number) => [start.x + u * tx + v * nx, start.y + u * ty + v * ny];
    cells.push([...corner(0, -ascent), ...corner(L, -ascent), ...corner(L, descent), ...corner(0, descent)]);
  }
  return cells;
}

const painted = (paint: string | undefined) => !!paint && paint !== "none";

// Whether a raster <image> layer (compact relief, path-layer canvas) is a hit region: an image hits its rect unless
// computed pointer-events is none (click-through). Without a view nothing is computed, so nothing is indexed.
export function rasterHits(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  return !!view && view.getComputedStyle(element).pointerEvents !== "none";
}

// Which areas are pointer-sensitive for a pointer-events value (SVG2 §15.6); null = not hit-testable at all.
export function sensitivity(style: Style): { fill: boolean; stroke: boolean; box: boolean } | null {
  const visible = style.visibility === "visible";
  const width = Number.parseFloat(style.strokeWidth || "1");
  const fill = painted(style.fill);
  const stroke = painted(style.stroke) && width > 0;
  switch (style.pointerEvents) {
    case "none":
      return null;
    case "bounding-box":
      return { fill: false, stroke: false, box: true };
    case "visibleFill":
      return visible ? { fill: true, stroke: false, box: false } : null;
    case "visibleStroke":
      return visible ? { fill: false, stroke: true, box: false } : null;
    case "visible":
      return visible ? { fill: true, stroke: true, box: false } : null;
    case "painted":
      return { fill, stroke, box: false };
    case "fill":
      return { fill: true, stroke: false, box: false };
    case "stroke":
      return { fill: false, stroke: true, box: false };
    case "all":
      return { fill: true, stroke: true, box: false };
    default:
      // auto / visiblePainted
      return visible ? { fill, stroke, box: false } : null;
  }
}

// The viewport rect of the nearest nested <svg> (in the world), when its overflow clips. Root <svg> is not a clip.
function nestedClip(
  leaf: Node,
  world: Affine,
  style: (node: Node) => Style | null,
  cache: Map<Node, number[] | null>
): number[] | undefined {
  const svg = leaf.parentElement?.closest("svg");
  if (!svg || !svg.ownerSVGElement) return undefined;
  if (!cache.has(svg)) {
    const parent = svg.parentElement?.getScreenCTM?.();
    const overflow = style(svg)?.overflow ?? "hidden";
    const geometry = svg as unknown as Partial<Record<"x" | "y" | "width" | "height", { animVal?: { value: number } }>>;
    const value = (name: "x" | "y" | "width" | "height") => geometry[name]?.animVal?.value ?? num(svg, name);
    cache.set(
      svg,
      parent && overflow !== "visible"
        ? boxCorners(relative(world, parent), value("x"), value("y"), value("width"), value("height"))
        : null
    );
  }
  return cache.get(svg) ?? undefined;
}

export type CompatRoot = Node & { querySelectorAll(selector: string): Iterable<Node> };

// DOM order, so later leaves stay topmost in PickIndex (last inserted wins). Screen CTMs on both sides: getCTM stops
// at the nearest viewport, which for marker content is the nested <svg>, not the map.
// Adjacent compatibility roots are converted in one synchronous chunk. Expose their owned culls together:
// restoring one <use> before reading the next otherwise forces a fresh SVG layout for every root.
export function compatShapesBatch(
  elements: CompatRoot[],
  viewbox: { getScreenCTM?(): Affine | null }
): HitShape[][] {
  return withCanonicalEmblemPaint(() => {
    const exposed = new Map<Node, string>();
    try {
      for (const element of elements) {
        const leaves = element.closest(LEAVES) === element ? [element] : [...element.querySelectorAll(LEAVES)];
        for (const leaf of leaves) {
          const current = leaf.getAttribute?.("class");
          if (!current?.split(/\s+/).includes("viewport-culled") || !leaf.setAttribute || exposed.has(leaf)) continue;
          const source = emblemSourceClass(leaf as unknown as Element);
          const value = source ? source.value : current.split(/\s+/).filter(c => c !== "viewport-culled").join(" ");
          exposed.set(leaf, current);
          if (value === null && leaf.removeAttribute) leaf.removeAttribute("class");
          else leaf.setAttribute("class", value ?? "");
        }
      }
      return elements.map(element => canonicalCompatShapes(element, viewbox));
    } finally {
      for (const [leaf, value] of exposed) leaf.setAttribute!("class", value);
    }
  });
}

export function compatShapes(element: CompatRoot, viewbox: { getScreenCTM?(): Affine | null }): HitShape[] {
  return withCanonicalEmblemPaint(() => canonicalCompatShapes(element, viewbox));
}

function canonicalCompatShapes(element: CompatRoot, viewbox: { getScreenCTM?(): Affine | null }): HitShape[] {
  const world = viewbox.getScreenCTM?.();
  if (!world || !(world.a * world.d - world.b * world.c)) return [];
  const leaves = element.closest(LEAVES) === element ? [element] : [...element.querySelectorAll(LEAVES)];
  const computed = typeof getComputedStyle === "function" ? getComputedStyle : null;
  const style = (node: Node) => (computed ? (computed(node as unknown as Element) as unknown as Style) : null);
  const hidden = new Map<Node, boolean>();
  // display:none anywhere up the chain removes the leaf from rendering and hit testing
  const displayed = (node: Node | null): boolean => {
    if (!node || !computed) return true;
    let known = hidden.get(node);
    if (known === undefined) {
      known = style(node)?.display === "none" || !displayed(node.parentElement);
      hidden.set(node, known);
    }
    return !known;
  };
  const clips = new Map<Node, number[] | null>();
  const positions = new Map<Element, Map<Element, number>>();
  const shapes: HitShape[] = [];
  const exposed: [Node, string][] = [];
  try {
    // Batch exposure before any geometry/style read: alternating writes and reads per emblem forces a shadow-tree
    // style/layout flush for every leaf. This remains synchronous; restore all classes before any caller can yield.
    for (const leaf of leaves) {
      const originalClass = leaf.getAttribute?.("class");
      if (!originalClass?.split(/\s+/).includes("viewport-culled") || !leaf.setAttribute) continue;
      const source = emblemSourceClass(leaf as unknown as Element);
      const value = source ? source.value : originalClass.split(/\s+/).filter(c => c !== "viewport-culled").join(" ");
      exposed.push([leaf, originalClass]);
      if (value === null && leaf.removeAttribute) leaf.removeAttribute("class");
      else leaf.setAttribute("class", value ?? "");
    }
    for (const leaf of leaves) {
      if (leaf.closest(UNPAINTED)) continue;
      const id = pickId(leaf);
      const ctm = leaf.getScreenCTM?.();
      if (!id || !ctm) continue;
      if (!displayed(leaf)) continue;
      const css = style(leaf);
      // without a style engine (tests) every painted area counts
      const sense = css ? sensitivity(css) : { fill: true, stroke: false, box: false };
      if (!sense) continue;
      const m = relative(world, ctm);
      const det = Math.abs(m.a * m.d - m.b * m.c);
      if (!(det > 0)) continue;
      const clip = nestedClip(leaf, world, style, clips);
      const shape: HitShape = { id };
      if (clip) shape.clip = clip;
      const depth = pickDepth(leaf);
      if (depth) {
        shape.depth = depth;
        const path = leafPath(leaf as unknown as Element, depth, positions);
        if (path) shape.path = path;
      }
      const tag = leaf.tagName.toLowerCase();
      const box = () => {
        const b = leaf.getBBox?.();
        return b && (b.width > 0 || b.height > 0) ? boxCorners(m, b.x, b.y, b.width, b.height) : undefined;
      };
      if (sense.box || tag === "use" || tag === "image") {
        // image: its viewport rect is the hit area for fill-sensitive values; <use>: approximated by its bbox
        if (sense.box || sense.fill || (tag === "use" && sense.stroke)) shape.box = box();
      } else if (tag === "text") {
        if (sense.fill || sense.stroke) {
          const cells = textCells(leaf as unknown as TextApi).map(cell =>
            transform(m, axisAligned(cell) ? layoutSnap(cell) : cell)
          );
          if (cells.length) {
            shape.fill = { rings: cells, evenOdd: false };
            // Chrome's 1px pointer square applies to axis-aligned glyph boxes only; rotated (textPath) glyphs hit by point
            shape.square = cells.every(axisAligned);
          }
        }
      } else {
        const d = shapePath(leaf);
        if (!d) continue;
        const scale = Math.sqrt(det);
        const subpaths = flattenPath(d, WORLD_TOLERANCE / scale).filter(s => s.points.length >= 2);
        const rings = subpaths.map(s => transform(m, s.points));
        if (sense.fill && rings.length) {
          // fill areas close every subpath (an open path's fill is its implicit closure)
          shape.fill = { rings, evenOdd: css?.fillRule === "evenodd" };
        }
        if (sense.stroke && rings.length) {
          const width = Number.parseFloat(css?.strokeWidth || "1");
          // dash lengths are in the leaf's user space, so the measure resolution is device px per user unit
          const resolution = Math.sqrt(Math.abs(ctm.a * ctm.d - ctm.b * ctm.c));
          const dashes = parseDashes(css?.strokeDasharray) ?? [];
          const offset = Number.parseFloat(css?.strokeDashoffset ?? "") || 0;
          const dashed = normalizeDashes(dashes).length > 0;
          const strokes = strokeHitRings(
            dashed ? () => dashHitRings(d, dashes, offset, resolution) : null,
            () => subpaths
          );
          const linecap = css?.strokeLinecap;
          shape.stroke = {
            rings: strokes.map(s => transform(m, s.points)),
            closed: strokes.map(s => s.closed),
            halfWidth: (width / 2) * scale,
            cap: linecap === "butt" || linecap === "round" || linecap === "square" ? linecap : undefined
          };
        }
      }
      if (shape.box || shape.fill || shape.stroke) shapes.push(shape);
    }
  } finally {
    for (const [leaf, originalClass] of exposed) leaf.setAttribute!("class", originalClass);
  }
  return shapes;
}
