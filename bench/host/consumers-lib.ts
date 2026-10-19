// Pure helpers for the consumers harness (bench/host/consumers.ts): save-section handling, header masking, pixel and
// byte comparison between the svg arm and the gpu arm, and the row summary. No browser, no I/O, so
// bench/host/consumers-lib.test.ts can prove each comparison can fail.
//
// Principle (PHASE1-PLAN D1, PROOF-PLAN G-S): every renderer-attributable claim is a comparison of the GPU arm against
// the SVG arm of the SAME world and build. An absolute property (46 sections, SVG at index 5) is asserted on both arms,
// never on the GPU arm alone, so a baseline quirk of the app is reported as such instead of as a GPU regression.
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { type Rgba, rgbDiff, ssim } from "../fidelity-metrics.ts";

// ---------------------------------------------------------------- the .map text format (src/io/save.ts)

/** The 46 sections of a text save, in order (src/io/save.ts `mapData`). Index 5 is the SVG (I3, I10). */
export const SECTION_NAMES = [
  "params", "settings", "coords", "biomes", "notes", "svg", "grid", "grid.h", "grid.prec", "grid.f", "grid.t", "grid.temp",
  "pack.features", "cultures", "states", "burgs", "cells.biome", "cells.burg", "cells.conf", "cells.culture", "cells.fl", "cells.pop",
  "cells.r", "road(deprecated)", "cells.s", "cells.state", "cells.religion", "cells.province", "crossroad(deprecated)", "religions",
  "provinces", "names", "rivers", "rulers", "fonts", "markers", "cells.routes", "routes", "zones", "ice",
  "cells.good", "goods", "markets", "deals", "cells.market", "customGoodIcons"
] as const;
export const SECTION_COUNT = 46;
export const SVG_SECTION = 5;

/** Split on CRLF: the SVG contains bare LF (I3), so a plain line split would be wrong. */
export const splitSections = (text: string): string[] => text.split("\r\n");

export interface HeaderFields {
  version: string;
  license: string;
  date: string;
  seed: string;
  width: string;
  height: string;
  mapId: string;
}

/**
 * The header is `VERSION|license|dateString|seed|graphWidth|graphHeight|mapId` (save.ts `params`). Two fields vary
 * between saves of the same map: field 2 is the calendar day (`getFullYear()-getMonth()+1-getDate()`) and the last
 * is `mapId`. The earlier harnesses masked only the last field and called it `savedAt`, but it is the map id (set
 * once at generation or load from the file), not a save time; the date went unmasked and would break a run that
 * crossed midnight. Both fields are masked here, under their real names.
 */
export function maskHeader(header: string): { masked: string; fields: HeaderFields | null } {
  const parts = header.split("|");
  if (parts.length !== 7) return { masked: header, fields: null };
  const [version, license, date, seed, width, height, mapId] = parts;
  return { masked: [version, license, "<date>", seed, width, height, "<map-id>"].join("|"), fields: { version, license, date, seed, width, height, mapId } };
}

/** The sections of a save with the header masked (declared normalization: the date and the map id). */
export function maskedSections(text: string): string[] {
  const sections = splitSections(text);
  if (sections.length) sections[0] = maskHeader(sections[0]).masked;
  return sections;
}

export interface TextDiff {
  offset: number;
  a: string;
  b: string;
  lengths: [number, number];
}

/** First difference between two strings with an excerpt on each side, or null when equal. */
export function firstDifference(a: string, b: string, context = 80): TextDiff | null {
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return null;
  return { offset: i, a: a.slice(Math.max(0, i - context), i + context * 2), b: b.slice(Math.max(0, i - context), i + context * 2), lengths: [a.length, b.length] };
}

export interface SectionDiff {
  index: number;
  name: string;
  diff: TextDiff;
}

export interface SaveComparison {
  equal: boolean;
  counts: [number, number];
  differing: SectionDiff[];
}

/** Section-by-section comparison with the header masked. `differing` lists every section that differs (capped). */
export function compareSaves(a: string, b: string, cap = 12): SaveComparison {
  const sa = maskedSections(a);
  const sb = maskedSections(b);
  const differing: SectionDiff[] = [];
  for (let i = 0; i < Math.max(sa.length, sb.length) && differing.length < cap; i++) {
    const diff = firstDifference(sa[i] ?? "", sb[i] ?? "");
    if (diff) differing.push({ index: i, name: SECTION_NAMES[i] ?? `section ${i}`, diff });
  }
  return { equal: sa.length === sb.length && !differing.length, counts: [sa.length, sb.length], differing };
}

