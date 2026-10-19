import { capCode, dashCovered, normalizeDashes } from "./geometry";

export type PickKind = "fill" | "stroke" | "box";
export interface PickHit {
  layer: string;
  id: string;
  index: number;
  order: number;
  instance?: number; // which instance of a multi-instance layer (a #terrain <use> child index), when exact
  depth?: number; // anonymous leaf: steps from the painted element up to the [id] ancestor named by `id` (absent = 0)
  path?: readonly number[]; // anonymous leaf: element-child indices from the [id] ancestor down to it (length depth)
}

// The element-child index path from the ancestor `depth` levels up down to `element` (PickHit.path), so an anonymous
// leaf can be found again in the live DOM without the index holding element references. `memo` caches sibling
// positions per parent across one prepare (anonymous siblings are many: indexOf per leaf would be quadratic).
export function leafPath(
  element: Element,
  depth: number,
  memo: Map<Element, Map<Element, number>> = new Map()
): number[] | null {
  if (!depth) return null;
  const path: number[] = [];
  let node = element;
  for (let k = 0; k < depth; k++) {
    const parent = node.parentElement;
    if (!parent?.children) return null;
    let positions = memo.get(parent);
    if (!positions) {
      positions = new Map(Array.from(parent.children, (child, i) => [child, i] as const));
      memo.set(parent, positions);
    }
    const position = positions.get(node);
    if (position === undefined) return null;
    path.push(position);
    node = parent;
  }
  return path.reverse();
}

// The live element at `path` below `ancestor`, or null when the DOM no longer has it (callers check the index revision
// first; this only guards against a structure the revision did not see).
export function resolveLeaf(ancestor: Element, path: readonly number[]): Element | null {
  let node: Element | undefined = ancestor;
  for (const i of path) {
    node = node.children[i];
    if (!node || node.id) return null; // a leaf path runs through anonymous elements only (pickId stops at an id)
  }
  return node;
}

// Per-instance narrowphase under a box broadphase: whether (x, y) within `tolerance` is in the instance's hit area.
export type Narrowphase = (x: number, y: number, tolerance: number) => boolean;

// SVG stroke-linecap of the open ends of a stroke hit shape (undefined = round, the historic hit area).
export type StrokeCap = "butt" | "round" | "square";

// Hit-test geometry of one painted element in world space, as SVG hit testing defines it (SVG2 §15.6): the fill area
// when the fill is pointer-sensitive, the stroke area when the stroke is, text character cells (not glyph ink), image
// rects. `clip` is an enclosing viewport ring (nested <svg> overflow) outside which nothing hits.
export interface HitShape {
  id: string;
  fill?: { rings: ArrayLike<number>[]; evenOdd: boolean };
  stroke?: { rings: ArrayLike<number>[]; closed: boolean[]; halfWidth: number; cap?: StrokeCap };
  box?: ArrayLike<number>;
  clip?: ArrayLike<number>;
  // Text cells: Chrome hit-tests SVG text with the 1×1 CSS px square whose top-left is the pointer, not the point, so a
  // cell is hit up to one CSS px left of and above its extent (measured: P3-TEXT-MARKER-PICKING.md). Convex rings only.
  square?: boolean;
  depth?: number; // see PickHit.depth
  path?: readonly number[] | null; // see PickHit.path
}

