// Dynamic trade-marker pass. P1 transitional bridge: the original D3 controller still animates <g transform> groups
// in #tradeAnimation; each GPU frame mirrors their current transforms into instanced RGBA quads, and the mutation
// classifier keeps those transient updates from invalidating the static prepare (they only request a frame).
// While the canvas presents the map the controller keeps the poses out of the SVG (renderers/caravan-poses.ts): they
// are read from there, and the renderer redraws on their tick instead of on a record.
import { caravanEnded, caravanTransform } from "../renderers/caravan-poses";
import type { GpuDevice, TrackedTexture } from "./device";
import { type Affine, decodeSvg, multiply, parseTransform } from "./raster";

export const TRADE_LAYER = "tradeAnimation";
// Per instance: origin (2) + u axis (2) + v axis (2), world units.
export const MARKER_FLOATS = 6;
const TEXTURE_SIZE = 256;
const svgNs = "http://www.w3.org/2000/svg";

type Kind = "land" | "water";

export function markerKind(href: string | null | undefined): Kind | null {
  const match = /^#trade-marker-(land|water)$/.exec(href || "");
  return match ? (match[1] as Kind) : null;
}

// Writes the <use> viewport box mapped through `m` (root * group * use); false for degenerate input.
export function writeMarker(
  out: Float32Array,
  offset: number,
  m: Affine,
  box: { x: number; y: number; width: number; height: number }
): boolean {
  const { x, y, width, height } = box;
  if (!(width > 0 && height > 0) || ![x, y, ...m].every(Number.isFinite)) return false;
  out[offset] = m[0] * x + m[2] * y + m[4];
  out[offset + 1] = m[1] * x + m[3] * y + m[5];
  out[offset + 2] = m[0] * width;
  out[offset + 3] = m[1] * width;
  out[offset + 4] = m[2] * height;
  out[offset + 5] = m[3] * height;
  return true;
}

export interface NodeLike {
  tagName?: string;
  id?: string;
  parentElement: NodeLike | null;
  isConnected?: boolean;
  getAttribute?(name: string): string | null;
}

export interface MutationLike {
  type: string;
  target: NodeLike;
  attributeName?: string | null;
  oldValue?: string | null;
  addedNodes: ArrayLike<NodeLike>;
  removedNodes: ArrayLike<NodeLike>;
  previousSibling?: NodeLike | null;
  nextSibling?: NodeLike | null;
}

const isMarkerGroup = (node: NodeLike) => node.tagName === "g" && node.parentElement?.id === TRADE_LAYER;

// Marker groups being added/removed, or anything inside one (transform ticks, use/circle attributes).
function transient(record: MutationLike): boolean {
  if (record.target.id === TRADE_LAYER)
    return (
      record.type === "childList" &&
      [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].every(node => node.tagName === "g")
    );
  for (let node: NodeLike | null = record.target; node; node = node.parentElement) if (isMarkerGroup(node)) return true;
  return false;
}

const has = (node: NodeLike, name: string) => node.getAttribute?.(name) != null;
const tokens = (value: string | null | undefined) => new Set((value || "").split(/\s+/).filter(Boolean));
const hatchScale = /^\s*scale\(\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*\)(.*)$/is;

// A zone-hatch clone writes `scale(1/k) <inherited transform>` (zone-hatching.ts). The leading scale is the camera
// term; the tail is the canonical pattern transform. Returns the tail, or null when the value is not that shape.
function hatchTail(value: string | null | undefined): string | null {
  const match = hatchScale.exec(value || "");
  if (!match) return null;
  const scale = Number(match[1]);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const tail = match[2].trim();
  return tail === "" || /^[\s,]/.test(match[2]) ? tail : null;
}
const NEUTRAL_CLASSES = new Set(["viewport-culled"]);

// dense-zoom.ts hands a canonical relief/burg image to its overlay by writing these on the image together
const ZOOM_HANDOFF = new Set(["style", "data-zoom-hidden", "data-zoom-visibility"]);
const declarations = (style: string | null | undefined) => {
  const map = new Map<string, string>();
  for (const rule of (style || "").split(";")) {
    const colon = rule.indexOf(":");
    if (colon > 0)
      map.set(
        rule.slice(0, colon).trim().toLowerCase(),
        rule
          .slice(colon + 1)
          .trim()
          .replace(/\s+/g, " ")
      );
  }
  return map;
};

