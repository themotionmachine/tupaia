// LZ4 block grammar: a token encodes literal length in its high nibble and
// match length minus four in its low nibble. Offsets are unsigned little-endian.
const LIMIT = 256 * 1024 * 1024;
const HASH_BITS = 16;
function word(bytes: Uint8Array, index: number): number {
  return bytes[index] | (bytes[index + 1] << 8) | (bytes[index + 2] << 16) | (bytes[index + 3] << 24);
}
function hash(value: number): number {
  return Math.imul(value, 0x9e3779b1) >>> (32 - HASH_BITS);
}
export function compressFast(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const size = bytes.length;
  if (size > LIMIT) throw new Error("Map compression input too large");
  if (!size) return new Uint8Array();
  const output = new Uint8Array(size + Math.floor(size / 255) + 16);
  const positions = new Int32Array(1 << HASH_BITS).fill(-1);
  let source = 0,
    anchor = 0,
    target = 0,
    misses = 0;
  const extension = (length: number) => {
    while (length >= 255) {
      output[target++] = 255;
      length -= 255;
    }
    output[target++] = length;
  };
  // Standard block tail: leave five final literals and start the last match
  // at least twelve bytes before the end.
  while (source <= size - 12) {
    const value = word(bytes, source),
      slot = hash(value),
      previous = positions[slot];
    positions[slot] = source;
    if (previous < 0 || source - previous > 65535 || word(bytes, previous) !== value) {
      // Accelerate long incompressible runs without changing block grammar.
      source += 1 + (misses++ >>> 6);
      continue;
    }
    misses = 0;
    let length = 4;
    while (source + length < size - 5 && bytes[previous + length] === bytes[source + length]) length++;
    const literals = source - anchor,
      match = length - 4;
    output[target++] = (Math.min(literals, 15) << 4) | Math.min(match, 15);
    if (literals >= 15) extension(literals - 15);
    if (literals <= 16) {
      for (let i = 0; i < literals; i++) output[target + i] = bytes[anchor + i];
    } else output.set(bytes.subarray(anchor, source), target);
    target += literals;
    const offset = source - previous;
    output[target++] = offset & 255;
    output[target++] = offset >>> 8;
    if (match >= 15) extension(match - 15);
    source += length;
    anchor = source;
    if (source <= size - 12) positions[hash(word(bytes, source - 2))] = source - 2;
  }
  const literals = size - anchor;
  output[target++] = Math.min(literals, 15) << 4;
  if (literals >= 15) extension(literals - 15);
  if (literals <= 16) {
    for (let i = 0; i < literals; i++) output[target + i] = bytes[anchor + i];
  } else output.set(bytes.subarray(anchor), target);
  target += literals;
  return output.slice(0, target);
}
export function decompressFast(bytes: Uint8Array, rawLength: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(rawLength) || rawLength < 0 || rawLength > LIMIT)
    throw new Error("Invalid map decompression length");
  const output = new Uint8Array(rawLength);
  let source = 0,
    target = 0;
  function length(initial: number): number {
    if (initial !== 15) return initial;
    let value = initial,
      extra: number;
    do {
      if (source >= bytes.length) throw new Error("Truncated map length");
      extra = bytes[source++];
      value += extra;
      if (value > rawLength) throw new Error("Map decompression exceeds section length");
    } while (extra === 255);
    return value;
  }
  while (source < bytes.length) {
    const token = bytes[source++];
    const literals = length(token >>> 4);
    if (source + literals > bytes.length) throw new Error("Truncated map literals");
    if (target + literals > rawLength) throw new Error("Map decompression exceeds section length");
    if (literals <= 16) {
      for (let i = 0; i < literals; i++) output[target + i] = bytes[source + i];
    } else output.set(bytes.subarray(source, source + literals), target);
    source += literals;
    target += literals;
    if (source === bytes.length) {
      if ((token & 15) !== 0) throw new Error("Invalid final map token");
      break;
    }
    if (source + 2 > bytes.length) throw new Error("Truncated map offset");
    const offset = bytes[source] | (bytes[source + 1] << 8);
    source += 2;
    if (!offset || offset > target) throw new Error("Invalid map match offset");
    const match = length(token & 15) + 4;
    if (target + match > rawLength) throw new Error("Map decompression exceeds section length");
    if (match <= 32) {
      // Forward copying permits matches overlapping their own output.
      for (let end = target + match; target < end; target++) output[target] = output[target - offset];
    } else {
      // Seed at most one existing period, then double the materialized prefix.
      // Each bulk copy reads only bytes already written, including offset-one runs.
      let available = Math.min(offset, match);
      output.copyWithin(target, target - offset, target - offset + available);
      target += available;
      let remaining = match - available;
      while (remaining) {
        const count = Math.min(available, remaining);
        output.copyWithin(target, target - available, target - available + count);
        target += count;
        available += count;
        remaining -= count;
      }
    }
  }
  if (target !== rawLength) throw new Error("Map decompression length mismatch");
  return output;
}
