import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bisectorDistance,
  classifyClick,
  cohortGate,
  compareSelections,
  inEdgeBand,
  mulberry32,
  normalizeGpu,
  planViews,
  REQUIRED,
  selectDiagnostics,
  tally
} from "./picking-oracle.ts";

const node = (tag: string, id = "", dataId?: string) => ({ tag, id, ...(dataId !== undefined ? { dataId } : {}) });
const svgRoot = [node("g", "viewbox"), node("svg", "map")];
const none = { available: false };

test("classifyClick follows clicked() branch order", () => {
  const label = { chain: [node("tspan"), node("textPath"), node("text", "stateLabel3"), node("g", "states"), node("g", "labels")], textId: "stateLabel3" };
  assert.deepEqual(classifyClick(label, none), { kind: "label", id: "stateLabel3", branch: "labels" });
  const burgLabel = { chain: [node("text", "burgLabel5", "5"), node("g", "town"), node("g", "burgLabels"), ...svgRoot] };
  assert.deepEqual(classifyClick(burgLabel, none), { kind: "burg", id: "5", branch: "burgLabels" });
  const river = { chain: [node("path", "river2"), node("g", "rivers"), ...svgRoot, node("body")] };
  assert.equal(classifyClick(river, none).kind, "river");
  const marker = { chain: [node("path"), node("g"), node("svg", "marker7"), node("g", "markers"), node("g", "viewbox")], closestSvgId: "marker7" };
  assert.deepEqual(classifyClick(marker, none), { kind: "marker", id: "marker7", branch: "markers" });
});

test("selectDiagnostics caps each mismatch class and skips agreement", () => {
  const burgLabel = (id: string) => ({ kind: "burg" as const, id, branch: "burgLabels" });
  const marker = (id: string) => ({ kind: "marker" as const, id, branch: "markers" });
  const ocean = { kind: "none" as const, id: "", branch: "none" };
  const rows = [
    { expected: burgLabel("1"), actual: burgLabel("1") },
    ...Array.from({ length: 7 }, (_, i) => ({ expected: burgLabel("1"), actual: burgLabel(String(i + 2)) })),
    { expected: burgLabel("1"), actual: ocean },
    { expected: marker("marker1"), actual: burgLabel("3") },
    { expected: { kind: "route" as const, id: "route1", branch: "routes" }, actual: burgLabel("4") },
    { expected: marker("marker2"), actual: marker("marker3") },
    { expected: { kind: "label" as const, id: "stateLabel1", branch: "labels" }, actual: ocean }
  ];
  const out = selectDiagnostics(rows, 5);
  assert.equal(out["burgLabel-wrong"].length, 5);
  assert.equal(out["burgLabel-missing"].length, 1);
  assert.deepEqual(out["burgLabel-wrongInto"].map(r => r.expected.id), ["route1"]);
  assert.deepEqual(out.marker.map(r => r.actual.id), ["3", "marker3"]);
  assert.equal(out.label.length, 1);
});

test("classifyClick consults pickBurg before pickRelief only when no DOM branch matched", () => {
  const ocean = { chain: [node("rect"), node("g", "oceanBase"), node("g", "ocean"), ...svgRoot] };
  assert.deepEqual(classifyClick(ocean, { available: true, burg: 12, relief: "r" }), { kind: "burg", id: "12", branch: "pickBurg" });
  assert.equal(classifyClick(ocean, { available: true, burg: null, relief: "r" }).kind, "relief");
  assert.equal(classifyClick(ocean, { available: false, burg: 12 }).kind, "none");
  const short = { chain: [node("svg", "map"), node("body"), node("html"), null, null] };
  assert.equal(classifyClick(short, { available: true, burg: 3 }).branch, "no-ancestor");
});

