// The durable state dir, TUPAIA_OUT/state: what a server needs to carry its work over a restart
// (idle exit, stop, crash) to the next server that uses the same TUPAIA_OUT.
//
//   state.json      history index (snapshots, undo, redo, the page after the newest call and its
//                   provenance, epoch counters), the active sketch (ops log, base, saved marks)
//                   and the screenshot counter; HMAC-signed, written atomically (temp + rename)
//                   after every call that can change any of it
//   blobs/<sha>.map the map texts it names, content-addressed (written once, pruned when unused)
//   owner.json      the pid that writes here: one server at a time. A daemon claims it at start,
//                   a stdio server on its first tool call (an idle stdio server never holds it);
//                   one that could not claim it retries on every call and takes over once the
//                   owner has exited (resume.ts ensureState)
//
// TUPAIA_OUT/provenance.key (0600, outside state/ so wiping the state keeps lineage) is the HMAC
// key of state.json and of .map provenance trailers: a file signed under another TUPAIA_OUT loads
// as 'foreign' unless that key is copied over.
//
// TUPAIA_STATE=off turns persistence and resume off. TUPAIA_SNAPSHOTS_MAX (entries, default 40)
// and TUPAIA_SNAPSHOTS_MAX_MB (default 512) cap the persisted history; the oldest go first.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import type { ShotRecord } from "./context.ts";
import { pidAlive } from "./daemon-state.ts";
import { hasFixedText } from "./history-text.ts";
import { hmac } from "./map-provenance.ts";
import type { Sketch } from "./ops.ts";
import type { HistoryEntry, HistoryState, RestorePoint, Snapshot } from "./snapshots.ts";

export const STATE_DIR = "state";
export const STATE_FILE = "state.json";
const KEY_FILE = "provenance.key";
const OWNER_FILE = "owner.json";
const BLOBS = "blobs";
export const STATE_SCHEMA = 1;

export function stateDirOf(outDir: string): string {
  return path.join(outDir, STATE_DIR);
}

/** Write via a temp file and rename, so a reader never sees half a file. */
export function writeAtomic(file: string, data: string | Buffer, mode?: number): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** This TUPAIA_OUT's HMAC key file (outside state/: deleting the state dir keeps it). */
export function keyFileOf(outDir: string): string {
  return path.join(outDir, KEY_FILE);
}

