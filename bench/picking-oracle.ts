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
  if (ids[2] === "emblems") return { kind: "emblem", id: ids[1], branch: "emblems" };
  if (ids[1] === "ice") return { kind: "ice", id: el.id, branch: "ice" };
  if (within("coastline")) return { kind: "coastline", id: el.id, branch: "coastline" };
  if (within("lakes")) return { kind: "lake", id: el.id, branch: "lakes" };
  // positional, as clicked(): the regiment <g> is the painted leaf's parent, under g#army under #armies
  if (ids[3] === "armies") return { kind: "regiment", id: ids[1], branch: "armies" };
  if (ids[2] === "markets") return { kind: "market", id: "", branch: "markets" };
  if (ids[2] === "goodsIcons" || ids[1] === "goodsCells") return { kind: "goods", id: "", branch: "goodsIcons" };
  return { kind: "none", id: hitId, branch: "non-selectable" };
}

// Kinds whose ids identify the same object on both sides in the raw index (reported only, D3). Relief compares only as
// raw data (GPU boxes are keyed by symbol href, the click selects a <use> instance).
export const COMPARABLE: Kind[] = ["burg", "label", "marker", "river", "route", "ice", "regiment"];
// D3 (PHASE1-PLAN): the gate is the semantic outcome (window.gpuSelect against clicked()), for every cohort with at
// least MIN_COHORT meaningful samples. These cohorts must reach that size on the REQUIRED_WORLDS (packet PICK, W3);
// an insufficient required cohort fails the run instead of passing quietly. Routes are gated wherever n>=MIN_COHORT
// but not required: on the parity fixture the goods data layer covers almost every route.
export const REQUIRED: Kind[] = ["burg", "label", "marker", "river", "ice", "regiment"];
export const REQUIRED_WORLDS = ["parity", "shared"];
export const MIN_COHORT = 50;
export const MIN_RATE = 0.995;
// Edge band (disclosed, like the cell border band): a sample whose SVG outcome changes within EDGE_BAND_PX CSS px of it
// sits on a hit boundary that Blink itself only approximates (Skia's stroke hit outline is off the true offset curve by
// up to ~0.09 world units on curved routes and rivers; the index flattens curves to 0.01). Such samples are excluded
// from the cohort gate and reported separately, with a strict all-samples tally beside the gate.
export const EDGE_BAND_PX = 0.25;
export const EDGE_RING = 8; // probe directions on the band circle
// The band is gated too, at a looser rate, so it cannot hide a hit-shape regression smaller than the band: a GPU
// polygon 0.2 px too narrow or wide, or a thin element missing from the index, sends its mismatches into the band, and
// this floor catches them. Per world, every band sample together must agree at >= BAND_MIN_RATE, and every band cohort
// with n >= MIN_COHORT must too. Calibrated on picking-20261020T102047-287Z (Metal): bands 170/171, 294/298, 477/483;
// river band 83/83, 222/225, 346/351 (lowest 98.6%).
export const BAND_MIN_RATE = 0.97;

// What clicked()'s DOM branches make of one probe hit; canvas fallbacks collapse to one key (they are not vector edges).
export function ringKey(desc: ChainDesc | null): string {
  if (!desc) return "outside";
  const dom = domBranch(desc);
  return dom ? dom.kind + ":" + dom.id : "fallback";
}

// `ring` lists only the probe hits whose element differs from the centre's (null when all match).
export function inEdgeBand(centre: ChainDesc | null, ring: (ChainDesc | null)[] | null | undefined): boolean {
  if (!ring?.length) return false;
  const key = ringKey(centre);
  return ring.some(desc => ringKey(desc) !== key);
}

/** @deprecated protocol v2's raw-index gate; kept for readers of old reports */
export const GATED: Kind[] = ["burg", "label", "marker"];

export type CohortStatus = "pass" | "fail" | "insufficient" | "rejected" | "reported";
export interface CohortVerdict {
  n: number; // expected + extra + wrongInto: every sample where either side names this kind
  agree: number;
  rate: number | null;
  required: boolean;
  status: CohortStatus;
}

// Per-cohort verdicts for one world. `settled` false (motion probe) reports without gating; an invalid run (scene
// changed, GPU not ready, camera misaligned) rejects every cohort. Failures name the cohorts that sink the world.
export function cohortGate(
  kinds: Record<string, KindTally>,
  opts: { valid: boolean; settled: boolean; required: readonly string[] }
): { cohorts: Record<string, CohortVerdict>; failures: string[] } {
  const cohorts: Record<string, CohortVerdict> = {};
  const failures: string[] = [];
  const names = [...new Set([...opts.required, ...Object.keys(kinds)])].filter(kind => kind !== "none");
  for (const kind of names) {
    const t = kinds[kind];
    const n = t ? t.expected + t.extra + t.wrongInto : 0;
    const agree = t?.agree ?? 0;
    const rate = n ? agree / n : null;
    const required = opts.required.includes(kind);
    const status: CohortStatus = !opts.valid
      ? "rejected"
      : !opts.settled
        ? "reported"
        : n < MIN_COHORT
          ? "insufficient"
          : agree / n >= MIN_RATE
            ? "pass"
            : "fail";
    cohorts[kind] = { n, agree, rate, required, status };
    if (status === "rejected") continue;
    if (status === "fail") failures.push(`${kind} ${agree}/${n} = ${((100 * agree) / n).toFixed(2)}% < ${MIN_RATE * 100}%`);
    if (status === "insufficient" && required) failures.push(`${kind} n=${n} < ${MIN_COHORT}`);
  }
  if (!opts.valid) failures.push("rejected: scene changed or GPU not ready during sampling");
  return { cohorts, failures };
}