// Whether scene.ts draws the image: a data-zoom-hidden image regardless of visibility, otherwise by computed
// visibility (the inline value, or the parent's when unset). null when the inherited value is unknown.
function drawn(zoomHidden: boolean, style: Map<string, string>, target: NodeLike): boolean | null {
  if (zoomHidden) return true;
  const value = (style.get("visibility") || "").replace(/\s*!important$/i, "").toLowerCase();
  if (value === "hidden" || value === "collapse") return false;
  if (value && value !== "inherit" && value !== "unset") return true;
  const parent = target.parentElement as unknown as Element | null;
  if (!parent || typeof getComputedStyle !== "function") return null;
  try {
    return !["hidden", "collapse"].includes(getComputedStyle(parent).visibility);
  } catch {
    return null;
  }
}

// The handoff on one image across the batch: only visibility and the zoom markers change, and the image is drawn
// (or not) both before and after. A user visibility edit without the marker still changes what is drawn.
function zoomHandoff(record: MutationLike, records: readonly MutationLike[]): boolean {
  const { target } = record;
  if (record.type !== "attributes" || !ZOOM_HANDOFF.has(record.attributeName || "")) return false;
  if (target.tagName !== "image" || !(has(target, "data-relief") || has(target, "data-burg-vectors"))) return false;
  const first = (name: string) =>
    records.find(other => other.type === "attributes" && other.target === target && other.attributeName === name);
  const styleRecord = first("style"),
    hiddenRecord = first("data-zoom-hidden");
  const after = target.getAttribute?.("style");
  if (after === undefined || (styleRecord && styleRecord.oldValue === undefined)) return false;
  const [before, now] = [declarations(styleRecord ? styleRecord.oldValue : after), declarations(after)];
  for (const map of [before, now]) map.delete("visibility");
  if (before.size !== now.size || [...before].some(([name, value]) => now.get(name) !== value)) return false;
  if (hiddenRecord && hiddenRecord.oldValue === undefined) return false;
  const hiddenNow = has(target, "data-zoom-hidden");
  const hiddenBefore = hiddenRecord ? hiddenRecord.oldValue !== null : hiddenNow;
  const [wasDrawn, isDrawn] = [
    drawn(hiddenBefore, declarations(styleRecord ? styleRecord.oldValue : after), target),
    drawn(hiddenNow, declarations(after), target)
  ];
  return wasDrawn !== null && wasDrawn === isDrawn;
}

// A same-position re-append (d3 raise() on the last child) queues removal + insertion of one node on its parent. Per
// batch: the removal/insertion records of such a pair, paired only when they are the parent's sole childList records.
const raisePairs = new WeakMap<readonly MutationLike[], Set<MutationLike>>();
function raised(records: readonly MutationLike[]): Set<MutationLike> {
  const cached = raisePairs.get(records);
  if (cached) return cached;
  const pairs = new Set<MutationLike>();
  raisePairs.set(records, pairs);
  const byTarget = new Map<NodeLike, MutationLike[]>();
  for (const record of records) {
    if (record.type !== "childList") continue;
    const list = byTarget.get(record.target);
    if (list) list.push(record);
    else byTarget.set(record.target, [record]);
  }
  for (const [, [removal, insertion, extra]] of byTarget) {
    if (!insertion || extra) continue;
    const node = removal.removedNodes[0];
    if (
      removal.removedNodes.length !== 1 ||
      removal.addedNodes.length ||
      insertion.removedNodes.length ||
      insertion.addedNodes.length !== 1 ||
      insertion.addedNodes[0] !== node ||
      removal.previousSibling !== insertion.previousSibling ||
      removal.nextSibling !== insertion.nextSibling
    )
      continue;
    pairs.add(removal).add(insertion);
  }
  return pairs;
}

