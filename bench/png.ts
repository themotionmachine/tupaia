// Minimal PNG codec for the golden runner. No colour management: the stored 8-bit code values are the pixels.
// decodePng reads 8-bit, non-interlaced greyscale, grey+alpha, RGB or RGBA (what Chromium screenshots emit) into RGBA
// and fails closed on anything else (palette, 16-bit, interlaced). encodePng writes 8-bit RGBA. Ancillary chunks
// (gAMA, iCCP, ...) are ignored on read: both arms of a golden go through the same capture path, so a colour chunk
// cannot make two equal captures differ.
import { crc32, deflateSync, inflateSync } from "node:zlib";
import type { Rgba } from "./fidelity-metrics.ts";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export interface DecodedPng extends Rgba {
  data: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(bytes: Uint8Array): DecodedPng {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let at = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  let ended = false;
  while (at + 12 <= buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    if (body.length !== length) throw new Error(`truncated ${type} chunk`);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      colorType = body[9];
      if (depth !== 8 || !(colorType in CHANNELS)) throw new Error(`unsupported PNG: bit depth ${depth}, colour type ${colorType}`);
      if (body[10] !== 0 || body[11] !== 0) throw new Error("unsupported PNG compression/filter method");
      if (body[12] !== 0) throw new Error("interlaced PNG not supported");
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") {
      ended = true;
      break;
    }
    at += 12 + length;
  }
  if (!ended || !width || !height || !idat.length) throw new Error("incomplete PNG");
  const channels = CHANNELS[colorType];
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error("PNG image data too short");
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x];
      const a = x >= channels ? rows[out + x - channels] : 0;
      const b = y ? rows[out - stride + x] : 0;
      const c = x >= channels && y ? rows[out - stride + x - channels] : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = value;
          break;
        case 1:
          v = value + a;
          break;
        case 2:
          v = value + b;
          break;
        case 3:
          v = value + ((a + b) >> 1);
          break;
        case 4:
          v = value + paeth(a, b, c);
          break;
        default:
          throw new Error(`bad PNG filter ${filter} on row ${y}`);
      }
      rows[out + x] = v & 255;
    }
  }
  if (channels === 4) return { width, height, data: rows };
  const data = new Uint8Array(width * height * 4);
  for (let p = 0, q = 0; p < width * height; p++, q += channels) {
    const o = p * 4;
    if (channels >= 3) {
      data[o] = rows[q];
      data[o + 1] = rows[q + 1];
      data[o + 2] = rows[q + 2];
    } else data[o] = data[o + 1] = data[o + 2] = rows[q];
    data[o + 3] = channels === 2 ? rows[q + 1] : channels === 4 ? rows[q + 3] : 255;
  }
  return { width, height, data };
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

export function encodePng(image: Rgba): Buffer {
  const { width, height, data } = image;
  if (data.length !== width * height * 4) throw new Error("RGBA data does not match its dimensions");
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = data[y * stride + x];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}
