// Editor selection preview from the GPU pick, without SVG hit testing: the PickIndex hit (nearest [id] of the painted
// element) is resolved to its DOM element and classified like public/modules/ui/editors.js clicked(). When the hit
// selects nothing (no hit, a layer clicked() has no branch for, or an id with no element), the same canvas fallbacks
// clicked() consults run at the GPU camera's world point: pickBurg, then the relief query. A relief sprite with no
// element is never a terrain-branch target by itself: the compact relief raster is click-through (pointer-events none),
// so SVG reaches the fallbacks there too. Read-only: the relief leg is peekRelief, which returns a descriptor and
// never materializes <use> glyphs; an editor commit (pickRelief/commitRelief) is the caller's step. The fallback legs
// are the same page functions the click path uses, so agreement through them is shared by construction.
// Not wired to clicks.
import type { PickHit } from "./pick";
import { glyphKey } from "./relief-pick";

export type SelectionKind =
  | "emblem"
  | "river"
  | "route"
  | "label"
  | "burg"
  | "ice"
  | "relief"
  | "marker"
  | "coastline"
  | "lake"
  | "regiment"
  | "none";

// A relief glyph before commit (relief-canvas.ts ReliefPeek): its index in the raster data and its href@x,y key.
export interface ReliefCandidate {
  index: number;
  key: string;
}

// A #terrain pick instance as prepared: href, child index and why its href is boxed (null when supported).
export interface GlyphInfo {
  index: number;
  href: string;
  reason: string | null;
}

export interface GpuSelection {
  glyph?: GlyphInfo | null; // diagnostics of a terrain/terrain-unsupported index hit; never decides the selection
  kind: SelectionKind;
  id: string;
  branch: string;
  via: "index" | "pickBurg" | "pickRelief" | "none";
  target: Element | null; // the existing element the editor would open; null for a relief glyph not yet committed
  relief: ReliefCandidate | null; // the uncommitted relief glyph (via pickRelief)
  hit: PickHit | null; // raw index hit, unchanged
  world: [number, number] | null;
  unavailable?: string; // why the index could not answer (branch "unavailable"); never a legitimate empty hit
}

export interface SelectionSources {
  // Why the prepared index cannot answer for the current source and camera (renderer.pickStatus), null when it can.
  // Checked first and synchronously with the pick, so an unavailable index never reaches pickBurg/peekRelief.
  unavailable?: () => string | null;
  pick(x: number, y: number, tolerance: number): PickHit | null;
  world(x: number, y: number): [number, number] | null;
  element(id: string): Element | null;
  // the live #terrain <use> of a pick instance, null when unresolved or stale (renderer.glyphAt)
  glyph?: (hit: PickHit) => Element | null;
  // the live anonymous leaf of a depth > 0 hit under its resolved [id] ancestor (PickHit.path), null when unresolved
  leaf?: (hit: PickHit, ancestor: Element) => Element | null;
  glyphInfo?: (hit: PickHit) => GlyphInfo | null; // prepared-data diagnostics (renderer.glyphInfo)
  // clicked() consults its fallbacks only when window.pickRelief exists
  fallbacks: boolean;
  pickBurg?: (x: number, y: number) => number | null | undefined;
  peekRelief?: (x: number, y: number) => ReliefCandidate | null;
}

type Classified = Pick<GpuSelection, "kind" | "id" | "branch">;

// Which clicked() branch the index element denotes. The index stores the element itself (a <text>, not the tspan
// clicked() receives), so the branch is found by ancestry rather than by clicked()'s fixed target depth. `depth` > 0:
// the painted leaf is an anonymous descendant `depth` steps below `element` (PickHit.depth), so the leaf's own id ("")
// and parent decide id-at-depth branches (an anonymous #ice polygon is ice, a coastline path has id "").
export function classifyElement(element: Element, depth = 0): Classified | null {
  const ids: string[] = Array.from({ length: depth }, () => "");
  for (let node: Element | null = element; node; node = node.parentElement) ids.push(node.id);
  const leafId = ids[0];
  const within = (id: string) => ids.includes(id);
  const dataId = (): string => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const value = node.getAttribute("data-id");
      if (value !== null) return value;
    }
    return "";
  };
  if (within("burgLabels")) return { kind: "burg", id: dataId(), branch: "burgLabels" };
  if (within("burgIcons")) return { kind: "burg", id: dataId(), branch: "burgIcons" };
  if (within("labels")) return { kind: "label", id: element.closest("text")?.id ?? "", branch: "labels" };
  if (within("markers")) return { kind: "marker", id: element.closest("svg")?.id ?? "", branch: "markers" };
  if (ids[1] === "rivers") return { kind: "river", id: leafId, branch: "rivers" };
  if (within("routes")) return { kind: "route", id: leafId, branch: "routes" };
  if (within("terrain")) return { kind: "relief", id: leafId, branch: "terrain" };
  if (within("emblems")) return { kind: "emblem", id: element.parentElement?.id ?? "", branch: "emblems" };
  if (ids[1] === "ice") return { kind: "ice", id: leafId, branch: "ice" };
  if (within("coastline")) return { kind: "coastline", id: leafId, branch: "coastline" };
  if (within("lakes")) return { kind: "lake", id: leafId, branch: "lakes" };
  if (within("armies")) return { kind: "regiment", id: element.parentElement?.id ?? "", branch: "armies" };
  return null;
}