test("normalizeGpu maps an index hit id to the editor selection", () => {
  const text = { chain: [node("text", "stateLabel3"), node("g", "states"), node("g", "labels"), ...svgRoot] };
  assert.deepEqual(normalizeGpu(text, "stateLabel3"), { kind: "label", id: "stateLabel3", branch: "labels" });
  const icon = { chain: [node("use", "burg5", "5"), node("g", "town"), node("g", "burgIcons"), ...svgRoot] };
  assert.equal(normalizeGpu(icon, "burg5").id, "5");
  assert.equal(normalizeGpu(null, "gone").branch, "unresolved-id");
  // an anonymous leaf (PickHit.depth) resolves to its [id] ancestor; the leaf's own id and parent decide the branch
  const ice = { chain: [node("g", "ice"), ...svgRoot] };
  assert.equal(normalizeGpu(ice, "ice").kind, "none");
  assert.deepEqual(normalizeGpu(ice, "ice", 1), { kind: "ice", id: "", branch: "ice" });
  const sea = { chain: [node("g", "sea_island"), node("g", "coastline"), ...svgRoot] };
  assert.deepEqual(normalizeGpu(sea, "sea_island", 1), { kind: "coastline", id: "", branch: "coastline" });
  assert.equal(normalizeGpu(null, "").kind, "none");
  const cult = { chain: [node("path", "culture1"), node("g", "cults"), ...svgRoot, node("body")] };
  assert.deepEqual(normalizeGpu(cult, "culture1"), { kind: "none", id: "culture1", branch: "non-selectable" });
});

test("compareSelections and tally separate missing, extra and wrong", () => {
  const burg = (id: string) => ({ kind: "burg" as const, id, branch: "x" });
  const nil = { kind: "none" as const, id: "q", branch: "x" };
  assert.equal(compareSelections(nil, nil), "agree-none");
  assert.equal(compareSelections(burg("1"), burg("1")), "agree");
  assert.equal(compareSelections(burg("1"), nil), "missing");
  assert.equal(compareSelections(nil, burg("1")), "extra");
  assert.equal(compareSelections(burg("1"), burg("2")), "wrong");
  const t = tally([
    { expected: burg("1"), actual: burg("1") },
    { expected: burg("1"), actual: nil },
    { expected: nil, actual: burg("2") },
    { expected: burg("1"), actual: burg("3") }
  ]);
  assert.deepEqual(t.burg, { expected: 3, agree: 1, missing: 1, wrong: 1, extra: 1, wrongInto: 1 });
});

test("bisectorDistance is the distance to the Voronoi edge", () => {
  assert.equal(bisectorDistance(1, 0, [0, 0], [4, 0]), 1);
  assert.equal(bisectorDistance(2, 5, [0, 0], [4, 0]), 0);
});

test("mulberry32 is deterministic and in [0,1)", () => {
  const a = mulberry32(7319),
    b = mulberry32(7319);
  for (let i = 0; i < 100; i++) {
    const value = a();
    assert.equal(value, b());
    assert.ok(value >= 0 && value < 1);
  }
});

test("cohortGate gates every cohort with n >= 50 and fails a short required cohort (D3)", () => {
  const t = (expected: number, agree: number, extra = 0, wrongInto = 0) => ({ expected, agree, missing: expected - agree, wrong: 0, extra, wrongInto });
  const kinds = { river: t(60, 60), route: t(49, 49, 1), marker: t(200, 199), relief: t(300, 290), lake: t(3, 3) };
  const { cohorts, failures } = cohortGate(kinds, { valid: true, settled: true, required: ["river", "route", "ice", "marker"] });
  assert.equal(cohorts.river.status, "pass");
  assert.equal(cohorts.route.n, 50); // expected + extra + wrongInto
  assert.equal(cohorts.route.status, "fail"); // 49/50 = 98%
  assert.equal(cohorts.marker.status, "pass"); // 199/200 = 99.5%
  assert.equal(cohorts.relief.status, "fail"); // not required, but n >= 50: gated
  assert.equal(cohorts.lake.status, "insufficient"); // not required: reported
  assert.equal(cohorts.ice.status, "insufficient");
  assert.deepEqual(failures.map(f => f.split(" ")[0]), ["route", "ice", "relief"]);
  const motion = cohortGate(kinds, { valid: true, settled: false, required: ["river"] });
  assert.equal(motion.cohorts.river.status, "reported");
  assert.deepEqual(motion.failures, []);
  const rejected = cohortGate(kinds, { valid: false, settled: true, required: ["river"] });
  assert.equal(rejected.cohorts.river.status, "rejected");
  assert.equal(rejected.failures.length, 1);
  assert.ok(REQUIRED.includes("regiment") && REQUIRED.includes("ice") && !REQUIRED.includes("route"));
});

