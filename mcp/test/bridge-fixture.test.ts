import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { type DemoFixture, sharedDemoFixture } from "./helpers.ts";

describe("warm demo bridge fixture", { timeout: 120_000 }, () => {
  let fixture: DemoFixture;
  let page: Awaited<ReturnType<DemoFixture["browser"]["getPage"]>>;
  let baselineName: string;
  before(async () => {
    fixture = await sharedDemoFixture();
    page = await fixture.browser.getPage();
    baselineName = await page.evaluate(
      () => (globalThis as unknown as { pack: { burgs: Array<{ name: string }> } }).pack.burgs[1].name
    );
  });
  beforeEach(async () => {
    await fixture.reset();
  });
  after(async () => {
    if (fixture) await fixture.close();
  });
  test("a bridge case can mutate its baseline", async () => {
    await page.evaluate(() => {
      (globalThis as unknown as { pack: { burgs: Array<{ name: string }> } }).pack.burgs[1].name = "fixture mutation";
      localStorage.setItem("fixture-marker", "dirty");
    });
    assert.equal(await page.evaluate(() => localStorage.getItem("fixture-marker")), "dirty");
  });
  test("river generator preserves packed heights on a real demo map", async () => {
    const heights = await page.evaluate(() =>
      Array.from((globalThis as unknown as { pack: { cells: { h: Uint8Array } } }).pack.cells.h)
    );
    const result = await fixture.call<{ ran: string[] }>("regenerate", { parts: ["rivers"], restoreLayers: true });
    assert.deepEqual(result.ran, ["rivers"]);
    assert.deepEqual(
      await page.evaluate(() =>
        Array.from((globalThis as unknown as { pack: { cells: { h: Uint8Array } } }).pack.cells.h)
      ),
      heights
    );
  });
  test("real edits retain independent snapshots and undo/redo on the reused page", async () => {
    const baseline = await fixture.tool<{ taken: { index: number } }>("snapshot", {
      action: "take",
      label: "fixture baseline"
    });
    await fixture.tool("edit", { type: "burg", ops: [{ ref: 1, set: { name: "Fixture Alpha" } }] });
    await fixture.tool("edit", { type: "burg", ops: [{ ref: 1, set: { name: "Fixture Beta" } }] });
    const name = () =>
      page.evaluate(() => (globalThis as unknown as { pack: { burgs: Array<{ name: string }> } }).pack.burgs[1].name);
    assert.equal(await name(), "Fixture Beta");
    await fixture.tool("snapshot", { action: "undo" });
    assert.equal(await name(), "Fixture Alpha");
    await fixture.tool("snapshot", { action: "redo" });
    assert.equal(await name(), "Fixture Beta");
    await fixture.tool("snapshot", { action: "restore", index: baseline.taken.index });
    assert.equal(await name(), baselineName);
    assert.equal(await fixture.browser.getPage(), page);
    assert.equal(fixture.browser.launches, 1);
  });
  test("next case restores map and storage while retaining the same renderer", async () => {
    assert.equal(await fixture.browser.getPage(), page);
    assert.equal(fixture.browser.launches, 1);
    const history = await fixture.tool<{ snapshots: unknown[]; undo: unknown[]; redo: unknown[] }>("snapshot", {
      action: "list"
    });
    assert.deepEqual(history.snapshots, []);
    assert.deepEqual(history.undo, []);
    assert.deepEqual(history.redo, []);
    assert.equal(
      await page.evaluate(
        () => (globalThis as unknown as { pack: { burgs: Array<{ name: string }> } }).pack.burgs[1].name
      ),
      baselineName
    );
    assert.equal(await page.evaluate(() => localStorage.getItem("fixture-marker")), null);
    assert.equal((await fixture.call<{ counts: Record<string, number> }>("summary")).counts.burgs > 0, true);
    const compaction = await page.evaluate(`(() => {
      drawBiomes();
      drawHeightmap();
      return ["biomes", "landHeights", "oceanHeights"].map(id => {
        const group = document.getElementById(id);
        const path = group?.querySelector("path");
        const style = path && getComputedStyle(path);
        return {id, images: group?.querySelectorAll("image[data-path-vectors]").length,
          paths: group?.querySelectorAll("path").length,
          mask: style?.maskImage, clip: style?.clipPath, filter: style?.filter};
      });
    })()`);
    console.log(JSON.stringify({ defaultLayerCompaction: compaction }));
    console.log(
      JSON.stringify({
        fixtureBootMs: Math.round(fixture.bootMs),
        fixtureResetMs: Math.round(fixture.resetMs),
        launches: fixture.browser.launches
      })
    );
  });
});