function ancestorAt(element: Element, steps: number): Element | null {
  let node: Element | null = element;
  for (let k = 0; k < steps && node; k++) node = node.parentElement;
  return node;
}

const sameClass = (a: Classified | null, b: Classified) =>
  !!a && a.kind === b.kind && a.id === b.id && a.branch === b.branch;

// x, y: SVG-local CSS px (the gpuPick convention).
export function selectAt(sources: SelectionSources, x: number, y: number, tolerance = 0): GpuSelection {
  const unavailable = sources.unavailable?.() ?? null;
  if (unavailable !== null) {
    const none = { kind: "none", id: "", branch: "unavailable", via: "none", unavailable } as const;
    return { ...none, target: null, relief: null, hit: null, world: null };
  }
  const hit = sources.pick(x, y, tolerance);
  const world = sources.world(x, y);
  const element = hit?.id ? sources.element(hit.id) : null;
  const direct = element ? classifyElement(element, hit?.depth) : null;
  const base = { target: null, relief: null, hit, world };
  // An anonymous leaf (hit.depth) is indexed under its [id] ancestor: the branch and id are the leaf's. The target is
  // the live leaf found by the hit's child-index path, re-checked here: exactly `depth` steps below the ancestor and
  // classified the same. Anything else (no path, DOM moved) leaves the target null rather than handing the editor
  // the ancestor or a sibling.
  if (direct && hit?.depth && direct.branch !== "terrain") {
    const leaf = sources.leaf?.(hit, element!) ?? null;
    const ok = leaf && ancestorAt(leaf, hit.depth) === element && sameClass(classifyElement(leaf), direct);
    return { ...direct, ...base, via: "index", target: ok ? leaf : null };
  }
  // A materialized relief glyph (an id-less <use>, indexed under the #terrain group): clicked()'s terrain branch,
  // ahead of the fallbacks. An exact pick instance resolved to its live <use> is the target, keyed like
  // editReliefIcon's "(id)|href@x,y"; otherwise (unsupported symbol, stale index) the hit is reported unsupported
  // rather than given the group as a target or passed through.
  const glyph = direct?.branch === "terrain" && (!direct.id || element!.id === "terrain");
  if (direct && !glyph) return { ...direct, ...base, via: "index", target: element };
  if (glyph || (hit?.layer === "terrain" && !element)) {
    const use = hit && hit.instance !== undefined ? (sources.glyph?.(hit) ?? null) : null;
    const info = hit && hit.instance !== undefined ? (sources.glyphInfo?.(hit) ?? null) : null;
    if (use)
      return { ...base, kind: "relief", id: glyphKey(use), branch: "terrain", via: "index", target: use, glyph: info };
    return { ...base, kind: "relief", id: "", branch: "terrain-unsupported", via: "index", glyph: info };
  }
  if (world && sources.fallbacks) {
    const burg = sources.pickBurg?.(world[0], world[1]);
    if (burg) return { ...base, kind: "burg", id: String(burg), branch: "pickBurg", via: "pickBurg" };
    const relief = sources.peekRelief?.(world[0], world[1]) ?? null;
    if (relief) return { ...base, kind: "relief", id: relief.key, branch: "pickRelief", via: "pickRelief", relief };
  }
  return {
    ...base,
    kind: "none",
    id: hit?.id ?? "",
    branch: !hit ? "none" : element ? "non-selectable" : "unresolved-id",
    via: "none"
  };
}
