// Node test (no browser): the committed parity fixture is the file its manifest describes, and the manifest proves
// every matrix row it claims. Run with: node --test bench/host/fixtures/fixtures.test.ts
// The browser-side proof (load the file in the app and re-measure) is `build-parity-fixture.ts --verify`.
import { strict as assert } from "node:assert";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { checkCensus, FEATURES, resolvePath, rowsCovered } from "./features.ts";
import { PARITY_CONFIG, PARITY_LAYERS_ON, PARITY_MAP, loadParityManifest, resolveFixture, sha256File } from "./index.ts";

const manifest = loadParityManifest();
const text = readFileSync(PARITY_MAP, "utf8");

// The rows the FIX packet owns (docs/performance/webgl-rewrite/PHASE1-PLAN.md, W0).
const REQUIRED_ROWS = [5, 6, 7, 10, 11, 17, 18, 19, 21, 23, 24, 42, 43];

test("the file matches its manifest", () => {
  assert.equal(sha256File(PARITY_MAP), manifest.sha256);
  assert.equal(statSync(PARITY_MAP).size, manifest.bytes);
  assert.ok(manifest.bytes < 3_000_000, `file is ${manifest.bytes} bytes, budget is 3 MB`);
  assert.equal(manifest.fixture, PARITY_CONFIG.version);
});

test("the header carries the normalised date and map id, so rebuilds hash the same", () => {
  const head = text.split("\r\n")[0].split("|");
  assert.equal(head[2], PARITY_CONFIG.normalizedDate);
  assert.equal(head[3], PARITY_CONFIG.seed);
  assert.equal(head[6], String(PARITY_CONFIG.normalizedMapId));
});

test("the manifest's censuses meet every feature expectation", () => {
  assert.deepEqual(checkCensus(manifest.census.afterBuild, { withPreamble: false }), []);
  assert.deepEqual(checkCensus(manifest.census.afterReload, { withPreamble: false }), []);
  assert.deepEqual(checkCensus(manifest.census.afterReloadPreamble, { withPreamble: true }), []);
});

test("every row the packet owns is covered by at least one feature", () => {
  const covered = rowsCovered();
  for (const row of REQUIRED_ROWS) assert.ok(covered[String(row)]?.length, `row ${row} has no feature`);
  assert.deepEqual(manifest.rowsCovered, covered);
  assert.equal(manifest.features.length, FEATURES.length);
});

test("every layer the fixture turns on is populated after loading", () => {
  const census = manifest.census.afterReloadPreamble as { layers: Record<string, { elements: number }>; buttonsOn: string[] };
  // layer -> the viewbox element that must hold content
  const layerEls: Record<string, string> = {
    texture: "texture", heightmap: "terrs", biomes: "biomes", cells: "cells", grid: "gridOverlay", coordinates: "coordinates",
    compass: "compass", rivers: "rivers", relief: "terrain", religions: "relig", cultures: "cults", states: "regions",
    provinces: "provs", zones: "zones", borders: "borders", routes: "routes", temperature: "temperature", ice: "ice",
    goods: "goods", markets: "markets", trade: "tradeAnimation", precipitation: "prec", population: "population",
    emblems: "emblems", burgs: "icons", labels: "labels", military: "armies", markers: "markers", rulers: "ruler",
    scaleBar: "scaleBar", vignette: "vignette", lakes: "lakes"
  };
  for (const layer of [...PARITY_LAYERS_ON, "cells"]) {
    const el = layerEls[layer];
    assert.ok(el, `no element mapped for layer ${layer}`);
    assert.ok((census.layers[el]?.elements ?? 0) > 0, `layer ${layer} (#${el}) is empty`);
  }
  assert.equal(Object.keys(manifest.layerCensus).length, Object.keys(census.layers).length);
});

test("the saved file really carries the features (static checks on the text)", () => {
  const has = (needle: string | RegExp, what: string) => assert.ok(typeof needle === "string" ? text.includes(needle) : needle.test(text), `missing: ${what}`);
  has('shape-rendering="geometricPrecision"', "halo: viewbox shape-rendering");
  has('auto-filter="1"', "coastline auto-filter");
  for (let n = 0; n < 42; n++) has(`url(#hatch${n})`, `zone hatch${n}`);
  has("data:image/png;base64", "data:image icon");
  has("data:image/svg+xml", "svg data:image icon");
  has('id="legendBox"', "legend box");
  // measurers are not saved as markup: the app redraws them from the serialized list (data[33]) on load
  for (const kind of ["Ruler", "Opisometer", "RouteOpisometer", "Planimeter"]) has(`${kind}: `, `serialized ${kind}`);
  has('stroke-dasharray="5 3"', "dashed grid");
  has('id="textPath_label904"', "custom label textPath");
  has('paint-order="stroke"', "haloed label group");
  has('id="focusState', "fog path");
  has("🇯🇵", "flag emoji marker");
  has("👩🏽‍🚀", "skin-tone ZWJ emoji marker");
  has(/"angle":-?\d+/, "rotated regiment");
});

test("camera presets frame inside the map for every k the golden matrix uses", () => {
  const [gw, gh] = manifest.config.width ? [manifest.config.width, manifest.config.height] : [0, 0];
  for (const k of [1, 2, 4, 8]) assert.ok(manifest.cameras.some(c => c.k === k), `no preset at k=${k}`);
  for (const c of [...manifest.cameras, ...manifest.coastlineSwitch]) {
    assert.ok(c.cx - 640 / c.k >= -0.1 && c.cx + 640 / c.k <= gw + 0.1, `${c.id} frames outside the map horizontally`);
    assert.ok(c.cy - 360 / c.k >= -0.1 && c.cy + 360 / c.k <= gh + 0.1, `${c.id} frames outside the map vertically`);
    assert.ok(Math.abs(c.x - (640 - c.cx * c.k)) < 0.02 && Math.abs(c.y - (360 - c.cy * c.k)) < 0.02, `${c.id}: x/y do not match cx/cy`);
  }
  // one frame either side of each coastline switch point (1.5 and 2.6)
  assert.deepEqual(manifest.coastlineSwitch.map(c => c.expect), ["url(#dropShadow)", "none", "none", "url(#blurFilter)", "url(#blurFilter)"]);
});

test("resolveFixture('parity') returns the verified file", () => {
  const fx = resolveFixture("parity");
  assert.equal(fx.sha256, manifest.sha256);
  assert.equal(fx.text(), text);
  assert.ok(fx.pageScript?.includes("__parity"));
  assert.equal(resolvePath(manifest.census.afterReload, "features.map.states"), 8);
});
