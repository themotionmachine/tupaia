import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, test } from "node:test";

const codecPath = "../../src/io/binary-map.ts";
const { BinaryMapArchive, encodeBinaryMap, isBinaryMap } = await import(codecPath);

import { type DemoFixture, sharedDemoFixture } from "./helpers.ts";

let fixture: DemoFixture;
before(async () => {
  fixture = await sharedDemoFixture();
});
beforeEach(async () => fixture.reset());
after(async () => fixture?.close());
const source = async () => {
  const page = await fixture.browser.getPage();
  return page.evaluate<string>("window.lazy.save().then(m => m.prepareMapData())");
};

test("default download is binary and preserves the source project exactly", async () => {
  const page = await fixture.browser.getPage();
  const text = await source();
  const downloading = page.waitForEvent("download");
  await page.evaluate("window.lazy.save().then(m => m.saveMap('machine'))");
  const download = await downloading;
  const file = `/tmp/tupaia-binary-download-${process.pid}.map`;
  await download.saveAs(file);
  const bytes = fs.readFileSync(file);
  fs.unlinkSync(file);
  assert.ok(isBinaryMap(bytes));
  assert.equal(await new BinaryMapArchive(bytes).text(), text);
});

test("browser storage and Dropbox default to binary bytes without a network upload", async () => {
  const page = await fixture.browser.getPage();
  const expected = await source();
  const stored = await page.evaluate<string>(`(async () => {
    await (await window.lazy.save()).saveMap("storage");
    const bytes = new Uint8Array(await (await ldb.get("lastMap")).arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(binary);
  })()`);
  const storageBytes = Buffer.from(stored, "base64");
  assert.ok(isBinaryMap(storageBytes));
  assert.equal(await new BinaryMapArchive(storageBytes).text(), expected);
  const uploaded = await page.evaluate<{ magic: number[]; size: number }>(`(async () => {
    const {Cloud} = await window.lazy.cloud();
    const original = Cloud.providers.dropbox.save;
    let result;
    Cloud.providers.dropbox.save = async (name, bytes) => { result = {magic: Array.from(bytes.slice(0, 8)), size: bytes.length}; return true; };
    try { await (await window.lazy.save()).saveMap("dropbox"); return result; }
    finally { Cloud.providers.dropbox.save = original; }
  })()`);
  assert.deepEqual(uploaded.magic, Array.from(storageBytes.subarray(0, 8)));
  assert.ok(uploaded.size > 0);
});

test("hidden zone and ice records remain lazy after a binary UI load and materialize on use", async () => {
  const page = await fixture.browser.getPage();
  await page.evaluate(`
    pack.zones = [{i: 99, name: "Lazy zone", type: "Unknown", color: "#fff", cells: [1, 2]}];
    pack.ice = [{i: 99, type: "iceberg", points: [[1, 2], [3, 4], [5, 6]]}];
    for (const id of ["zones", "ice"]) { const el = document.getElementById(id); el.style.display = "none"; el.replaceChildren(); }
  `);
  const bytes = await encodeBinaryMap(await source());
  const b64 = Buffer.from(bytes).toString("base64");
  const result = await page.evaluate<{
    zoneDeferred: boolean;
    iceDeferred: boolean;
    zones: unknown[];
    ice: unknown[];
  }>(`(async () => {
    const module = await window.lazy.load();
    const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
    const loaded = new Promise(resolve => addEventListener("map:loaded", resolve, {once:true}));
    module.uploadMap(new Blob([bytes]));
    await loaded;
    const zoneDeferred = typeof Object.getOwnPropertyDescriptor(pack, "zones").get === "function";
    const iceDeferred = typeof Object.getOwnPropertyDescriptor(pack, "ice").get === "function";
    return {zoneDeferred, iceDeferred, zones: pack.zones, ice: pack.ice};
  })()`);
  assert.equal(result.zoneDeferred, true);
  assert.equal(result.iceDeferred, true);
  assert.deepEqual(result.zones, [{ i: 99, name: "Lazy zone", type: "Unknown", color: "#fff", cells: [1, 2] }]);
  assert.deepEqual(result.ice, [
    {
      i: 99,
      type: "iceberg",
      points: [
        [1, 2],
        [3, 4],
        [5, 6]
      ]
    }
  ]);
});