export const describeSaveDiff = (c: SaveComparison): string =>
  c.equal
    ? "equal"
    : `${c.counts[0] !== c.counts[1] ? `section counts ${c.counts.join(" vs ")}; ` : ""}${c.differing.map(d => `#${d.index} ${d.name} @${d.diff.offset} (len ${d.diff.lengths.join(" vs ")})`).join(", ")}`;

export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

// ---------------------------------------------------------------- structure facts of a saved SVG (computed in the page)

/** What the page reads from the SVG section of a save (DOMParser). Compared across arms and asserted per arm. */
export interface SvgFacts {
  parsed: boolean;
  rootId: string | null;
  width: string | null;
  height: string | null;
  viewboxTransform: string | null; // I8: must be null
  rulerChildren: number | null; // I9: 0
  tradeChildren: number | null; // I9: 0
  tradeLayerOff: string | null; // I11: "1" only when the trade layer is off
  viewportCulled: number; // I9: 0
  emptyClassAttrs: number; // MCPFIX: culling must not leave class=""
  canvases: number; // no GPU canvas in a save
  gpuMarkers: number; // data-gpu-renderer / data-gpu attributes
  tempGroups: number; // I15: #temp staging groups present in the save
  tempLeak: boolean | null; // I15 probe: a node planted in a #temp staging group appears in the save
  elements: number;
}

export interface Check {
  row: number | string;
  id: string; // e.g. "save.sections", "export.png"
  name: string;
  status: "PASS" | "FAIL" | "INFO" | "SKIP";
  detail: string;
  evidence?: string; // path or key of the artifact that shows it
}

/**
 * Absolute properties of a saved SVG (asserted per arm, never only on the gpu arm):
 *   I8  canonical size on save (width/height = graph size) and no camera transform on #viewbox;
 *   I9  #ruler and #tradeAnimation emptied and no `viewport-culled` class (the class="" that label culling leaves on
 *       labels and emblem groups is reported as a baseline count, not gated: the SVG arm has it too);
 *   I11 trade `data-layer-off` only when the layer is off;
 * and that nothing of the gpu path (a canvas, a data-gpu attribute) reached the file.
 */
export function judgeSvgFacts(row: Check["row"], idPrefix: string, arm: string, f: SvgFacts, expect: { width: string; height: string; tradeOn: boolean }): Check[] {
  if (!f?.parsed) return [fail(row, `${idPrefix}.parsed`, `${arm}: the saved SVG parses as XML`, "DOMParser reported an error")];
  const at = (suffix: string) => `${idPrefix}.${suffix}`;
  return [
    verdict(f.rootId === "map", row, at("root"), `${arm}: the SVG root is svg#map`, `id ${JSON.stringify(f.rootId)}`),
    verdict(f.width === expect.width && f.height === expect.height, row, at("canonical-size"), `${arm}: I8 canonical width/height = graph size ${expect.width}x${expect.height}`, `got ${f.width}x${f.height}`),
    verdict(f.viewboxTransform === null, row, at("no-camera"), `${arm}: I8 #viewbox carries no camera transform`, `transform ${JSON.stringify(f.viewboxTransform)}`),
    verdict(f.rulerChildren === 0 && f.tradeChildren === 0, row, at("cleared"), `${arm}: I9 #ruler and #tradeAnimation are emptied`, `ruler ${f.rulerChildren}, trade ${f.tradeChildren}`),
    verdict(f.viewportCulled === 0, row, at("no-culled-class"), `${arm}: I9 no viewport-culled class in the file`, `${f.viewportCulled} elements`),
    info(row, at("empty-class-baseline"), `${arm}: elements saved with class="" (culling leftovers: labels, emblem groups; not gated, the arms are compared byte for byte instead)`, `${f.emptyClassAttrs} elements`),
    verdict(expect.tradeOn ? f.tradeLayerOff === null : f.tradeLayerOff === "1", row, at("trade-flag"), `${arm}: I11 trade data-layer-off matches the layer state (${expect.tradeOn ? "on" : "off"})`, `data-layer-off ${JSON.stringify(f.tradeLayerOff)}`),
    verdict(f.canvases === 0 && f.gpuMarkers === 0, row, at("no-gpu-content"), `${arm}: no canvas or gpu attribute in the file`, `canvases ${f.canvases}, gpu markers ${f.gpuMarkers}`)
  ];
}

