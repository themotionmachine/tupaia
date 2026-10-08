// In-memory map history kept in Node (it survives page relaunches):
// - a named ring of whole-map snapshots (.map text from prepareMapData),
// - an auto-undo stack: every mutating tool pushes the state from BEFORE it ran,
// - a redo stack filled by undo,
// - the provenance of the map currently in the page.
// Each snapshot/undo entry owns a digest baseline key in the page (for map_info diffs).

export type ProvenanceKind = "boot" | "generated" | "file" | "shared" | "sketch" | "snapshot" | "unknown";

export interface Provenance {
  kind: ProvenanceKind;
  seed?: string | null;
  path?: string;
  /** shared: the version loaded. sketch: the shared version the sketch is based on. */
  sharedVersion?: number;
  /** sketch: the sketch opened from the Worker (`sketch-<slug>`) and its blob version. */
  sketchSlug?: string;
  sketchVersion?: number;
  sharedUpdatedBy?: string | null;
  sharedUpdatedAt?: string | null;
  fetchedAt?: string;
  /**
   * The page's window.mapId when this provenance was recorded. The app stamps a new id on every
   * generate and reads it back from the file on load, so a different id in the page means the map
   * was replaced by something that did not update provenance (eval, a failed generate, a relaunch).
   */
  mapId?: number | null;
  /** Snapshot/undo restore that produced this map (lineage stays with the restored provenance). */
  restoredFrom?: string;
  /** Mutating operations applied since the map was generated/loaded. */
  opsSince: number;
}

export interface Snapshot {
  id: number;
  label: string | null;
  at: string;
  bytes: number;
  text: string;
  provenance: Provenance;
  baselineKey: string;
  savedTo?: string;
}

export interface HistoryEntry {
  id: number;
  op: string;
  argsSummary: string;
  at: string;
  bytes: number;
  text: string;
  provenance: Provenance;
  baselineKey: string;
}

export interface UndoPlan {
  n: number;
  /** Entry whose text gets loaded (the state before the oldest undone op). */
  load: HistoryEntry;
  /** Undone entries, newest first. */
  undone: HistoryEntry[];
  /** Redo entries to push (state after each undone op), newest op first. */
  redo: HistoryEntry[];
}

export function cloneProv(p: Provenance): Provenance {
  return { ...p };
}