// Automatic viewport decoration the prepared frame provably does not draw differently (scene.ts / raster.ts):
// - `viewport-culled` toggles: the scene draws culled labels anyway (the camera culls on the GPU);
// - zone-hatch clone `patternTransform` leading scale() with an unchanged tail: the tile is rasterized at the prepare's reference zoom and the
//   frame graph rescales its UVs to the live camera (hatchUvAtZoom), so the attribute value never reaches pixels;
// - dense-zoom overlays and their contents: the scene skips them, the GPU draws the canonical image instead;
// - the dense-zoom visibility handoff on that canonical image when it leaves the image drawn or undrawn (zoomHandoff);
// - a node re-appended at its own position (raised), the pair's two childList records only;
// - the root #map filter / data-filter (forwarded to the canvas, never rasterized; rootFilterRecord).
// User edits of the same attributes are not excluded by origin, only when their effect is provably absent.
function neutral(record: MutationLike, records: readonly MutationLike[]): boolean {
  const { target } = record;
  if (rootFilterRecord(record)) return true;
  if (zoomHandoff(record, records)) return true;
  if (raised(records).has(record)) return true;
  if (record.type === "childList") {
    const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
    if (nodes.length && nodes.every(node => has(node, "data-dense-zoom"))) return true;
    // the overlay's own content swap (relief-viewport.ts replaceChildren); the scene skips its whole subtree
    if (has(target, "data-dense-zoom")) return true;
  }
  if (record.type === "attributes" && record.attributeName !== "data-dense-zoom" && has(target, "data-dense-zoom"))
    return true;
  for (let node = target.parentElement; node; node = node.parentElement) if (has(node, "data-dense-zoom")) return true;
  if (record.type !== "attributes" || record.oldValue === undefined) return false;
  const value = target.getAttribute?.(record.attributeName || "");
  if (value === undefined) return false;
  if (record.attributeName === "patternTransform") {
    if (target.tagName !== "pattern" || !has(target, "data-zone-hatch-clone")) return false;
    // Only the camera scale may change: UVs are rescaled by k/k0 on the right, exact for any fixed tail.
    const [before, after] = [hatchTail(record.oldValue), hatchTail(value)];
    return before !== null && before === after;
  }
  if (record.attributeName === "class") {
    const [before, after] = [tokens(record.oldValue), tokens(value)];
    const changed = [...before]
      .filter(token => !after.has(token))
      .concat([...after].filter(token => !before.has(token)));
    // the scene draws a culled element even under display:none, so a co-present hiding class would make uncull visible
    return !after.has("hidden") && changed.every(token => NEUTRAL_CLASSES.has(token));
  }
  return false;
}

// Root <svg> children prepareFrame never rasterizes as screen overlays (mirrors ignoredRoot in prepare.ts).
const NOT_OVERLAY = new Set(["defs", "style", "title", "desc", "metadata", "script"]);

// The screen-space overlay (a root svg#map child outside #viewbox, e.g. #scaleBar) containing `node`, or null when
// the node is in the world, is the root itself, or is not under svg#map. Each such root is its own prepared compat
// screen batch, so a change inside it can refresh that batch alone.
export function overlayRoot(node: NodeLike | null): NodeLike | null {
  for (; node; node = node.parentElement) {
    const parent = node.parentElement;
    if (parent?.tagName?.toLowerCase() !== "svg" || parent.id !== "map") continue;
    return node.id === "viewbox" || NOT_OVERLAY.has(node.tagName?.toLowerCase() || "") ? null : node;
  }
  return null;
}

// World layers inside #viewbox whose whole content is redrawn from the camera at every settle (drawCoordinates removes
// and re-appends the graticule and its edge-pinned labels on each exact position change). Their churn is routed to
// the overlay lane with the layer as its root instead of a static revision; the lane answers "full" for a root the
// prepared frame cannot refresh in place, so nothing is ever dropped.
const VIEW_OVERLAYS = new Set(["coordinates"]);

export function viewOverlayRoot(node: NodeLike | null): NodeLike | null {
  for (; node; node = node.parentElement) {
    const parent = node.parentElement;
    if (parent?.id !== "viewbox") continue;
    return VIEW_OVERLAYS.has(node.id || "") ? node : null;
  }
  return null;
}

// The root <svg id=map> filter is not part of the prepared frame: the renderer forwards it as the canvas CSS filter
// (lifecycle.ts rootFilter) and compat rasters are cut without it (compat.ts rasterizeRun).
const ROOT_FILTER = new Set(["filter", "data-filter"]);
const rootFilterRecord = (record: MutationLike) =>
  record.type === "attributes" &&
  ROOT_FILTER.has(record.attributeName || "") &&
  record.target.tagName?.toLowerCase() === "svg" &&
  record.target.id === "map";

