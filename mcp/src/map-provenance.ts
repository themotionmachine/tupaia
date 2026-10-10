// Lineage that survives a .map file: save_map and the exit save append one trailing line
//
//   \r\n#tupaia-provenance {json}
//
// after the app's own 46 lines. The app splits a file by CRLF and reads lines 0-45 by index, so
// it ignores the extra line (old and new builds alike); a save from the app drops it. The block
// names where the map came from (lineage, shared base version, sketch slug and its ops log, ops
// since) and carries the sha256 of the map content before the trailer plus an HMAC over the block
// with this TUPAIA_OUT's key (TUPAIA_OUT/provenance.key, 0600). A file edited after the save fails the
// content hash; a copied or hand-written block fails the HMAC: both load as unrelated. A valid
// block's base is then checked against the shared map server (state.ts has the key).
import crypto from "node:crypto";
import zlib from "node:zlib";
import type { Provenance, ProvenanceKind } from "./snapshots.ts";

export const PROV_MARK = "#tupaia-provenance ";
const SEP = `\r\n${PROV_MARK}`;
export const PROV_SCHEMA = 1;

export interface ProvBase {
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Size of the base blob (checked against the retained version's size). */
  bytes?: number;
  /** sha256 of the base blob (checked while it is the shared map's current version). */
  sha256?: string;
}

export interface ProvSketch {
  slug: string;
  note: string | null;
  created: string;
  baseCounts: Record<string, number>;
  recording: boolean;
  /** Op count, and the log itself (sanitized again on load) unless it was too big. */
  ops: number;
  log: unknown[] | null;
  blockers: string[];
  saved: { version: number | null; at: string; dirty: boolean } | null;
}

export interface ProvBlock {
  v: number;
  savedAt: string;
  by: string;
  /** TUPAIA_LIVE_ORIGIN of the server that wrote it. */
  origin: string | null;
  lineage: "shared" | "none";
  kind: ProvenanceKind;
  seed: string | null;
  base: ProvBase | null;
  opsSince: number;
  sketch: ProvSketch | null;
  /** save_map compact:true: removed records are stubs (counted as one op since the base). */
  compacted?: boolean;
  /** sha256 of the map content (the file before the trailer line). */
  sha256: string;
  sig?: string;
}

export function hmac(key: Buffer, text: string): string {
  return crypto.createHmac("sha256", key).update(text).digest("hex");
}

function sha256(s: string | Buffer): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** `text` plus the signed trailer line. */
export function withTrailer(text: string, block: Omit<ProvBlock, "sha256" | "sig" | "v">, key: Buffer): string {
  const body: ProvBlock = { v: PROV_SCHEMA, ...block, sha256: sha256(Buffer.from(text, "utf8")) };
  const sig = hmac(key, JSON.stringify(body));
  // "<" escaped: the app finds the map SVG with a regex over the whole file
  const json = JSON.stringify({ ...body, sig }).replace(/</g, "\\u003c");
  return `${text}${SEP}${json}`;
}

export type TrailerCheck =
  | { status: "none" }
  | { status: "modified" | "foreign" | "bad"; reason: string; block?: ProvBlock }
  | { status: "valid"; block: ProvBlock };

/** The map text of a file (plain or gzip), or null for anything else (base64). */
function textOf(bytes: Buffer): string | null {
  try {
    const buf = bytes[0] === 0x1f && bytes[1] === 0x8b ? zlib.gunzipSync(bytes) : bytes;
    const head = buf.toString("utf8", 0, 16);
    return head.includes("|") ? buf.toString("utf8") : null;
  } catch {
    return null;
  }
}

/** Read and verify a file's trailer: valid only when the content hash and the HMAC both match. */
export function checkTrailer(bytes: Buffer, key: Buffer): TrailerCheck {
  const text = textOf(bytes);
  if (text === null) return { status: "none" };
  const at = text.lastIndexOf(SEP);
  if (at < 0) return { status: "none" };
  const raw = text.slice(at + SEP.length).trim();
  if (raw.includes("\n")) return { status: "none" };
  let block: ProvBlock;
  try {
    block = JSON.parse(raw) as ProvBlock;
  } catch (e) {
    return { status: "bad", reason: `the provenance line is not JSON (${(e as Error).message})` };
  }
  if (!block || typeof block !== "object" || block.v !== PROV_SCHEMA || typeof block.sha256 !== "string")
    return { status: "bad", reason: `unknown provenance schema ${String((block as { v?: unknown })?.v)}` };
  if (sha256(Buffer.from(text.slice(0, at), "utf8")) !== block.sha256)
    return {
      status: "modified",
      reason: "the map content changed after it was saved (its sha256 differs from the one recorded)",
      block
    };
  const { sig, ...unsigned } = block;
  const want = hmac(key, JSON.stringify(unsigned));
  if (
    typeof sig !== "string" ||
    sig.length !== want.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))
  )
    return {
      status: "foreign",
      reason:
        "the provenance was not written by this TUPAIA_OUT's server (signature mismatch: another output directory's key, or a copied or edited block)",
      block
    };
  return { status: "valid", block };
}

/** The shared base a provenance claims (shared/sketch with a version), or null. */
export function baseOf(p: Provenance): ProvBase | null {
  if ((p.kind !== "shared" && p.kind !== "sketch") || typeof p.sharedVersion !== "number") return null;
  return {
    version: p.sharedVersion,
    updatedAt: p.sharedUpdatedAt ?? null,
    updatedBy: p.sharedUpdatedBy ?? null,
    ...(typeof p.sharedBytes === "number" ? { bytes: p.sharedBytes } : {}),
    ...(p.sharedSha256 ? { sha256: p.sharedSha256 } : {})
  };
}