// Whether the axis-aligned square [x, x + s] × [y, y + s] meets the convex ring (separating axis test).
export function squareMeetsConvex(x: number, y: number, s: number, ring: ArrayLike<number>): boolean {
  const n = ring.length >> 1;
  if (n < 3) return false;
  let minX = Number.POSITIVE_INFINITY,
    minY = Number.POSITIVE_INFINITY,
    maxX = Number.NEGATIVE_INFINITY,
    maxY = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < n; k++) {
    minX = Math.min(minX, ring[2 * k]);
    maxX = Math.max(maxX, ring[2 * k]);
    minY = Math.min(minY, ring[2 * k + 1]);
    maxY = Math.max(maxY, ring[2 * k + 1]);
  }
  if (maxX < x || minX > x + s || maxY < y || minY > y + s) return false;
  const corners = [x, y, x + s, y, x + s, y + s, x, y + s];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const nx = ring[2 * j + 1] - ring[2 * i + 1];
    const ny = ring[2 * i] - ring[2 * j];
    if (!nx && !ny) continue;
    let ringMin = Number.POSITIVE_INFINITY,
      ringMax = Number.NEGATIVE_INFINITY,
      squareMin = Number.POSITIVE_INFINITY,
      squareMax = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < n; k++) {
      const p = ring[2 * k] * nx + ring[2 * k + 1] * ny;
      ringMin = Math.min(ringMin, p);
      ringMax = Math.max(ringMax, p);
    }
    for (let k = 0; k < 4; k++) {
      const p = corners[2 * k] * nx + corners[2 * k + 1] * ny;
      squareMin = Math.min(squareMin, p);
      squareMax = Math.max(squareMax, p);
    }
    if (ringMax < squareMin || squareMax < ringMin) return false;
  }
  return true;
}

// Native stroke outline parameters (SVG2 §13.5): the dash pattern restarts on every subpath and the cap applies at
// open subpath ends and on every dash. Joins are taken as round (a subset of the default miter outline).
export interface StrokeOutline {
  dashes: number[];
  dashOffset: number;
  lineCap: string;
}

interface Item {
  kind: PickKind;
  layer: string;
  id: string;
  rings: Float64Array[];
  closed: boolean[];
  evenOdd: boolean;
  halfWidth: number;
  clip: Float64Array | null;
  outline: { dashes: number[]; offset: number; cap: number } | null;
  cap?: StrokeCap;
  instance: number | null;
  narrow: Narrowphase | null;
  square: boolean;
  depth: number;
  path: readonly number[] | null;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function windingNumber(x: number, y: number, ring: ArrayLike<number>): number {
  const n = ring.length >> 1;
  let w = 0;
  for (let i = 0; i < n; i++) {
    const j = i === 0 ? n - 1 : i - 1;
    const xi = ring[2 * i];
    const yi = ring[2 * i + 1];
    const xj = ring[2 * j];
    const yj = ring[2 * j + 1];
    const left = (xi - xj) * (y - yj) - (x - xj) * (yi - yj);
    if (yj <= y) {
      if (yi > y && left > 0) w++;
    } else if (yi <= y && left < 0) {
      w--;
    }
  }
  return w;
}

export function insideRings(x: number, y: number, rings: ArrayLike<number>[], evenOdd: boolean): boolean {
  let w = 0;
  for (const ring of rings) w += windingNumber(x, y, ring);
  return evenOdd ? (Math.abs(w) & 1) === 1 : w !== 0;
}

export function segmentDistance(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0;
  return Math.hypot(x0 + t * dx - px, y0 + t * dy - py);
}

export function polylineDistance(px: number, py: number, points: ArrayLike<number>, closed: boolean): number {
  const n = points.length >> 1;
  if (n === 0) return Number.POSITIVE_INFINITY;
  if (n === 1) return Math.hypot(px - points[0], py - points[1]);
  let best = Number.POSITIVE_INFINITY;
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % n;
    const d = segmentDistance(px, py, points[2 * i], points[2 * i + 1], points[2 * j], points[2 * j + 1]);
    if (d < best) best = d;
  }
  return best;
}

// A zero-length piece has no direction, so Skia caps it upright: a round dot, or an axis-aligned square of half-width
// `reach`. Butt draws nothing.
function dotCovers(px: number, py: number, x: number, y: number, cap: number, reach: number): boolean {
  if (cap === 1) return false;
  return cap === 0 ? Math.abs(px - x) <= reach && Math.abs(py - y) <= reach : Math.hypot(px - x, py - y) <= reach;
}

// How far past a butt end still counts as on it. Click points arrive as float32 screen coordinates, so a burg centre
// sitting exactly on a route's endpoint lands a few millionths of a unit to either side of the end line; Blink hits it.
const END_SLACK = 1e-3;