/** This TUPAIA_OUT's HMAC key (made on first use, 0600). */
export function provenanceKey(outDir: string): Buffer {
  fs.mkdirSync(outDir, { recursive: true });
  const file = keyFileOf(outDir);
  // the first builds kept it in state/: move it out (same key, so earlier files stay valid)
  const old = path.join(stateDirOf(outDir), KEY_FILE);
  if (!fs.existsSync(file) && fs.existsSync(old)) {
    try {
      fs.renameSync(old, file);
    } catch {
      // another process moved it
    }
  }
  const read = (): Buffer | null => {
    try {
      const k = Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
      return k.length >= 32 ? k : null;
    } catch {
      return null;
    }
  };
  const have = read();
  if (have) return have;
  const fresh = crypto.randomBytes(32);
  try {
    fs.writeFileSync(file, fresh.toString("hex"), { mode: 0o600, flag: "wx" });
    return fresh;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  // another process made it first, or it is unreadable: use theirs, else replace it
  const theirs = read();
  if (theirs) return theirs;
  writeAtomic(file, fresh.toString("hex"), 0o600);
  return fresh;
}

type Stored<T> = Omit<T, "text"> & { blob: string };

interface StateFile {
  schema: number;
  savedAt: string;
  pid: number;
  transport: string;
  reason?: string;
  history: Omit<HistoryState, "ring" | "undo" | "redo" | "restorePoint"> & {
    ring: Stored<Snapshot>[];
    undo: Stored<HistoryEntry>[];
    redo: Stored<HistoryEntry>[];
    restorePoint: Stored<RestorePoint> | null;
  };
  sketch: (Omit<Sketch, "baseText"> & { baseBlob: string | null }) | null;
  shotSeq: number;
  /** The newest screenshot records (compare/view by id after a restart). */
  shots?: ShotRecord[];
  /** History entries left out by the caps. */
  pruned?: number;
  sig?: string;
}

export interface Resumed {
  history: HistoryState;
  sketch: Sketch | null;
  shotSeq: number;
  shots: ShotRecord[];
  savedAt: string;
  pid: number;
  transport: string;
  reason: string | null;
  pruned: number;
  /** Entries whose map text was missing or damaged (left out). */
  dropped: string[];
}

export class StateStore {
  readonly dir: string;
  readonly enabled: boolean;
  /** This process writes the state dir (claim() succeeded). */
  owner = false;
  /** Why this process does not persist (or the last persist failed), for session. */
  note: string | null = null;
  /** The live process that writes the state dir instead of this one (claim() failed), or null. */
  heldBy: number | null = null;
  /** claim() was tried at least once. */
  tried = false;
  readonly #key: Buffer;
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  /** text: null when the owner's text is fixed (hasFixedText): never re-read, never held twice. */
  readonly #hashes = new WeakMap<object, { text: string | null; hash: string }>();
  readonly #onDisk = new Set<string>();
  #last = "";
  #ownerFile: string;

  constructor(config: Config, key: Buffer) {
    this.dir = stateDirOf(config.outDir);
    this.enabled = config.stateEnabled;
    this.#key = key;
    this.#maxEntries = config.persistMax;
    this.#maxBytes = config.persistMaxMb * 1024 * 1024;
    this.#ownerFile = path.join(this.dir, OWNER_FILE);
    if (!this.enabled) this.note = "TUPAIA_STATE=off: nothing is persisted or resumed";
  }

  get file(): string {
    return path.join(this.dir, STATE_FILE);
  }

  /** Become the writer of the state dir unless a live process already is. */
  claim(): boolean {
    if (!this.enabled) return false;
    if (this.owner) return true;
    this.tried = true;
    fs.mkdirSync(path.join(this.dir, BLOBS), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(this.#ownerFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), {
          flag: "wx",
          mode: 0o600
        });
        this.owner = true;
        this.heldBy = null;
        if (this.note?.startsWith("another server")) this.note = null;
        process.once("exit", () => this.release());
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      let pid = 0;
      try {
        pid = Number((JSON.parse(fs.readFileSync(this.#ownerFile, "utf8")) as { pid?: unknown }).pid) || 0;
      } catch {
        pid = 0;
      }
      if (pid === process.pid) {
        this.owner = true;
        return true;
      }
      if (pid && pidAlive(pid)) {
        this.heldBy = pid;
        this.note = `another server (pid ${pid}) writes ${this.dir}, so this one does not persist its history or sketch yet; it takes over on its first call after that server exits (or give each server its own TUPAIA_OUT)`;
        return false;
      }
      fs.rmSync(this.#ownerFile, { force: true });
    }
    return false;
  }

  release(): void {
    if (!this.owner) return;
    try {
      const pid = Number((JSON.parse(fs.readFileSync(this.#ownerFile, "utf8")) as { pid?: unknown }).pid);
      if (pid === process.pid) fs.rmSync(this.#ownerFile, { force: true });
    } catch {
      // gone already
    }
    this.owner = false;
  }

  #sign(body: Omit<StateFile, "sig">): string {
    return hmac(this.#key, JSON.stringify(body));
  }

  /**
   * sha256 of `text`, cached per owning object (entries never change their text). A history
   * entry's text is a getter over shared blocks (history-text.ts): reading it rebuilds the whole
   * map, so a cached hash is trusted without reading it, and the string is not kept.
   */
  #hashOf(owner: object, text: () => string): string {
    const c = this.#hashes.get(owner);
    const isFixed = hasFixedText(owner);
    if (c && isFixed) {
      if (c.text !== null) this.#hashes.set(owner, { text: null, hash: c.hash });
      return c.hash;
    }
    const t = text();
    if (c && c.text === t) return c.hash;
    const hash = crypto.createHash("sha256").update(t).digest("hex");
    this.#hashes.set(owner, { text: isFixed ? null : t, hash });
    return hash;
  }

  #blobFile(hash: string): string {
    return path.join(this.dir, BLOBS, `${hash}.map`);
  }

  #putBlob(hash: string, text: () => string): void {
    if (this.#onDisk.has(hash)) return;
    const f = this.#blobFile(hash);
    if (!fs.existsSync(f)) writeAtomic(f, text());
    this.#onDisk.add(hash);
  }

  /** The persisted state, verified, or null (none, disabled, not ours). Rejects a tampered file. */
  load(): Resumed | { error: string } | null {
    if (!this.owner || !fs.existsSync(this.file)) return null;
    let st: StateFile;
    try {
      st = JSON.parse(fs.readFileSync(this.file, "utf8")) as StateFile;
    } catch (e) {
      return this.#reject(`unreadable (${(e as Error).message})`);
    }
    const { sig, ...body } = st;
    if (st.schema !== STATE_SCHEMA) return this.#reject(`schema ${String(st.schema)} is not ${STATE_SCHEMA}`);
    if (typeof sig !== "string" || sig !== this.#sign(body)) return this.#reject("its signature does not match");
    const dropped: string[] = [];
    const text = (hash: string | null | undefined, what: string): string | null => {
      if (!hash) return null;
      try {
        const t = fs.readFileSync(this.#blobFile(hash), "utf8");
        if (crypto.createHash("sha256").update(t).digest("hex") === hash) {
          this.#onDisk.add(hash);
          return t;
        }
      } catch {
        // missing
      }
      dropped.push(what);
      return null;
    };
    const entries = <T extends { text: string }>(list: Stored<T>[], what: string): T[] => {
      const out: T[] = [];
      for (const e of list ?? []) {
        const t = text(e.blob, `${what} ${String((e as { id?: unknown }).id ?? "?")}`);
        if (t === null) continue;
        const { blob: _b, ...rest } = e;
        const full = { ...rest, text: t } as unknown as T;
        this.#hashes.set(full, { text: t, hash: e.blob });
        out.push(full);
      }
      return out;
    };
    const h = st.history;
    let restorePoint: RestorePoint | null = null;
    if (h.restorePoint) {
      const t = text(h.restorePoint.blob, "the page map");
      if (t !== null) {
        const { blob: _b, ...rest } = h.restorePoint;
        // never reused as a fresh page read (another process, another page)
        restorePoint = { ...rest, text: t, writes: -1, launches: -1, callSeq: -1 };
        this.#hashes.set(restorePoint, { text: t, hash: h.restorePoint.blob });
      }
    }
    // undo entries must stay contiguous from the newest: one that is gone cuts off the older ones
    const undo = entries<HistoryEntry>(h.undo, "undo entry");
    const contiguous = h.undo.length === undo.length ? undo : undo.slice(undo.length - this.#contiguousTail(h.undo));
    let sketch: Sketch | null = null;
    if (st.sketch) {
      const { baseBlob, ...rest } = st.sketch;
      const baseText = baseBlob ? (text(baseBlob, "the sketch base") ?? "") : "";
      sketch = { ...rest, baseText } as Sketch;
      if (baseBlob && baseText) this.#hashes.set(sketch, { text: baseText, hash: baseBlob });
    }
    this.#last = JSON.stringify({ ...body, savedAt: "" });
    return {
      history: {
        ring: entries<Snapshot>(h.ring, "snapshot"),
        undo: contiguous,
        redo: entries<HistoryEntry>(h.redo, "redo entry"),
        nextId: h.nextId,
        nextHist: h.nextHist,
        tick: h.tick,
        epochSeq: h.epochSeq,
        provenance: h.provenance,
        restorePoint
      },
      sketch,
      shotSeq: st.shotSeq ?? 0,
      shots: Array.isArray(st.shots) ? st.shots : [],
      savedAt: st.savedAt,
      pid: st.pid,
      transport: st.transport,
      reason: st.reason ?? null,
      pruned: st.pruned ?? 0,
      dropped
    };
  }

  /** How many of the newest undo entries have their blob (stops at the first missing one). */
  #contiguousTail(list: Stored<HistoryEntry>[]): number {
    let n = 0;
    for (let k = list.length - 1; k >= 0; k--) {
      if (!this.#onDisk.has(list[k].blob)) break;
      n++;
    }
    return n;
  }

  #reject(why: string): { error: string } {
    const moved = `${this.file}.rejected-${Date.now()}`;
    try {
      fs.renameSync(this.file, moved);
    } catch {
      // leave it
    }
    return { error: `${this.file} was not resumed: ${why} (kept as ${path.basename(moved)})` };
  }

  /**
   * Write the state (only when something changed since the last write). Returns true when it
   * wrote. Throws on I/O errors (the caller reports them).
   */
  save(
    history: HistoryState,
    sketch: Sketch | null,
    shotSeq: number,
    meta: { transport: string; reason?: string },
    shots: ShotRecord[] = []
  ): boolean {
    if (!this.enabled || !this.owner) return false;
    // the caps: oldest history entries first (redo entries are the newest states)
    type Item = { list: "ring" | "undo" | "redo"; e: Snapshot | HistoryEntry };
    const items: Item[] = [
      ...history.ring.map(e => ({ list: "ring" as const, e })),
      ...history.undo.map(e => ({ list: "undo" as const, e })),
      ...history.redo.map(e => ({ list: "redo" as const, e }))
    ];
    items.sort((a, b) => (a.e.tick ?? Number.POSITIVE_INFINITY) - (b.e.tick ?? Number.POSITIVE_INFINITY));
    let bytes = items.reduce((n, i) => n + i.e.bytes, 0);
    const skip = new Set<object>();
    for (const i of items) {
      if (items.length - skip.size <= this.#maxEntries && bytes <= this.#maxBytes) break;
      skip.add(i.e);
      bytes -= i.e.bytes;
    }
    // texts are read only to hash a new entry or write a missing blob
    const used = new Map<string, () => string>();
    const ref = <T extends { text: string }>(e: T): Stored<T> => {
      const read = () => e.text;
      const hash = this.#hashOf(e, read);
      used.set(hash, read);
      // every field but text (a rest pattern would read the text getter)
      const rest: Record<string, unknown> = {};
      for (const k of Object.keys(e)) if (k !== "text") rest[k] = (e as Record<string, unknown>)[k];
      return { ...rest, blob: hash } as Stored<T>;
    };
    const keep = <T extends Snapshot | HistoryEntry>(list: T[]) => list.filter(e => !skip.has(e)).map(e => ref(e));
    // undo entries are dropped oldest first, so the kept ones stay contiguous
    const rp = history.restorePoint;
    let sk: StateFile["sketch"] = null;
    if (sketch) {
      const { baseText, ...rest } = sketch;
      let baseBlob: string | null = null;
      if (baseText) {
        baseBlob = this.#hashOf(sketch, () => baseText);
        used.set(baseBlob, () => baseText);
      }
      sk = { ...rest, baseBlob };
    }
    const body: Omit<StateFile, "sig"> = {
      schema: STATE_SCHEMA,
      savedAt: "",
      pid: process.pid,
      transport: meta.transport,
      ...(meta.reason ? { reason: meta.reason } : {}),
      history: {
        ring: keep(history.ring),
        undo: keep(history.undo),
        redo: keep(history.redo),
        nextId: history.nextId,
        nextHist: history.nextHist,
        tick: history.tick,
        epochSeq: history.epochSeq,
        provenance: history.provenance,
        restorePoint: rp ? ref(rp) : null
      },
      sketch: sk,
      shotSeq,
      ...(shots.length ? { shots } : {}),
      ...(skip.size ? { pruned: skip.size } : {})
    };
    const cmp = JSON.stringify(body);
    if (cmp === this.#last) return false;
    for (const [hash, text] of used) this.#putBlob(hash, text);
    body.savedAt = new Date().toISOString();
    const signed: StateFile = { ...body, sig: this.#sign(body) };
    writeAtomic(this.file, JSON.stringify(signed), 0o600);
    this.#last = cmp;
    this.#gc(new Set(used.keys()));
    return true;
  }

  /** Remove blobs nothing references any more. */
  #gc(used: Set<string>): void {
    const dir = path.join(this.dir, BLOBS);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const hash = n.replace(/\.map$/, "");
      if (n.endsWith(".map") && !used.has(hash)) {
        fs.rmSync(path.join(dir, n), { force: true });
        this.#onDisk.delete(hash);
      } else if (n.endsWith(".tmp")) {
        // a temp file a killed writer left (never ours: ours are renamed at once)
        try {
          if (Date.now() - fs.statSync(path.join(dir, n)).mtimeMs > 60_000)
            fs.rmSync(path.join(dir, n), { force: true });
        } catch {
          // gone
        }
      }
    }
  }
}