// The edge-band floor for one world: `all` counts every band sample (agree includes agree-none), `kinds` the band
// samples per cohort (tally). Same valid/settled rules as cohortGate; a band cohort below MIN_COHORT is reported only.
export function edgeBandGate(
  all: { n: number; agree: number },
  kinds: Record<string, KindTally>,
  opts: { valid: boolean; settled: boolean }
): { cohorts: Record<string, CohortVerdict>; failures: string[] } {
  const cohorts: Record<string, CohortVerdict> = {};
  const failures: string[] = [];
  if (!opts.valid) return { cohorts, failures };
  const gating = opts.settled;
  if (gating && all.n && all.agree / all.n < BAND_MIN_RATE)
    failures.push(`edge band ${all.agree}/${all.n} = ${((100 * all.agree) / all.n).toFixed(2)}% < ${BAND_MIN_RATE * 100}%`);
  for (const [kind, t] of Object.entries(kinds)) {
    if (kind === "none") continue;
    const n = t.expected + t.extra + t.wrongInto;
    const rate = n ? t.agree / n : null;
    const status: CohortStatus = !gating ? "reported" : n < MIN_COHORT ? "insufficient" : t.agree / n >= BAND_MIN_RATE ? "pass" : "fail";
    cohorts[kind] = { n, agree: t.agree, rate, required: false, status };
    if (status === "fail") failures.push(`edge band ${kind} ${t.agree}/${n} = ${((100 * t.agree) / n).toFixed(2)}% < ${BAND_MIN_RATE * 100}%`);
  }
  return { cohorts, failures };
}

// Camera centres (world units) for one world at zoom k: the primary centre first, then up to `max` views in all, each
// centred where the most not-yet-visible elements of the scarcest required kind sit, until every kind shows `need`
// elements (or all it has). Deterministic: candidates are scanned in inventory order. A view is a viewport-sized
// window shrunk by `margin` CSS px, clamped inside the map.
export function planViews(
  inventory: Record<string, [number, number][]>,
  primary: [number, number],
  k: number,
  opts: { width: number; height: number; mapWidth: number; mapHeight: number; need: number; max: number; margin?: number; kinds: readonly string[] }
): [number, number][] {
  const hw = opts.width / 2 / k,
    hh = opts.height / 2 / k,
    m = (opts.margin ?? 20) / k;
  const clamp = (v: number, half: number, size: number) => (size <= 2 * half ? size / 2 : Math.min(size - half, Math.max(half, v)));
  const inView = (c: [number, number], p: [number, number]) =>
    Math.abs(p[0] - c[0]) <= hw - m && Math.abs(p[1] - c[1]) <= hh - m;
  const views: [number, number][] = [primary];
  const seen = (kind: string) => (inventory[kind] ?? []).filter(p => views.some(v => inView(v, p)));
  const deficit = (kind: string) => Math.min(opts.need, (inventory[kind] ?? []).length) - seen(kind).length;
  const stuck = new Set<string>(); // no window shows any more of it (elements off the map)
  while (views.length < opts.max) {
    const short = opts.kinds.filter(kind => !stuck.has(kind) && deficit(kind) > 0);
    if (!short.length) break;
    const kind = short.reduce((a, b) => (deficit(b) > deficit(a) ? b : a));
    const hidden = (list: [number, number][]) => list.filter(p => !views.some(v => inView(v, p)));
    let best: [number, number] | null = null,
      score = 0;
    for (const p of hidden(inventory[kind] ?? []).slice(0, 400)) {
      const c: [number, number] = [clamp(p[0], hw, opts.mapWidth), clamp(p[1], hh, opts.mapHeight)];
      let s = 0;
      for (const other of short)
        s += (other === kind ? 1 : 0.1) * hidden(inventory[other] ?? []).filter(q => inView(c, q)).length;
      if (s > score) [best, score] = [c, s];
    }
    if (best) views.push(best);
    else stuck.add(kind);
  }
  return views;
}

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
  "ice",
  "river",
  "regiment",
  "emblem",
  "goods",
  "market",
  "lake",
  "relief",
  "other"
] as const;
export function diagnosticClass(expected: Selection, actual: Selection): (typeof DIAGNOSTIC_CLASSES)[number] | null {
  const outcome = compareSelections(expected, actual);
  if (outcome === "agree" || outcome === "agree-none") return null;
  if (expected.branch === "burgLabels") return outcome === "wrong" ? "burgLabel-wrong" : "burgLabel-missing";
  if (expected.kind === "marker") return "marker";
  if (actual.branch === "burgLabels") return "burgLabel-wrongInto";
  if (actual.kind === "marker") return "marker";
  if (expected.kind === "label" || actual.kind === "label") return "label";
  for (const kind of ["route", "coastline", "ice", "river", "regiment", "emblem", "goods", "market", "lake", "relief"] as const)
    if (expected.kind === kind || actual.kind === kind) return kind;
  return "other";
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
