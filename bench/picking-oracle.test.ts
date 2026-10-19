import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bisectorDistance,
  classifyClick,
  compareSelections,
  mulberry32,
  normalizeGpu,
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