// Camera-owned #viewbox transform, records on nodes detached later in the batch (their parent's childList record covers
// them) and attribute writes that left the value unchanged.
function ignored(record: MutationLike): boolean {
  if (record.attributeName === "transform" && record.target.id === "viewbox") return true;
  if (record.target.isConnected === false) return true;
  return (
    record.type === "attributes" &&
    !!record.attributeName &&
    record.oldValue !== undefined &&
    !!record.target.getAttribute &&
    record.oldValue === record.target.getAttribute(record.attributeName)
  );
}

// The records classify() counts as pixel changes (static or overlay), each judged in its batch: what the compat reuse
// tracker (compat-reuse.ts) must see. Neutral decoration and transient marker records change no prepared pixel.
export function pixelRecords(records: ArrayLike<MutationLike>): MutationLike[] {
  const batch = Array.from(records);
  return batch.filter(record => !ignored(record) && !neutral(record, batch) && !transient(record));
}

// Records less those of the live marker pass (caravan groups added, removed or ticking): those change neither a
// prepared pixel nor the model, so the D13 net-change test (renderer.ts) must not count them. W3b PAINT.
export function withoutMarkerRecords<T extends MutationLike>(records: ArrayLike<T>): T[] {
  return Array.from(records).filter(record => !transient(record));
}

// "static" needs a full prepare; "overlay" only a refresh of the screen batches passed to `overlay`; "dynamic" only a
// redraw of the marker pass; "none" changes no prepared pixel. Precedence: static > overlay > dynamic > none. Without
// an `overlay` callback overlay changes stay static. The #viewbox transform is camera-owned, and records on nodes
// detached later in the same batch are covered by their parent's childList record. `neutral` counts records skipped
// as pixel-neutral decoration (telemetry).
export function classify(
  records: ArrayLike<MutationLike>,
  found?: (record: MutationLike) => void,
  skipped?: (record: MutationLike) => void,
  overlay?: (root: NodeLike) => void
): "none" | "dynamic" | "overlay" | "static" {
  let change: "none" | "dynamic" | "overlay" = "none";
  const batch = Array.from(records);
  for (const record of batch) {
    if (ignored(record)) continue;
    if (neutral(record, batch)) {
      skipped?.(record);
      continue;
    }
    if (!transient(record)) {
      const root = overlay && (overlayRoot(record.target) ?? viewOverlayRoot(record.target));
      if (!root) {
        found?.(record);
        return "static";
      }
      overlay(root);
      change = "overlay";
      continue;
    }
    if (change === "none") change = "dynamic";
  }
  return change;
}

export interface MarkerRun {
  first: number;
  count: number;
  texture: TrackedTexture;
}

export interface MarkerInstances {
  data: Float32Array;
  count: number;
  runs: MarkerRun[];
}

export interface MarkerElementLike {
  tagName: string;
  getAttribute(name: string): string | null;
  children: ArrayLike<MarkerElementLike>;
}

const effects = ["filter", "clip-path", "mask", "opacity"];
const effectStyle = /(?:^|;)\s*(filter|clip-path|mask|opacity)\s*:/i;
const effect = (element: MarkerElementLike) =>
  effects.find(name => element.getAttribute(name) !== null) ??
  effectStyle.exec(element.getAttribute("style") || "")?.[1];

// Why a live marker group cannot be mirrored exactly by the instanced pass (null when it can). The D3 controller
// writes one <use> of a known symbol plus an invisible hit circle; anything else must show the SVG, not vanish.
// `transform` is the group's current pose (its attribute unless the controller holds a newer one).
export function markerIssue(group: MarkerElementLike, transform = group.getAttribute("transform")): string | null {
  if (!parseTransform(transform)) return "marker transform unparsable";
  const own = effect(group);
  if (own) return `marker group ${own}`;
  for (const child of Array.from(group.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === "circle") {
      // fill defaults to black, stroke to none
      if (child.getAttribute("fill") !== "none" || (child.getAttribute("stroke") ?? "none") !== "none")
        return "painted marker circle";
      continue;
    }
    if (tag !== "use") return `marker child <${tag}>`;
    const href = child.getAttribute("href") ?? child.getAttribute("xlink:href");
    if (!markerKind(href)) return `marker symbol ${href || "(none)"}`;
    if (!parseTransform(child.getAttribute("transform"))) return "marker <use> transform unparsable";
    const used = effect(child);
    if (used) return `marker <use> ${used}`;
  }
  return null;
}