export const pass = (row: Check["row"], id: string, name: string, detail = "", evidence?: string): Check => ({ row, id, name, status: "PASS", detail, evidence });
export const fail = (row: Check["row"], id: string, name: string, detail: string, evidence?: string): Check => ({ row, id, name, status: "FAIL", detail, evidence });
export const info = (row: Check["row"], id: string, name: string, detail: string, evidence?: string): Check => ({ row, id, name, status: "INFO", detail, evidence });
export const skip = (row: Check["row"], id: string, name: string, detail: string): Check => ({ row, id, name, status: "SKIP", detail });
export const verdict = (ok: boolean, row: Check["row"], id: string, name: string, detail = "", evidence?: string): Check => (ok ? pass(row, id, name, detail, evidence) : fail(row, id, name, detail, evidence));

/** Checks of a row: PASS only when none failed and at least one passed. SKIP and INFO never gate. */
export function rowStatus(checks: Check[], row: Check["row"]): "PASS" | "FAIL" | "SKIP" {
  const mine = checks.filter(c => String(c.row) === String(row));
  if (mine.some(c => c.status === "FAIL")) return "FAIL";
  return mine.some(c => c.status === "PASS") ? "PASS" : "SKIP";
}

// ---------------------------------------------------------------- pixels

export interface Pixels extends Rgba {
  data: Uint8Array;
}

export interface PixelComparison {
  equal: boolean; // every channel of every pixel, alpha included
  sizeEqual: boolean;
  sizes: [string, string];
  changedFraction?: number;
  over16Fraction?: number;
  maxDelta?: number;
  ssim?: number;
}

/** Composite over white, giving the opaque image the metrics require. */
export function flattenOverWhite(image: Pixels): Pixels {
  const out = new Uint8Array(image.data.length);
  for (let i = 0; i < image.data.length; i += 4) {
    const a = image.data[i + 3] / 255;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(image.data[i + c] * a + 255 * (1 - a));
    out[i + 3] = 255;
  }
  return { width: image.width, height: image.height, data: out };
}

/** Exact equality first; when unequal (or JPEG), the D1 style metrics over the opaque composite, for the report. */
export function comparePixels(a: Pixels, b: Pixels): PixelComparison {
  const sizes: [string, string] = [`${a.width}x${a.height}`, `${b.width}x${b.height}`];
  if (a.width !== b.width || a.height !== b.height) return { equal: false, sizeEqual: false, sizes };
  let equal = a.data.length === b.data.length;
  if (equal) for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) { equal = false; break; }
  if (equal) return { equal, sizeEqual: true, sizes };
  const fa = flattenOverWhite(a);
  const fb = flattenOverWhite(b);
  const d = rgbDiff(fa, fb);
  return { equal, sizeEqual: true, sizes, changedFraction: d.changedFraction, over16Fraction: d.over16Fraction, maxDelta: d.maxDelta, ssim: ssim(fa, fb).ssim };
}

/** The D1 thresholds (PROOF-PLAN §4) for a comparison that is not byte-exact. Conservative reading. */
export const withinD1 = (c: PixelComparison): boolean =>
  c.equal || (!!c.sizeEqual && (c.ssim ?? 0) >= 0.95 && (c.over16Fraction ?? 1) <= 0.01 && (c.changedFraction ?? 1) <= 0.005 && (c.maxDelta ?? 255) <= 44);

export const describePixels = (c: PixelComparison): string =>
  c.equal
    ? `pixel-identical (${c.sizes[0]})`
    : !c.sizeEqual
      ? `sizes differ ${c.sizes.join(" vs ")}`
      : `changed ${((c.changedFraction ?? 0) * 100).toFixed(3)}% over16 ${((c.over16Fraction ?? 0) * 100).toFixed(3)}% max ${c.maxDelta} ssim ${(c.ssim ?? 0).toFixed(4)}`;

// ---------------------------------------------------------------- zip (tiles)

/**
 * Entries of a zip archive, by name, via the central directory (stored and deflated entries; no zip64, no encryption).
 * JSZip (libs/jszip.min.js, used by exportToPngTiles) writes both a local header and a central directory.
 */
export function unzipTiles(bytes: Uint8Array): Array<[string, Uint8Array]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("not a zip archive: no end-of-central-directory record");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out: Array<[string, Uint8Array]> = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + compressed);
    if (method !== 0 && method !== 8) throw new Error(`zip entry ${name}: unsupported method ${method}`);
    if (!name.endsWith("/")) out.push([name, method === 0 ? raw : new Uint8Array(inflateRawSync(raw))]);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
