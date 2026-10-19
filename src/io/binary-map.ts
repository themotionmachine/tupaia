import { compressFast, decompressFast } from "./fast-map-compression.ts";

// Native binary project codec used by downloads, browser storage and cloud saves.
// Sections decompress independently, and cell arrays are stored as little-endian binary values.
const MAGIC = new Uint8Array([84, 85, 80, 65, 73, 65, 0, 1]);
const HEADER = 12;
const ENTRY = 24;
const LIMIT = 256 * 1024 * 1024;
const CELL_SECTIONS = new Set([7, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 24, 25, 26, 27, 40, 44]);
const TYPES = [Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float64Array] as const;
export type MapCellArray = InstanceType<(typeof TYPES)[number]>;
export type BinaryMapSection = string | ArrayLike<number>;
interface Section {
  type: number;
  compression: number;
  offset: number;
  length: number;
  rawLength: number;
  count: number;
  hash: number;
}

function checksum(bytes: Uint8Array): number {
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 16777619);
  return hash >>> 0;
}

function numbers(text: string): { type: number; bytes: Uint8Array<ArrayBuffer>; count: number } | undefined {
  if (!text) return;
  const tokens = text.split(",");
  const values = tokens.map(Number);
  if (values.some((value, i) => !Number.isFinite(value) || String(value) !== tokens[i])) return;
  let min = Infinity,
    max = -Infinity,
    integer = true;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    integer &&= Number.isInteger(value);
  }
  const type = !integer
    ? 7
    : min >= 0 && max <= 255
      ? 1
      : min >= 0 && max <= 65535
        ? 2
        : min >= 0 && max <= 4294967295
          ? 3
          : min >= -128 && max <= 127
            ? 4
            : min >= -32768 && max <= 32767
              ? 5
              : min >= -2147483648 && max <= 2147483647
                ? 6
                : 7;
  const width = TYPES[type - 1].BYTES_PER_ELEMENT;
  const bytes = new Uint8Array(values.length * width);
  const view = new DataView(bytes.buffer);
  values.forEach((value, i) => {
    const at = i * width;
    if (type === 1) view.setUint8(at, value);
    else if (type === 2) view.setUint16(at, value, true);
    else if (type === 3) view.setUint32(at, value, true);
    else if (type === 4) view.setInt8(at, value);
    else if (type === 5) view.setInt16(at, value, true);
    else if (type === 6) view.setInt32(at, value, true);
    else view.setFloat64(at, value, true);
  });
  return { type, bytes, count: values.length };
}

export function isBinaryMap(bytes: Uint8Array): boolean {
  return bytes.length >= MAGIC.length && MAGIC.every((byte, i) => bytes[i] === byte);
}

/** Snapshot a native numeric section without a CSV or boxed-number round trip. */
function nativeNumbers(
  input: ArrayLike<number>
): { type: number; bytes: Uint8Array<ArrayBuffer>; count: number } | undefined {
  if (!input.length) return; // Empty optional sections keep the legacy loader's absent-value semantics.
  const nativeType = TYPES.findIndex(Type => input instanceof Type) + 1;
  let array: MapCellArray;
  const type = nativeType || 7;
  if (type === 7) {
    // Float values must match canonical .join() text, including nonfinite fallback and signed zero.
    for (let i = 0; i < input.length; i++) if (!Number.isFinite(input[i])) return;
    array = Float64Array.from(input, value => (value === 0 ? 0 : value));
  } else {
    const Type = TYPES[type - 1];
    array = Type.from(input);
  }
  const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  if (littleEndian || array.BYTES_PER_ELEMENT === 1)
    return { type, bytes: new Uint8Array(array.buffer), count: array.length };
  // Preserve the format's little-endian contract on other hosts too.
  const bytes = new Uint8Array(array.byteLength);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < array.length; i++) {
    const at = i * array.BYTES_PER_ELEMENT;
    if (type === 2) view.setUint16(at, array[i], true);
    else if (type === 3) view.setUint32(at, array[i], true);
    else if (type === 5) view.setInt16(at, array[i], true);
    else if (type === 6) view.setInt32(at, array[i], true);
    else view.setFloat64(at, array[i], true);
  }
  return { type, bytes, count: array.length };
}

