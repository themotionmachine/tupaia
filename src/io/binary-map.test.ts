/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BinaryMapArchive, decodeBinaryMap, encodeBinaryMap, encodeBinarySections, isBinaryMap } from "./binary-map";

function map(numbers: string): string {
  return Array.from({ length: 46 }, (_, i) =>
    i === 0
      ? "1.130.0|license|seed"
      : i === 5
        ? `<svg id="map"><text>世界 🗺️</text>${'<path d="M0 0L1 1"/>'.repeat(2000)}</svg>`
        : i === 7 || i === 21 || i === 25
          ? numbers
          : ""
  ).join("\r\n");
}

describe("binary map", () => {
  it("feeds typed sections to the loader without CSV materialization, with text fallback", async () => {
    const decoded = await decodeBinaryMap(await encodeBinaryMap(map("1,2,3")));
    expect(decoded.cells.get(25)).toEqual(new Uint8Array([1, 2, 3]));
    expect(decoded.sections[25]).toBe("binary-cell-array");
    expect(typeof Object.getOwnPropertyDescriptor(decoded.sections, "0")?.get).toBe("function");
    expect(decoded.sections[0]).toBe("1.130.0|license|seed");
    expect(Object.getOwnPropertyDescriptor(decoded.sections, "0")?.get).toBeUndefined();
    const fallback = await decodeBinaryMap(await encodeBinaryMap(map("1.00,-0")));
    expect(fallback.cells.has(25)).toBe(false);
    expect(fallback.sections[25]).toBe("1.00,-0");
  });

  it("round-trips the real demo exactly and compresses it", async () => {
    const text = readFileSync(new URL("../../tests/fixtures/demo.map", import.meta.url), "utf8");
    const bytes = await encodeBinaryMap(text);
    expect(isBinaryMap(bytes)).toBe(true);
    const archive = new BinaryMapArchive(bytes);
    expect(archive.decodedSections).toBe(0);
    expect(await archive.text()).toBe(text);
    expect(bytes.length).toBeLessThan(Buffer.byteLength(text) / 2);
  });

  it.each([
    "0,255,2",
    "256,65535",
    "65536,4294967295",
    "-128,127",
    "-32768,32767",
    "-2147483648,2147483647",
    "0.125,1e-8,0.3333333333333333",
    "1e+21,-1e+30",
    "0,-0,1.00,,NaN,Infinity",
    ""
  ])("preserves typed values and exact noncanonical spellings: %s", async values => {
    const text = map(values);
    const archive = new BinaryMapArchive(await encodeBinaryMap(text));
    expect(await archive.text()).toBe(text);
  });

  it("leaves hidden sections compressed until access and caches typed arrays", async () => {
    const archive = new BinaryMapArchive(await encodeBinaryMap(map("1,2,3")));
    expect(await archive.section(0)).toBe("1.130.0|license|seed");
    expect(archive.decodedSections).toBe(1);
    const cells = await archive.array(25);
    expect(cells).toEqual(new Uint8Array([1, 2, 3]));
    expect(await archive.array(25)).toBe(cells);
    expect(archive.decodedSections).toBe(2);
    expect((await archive.section(5)).includes("世界 🗺️")).toBe(true);
    expect(archive.decodedSections).toBe(3);
  });

  it("supports independent concurrent reads and sliced binary input", async () => {
    const bytes = await encodeBinaryMap(map("255,12"));
    const padded = new Uint8Array(bytes.length + 20);
    padded.set(bytes, 10);
    const archive = new BinaryMapArchive(padded.subarray(10, -10));
    const [first, second] = await Promise.all([archive.section(25), archive.section(7)]);
    expect(first).toBe("255,12");
    expect(second).toBe(first);
  });

  it("rejects truncation, unknown version/type, overlapping ranges, corruption and huge decoded lengths", async () => {
    const bytes = await encodeBinaryMap(map("1,2,3"));
    for (const size of [0, 8, 12, 100, bytes.length - 1]) {
      expect(() => new BinaryMapArchive(bytes.subarray(0, size))).toThrow();
    }
    for (const mutate of [
      (b: Uint8Array) => {
        b[7] = 2;
      },
      (b: Uint8Array) => {
        b[12] = 99;
      },
      (b: Uint8Array) => {
        new DataView(b.buffer).setUint32(16, 0, true);
      },
      (b: Uint8Array) => {
        new DataView(b.buffer).setUint32(24, 0xffffffff, true);
      }
    ]) {
      const corrupt = bytes.slice();
      mutate(corrupt);
      expect(() => new BinaryMapArchive(corrupt)).toThrow();
    }
    const corrupt = bytes.slice();
    const offset = new DataView(corrupt.buffer).getUint32(16, true);
    corrupt[offset] ^= 1;
    await expect(new BinaryMapArchive(corrupt).section(0)).rejects.toThrow("Corrupt map section");
    await expect(new BinaryMapArchive(bytes).section(999)).rejects.toThrow("Unknown map section");
  });

  it("preserves future sections and refuses malformed Unicode instead of silently replacing it", async () => {
    const text = `${map("1,2")}\r\nfuture|field\nline`;
    expect(await new BinaryMapArchive(await encodeBinaryMap(text)).text()).toBe(text);
    await expect(encodeBinaryMap("bad\ud800")).rejects.toThrow("malformed Unicode");
  });
});