function isPoint(points: ArrayLike<number>, n: number): boolean {
  for (let k = 1; k < n; k++) if (points[2 * k] !== points[0] || points[2 * k + 1] !== points[1]) return false;
  return true;
}

// The round join at interior vertex j, for a point already past the end of the segment arriving there: the disc
// clipped to the outer wedge, i.e. also before the start of the next segment. The whole disc would reach past a butt
// end when the last segment is shorter than the half-width (a flattened curve's final step).
function joinCovers(px: number, py: number, points: ArrayLike<number>, j: number, closed: boolean, reach: number) {
  const n = points.length >> 1;
  const vx = points[2 * j];
  const vy = points[2 * j + 1];
  if (Math.hypot(px - vx, py - vy) > reach) return false;
  for (let step = 1; step < n; step++) {
    if (!closed && j + step >= n) return false;
    const m = (j + step) % n;
    const dx = points[2 * m] - vx;
    const dy = points[2 * m + 1] - vy;
    if (dx || dy) return (px - vx) * dx + (py - vy) * dy <= 0;
  }
  return false;
}

// Whether (px, py) lies in the outline of one stroked subpath with the given caps and dashes. Interior vertices are
// round-joined; open ends get the cap only, so a butt-capped route ends exactly at its endpoint. A subpath that is a
// single point (a zero-length dash, already cut by the caller) is a dot, not an empty stroke.
export function strokeCovers(
  px: number,
  py: number,
  points: ArrayLike<number>,
  closed: boolean,
  reach: number,
  dashes: number[],
  offset: number,
  cap: number
): boolean {
  const n = points.length >> 1;
  if (n === 0) return false;
  if (n === 1 || (!closed && isPoint(points, n))) return dotCovers(px, py, points[0], points[1], cap, reach);
  const segments = closed ? n : n - 1;
  const live = (i: number) => points[2 * i] !== points[2 * i + 2] || points[2 * i + 1] !== points[2 * i + 3];
  let first = 0;
  let last = segments - 1;
  if (!closed) {
    while (!live(first)) first++;
    while (!live(last)) last--;
  }
  let start = 0;
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % n;
    const x0 = points[2 * i];
    const y0 = points[2 * i + 1];
    const dx = points[2 * j] - x0;
    const dy = points[2 * j + 1] - y0;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const along = ((px - x0) * dx + (py - y0) * dy) / len;
    const across = Math.abs((px - x0) * dy - (py - y0) * dx) / len;
    const before = along < 0 && !closed && i === first;
    const after = along > len && !closed && i === last;
    let inside: boolean;
    if (before || after) {
      const past = before ? -along : along - len;
      // butt: nothing beyond the end line; square: a half-width box; round: a half-width disc
      if (cap === 2) inside = past * past + across * across <= reach * reach;
      else inside = past <= (cap === 0 ? reach : END_SLACK) && across <= reach;
    } else if (along < 0) {
      inside = false; // an interior start vertex: its join is tested from the segment arriving there
    } else if (along > len) {
      inside = joinCovers(px, py, points, j, closed, reach);
    } else {
      inside = across <= reach;
    }
    if (inside && dashCovered(start + Math.min(len, Math.max(0, along)), across, dashes, offset, cap, reach))
      return true;
    start += len;
  }
  return false;
}