/** UTF-8 text except numeric cell arrays, with exact text fallback for noncanonical numbers. */
export async function encodeBinaryMap(text: string): Promise<Uint8Array<ArrayBuffer>> {
  return encodeBinarySections(text.split("\r\n"));
}

/** Native saving snapshots all sections before yielding, then uses fast independently decodable blocks. */
export async function encodeBinarySections(sections: readonly BinaryMapSection[]): Promise<Uint8Array<ArrayBuffer>> {
  if (sections.length > 65535) throw new Error("Too many map sections");
  const encoder = new TextEncoder();
  const rawSections = sections.map((section, i) => {
    const isText = typeof section === "string";
    const numeric = CELL_SECTIONS.has(i) ? (isText ? numbers(section) : nativeNumbers(section)) : undefined;
    const text = isText ? section : numeric ? "" : Array.from(section).join(",");
    if (/[\uD800-\uDFFF]/u.test(text)) throw new Error("Map contains malformed Unicode");
    const raw = numeric?.bytes ?? encoder.encode(text);
    if (raw.length > LIMIT) throw new Error("Map section too large");
    return { raw, type: numeric?.type ?? 0, count: numeric?.count ?? 0, hash: checksum(raw) };
  });
  const payloads: Uint8Array<ArrayBuffer>[] = new Array(sections.length);
  const directory: Section[] = new Array(sections.length);
  for (let i = 0; i < rawSections.length; i++) {
    // Keep an owned snapshot while allowing input/paint between section batches.
    if (i && i % 8 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    const { raw, type, count, hash } = rawSections[i];
    const packed = raw.length > 128 ? compressFast(raw) : raw;
    const compression = packed.length < raw.length ? 2 : 0;
    const payload = compression ? packed : raw;
    payloads[i] = payload;
    directory[i] = { type, compression, offset: 0, length: payload.length, rawLength: raw.length, count, hash };
  }
  let offset = HEADER + sections.length * ENTRY;
  for (const section of directory) {
    section.offset = offset;
    offset += section.length;
  }
  if (offset > 0xffffffff) throw new Error("Map too large");
  const bytes = new Uint8Array(offset);
  bytes.set(MAGIC);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, sections.length, true);
  view.setUint16(10, ENTRY, true);
  directory.forEach((section, i) => {
    const at = HEADER + i * ENTRY;
    view.setUint8(at, section.type);
    view.setUint8(at + 1, section.compression);
    view.setUint32(at + 4, section.offset, true);
    view.setUint32(at + 8, section.length, true);
    view.setUint32(at + 12, section.rawLength, true);
    view.setUint32(at + 16, section.count, true);
    view.setUint32(at + 20, section.hash, true);
    bytes.set(payloads[i], section.offset);
  });
  return bytes;
}

/** Directory-only open; decoding occurs only when a caller requests a section. */
export class BinaryMapArchive {
  readonly length: number;
  #bytes: Uint8Array<ArrayBuffer>;
  #directory: Section[] = [];
  #raw = new Map<number, Promise<Uint8Array<ArrayBuffer>>>();
  #arrays = new Map<number, Promise<MapCellArray | undefined>>();

