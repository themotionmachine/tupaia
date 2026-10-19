// Exact .map history as shared immutable sections. Cell arrays share 128-cell blocks:
// a sparse paint retains changed blocks, not another copy of every array and the SVG.
// Versions have no parent pointers, so eviction releases blocks without a rebase chain.
const CELL_SECTIONS = new Set([7, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 24, 25, 26, 27, 40, 44]);
const CELLS_PER_BLOCK = 128;
const TEXT_BLOCK_SIZE = 16 * 1024;

interface Block {
  text: string;
  bytes: number;
}

export interface HistoryText {
  readonly blocks: readonly Block[];
  readonly bytes: number;
}

/** Detach slices from the multi-megabyte input backing string, preserving UTF-16 exactly. */
function ownText(text: string): string {
  return Buffer.from(text, "utf16le").toString("utf16le");
}

export class HistoryTextStore {
  #last: HistoryText | undefined;
  #entries = new WeakMap<object, HistoryText>();

  attach<T extends { text: string }>(entry: T, text: string): T {
    const encoded = this.encode(text);
    this.#entries.set(entry, encoded);
    Object.defineProperty(entry, "text", {
      enumerable: true,
      configurable: false,
      get: () => encoded.blocks.map(block => block.text).join("")
    });
    return entry;
  }

  encode(text: string): HistoryText {
    const prior = new Map(this.#last?.blocks.map(block => [block.text, block]));
    const blocks: Block[] = [];
    const add = (part: string) => {
      if (!part) return;
      let block = prior.get(part);
      if (!block) {
        block = { text: ownText(part), bytes: Buffer.byteLength(part) };
        prior.set(block.text, block);
      }
      blocks.push(block);
    };
    // Keep separators too: old files and arbitrary eval snapshots must restore byte-for-byte.
    // Only CRLF separates project sections; embedded SVG LF/CR stays in its section.
    // Arbitrary eval snapshots still preserve their line endings within text blocks.
    const sections = text.split(/(\r\n)/);
    for (let s = 0; s < sections.length; s++) {
      const section = sections[s];
      if (s % 2) {
        add(section);
        continue;
      }
      if (CELL_SECTIONS.has(s / 2)) {
        let start = 0;
        let cells = 0;
        for (let i = 0; i < section.length; i++) {
          if (section.charCodeAt(i) !== 44 || ++cells < CELLS_PER_BLOCK) continue;
          add(section.slice(start, i + 1));
          start = i + 1;
          cells = 0;
        }
        add(section.slice(start));
      } else {
        for (let i = 0; i < section.length; i += TEXT_BLOCK_SIZE) add(section.slice(i, i + TEXT_BLOCK_SIZE));
      }
    }
    const encoded = { blocks, bytes: Buffer.byteLength(text) };
    this.#last = encoded;
    return encoded;
  }

  /** UTF-8 payload bytes of retained blocks; excludes JS metadata and heap overhead. Text is not cached. */
  stats(entries: readonly object[]): { retainedBytes: number; logicalBytes: number; blocks: number } {
    const unique = new Set<Block>();
    let logicalBytes = 0;
    for (const entry of entries) {
      const encoded = this.#entries.get(entry);
      if (!encoded) continue;
      logicalBytes += encoded.bytes;
      for (const block of encoded.blocks) unique.add(block);
    }
    // The next capture's comparison index owns at most one additional version.
    for (const block of this.#last?.blocks ?? []) unique.add(block);
    return {
      retainedBytes: Array.from(unique).reduce((sum, block) => sum + block.bytes, 0),
      logicalBytes,
      blocks: unique.size
    };
  }
}