// Whether (px, py) lies within `reach` of a polyline with round joins whose open ends are shaped by `cap` (undefined
// keeps polylineDistance's round disc). Butt: nothing past the first or last endpoint along its segment; square: a
// `reach` box past it. Degenerate open rings are dots, as in strokeCovers.
export function polylineCovers(
  px: number,
  py: number,
  points: ArrayLike<number>,
  closed: boolean,
  reach: number,
  cap?: StrokeCap
): boolean {
  if (closed || cap === undefined || cap === "round") return polylineDistance(px, py, points, closed) <= reach;
  const n = points.length >> 1;
  if (n === 0) return false;
  if (n === 1 || isPoint(points, n)) return dotCovers(px, py, points[0], points[1], capCode(cap), reach);
  const live = (i: number) => points[2 * i] !== points[2 * i + 2] || points[2 * i + 1] !== points[2 * i + 3];
  let first = 0;
  while (!live(first)) first++;
  let last = n - 2;
  while (!live(last)) last--;
  for (let i = first; i <= last; i++) {
    if (!live(i)) continue;
    const x0 = points[2 * i];
    const y0 = points[2 * i + 1];
    const dx = points[2 * i + 2] - x0;
    const dy = points[2 * i + 3] - y0;
    const len = Math.hypot(dx, dy);
    const along = ((px - x0) * dx + (py - y0) * dy) / len;
    const across = Math.abs((px - x0) * dy - (py - y0) * dx) / len;
    const before = i === first && along < 0;
    const after = i === last && along > len;
    if (before || after) {
      // open end: butt stops at the endpoint, square extends the end segment by a half-width box
      const past = before ? -along : along - len;
      if (past <= (cap === "square" ? reach : END_SLACK) && across <= reach) return true;
    } else if (along > len) {
      if (joinCovers(px, py, points, i + 1, false, reach)) return true;
    } else if (along >= 0 && across <= reach) return true;
  }
  return false;
}

export class PickIndex {
  private readonly items: Item[] = [];
  private readonly buckets = new Map<number, number[]>();
  private readonly cell: number;
  private readonly nx: number;
  private readonly ny: number;
  private coords = 0;
  private entries = 0;

  constructor(width: number, height: number, cellSize = 64) {
    this.cell = cellSize;
    this.nx = Math.max(1, Math.ceil(width / cellSize));
    this.ny = Math.max(1, Math.ceil(height / cellSize));
  }

  get size(): number {
    return this.items.length;
  }

  addFill(layer: string, id: string, rings: ArrayLike<number>[], evenOdd: boolean): number {
    // fill rings are implicitly closed: the tolerance band includes the closing edge
    return this.add(
      "fill",
      layer,
      id,
      rings,
      rings.map(() => true),
      evenOdd,
      0
    );
  }

  // Without an outline the stroke is round-capped and solid (compat geometry's documented approximation).
  addStroke(
    layer: string,
    id: string,
    rings: ArrayLike<number>[],
    closed: boolean[],
    halfWidth: number,
    outline?: StrokeOutline
  ): number {
    const index = this.add("stroke", layer, id, rings, closed, false, halfWidth);
    if (outline)
      this.items[index].outline = {
        dashes: normalizeDashes(outline.dashes),
        offset: outline.dashOffset,
        cap: capCode(outline.lineCap)
      };
    return index;
  }

  addBox(layer: string, id: string, corners: ArrayLike<number>): number {
    return this.add("box", layer, id, [corners], [true], false, 0);
  }

  // A box broadphase whose hits are decided by `narrow` (null keeps the box as the hit area). A narrowphase miss is no
  // hit, so lower items below it are still found in topmost order.
  addInstance(
    layer: string,
    id: string,
    corners: ArrayLike<number>,
    instance: number,
    narrow: Narrowphase | null
  ): number {
    const index = this.addBox(layer, id, corners);
    this.items[index].instance = instance;
    this.items[index].narrow = narrow;
    return index;
  }

  // Branch identity of an anonymous leaf (PickHit.depth), set on items added since `from`.
  setDepth(from: number, depth: number, path: readonly number[] | null = null): void {
    for (let i = from; i < this.items.length; i++) {
      this.items[i].depth = depth;
      this.items[i].path = depth && path?.length === depth ? path : null;
    }
  }

  // Fill before stroke: both carry the same id, so their relative order never changes the answer.
  addShape(layer: string, shape: HitShape): void {
    const { id, clip = null } = shape;
    const from = this.items.length;
    this.addShapeItems(layer, id, clip, shape);
    if (shape.depth) this.setDepth(from, shape.depth, shape.path ?? null);
  }