  constructor(input: ArrayBuffer | Uint8Array) {
    this.#bytes = input instanceof ArrayBuffer ? new Uint8Array(input.slice(0)) : new Uint8Array(input);
    if (!isBinaryMap(this.#bytes) || this.#bytes.length < HEADER) throw new Error("Invalid binary map header");
    const view = new DataView(this.#bytes.buffer);
    this.length = view.getUint16(8, true);
    let end = HEADER + this.length * ENTRY;
    if (view.getUint16(10, true) !== ENTRY || end > this.#bytes.length) throw new Error("Invalid map directory");
    for (let i = 0; i < this.length; i++) {
      const at = HEADER + i * ENTRY;
      const section = {
        type: view.getUint8(at),
        compression: view.getUint8(at + 1),
        offset: view.getUint32(at + 4, true),
        length: view.getUint32(at + 8, true),
        rawLength: view.getUint32(at + 12, true),
        count: view.getUint32(at + 16, true),
        hash: view.getUint32(at + 20, true)
      };
      if (
        section.type > TYPES.length ||
        section.compression > 2 ||
        view.getUint16(at + 2, true) !== 0 ||
        section.offset !== end ||
        section.offset + section.length > this.#bytes.length ||
        section.rawLength > LIMIT ||
        (section.type && section.count * TYPES[section.type - 1].BYTES_PER_ELEMENT !== section.rawLength) ||
        (!section.type && section.count !== 0)
      )
        throw new Error("Invalid map section");
      this.#directory.push(section);
      end += section.length;
    }
    if (end !== this.#bytes.length) throw new Error("Unexpected trailing map data");
  }

  get decodedSections(): number {
    return this.#raw.size;
  }

  raw(index: number): Promise<Uint8Array<ArrayBuffer>> {
    if (!this.#directory[index]) return Promise.reject(new Error("Unknown map section"));
    let pending = this.#raw.get(index);
    if (!pending) {
      pending = this.#read(index);
      this.#raw.set(index, pending);
    }
    return pending;
  }

  async #read(index: number): Promise<Uint8Array<ArrayBuffer>> {
    const section = this.#directory[index];
    let bytes = this.#bytes.slice(section.offset, section.offset + section.length);
    if (section.compression === 2) bytes = decompressFast(bytes, section.rawLength);
    else if (section.compression === 1) {
      const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > section.rawLength) throw new Error("Map decompression exceeds section length");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
    }
    if (bytes.length !== section.rawLength || checksum(bytes) !== section.hash) throw new Error("Corrupt map section");
    return bytes;
  }

  array(index: number): Promise<MapCellArray | undefined> {
    let pending = this.#arrays.get(index);
    if (!pending) {
      pending = this.#array(index);
      this.#arrays.set(index, pending);
    }
    return pending;
  }

  async #array(index: number): Promise<MapCellArray | undefined> {
    const section = this.#directory[index];
    if (!section?.type) return undefined;
    const raw = await this.raw(index);
    const view = new DataView(raw.buffer);
    const Type = TYPES[section.type - 1];
    const array = new Type(section.count);
    if (new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 || Type.BYTES_PER_ELEMENT === 1) {
      // Native little-endian hosts can copy values directly without per-cell DataView reads.
      // Keep the raw-section cache separate from the mutable array returned to callers.
      array.set(new Type(raw.buffer, raw.byteOffset, section.count));
      return array;
    }
    for (let i = 0; i < array.length; i++) {
      const at = i * array.BYTES_PER_ELEMENT;
      array[i] =
        section.type === 1
          ? view.getUint8(at)
          : section.type === 2
            ? view.getUint16(at, true)
            : section.type === 3
              ? view.getUint32(at, true)
              : section.type === 4
                ? view.getInt8(at)
                : section.type === 5
                  ? view.getInt16(at, true)
                  : section.type === 6
                    ? view.getInt32(at, true)
                    : view.getFloat64(at, true);
    }
    return array;
  }

  async section(index: number): Promise<string> {
    const array = await this.array(index);
    return array ? array.join(",") : new TextDecoder("utf-8", { fatal: true }).decode(await this.raw(index));
  }

  async text(): Promise<string> {
    const sections: string[] = [];
    for (let i = 0; i < this.length; i++) sections.push(await this.section(i));
    return sections.join("\r\n");
  }
}

export interface DecodedBinaryMap {
  sections: string[];
  cells: Map<number, MapCellArray>;
}

/** Loader adapter avoids converting binary cell arrays to CSV only to parse them again. */
export async function decodeBinaryMap(input: ArrayBuffer | Uint8Array): Promise<DecodedBinaryMap> {
  const archive = new BinaryMapArchive(input);
  const sections: string[] = [];
  const cells = new Map<number, MapCellArray>();
  for (let i = 0; i < archive.length; i++) {
    const array = await archive.array(i);
    if (array) {
      cells.set(i, array);
      // Legacy optional-section checks need a truthy marker; numeric consumers use cells below.
      sections.push("binary-cell-array");
    } else {
      const raw = await archive.raw(i);
      Object.defineProperty(sections, i, {
        enumerable: true,
        configurable: true,
        get() {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
          Object.defineProperty(sections, i, { value: text, writable: true, configurable: true, enumerable: true });
          return text;
        }
      });
    }
  }
  return { sections, cells };
}