describe("native binary sections", () => {
  it("preserves native cell types, exact rounded values and a synchronous owned snapshot", async () => {
    const height = new Uint8Array([0, 20, 100]);
    const states = new Uint16Array([0, 256, 65535]);
    const markets = new Uint32Array([0, 65536, 100000]);
    const sections = map("1,2,3").split("\r\n") as (string | ArrayLike<number>)[];
    sections[7] = height;
    sections[21] = [-0, 0.1234, 100000.0001];
    sections[25] = states;
    sections[44] = markets;
    sections[40] = new Uint16Array(0);
    const expected = sections.join("\r\n");
    const saving = encodeBinarySections(sections);
    height[1] = 99;
    states[1] = 1;
    markets[2] = 2;
    const archive = new BinaryMapArchive(await saving);
    expect(await archive.text()).toBe(expected);
    expect(await archive.array(7)).toEqual(new Uint8Array([0, 20, 100]));
    expect(await archive.array(25)).toEqual(new Uint16Array([0, 256, 65535]));
    expect(await archive.array(44)).toEqual(new Uint32Array([0, 65536, 100000]));
    expect(await archive.array(40)).toBeUndefined();
    expect(Object.is((await archive.array(21))![0], -0)).toBe(false);
  });

  it("keeps text fallback for nonfinite numeric arrays and rejects malformed native text", async () => {
    const sections = map("1,2,3").split("\r\n") as (string | ArrayLike<number>)[];
    sections[21] = [1, NaN, Infinity];
    const archive = new BinaryMapArchive(await encodeBinarySections(sections));
    expect(await archive.array(21)).toBeUndefined();
    expect(await archive.text()).toBe(sections.join("\r\n"));
    sections[0] = "invalid\ud800";
    await expect(encodeBinarySections(sections)).rejects.toThrow("malformed Unicode");
  });
});

it("reads prior deflate section files and rejects unknown compression modes", async () => {
  const text = "legacy project section 世界 ".repeat(1000);
  const raw = new TextEncoder().encode(text);
  const compressed = new Uint8Array(
    await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer()
  );
  const bytes = new Uint8Array(36 + compressed.length);
  bytes.set([84, 85, 80, 65, 73, 65, 0, 1]);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, 1, true);
  view.setUint16(10, 24, true);
  view.setUint8(13, 1);
  view.setUint32(16, 36, true);
  view.setUint32(20, compressed.length, true);
  view.setUint32(24, raw.length, true);
  let hash = 2166136261;
  for (const byte of raw) hash = Math.imul(hash ^ byte, 16777619);
  view.setUint32(32, hash >>> 0, true);
  bytes.set(compressed, 36);
  expect(await new BinaryMapArchive(bytes).text()).toBe(text);
  view.setUint8(13, 3);
  expect(() => new BinaryMapArchive(bytes)).toThrow("Invalid map section");
});

it("keeps decoded typed cells separate from the verified raw-section cache", async () => {
  const sections = map("1,2,3").split("\r\n") as (string | ArrayLike<number>)[];
  sections[25] = new Uint16Array([0, 256, 65535]);
  const archive = new BinaryMapArchive(await encodeBinarySections(sections));
  const cells = await archive.array(25);
  cells![1] = 7;
  expect(await archive.raw(25)).toEqual(new Uint8Array([0, 0, 0, 1, 255, 255]));
  expect(await archive.array(25)).toBe(cells);
});
