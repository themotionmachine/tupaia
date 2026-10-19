// Node tests for the consumers harness math (no browser): header masking, section comparison, pixel comparison, the
// zip reader, and that each comparison can fail. Part of `gate bench`.
import assert from "node:assert/strict";
import { deflateRawSync, crc32 } from "node:zlib";
import { test } from "node:test";
import { encodePng, decodePng } from "../png.ts";
import {
  type SvgFacts,
  SECTION_COUNT,
  comparePixels,
  compareSaves,
  describeSaveDiff,
  firstDifference,
  judgeSvgFacts,
  maskHeader,
  maskedSections,
  pass,
  fail,
  info,
  rowStatus,
  splitSections,
  unzipTiles,
  verdict,
  withinD1
} from "./consumers-lib.ts";

const header = (date = "2026-10-19", mapId = "1760000000000") => ["1.116.0", "File can be loaded in azgaar.github.io/Fantasy-Map-Generator", date, "seed", "1280", "720", mapId].join("|");
// a 46-section save whose SVG (index 5) contains bare LF, like the real one
function save(overrides: Record<number, string> = {}, head = header()): string {
  const sections = Array.from({ length: SECTION_COUNT }, (_, i) => `section-${i}`);
  sections[0] = head;
  sections[5] = '<svg id="map" width="1280" height="720">\n<g id="viewbox"></g>\n</svg>';
  for (const [i, v] of Object.entries(overrides)) sections[Number(i)] = v;
  return sections.join("\r\n");
}

test("the header mask covers the day and the map id, under their real names", () => {
  const { masked, fields } = maskHeader(header("2026-10-19", "1760000000000"));
  assert.equal(fields?.date, "2026-10-19");
  assert.equal(fields?.mapId, "1760000000000");
  assert.match(masked, /\|<date>\|seed\|1280\|720\|<map-id>$/);
  assert.ok(!masked.includes("saved"), "no savedAt label");
  assert.equal(maskHeader("a|b").masked, "a|b", "an unexpected header is left alone, so it shows up as a difference");
});

test("splitSections splits on CRLF only (the SVG holds bare LF)", () => {
  const sections = splitSections(save());
  assert.equal(sections.length, SECTION_COUNT);
  assert.ok(sections[5].includes("\n"));
});