  private addShapeItems(layer: string, id: string, clip: ArrayLike<number> | null, shape: HitShape): void {
    if (shape.box) this.add("box", layer, id, [shape.box], [true], false, 0, clip);
    if (shape.fill?.rings.length) {
      const index = this.add(
        "fill",
        layer,
        id,
        shape.fill.rings,
        shape.fill.rings.map(() => true),
        shape.fill.evenOdd,
        0,
        clip
      );
      this.items[index].square = !!shape.square;
    }
    if (shape.stroke?.rings.length) {
      const index = this.add(
        "stroke",
        layer,
        id,
        shape.stroke.rings,
        shape.stroke.closed,
        false,
        shape.stroke.halfWidth,
        clip
      );
      this.items[index].cap = shape.stroke.cap;
    }
  }

  clear(): void {
    this.items.length = 0;
    this.buckets.clear();
    this.coords = 0;
    this.entries = 0;
  }

  // `pixel` = one CSS px in index units: the pointer square of `square` items (0 = point hit testing everywhere).
  pickAll(x: number, y: number, tolerance = 0, pixel = 0): PickHit[] {
    return this.candidates(x, y, Math.max(tolerance, pixel))
      .filter(i => this.hits(this.items[i], x, y, tolerance, pixel))
      .sort((a, b) => b - a)
      .map(i => this.hit(i));
  }

  // The topmost hit: candidates are tested top-down and the first hit returns, so the large low fills under a hit
  // (biomes, cells, ocean) are never ring-tested. Buckets hold item indices in insertion (paint) order.
  pick(x: number, y: number, tolerance = 0, layer?: string, pixel = 0): PickHit | null {
    const reach = Math.max(tolerance, pixel);
    const r0 = this.row(y - reach);
    const c0 = this.col(x - reach);
    const single = r0 === this.row(y + reach) && c0 === this.col(x + reach);
    const order = single
      ? (this.buckets.get(r0 * this.nx + c0) ?? [])
      : this.candidates(x, y, reach).sort((a, b) => a - b);
    for (let k = order.length - 1; k >= 0; k--) {
      const item = this.items[order[k]];
      if (layer !== undefined && item.layer !== layer) continue;
      if (this.hits(item, x, y, tolerance, pixel)) return this.hit(order[k]);
    }
    return null;
  }

  bytes(): number {
    return this.coords * 8 + this.entries * 4;
  }

  // Diagnostics only (bench): the broadphase candidates at (x, y) whose box contains it, topmost first, plus every item
  // of `ids`, each with its geometry, which rings contain the point and whether the item hits. Never used to select.
  inspect(x: number, y: number, ids: string[] = [], pixel = 0) {
    const round = (ring: ArrayLike<number>) => Array.from(ring, v => Math.round(v * 1000) / 1000);
    const near = this.candidates(x, y, 0).filter(i => {
      const item = this.items[i];
      return x >= item.minX && x <= item.maxX && y >= item.minY && y <= item.maxY;
    });
    const named = this.items.flatMap((item, i) => (ids.includes(item.id) ? [i] : []));
    return [...new Set([...near, ...named])]
      .sort((a, b) => b - a)
      .map(i => {
        const item = this.items[i];
        return {
          order: i,
          layer: item.layer,
          id: item.id,
          kind: item.kind,
          broadphase: near.includes(i),
          hit: this.hits(item, x, y, 0, pixel),
          narrow: !!item.narrow,
          square: item.square,
          depth: item.depth,
          halfWidth: item.halfWidth,
          outline: item.outline,
          distance:
            Math.round(Math.min(...item.rings.map((ring, k) => polylineDistance(x, y, ring, item.closed[k]))) * 1e4) /
            1e4,
          box: [item.minX, item.minY, item.maxX, item.maxY].map(v => Math.round(v * 1000) / 1000),
          clip: item.clip ? { ring: round(item.clip), inside: insideRings(x, y, [item.clip], false) } : null,
          ringsContaining: item.rings.flatMap((ring, k) => (windingNumber(x, y, ring) ? [k] : [])),
          rings: item.rings.slice(0, 40).map(round)
        };
      });
  }

