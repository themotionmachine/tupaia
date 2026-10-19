// Pure semantics for bench/picking-parity.ts. The browser only collects element descriptors; every classification
// happens here so the rules are unit-tested (picking-oracle.test.ts).

// One element of a hit chain: [target, parent, grand, great, ancestor] exactly as clicked() reads them.
export interface NodeDesc {
  tag: string;
  id: string;
  dataId?: string;
}

export interface ChainDesc {
  chain: (NodeDesc | null)[]; // index 0 = d3.event.target
  closestSvgId?: string; // target.closest("svg").id, what editMarker's getElement selects
  textId?: string; // tspan.parentNode.parentNode.id, what editLabel selects
  instance?: string; // a #terrain > use target as "(id)|href@x,y": which glyph editReliefIcon opens (protocol v2)
}

// Canvas-layer fallbacks clicked() consults at d3.mouse(viewbox) coordinates when no DOM branch matched.
export interface Fallback {
  available: boolean; // window.pickRelief exists
  burg?: number | null;
  relief?: string | null; // selected <use> descriptor
}

export type Kind =
  | "emblem"
  | "river"
  | "route"
  | "label"
  | "burg"
  | "ice"
  | "relief"
  | "marker"
  | "market"
  | "goods"
  | "coastline"
  | "lake"
  | "regiment"
  | "none";

export interface Selection {
  kind: Kind;
  id: string; // what the editor ends up selecting; "" when the editor reads the target only
  branch: string;
}

const NONE: Selection = { kind: "none", id: "", branch: "none" };

// Mirrors public/modules/ui/editors.js clicked() branch order. Keep in lockstep with that function.
export function classifyClick(desc: ChainDesc, fallback: Fallback): Selection {
  const dom = domBranch(desc);
  if (dom) return dom;
  if (fallback.available) {
    if (fallback.burg) return { kind: "burg", id: String(fallback.burg), branch: "pickBurg" };
    if (fallback.relief) return { kind: "relief", id: fallback.relief, branch: "pickRelief" };
  }
  return NONE;
}

// Whether clicked() would consult its canvas fallbacks for this hit (protocol v2 queries them only then).
export function needsFallback(desc: ChainDesc | null): boolean {
  return !!desc && !domBranch(desc);
}

// The DOM branches of clicked(); null = none matched (fallbacks next). "no-ancestor" returns before any fallback.
export function domBranch(desc: ChainDesc): Selection | null {
  const [el, parent, grand, great, ancestor] = desc.chain;
  if (!el || !ancestor || !parent || !grand || !great) return { ...NONE, branch: "no-ancestor" };
  if (grand.id === "emblems") return { kind: "emblem", id: parent.id, branch: "emblems" };
  if (parent.id === "rivers") return { kind: "river", id: el.id, branch: "rivers" };
  if (grand.id === "routes") return { kind: "route", id: el.id, branch: "routes" };
  if (ancestor.id === "labels" && el.tag === "tspan") return { kind: "label", id: desc.textId || "", branch: "labels" };
  if (grand.id === "burgLabels") return { kind: "burg", id: el.dataId || "", branch: "burgLabels" };
  if (grand.id === "burgIcons") return { kind: "burg", id: el.dataId || "", branch: "burgIcons" };
  if (parent.id === "ice") return { kind: "ice", id: el.id, branch: "ice" };
  if (parent.id === "terrain") return { kind: "relief", id: desc.instance ?? el.id, branch: "terrain" };
  if (grand.id === "markers" || great.id === "markers")
    return { kind: "marker", id: desc.closestSvgId || "", branch: "markers" };
  if (grand.id === "markets" && el.tag !== "path") return { kind: "market", id: parent.dataId || "", branch: "markets" };
  if (grand.id === "goodsIcons") return { kind: "goods", id: "", branch: "goodsIcons" };
  if (parent.id === "goodsCells") return { kind: "goods", id: "", branch: "goodsCells" };
  if (grand.id === "goodsBurgs") return { kind: "market", id: parent.dataId || "", branch: "goodsBurgs" };
  if (grand.id === "coastline") return { kind: "coastline", id: el.id, branch: "coastline" };
  if (grand.id === "lakes") return { kind: "lake", id: el.id, branch: "lakes" };
  if (great.id === "armies") return { kind: "regiment", id: parent.id, branch: "armies" };
  return null;
}