/** Short human summary of tool args for the undo list. */
export function summarizeArgs(args: unknown, max = 120): string {
  let s: string;
  try {
    s = JSON.stringify(args, (_k, v) => (typeof v === "string" && v.length > 60 ? `${v.slice(0, 57)}...` : v)) ?? "";
  } catch {
    s = String(args);
  }
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

export class SnapshotStore {
  readonly max: number;
  readonly undoDepth: number;
  #ring: Snapshot[] = [];
  #undo: HistoryEntry[] = [];
  #redo: HistoryEntry[] = [];
  #nextId = 1;
  #nextHist = 1;
  provenance: Provenance = { kind: "boot", opsSince: 0 };

  constructor(max: number, undoDepth: number) {
    this.max = max;
    this.undoDepth = undoDepth;
  }

  get snapshots(): readonly Snapshot[] {
    return this.#ring;
  }
  get undoStack(): readonly HistoryEntry[] {
    return this.#undo;
  }
  get redoStack(): readonly HistoryEntry[] {
    return this.#redo;
  }

  /** Adds a named snapshot; returns it plus baseline keys evicted from the ring. */
  add(text: string, label: string | null): { snap: Snapshot; evicted: string[] } {
    const id = this.#nextId++;
    const snap: Snapshot = {
      id,
      label,
      at: new Date().toISOString(),
      bytes: Buffer.byteLength(text),
      text,
      provenance: cloneProv(this.provenance),
      baselineKey: `snap:${id}`
    };
    this.#ring.push(snap);
    const evicted: string[] = [];
    while (this.#ring.length > this.max) {
      const old = this.#ring.shift();
      if (old) evicted.push(old.baselineKey);
    }
    return { snap, evicted };
  }

  /** Find by id (number or numeric string) or label (newest wins). */
  find(ref: number | string): Snapshot | undefined {
    if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
      const id = Number(ref);
      return this.#ring.find(s => s.id === id);
    }
    for (let k = this.#ring.length - 1; k >= 0; k--) if (this.#ring[k].label === ref) return this.#ring[k];
    return undefined;
  }

  drop(ref: number | string): Snapshot | undefined {
    const s = this.find(ref);
    if (s) this.#ring = this.#ring.filter(x => x !== s);
    return s;
  }

  latestSnapshot(): Snapshot | undefined {
    return this.#ring[this.#ring.length - 1];
  }

  /**
   * Newest state we can restore after a crash or hang: the newest of ring and undo entries by
   * time. An undo entry holds the state from BEFORE its op, so restoring one loses that op; a
   * snapshot loses every op recorded after it. lostOps names them (oldest first).
   */
  newestRestorable():
    | { kind: "snapshot" | "undo"; text: string; label: string; provenance: Provenance; lostOps: string[] }
    | undefined {
    const s = this.latestSnapshot();
    const u = this.#undo[this.#undo.length - 1];
    if (!s && !u) return undefined;
    if (s && (!u || s.at >= u.at)) {
      return {
        kind: "snapshot",
        text: s.text,
        label: `snapshot ${s.id}${s.label ? ` '${s.label}'` : ""}`,
        provenance: s.provenance,
        lostOps: this.#undo.filter(e => e.at > s.at).map(e => `${e.op} ${e.argsSummary}`)
      };
    }
    if (!u) return undefined;
    return {
      kind: "undo",
      text: u.text,
      label: `undo point before '${u.op}' (${u.at})`,
      provenance: u.provenance,
      lostOps: [`${u.op} ${u.argsSummary}`]
    };
  }

  /**
   * After newestRestorable() was loaded into a fresh page: an undo point that is now the current
   * state is popped (undoing to it again would do nothing), and redo entries are dropped (they
   * were relative to a page state that no longer exists). Returns the baseline keys dropped.
   */
  afterRestore(kind: "snapshot" | "undo"): string[] {
    const dropped: string[] = [];
    if (kind === "undo") {
      const top = this.#undo.pop();
      if (top) dropped.push(top.baselineKey);
    }
    for (const r of this.#redo) dropped.push(r.baselineKey);
    this.#redo = [];
    return dropped;
  }

  /** Push the pre-op state; clears redo. Returns baseline keys that fell off. */
  pushUndo(op: string, argsSummary: string, text: string): { entry: HistoryEntry; evicted: string[] } {
    const id = this.#nextHist++;
    const entry: HistoryEntry = {
      id,
      op,
      argsSummary,
      at: new Date().toISOString(),
      bytes: Buffer.byteLength(text),
      text,
      provenance: cloneProv(this.provenance),
      baselineKey: `undo:${id}`
    };
    this.#undo.push(entry);
    const evicted: string[] = [];
    while (this.#undo.length > this.undoDepth) {
      const old = this.#undo.shift();
      if (old) evicted.push(old.baselineKey);
    }
    for (const r of this.#redo) evicted.push(r.baselineKey);
    this.#redo = [];
    return { entry, evicted };
  }

  /**
   * Plan an undo of n steps given the current map text. Nothing changes until commitUndo,
   * so a failed load leaves the stacks intact.
   */
  planUndo(n: number, currentText: string): UndoPlan | undefined {
    if (!Number.isInteger(n) || n < 1 || n > this.#undo.length) return undefined;
    const undone = this.#undo.slice(-n).reverse(); // newest op first
    const redo: HistoryEntry[] = undone.map((e, k) => {
      const afterText = k === 0 ? currentText : undone[k - 1].text;
      const afterProv = k === 0 ? cloneProv(this.provenance) : cloneProv(undone[k - 1].provenance);
      return {
        id: e.id,
        op: e.op,
        argsSummary: e.argsSummary,
        at: e.at,
        bytes: Buffer.byteLength(afterText),
        text: afterText,
        provenance: afterProv,
        baselineKey: `redo:${e.id}`
      };
    });
    return { n, load: undone[undone.length - 1], undone, redo };
  }

  /** Apply a planned undo after the load succeeded. Returns baseline keys to drop. */
  commitUndo(plan: UndoPlan): string[] {
    this.#undo.splice(this.#undo.length - plan.n, plan.n);
    // push newest op first so redo pops the oldest undone op first
    for (const r of plan.redo) this.#redo.push(r);
    this.provenance = cloneProv(plan.load.provenance);
    return plan.undone.map(e => e.baselineKey);
  }

  /** Redo entries to replay, oldest undone op first. */
  planRedo(n: number): HistoryEntry[] | undefined {
    if (!Number.isInteger(n) || n < 1 || n > this.#redo.length) return undefined;
    return this.#redo.slice(-n).reverse();
  }

  /**
   * Apply a redo after loading entries[last].text; pushes matching undo entries. Returns the
   * new undo entries' baseline keys (oldest first; the first one is nextHistKey as it was before
   * the call, i.e. the page state before the redo) and the keys to drop (replayed redo entries
   * and undo entries evicted by the depth limit).
   */
  commitRedo(
    entries: HistoryEntry[],
    currentText: string
  ): { added: string[]; dropped: string[]; pairs: Array<{ from: number; to: number }> } {
    this.#redo.splice(this.#redo.length - entries.length, entries.length);
    const dropped = entries.map(e => e.baselineKey);
    const added: string[] = [];
    // redo entry id (= the original undo entry's id) -> id of the undo entry that replaces it
    const pairs: Array<{ from: number; to: number }> = [];
    let before = currentText;
    let beforeProv = cloneProv(this.provenance);
    for (const e of entries) {
      const id = this.#nextHist++;
      const entry: HistoryEntry = {
        id,
        op: e.op,
        argsSummary: e.argsSummary,
        at: new Date().toISOString(),
        bytes: Buffer.byteLength(before),
        text: before,
        provenance: beforeProv,
        baselineKey: `undo:${id}`
      };
      this.#undo.push(entry);
      added.push(entry.baselineKey);
      pairs.push({ from: e.id, to: id });
      before = e.text;
      beforeProv = cloneProv(e.provenance);
    }
    while (this.#undo.length > this.undoDepth) {
      const old = this.#undo.shift();
      if (!old) break;
      dropped.push(old.baselineKey);
      const k = added.indexOf(old.baselineKey);
      if (k >= 0) added.splice(k, 1);
    }
    this.provenance = cloneProv(entries[entries.length - 1].provenance);
    return { added, dropped, pairs };
  }

  /** Baseline key the next undo entry will get (redo sets it before loading). */
  get nextHistKey(): string {
    return `undo:${this.#nextHist}`;
  }

  noteMutation(): void {
    this.provenance.opsSince++;
  }

  setProvenance(p: Omit<Provenance, "opsSince"> & { opsSince?: number }): void {
    this.provenance = { ...p, opsSince: p.opsSince ?? 0 };
  }

  /** Newest baseline key for map_info's default 'since': latest snapshot or undo point. */
  latestBaselineKey(): { key: string; describe: string } | undefined {
    const s = this.latestSnapshot();
    const u = this.#undo[this.#undo.length - 1];
    if (!s && !u) return undefined;
    if (s && (!u || s.at >= u.at))
      return { key: s.baselineKey, describe: `snapshot ${s.id}${s.label ? ` '${s.label}'` : ""}` };
    if (!u) return undefined;
    return { key: u.baselineKey, describe: `before '${u.op}' at ${u.at}` };
  }

  listing() {
    return {
      snapshots: this.#ring.map(s => ({
        index: s.id,
        label: s.label,
        at: s.at,
        bytes: s.bytes,
        origin: s.provenance.kind,
        savedTo: s.savedTo
      })),
      undo: [...this.#undo]
        .reverse()
        .map((e, k) => ({ n: k + 1, op: e.op, argsSummary: e.argsSummary, args: e.argsSummary, at: e.at })),
      redo: [...this.#redo]
        .reverse()
        .map((e, k) => ({ n: k + 1, op: e.op, argsSummary: e.argsSummary, args: e.argsSummary, at: e.at })),
      max: this.max,
      undoDepth: this.undoDepth
    };
  }
}