  private add(
    kind: PickKind,
    layer: string,
    id: string,
    rings: ArrayLike<number>[],
    closed: boolean[],
    evenOdd: boolean,
    halfWidth: number,
    clip: ArrayLike<number> | null = null
  ): number {
    const index = this.items.length;
    const copies = rings.map(ring => Float64Array.from(ring));
    const clipRing = clip ? Float64Array.from(clip) : null;
    if (clipRing) this.coords += clipRing.length;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const ring of copies) {
      this.coords += ring.length;
      for (let k = 0; k < ring.length; k += 2) {
        minX = Math.min(minX, ring[k]);
        maxX = Math.max(maxX, ring[k]);
        minY = Math.min(minY, ring[k + 1]);
        maxY = Math.max(maxY, ring[k + 1]);
      }
    }
    if (minX > maxX) {
      minX = minY = maxX = maxY = 0;
    }
    const pad = kind === "stroke" ? halfWidth : 0;
    const item: Item = {
      kind,
      layer,
      id,
      rings: copies,
      closed: copies.map((_, k) => closed[k] ?? false),
      evenOdd,
      halfWidth,
      clip: clipRing,
      outline: null,
      instance: null,
      narrow: null,
      square: false,
      depth: 0,
      path: null,
      minX: minX - pad,
      minY: minY - pad,
      maxX: maxX + pad,
      maxY: maxY + pad
    };
    this.items.push(item);
    for (let r = this.row(item.minY); r <= this.row(item.maxY); r++) {
      for (let c = this.col(item.minX); c <= this.col(item.maxX); c++) {
        const key = r * this.nx + c;
        const bucket = this.buckets.get(key);
        if (bucket) bucket.push(index);
        else this.buckets.set(key, [index]);
        this.entries++;
      }
    }
    return index;
  }

  private col(x: number): number {
    return Math.min(this.nx - 1, Math.max(0, Math.floor(x / this.cell)));
  }

  private row(y: number): number {
    return Math.min(this.ny - 1, Math.max(0, Math.floor(y / this.cell)));
  }

  private candidates(x: number, y: number, tolerance: number): number[] {
    const seen = new Set<number>();
    const out: number[] = [];
    for (let r = this.row(y - tolerance); r <= this.row(y + tolerance); r++) {
      for (let c = this.col(x - tolerance); c <= this.col(x + tolerance); c++) {
        for (const i of this.buckets.get(r * this.nx + c) ?? []) {
          if (!seen.has(i)) {
            seen.add(i);
            out.push(i);
          }
        }
      }
    }
    return out;
  }

  private hits(item: Item, x: number, y: number, tolerance: number, pixel = 0): boolean {
    const reach = item.square ? pixel : 0; // the pointer square extends right and down from (x, y)
    if (x + reach < item.minX - tolerance || x > item.maxX + tolerance) return false;
    if (y + reach < item.minY - tolerance || y > item.maxY + tolerance) return false;
    if (item.clip && !insideRings(x, y, [item.clip], false)) return false;
    if (reach > 0 && item.rings.some(ring => squareMeetsConvex(x, y, reach, ring))) return true;
    if (item.narrow) return item.narrow(x, y, tolerance);
    if (item.kind === "stroke") {
      const reach = item.halfWidth + tolerance;
      const outline = item.outline;
      if (outline)
        return item.rings.some((ring, k) =>
          strokeCovers(x, y, ring, item.closed[k], reach, outline.dashes, outline.offset, outline.cap)
        );
      return item.rings.some((ring, k) => polylineCovers(x, y, ring, item.closed[k], reach, item.cap));
    }
    if (insideRings(x, y, item.rings, item.evenOdd)) return true;
    return item.rings.some((ring, k) => polylineDistance(x, y, ring, item.closed[k]) <= tolerance);
  }

  private hit(i: number): PickHit {
    const item = this.items[i];
    const hit: PickHit = { layer: item.layer, id: item.id, index: i, order: i };
    if (item.instance !== null) hit.instance = item.instance;
    if (item.depth) hit.depth = item.depth;
    if (item.path) hit.path = item.path;
    return hit;
  }
}