// Scene fingerprint taken around each sampling pass (protocol v2). A run is valid only if nothing structural changed.
export interface SceneProbe {
  regime: "compact" | "materialized" | "none";
  terrainHash: string;
  terrainChildren: number;
  revision: number; // relief-canvas render/materialize revision (window.reliefRevision)
  prepared: number; // GPU prepared-scene generation (identity changes counted in page)
  preparedRevision: number; // source revision the prepared scene was built from
  sourceRevision: number; // renderer source revision (rendererStatus().gpu.revision)
  pickIndex: number; // prepared PickIndex identity (counted in page like `prepared`)
  camera: string; // exact #viewbox transform and the scale/viewX/viewY globals
  layout: string; // #map client rect and the window size
}

// Observer records over #map (subtree): every kind invalidates a run, attribute and text edits included, since font,
// radius, display, pointer-events or geometry changes move hit areas without adding or removing a node.
export interface MutationCounts {
  childList: number;
  attributes: number;
  characterData: number;
}

const probeKeys = [
  "regime",
  "terrainHash",
  "terrainChildren",
  "revision",
  "prepared",
  "preparedRevision",
  "sourceRevision",
  "pickIndex",
  "camera",
  "layout"
] as const;

export function sceneChanges(
  before: SceneProbe,
  after: SceneProbe,
  mutations: MutationCounts,
  pickReliefCalls: number
): string[] {
  const out: string[] = [];
  for (const key of probeKeys) if (before[key] !== after[key]) out.push(`${key}: ${before[key]} -> ${after[key]}`);
  for (const kind of ["childList", "attributes", "characterData"] as const)
    if (mutations[kind]) out.push(`${kind} mutations: ${mutations[kind]}`);
  if (pickReliefCalls) out.push(`pickRelief (committing) calls: ${pickReliefCalls}`);
  return out;
}

// The GPU index returns the nearest [id] of the painted element (prepare.ts pickId). Normalization resolves that id to
// the DOM element and then asks which editor selection it denotes. It is deliberately not classifyClick: the GPU hit
// is a <text>, not a tspan, so reusing the click rule would hide label hits rather than test them. `depth` > 0
// (PickHit.depth): the painted leaf is anonymous, that many steps below the resolved element (selection.ts).
export function normalizeGpu(desc: ChainDesc | null, hitId: string, depth = 0): Selection {
  if (!desc || !desc.chain[0]) return hitId ? { kind: "none", id: hitId, branch: "unresolved-id" } : NONE;
  const ids = [...Array.from({ length: depth }, () => ""), ...desc.chain.map(node => node?.id || "")];
  const el = { id: ids[0] };
  const within = (id: string) => ids.includes(id);
  if (within("burgLabels") || within("burgIcons")) {
    const dataId = desc.chain.find(node => node?.dataId)?.dataId || "";
    return { kind: "burg", id: dataId, branch: within("burgLabels") ? "burgLabels" : "burgIcons" };
  }
  if (within("labels")) {
    const text = desc.chain.find(node => node?.tag === "text");
    return { kind: "label", id: text?.id || "", branch: "labels" };
  }
  if (within("markers")) return { kind: "marker", id: desc.closestSvgId || "", branch: "markers" };
  if (ids[1] === "rivers") return { kind: "river", id: el.id, branch: "rivers" };
  if (within("routes")) return { kind: "route", id: el.id, branch: "routes" };
  if (within("terrain")) return { kind: "relief", id: el.id, branch: "terrain" };
  if (within("emblems")) return { kind: "emblem", id: "", branch: "emblems" };
  if (ids[1] === "ice") return { kind: "ice", id: el.id, branch: "ice" };
  if (within("coastline")) return { kind: "coastline", id: el.id, branch: "coastline" };
  if (within("lakes")) return { kind: "lake", id: el.id, branch: "lakes" };
  return { kind: "none", id: hitId, branch: "non-selectable" };
}