const number = (element: Element, name: string) => Number(element.getAttribute(name) || 0);

export class TradeMarkers {
  private data = new Float32Array(64 * MARKER_FLOATS);
  private textures = new Map<Kind, TrackedTexture | "loading">();
  private token = 0;
  count = 0;
  issue: string | null = null;

  constructor(
    private device: GpuDevice,
    private ready: () => void,
    private failed: (reason: string) => void
  ) {}

  get pending(): boolean {
    return [...this.textures.values()].some(value => value === "loading");
  }

  // Reads the live D3 groups in DOM order; consecutive markers of one kind share a run (one instanced draw). A group
  // the pass cannot mirror sets `issue` (the caller falls back to SVG) instead of being skipped silently.
  collect(root: Element | null): MarkerInstances | null {
    this.count = 0;
    this.issue = null;
    if (!root) return null;
    const base = parseTransform(root.getAttribute("transform"));
    if (!base) {
      this.issue = "trade layer transform unparsable";
      return null;
    }
    const runs: MarkerRun[] = [];
    for (const group of root.children) {
      // PAN (W4a): a caravan that ended during a GPU gesture stays in the DOM until the gesture ends, no longer drawn
      if (group.tagName !== "g" || group.getAttribute("display") === "none" || caravanEnded(group)) continue;
      const transform = caravanTransform(group);
      this.issue = markerIssue(group, transform);
      if (this.issue) return null;
      const outer = parseTransform(transform)!;
      for (const use of group.children) {
        if (use.tagName !== "use") continue;
        const texture = this.texture(markerKind(use.getAttribute("href") ?? use.getAttribute("xlink:href"))!);
        const inner = parseTransform(use.getAttribute("transform"))!;
        if (!texture) continue; // still loading: `pending` hides the frame
        if ((this.count + 1) * MARKER_FLOATS > this.data.length) {
          const grown = new Float32Array(this.data.length * 2);
          grown.set(this.data);
          this.data = grown;
        }
        const box = {
          x: number(use, "x"),
          y: number(use, "y"),
          width: number(use, "width"),
          height: number(use, "height")
        };
        if (!writeMarker(this.data, this.count * MARKER_FLOATS, multiply(multiply(base, outer), inner), box)) continue;
        const last = runs[runs.length - 1];
        if (last?.texture === texture) last.count++;
        else runs.push({ first: this.count, count: 1, texture });
        this.count++;
      }
    }
    return this.count ? { data: this.data, count: this.count, runs } : null;
  }

  private texture(kind: Kind): TrackedTexture | null {
    const state = this.textures.get(kind);
    if (state === "loading") return null;
    if (state) return state;
    const symbol = document.getElementById(`trade-marker-${kind}`);
    if (symbol) void this.load(kind, symbol); // a missing symbol (still fetching) is retried next frame
    return null;
  }

  private async load(kind: Kind, symbol: Element): Promise<void> {
    this.textures.set(kind, "loading");
    const token = this.token;
    try {
      const source = await decodeSvg(symbolMarkup(symbol, TEXTURE_SIZE), TEXTURE_SIZE, TEXTURE_SIZE);
      if (token !== this.token || this.device.lost || this.device.disposed) return;
      const texture = this.device.texture(`trade marker ${kind}`, source, { mipmap: true, premultiply: true });
      this.textures.set(kind, texture);
      this.ready();
    } catch (error) {
      if (token !== this.token || this.device.lost || this.device.disposed) return;
      this.textures.delete(kind);
      this.failed(`Trade marker ${kind} texture failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Context loss: handles are already gone with the context; pending decodes are discarded, textures reload lazily.
  forget(): void {
    this.textures.clear();
    this.token++;
    this.count = 0;
  }

  // World replace / dispose: free textures and drop references.
  release(): void {
    for (const state of this.textures.values()) if (state !== "loading") this.device.release(state);
    this.forget();
  }
}

// Standalone SVG of a <symbol> (viewBox + content) for rasterization at a fixed size.
function symbolMarkup(symbol: Element, size: number): string {
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  for (const name of ["viewBox", "preserveAspectRatio"])
    if (symbol.hasAttribute(name)) svg.setAttribute(name, symbol.getAttribute(name)!);
  for (const child of symbol.childNodes) svg.appendChild(child.cloneNode(true));
  return new XMLSerializer().serializeToString(svg);
}