test("saves that differ only in the day and map id are equal; any other difference is found, with its section", () => {
  const a = save({}, header("2026-10-19", "1"));
  const b = save({}, header("2026-10-20", "2"));
  assert.ok(compareSaves(a, b).equal);
  const c = compareSaves(a, save({ 5: '<svg id="map" width="1280" height="721">\n</svg>' }, header("2026-10-19", "1")));
  assert.equal(c.equal, false);
  assert.equal(c.differing[0].index, 5);
  assert.equal(c.differing[0].name, "svg");
  assert.match(describeSaveDiff(c), /#5 svg/);
  const d = compareSaves(a, save({ 21: "pop-changed" }, header("2026-10-19", "1")));
  assert.deepEqual(d.differing.map(x => x.name), ["cells.pop"]);
  // the seed is in the header and is not masked
  const e = compareSaves(a, save({}, header("2026-10-19", "1").replace("|seed|", "|other|")));
  assert.equal(e.equal, false);
  assert.equal(e.differing[0].index, 0);
});

test("a save with a different section count is not equal even when the prefix matches", () => {
  const a = save();
  const b = `${a}\r\nextra`;
  const c = compareSaves(a, b);
  assert.equal(c.equal, false);
  assert.deepEqual(c.counts, [46, 47]);
  assert.match(describeSaveDiff(c), /section counts 46 vs 47/);
});

test("firstDifference finds the offset and gives an excerpt on both sides", () => {
  assert.equal(firstDifference("abc", "abc"), null);
  const d = firstDifference("hello world", "hello there", 3);
  assert.equal(d?.offset, 6);
  assert.deepEqual(d?.lengths, [11, 11]);
  assert.equal(firstDifference("abc", "abcd")?.offset, 3);
});

const goodFacts = (over: Partial<SvgFacts> = {}): SvgFacts => ({
  parsed: true, rootId: "map", width: "1280", height: "720", viewboxTransform: null, rulerChildren: 0, tradeChildren: 0, tradeLayerOff: null,
  viewportCulled: 0, emptyClassAttrs: 61, canvases: 0, gpuMarkers: 0, tempGroups: 0, tempLeak: false, elements: 100, ...over
});
const statusOf = (facts: SvgFacts, tradeOn = true) => judgeSvgFacts(31, "p", "gpu", facts, { width: "1280", height: "720", tradeOn });

test("a clean saved SVG passes the absolute properties (I8, I9, I11), and class=\"\" is reported, not gated", () => {
  const checks = statusOf(goodFacts());
  assert.ok(checks.every(c => c.status !== "FAIL"), JSON.stringify(checks.filter(c => c.status === "FAIL")));
  assert.ok(checks.some(c => c.status === "INFO" && /class=""/.test(c.name)));
});

test("each absolute property can fail", () => {
  const failing = (over: Partial<SvgFacts>, tradeOn = true) => statusOf(goodFacts(over), tradeOn).filter(c => c.status === "FAIL").map(c => c.id);
  assert.deepEqual(failing({ width: "2816" }), ["p.canonical-size"]);
  assert.deepEqual(failing({ viewboxTransform: "translate(1 2) scale(2)" }), ["p.no-camera"]);
  assert.deepEqual(failing({ rulerChildren: 2 }), ["p.cleared"]);
  assert.deepEqual(failing({ tradeChildren: 3 }), ["p.cleared"]);
  assert.deepEqual(failing({ viewportCulled: 1 }), ["p.no-culled-class"]);
  assert.deepEqual(failing({ canvases: 1 }), ["p.no-gpu-content"]);
  assert.deepEqual(failing({ gpuMarkers: 1 }), ["p.no-gpu-content"]);
  assert.deepEqual(failing({ tradeLayerOff: "1" }), ["p.trade-flag"], "layer on but flagged off");
  assert.deepEqual(failing({ tradeLayerOff: null }, false), ["p.trade-flag"], "layer off but not flagged");
  assert.deepEqual(statusOf({ parsed: false } as SvgFacts).map(c => c.status), ["FAIL"]);
});

test("a row passes only with a pass and no failure; SKIP and INFO never gate", () => {
  const checks = [pass(31, "a", "x"), info(31, "b", "y", ""), fail(32, "c", "z", "boom"), pass(32, "d", "w")];
  assert.equal(rowStatus(checks, 31), "PASS");
  assert.equal(rowStatus(checks, 32), "FAIL");
  assert.equal(rowStatus(checks, 33), "SKIP");
  assert.equal(rowStatus([info(34, "a", "x", "")], 34), "SKIP");
  assert.equal(verdict(false, 1, "i", "n").status, "FAIL");
});

function image(width: number, height: number, f: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set(f(x, y), (y * width + x) * 4);
  return { width, height, data };
}
const field = (x: number, y: number): [number, number, number, number] => (x > 30 && y > 30 && x < 70 ? [20, 90, 160, 255] : [240, 235, 220, 255]);

test("identical images are equal, a one-code-value change is not exact but is within D1, a large change fails D1", () => {
  const a = image(100, 100, field);
  assert.deepEqual(comparePixels(a, image(100, 100, field)).equal, true);
  const nudged = image(100, 100, (x, y) => { const p = field(x, y); return x === 5 && y === 5 ? [p[0] + 1, p[1], p[2], p[3]] : p; });
  const c = comparePixels(a, nudged);
  assert.equal(c.equal, false);
  assert.ok(withinD1(c));
  const broken = image(100, 100, (x, y) => (x > 30 && x < 70 ? [255, 255, 255, 255] : field(x, y)));
  assert.equal(withinD1(comparePixels(a, broken)), false);
  assert.equal(comparePixels(a, image(50, 100, field)).sizeEqual, false);
});

test("transparent pixels are compared over white and alpha differences are caught", () => {
  const a = image(40, 40, (x) => (x < 20 ? [0, 0, 0, 0] : [10, 10, 10, 255]));
  const b = image(40, 40, (x) => (x < 20 ? [0, 0, 0, 255] : [10, 10, 10, 255]));
  const c = comparePixels(a, b);
  assert.equal(c.equal, false, "alpha 0 vs black");
  assert.ok((c.over16Fraction ?? 0) > 0.4);
});

test("pixels survive the PNG round trip the harness uses for exports", () => {
  const a = image(30, 20, field);
  const back = decodePng(new Uint8Array(encodePng(a)));
  assert.ok(comparePixels(a, back).equal);
});

// a stored/deflated zip written by hand, to prove the reader without JSZip
function zip(entries: Array<[string, Uint8Array, 0 | 8]>): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data, method] of entries) {
    const body = method === 8 ? deflateRawSync(data) : Buffer.from(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, dir, end]));
}

test("unzipTiles reads stored and deflated entries, sorted by name", () => {
  const text = new TextEncoder().encode("tile data ".repeat(50));
  const entries = unzipTiles(zip([["B1.png", text, 8], ["A1.png", new Uint8Array([1, 2, 3]), 0], ["schema.png", text, 8]]));
  assert.deepEqual(entries.map(([n]) => n), ["A1.png", "B1.png", "schema.png"]);
  assert.deepEqual([...entries[0][1]], [1, 2, 3]);
  assert.deepEqual(entries[1][1], text);
  assert.throws(() => unzipTiles(new Uint8Array(10)), /not a zip/);
});

test("maskedSections leaves every section but the header alone", () => {
  const a = maskedSections(save());
  assert.equal(a.length, SECTION_COUNT);
  assert.equal(a[1], "section-1");
  assert.match(a[0], /<date>/);
});