// Kinds whose ids identify the same object on both sides. Relief compares only as raw data (GPU boxes are keyed by
// symbol href, the click selects a <use> instance), and the rest have no GPU index entries to compare.
export const COMPARABLE: Kind[] = ["burg", "label", "marker", "river", "route"];
export const GATED: Kind[] = ["burg", "label", "marker"];

export type Outcome = "agree" | "missing" | "extra" | "wrong" | "agree-none";

export function compareSelections(expected: Selection, actual: Selection): Outcome {
  const e = expected.kind === "none" ? "" : expected.kind + ":" + expected.id;
  const a = actual.kind === "none" ? "" : actual.kind + ":" + actual.id;
  if (!e && !a) return "agree-none";
  if (e === a) return "agree";
  if (!a) return "missing";
  if (!e) return "extra";
  return "wrong";
}

// Distance from p to the Voronoi edge between its nearest site s1 and runner-up s2 (exact for Voronoi cells).
export function bisectorDistance(px: number, py: number, s1: [number, number], s2: [number, number]): number {
  const dx = s2[0] - s1[0],
    dy = s2[1] - s1[1];
  const length = Math.hypot(dx, dy);
  if (!length) return 0;
  const d1 = (px - s1[0]) ** 2 + (py - s1[1]) ** 2;
  const d2 = (px - s2[0]) ** 2 + (py - s2[1]) ** 2;
  return (d2 - d1) / (2 * length);
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface KindTally {
  expected: number; // samples the SVG oracle selects this kind for
  agree: number;
  missing: number;
  wrong: number;
  extra: number; // GPU selects this kind, SVG selects nothing
  wrongInto: number; // GPU selects this kind, SVG selects a different object
}

// Representative semantic mismatches for the pretty .diagnostics.json: the first `per` rows of each class, in sample
// order (deterministic under the frozen seeds). An expected marker is a marker row whatever the GPU named; otherwise
// wrongInto = the GPU names a burg label the SVG does not. Route, coastline and ice rows (either side) follow.
export const DIAGNOSTIC_CLASSES = [
  "burgLabel-wrong",
  "burgLabel-missing",
  "burgLabel-wrongInto",
  "marker",
  "label",
  "route",
  "coastline",
  "ice"
] as const;
export function diagnosticClass(expected: Selection, actual: Selection): (typeof DIAGNOSTIC_CLASSES)[number] | null {
  const outcome = compareSelections(expected, actual);
  if (outcome === "agree" || outcome === "agree-none") return null;
  if (expected.branch === "burgLabels") return outcome === "wrong" ? "burgLabel-wrong" : "burgLabel-missing";
  if (expected.kind === "marker") return "marker";
  if (actual.branch === "burgLabels") return "burgLabel-wrongInto";
  if (actual.kind === "marker") return "marker";
  if (expected.kind === "label" || actual.kind === "label") return "label";
  for (const kind of ["route", "coastline", "ice"] as const) if (expected.kind === kind || actual.kind === kind) return kind;
  return null;
}
export function selectDiagnostics<T extends { expected: Selection; actual: Selection }>(rows: T[], per = 5) {
  const out: Record<string, T[]> = Object.fromEntries(DIAGNOSTIC_CLASSES.map(name => [name, []]));
  for (const row of rows) {
    const name = diagnosticClass(row.expected, row.actual);
    if (name && out[name].length < per) out[name].push(row);
  }
  return out;
}

export function tally(rows: { expected: Selection; actual: Selection }[]): Record<string, KindTally> {
  const out: Record<string, KindTally> = {};
  const get = (kind: string) =>
    (out[kind] ??= { expected: 0, agree: 0, missing: 0, wrong: 0, extra: 0, wrongInto: 0 });
  for (const { expected, actual } of rows) {
    const outcome = compareSelections(expected, actual);
    if (expected.kind !== "none") {
      const t = get(expected.kind);
      t.expected++;
      if (outcome === "agree") t.agree++;
      else if (outcome === "missing") t.missing++;
      else if (outcome === "wrong") t.wrong++;
    }
    if (actual.kind !== "none" && outcome === "extra") get(actual.kind).extra++;
    if (actual.kind !== "none" && outcome === "wrong") get(actual.kind).wrongInto++;
  }
  return out;
}
