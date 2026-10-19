import { expect, it } from "vitest";
import { compressFast, decompressFast } from "./fast-map-compression";

function random(size: number, seed = 0x12345678): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    bytes[i] = seed & 255;
  }
  return bytes;
}
it("roundtrips empty, short, random, repetitive and long literal inputs", () => {
  for (const length of [0, 1, 4, 11, 12, 14, 15, 16, 254, 255, 256, 65535, 65536, 200000]) {
    for (const input of [random(length), new Uint8Array(length).fill(7)]) {
      expect(decompressFast(compressFast(input), length)).toEqual(input);
    }
  }
});
it("compresses repeated SVG and copies overlapping matches correctly", () => {
  const input = new TextEncoder().encode('<use href="#hill" x="123" y="456" width="8" height="8"/>'.repeat(20000));
  const packed = compressFast(input);
  expect(packed.length / input.length).toBeLessThan(0.02);
  expect(decompressFast(packed, input.length)).toEqual(input);
  // One literal followed by an offset-one match of nine bytes.
  expect([...decompressFast(new Uint8Array([0x15, 65, 1, 0, 0]), 10)]).toEqual(new Array(10).fill(65));
});
it("handles nonzero input buffer offsets and long-distance repeated fragments", () => {
  const input = random(150000);
  input.set(input.subarray(0, 30000), 50000);
  const backing = new Uint8Array(input.length + 19);
  backing.set(input, 7);
  expect(decompressFast(compressFast(backing.subarray(7, 7 + input.length)), input.length)).toEqual(input);
});
it("rejects invalid lengths, offsets, truncated extensions and output overflow", () => {
  for (const length of [-1, 1.5, NaN, Infinity, 256 * 1024 * 1024 + 1])
    expect(() => decompressFast(new Uint8Array(), length)).toThrow();
  const invalid: Array<[number[], number]> = [
    [[0xf0], 15],
    [[0xf0, 255], 300],
    [[0x20, 1], 2],
    [[0x10, 65, 1], 5],
    [[0x10, 65, 0, 0], 5],
    [[0x10, 65, 2, 0], 5],
    [[0x1f, 65, 1, 0], 30],
    [[0x15, 65, 1, 0, 0], 9],
    [[0x10, 65], 2],
    [[0x11, 65], 1],
    [[0x20, 65, 66], 1]
  ];
  for (const [bytes, length] of invalid) expect(() => decompressFast(new Uint8Array(bytes), length)).toThrow();
});

it("bulk-decodes overlapping long matches across arbitrary period and length boundaries", () => {
  for (const period of [1, 2, 3, 7, 17, 31, 32, 33, 255, 257, 1024]) {
    for (const size of [31, 32, 33, 63, 64, 65, 1023, 1024, 1025, 10000]) {
      const input = new Uint8Array(size);
      const pattern = random(period, period);
      for (let i = 0; i < size; i++) input[i] = pattern[i % period];
      const restored = decompressFast(compressFast(input), input.length);
      expect(restored).toEqual(input);
    }
  }
});
