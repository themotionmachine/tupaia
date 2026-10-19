import assert from "node:assert/strict";
import fs from "node:fs";
import {test} from "node:test";

const mutations = fs.readFileSync(new URL("../src/bridge-mutations.js", import.meta.url), "utf8");
const bridge = fs.readFileSync(new URL("../src/bridge.js", import.meta.url), "utf8");
const paintSource = mutations.slice(mutations.indexOf("  function paintTerritory("), mutations.indexOf("  function featureSummary()"));
const redrawSource = bridge.slice(bridge.indexOf("  const REDRAW_ORDER"), bridge.indexOf("  /** JSON-safe copy"));

function fixture(existingLabels = [1, 2]) {
  const pack = {
    cells: {
      h: [30, 30, 30, 30, 30, 10], state: [1, 1, 2, 3, 3, 1], province: [1, 1, 2, 3, 2, 1],
      burg: [0, 0, 0, 0, 1, 0]
    },
    states: [{i: 0}, {i: 1, center: 0}, {i: 2, center: 2}, {i: 3, center: 3}],
    provinces: [{i: 0}, {i: 1, state: 1, center: 0}, {i: 2, state: 2, center: 2}, {i: 3, state: 3, center: 3}],
    burgs: [{i: 0}, {i: 1, cell: 4, capital: 1}]
  };
  const plans: Array<{layer: string; ids?: number[]}> = [];
  const paint = new Function("pack", "nameFor", "isLive", "States", "Provinces", "document", `${paintSource}; return paintApply;`)(
    pack, (key: string, id: number) => `${key}${id}`, (x: {removed?: boolean}) => !!x && !x.removed,
    {collectStatistics() {}, getPoles() {}}, {getPoles() {}},
    {getElementById: (id: string) => existingLabels.some(n => id === `stateLabel${n}`) ? {x: 99, y: 42} : null}
  );
  const context = {
    R: {add(layer: string, ids?: number[]) {plans.push({layer, ids});}},
    internals: {adjustProvinces() {}}
  };
  return {pack, plans, paint, context};
}

test("state painting redraws source and destination entities, preserves labels, skips protected cells", async () => {
  const f = fixture();
  const result = await f.paint({cells: [0, 1, 2, 4, 5], state: 2}, true, f.context);
  assert.equal(result.state.changed, 1);
  assert.deepEqual(result.state.skipped, {stateCenter: 1, unchanged: 1, capital: 1, water: 1});
  assert.deepEqual(f.plans, [
    {layer: "states", ids: [1, 2]}, {layer: "borders", ids: [1, 2]}, {layer: "provinces", ids: [1]}
  ]);
  assert.equal(f.pack.cells.state[1], 2);
});
test("state painting requests only missing labels", async () => {
  const f = fixture([1]);
  await f.paint({cells: [1], state: 2}, true, f.context);
  assert.deepEqual(f.plans.at(-1), {layer: "stateLabels", ids: [2]});
});
test("province painting tracks old and new provinces and the owning state", async () => {
  const f = fixture();
  f.pack.provinces.push({i: 4, state: 1, center: 4});
  await f.paint({cells: [1], province: 4}, true, f.context);
  assert.deepEqual(f.plans, [{layer: "borders", ids: [1]}, {layer: "provinces", ids: [1, 4]}]);
});
test("no-op and validation painting schedule no redraw and mutate nothing", async () => {
  const f = fixture(), original = structuredClone(f.pack);
  await f.paint({cells: [1], state: 1}, true, f.context);
  await f.paint({cells: [1], state: 2}, false, f.context);
  assert.deepEqual(f.pack, original);
  assert.deepEqual(f.plans, []);
});
test("coalescing unions dirty IDs and full requests override selective requests", () => {
  const coalesce = new Function("fail", `${redrawSource}; return coalesceRedraws;`)((code: string) => {throw Error(code);});
  assert.deepEqual(coalesce([{layer: "states", ids: [2, 1]}, {layer: "states", ids: [2, 3]}, {layer: "borders", ids: [1]}]),
    [{layer: "states", ids: [1, 2, 3]}, {layer: "borders", ids: [1]}]);
  assert.deepEqual(coalesce([{layer: "states", ids: [2]}, "states"]), [{layer: "states"}]);
});

test("bridge forwards coalesced entity IDs to state, province and border renderers", async () => {
  const calls: Array<[string, number[]]> = [];
  const root = Object.fromEntries(["States", "Provinces", "Borders"].map(name =>
    [`draw${name}`, (ids: number[]) => calls.push([name, ids])]));
  const runtime = bridge.slice(bridge.indexOf("  const REDRAW ="), bridge.indexOf("  FNS.redraw ="));
  const redraw = new Function("root", "pack", "fail", "layerIsOn", "raf2", `${redrawSource}\n${runtime}\nreturn redraw;`)(
    root, {states: []}, (code: string) => {throw Error(code);}, () => true, async () => {});
  await redraw({layers: [{layer: "states", ids: [2,1]}, {layer: "provinces", ids: [8]}, {layer: "borders", ids: [1,2]}]});
  assert.deepEqual(calls, [["States", [1,2]], ["Provinces", [8]], ["Borders", [1,2]]]);
});
