import assert from "node:assert/strict";
import {test} from "node:test";
import {drawsReliefOnLoad, needsReliefLoadHook} from "../src/tools/relief.ts";

test("deprecated relief flag requires compatibility only for truly empty saved relief", () => {
  const wrap = (body: string) => `<svg><g id="terrain" data-regenerate="1">${body}</g><g id="labels"></g></svg>`;
  assert.equal(drawsReliefOnLoad(wrap('<use href="#relief-mount"/>')), true);
  assert.equal(needsReliefLoadHook(wrap("")), true);
  assert.equal(needsReliefLoadHook("<svg><g id=\"terrain\" data-regenerate=\"1\"/><g><image href=\"elsewhere\"/></g></svg>"), true);
  assert.equal(needsReliefLoadHook(wrap(" \n ")), true);
  assert.equal(needsReliefLoadHook(wrap('<use href="#relief-mount"/>')), false);
  assert.equal(needsReliefLoadHook(wrap('<image href="data:image/png;base64,AAAA"/>')), false);
  assert.equal(needsReliefLoadHook('<svg><g id="terrain"></g></svg>'), false);
  assert.equal(needsReliefLoadHook(wrap("").replace('<g id="labels"></g>', '<g id="labels"><image href="elsewhere"/></g>')), true);
});

test("relief bridge counts logical raster glyphs and vector edits rather than image elements", async () => {
  const {readFileSync} = await import("node:fs");
  const source = readFileSync(new URL("../src/bridge-ext/relief.js", import.meta.url), "utf8");
  const start = source.indexOf("  function reliefCount(");
  const end = source.indexOf("\n  }", start) + 4;
  const count = new Function(`${source.slice(start,end)}; return reliefCount;`)();
  const raster = {querySelector: () => ({getAttribute: () => "543"}), querySelectorAll: () => [1,2]};
  assert.equal(count(raster), 543, "visible vector overlays do not double count raster metadata");
  assert.equal(count({querySelector: () => null, querySelectorAll: () => [1,2]}), 2);
  assert.equal(count({querySelector: () => ({getAttribute: () => "invalid"}), querySelectorAll: () => [1,2]}), 2);
});