test("planViews adds windows on the scarce kinds, clamped inside the map, deterministically", () => {
  const opts = { width: 1280, height: 720, mapWidth: 2000, mapHeight: 1000, need: 3, max: 4, kinds: ["river", "ice"] };
  const inventory: Record<string, [number, number][]> = {
    river: [[500, 300], [520, 310], [540, 320], [900, 500]],
    ice: [[1900, 50], [1880, 60], [1850, 80], [1990, 990]]
  };
  const views = planViews(inventory, [520, 300], 2, opts);
  assert.equal(views.length, 2); // rivers already seen in the primary view; one window for the ice cluster
  assert.deepEqual(views[0], [520, 300]);
  assert.deepEqual(views[1], [2000 - 320, 180]); // clamped: half a window (320 x 180 world at k 2) from the edges
  assert.deepEqual(planViews(inventory, [520, 300], 2, opts), views);
  // a kind with nothing on the map, or already enough, adds no view
  assert.equal(planViews({ river: inventory.river }, [520, 300], 2, { ...opts, kinds: ["river", "ice"] }).length, 1);
  assert.equal(planViews(inventory, [520, 300], 2, { ...opts, max: 1 }).length, 1);
});

test("normalizeGpu names the regiment <g> for any regiment leaf", () => {
  const regimentG = { chain: [node("g", "regiment3-2"), node("g", "army3"), node("g", "armies"), node("g", "viewbox"), node("svg", "map")] };
  assert.deepEqual(normalizeGpu(regimentG, "regiment3-2", 1), { kind: "regiment", id: "regiment3-2", branch: "armies" });
  const leaf = { chain: [node("rect"), node("g", "regiment3-2"), node("g", "army3"), node("g", "armies"), node("g", "viewbox")] };
  assert.deepEqual(classifyClick(leaf, { available: false }), { kind: "regiment", id: "regiment3-2", branch: "armies" });
});

test("inEdgeBand flags a sample whose clicked() outcome changes on the band circle", () => {
  const river = { chain: [node("path", "river2"), node("g", "rivers"), ...svgRoot, node("body")] };
  const route = { chain: [node("path", "route8"), node("g", "roads"), node("g", "routes"), ...svgRoot] };
  const leafA = { chain: [node("rect"), node("g", "regiment3-2"), node("g", "army3"), node("g", "armies"), node("g", "viewbox")] };
  const leafB = { chain: [node("text"), node("g", "regiment3-2"), node("g", "army3"), node("g", "armies"), node("g", "viewbox")] };
  const ocean = { chain: [node("rect", "oceanPattern"), node("g", "ocean"), ...svgRoot, node("body")] };
  assert.equal(inEdgeBand(river, null), false); // every probe hit the same element
  assert.equal(inEdgeBand(river, [route]), true);
  assert.equal(inEdgeBand(leafA, [leafB]), false); // another leaf of the same regiment: same editor
  assert.equal(inEdgeBand(river, [null]), true); // off the map
  assert.equal(inEdgeBand(ocean, [{ chain: [node("rect", "oceanBase"), node("g", "ocean"), ...svgRoot, node("body")] }]), false); // fallback both
});
