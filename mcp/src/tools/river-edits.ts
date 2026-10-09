// River structure edits ride on the edit tool: edit river {mainStem, split, merge, reroute, end,
// joinAt} is
// implemented page-side in src/bridge-ext/rivers.js. This module defines no tool; server.ts
// imports every tools/*.ts, so it registers their replay metadata at startup:
// - mainStem holds a river ref ({ref, expect, name} in the resolved form), and so does joinAt
//   ({ref, at:{cell}, cells}: the river joined and the literal path), which replay maps when the
//   sketch created that river (a split reports the river it created, like add);
// - replay safety needs no id check: before/after of a structural field is the river's course
//   ("<n> cells <source>-><mouth> #<cell hash>", no river ids), so a river someone else re-cut is
//   a both-changed conflict; mainStem's literal carries the course it must produce (`expect`), so
//   a re-cut tributary or a repeated swap is refused; a repeated split is refused (the cell is
//   the source now); a repeated reroute, end or joinAt is a no-op success with a note;
// - the sketch log gets one readable phrase per structural op (EDIT_FIELD_SUMMARIES).
import { EDIT_FIELD_SUMMARIES, EDIT_REF_FIELDS, type EditResolved } from "../ops.ts";

EDIT_REF_FIELDS.river = { ...(EDIT_REF_FIELDS.river ?? {}), mainStem: "river", joinAt: "river" };

type Op = EditResolved["ops"][number];

interface Course {
  n: number;
  source: number;
  mouth: number;
}

function course(v: unknown): Course | null {
  const m = /^(\d+) cells (-?\d+)->(-?\d+)/.exec(typeof v === "string" ? v : "");
  return m ? { n: Number(m[1]), source: Number(m[2]), mouth: Number(m[3]) } : null;
}

const short = (v: unknown, n = 40): string => {
  const s = String(v ?? "");
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const num = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? String(v) : "?");

EDIT_FIELD_SUMMARIES.river = {
  ...(EDIT_FIELD_SUMMARIES.river ?? {}),
  mainStem: (o: Op) => {
    const v = obj(o.set?.mainStem);
    const ref = typeof o.set?.mainStem === "number" ? o.set.mainStem : v.ref;
    const a = course(o.after?.mainStem);
    const b = course(o.before?.mainStem);
    if (!a || !b) return null;
    const who = v.name ? `"${short(v.name)}" (river ${num(ref)})` : `river ${num(ref)}`;
    return `main stem now follows ${who}: rises at cell ${a.source}, ${a.n} cells (was ${b.source}, ${b.n}); the old upper course is now river ${num(ref)}`;
  },
  split: (o: Op) => {
    const v = obj(o.set?.split);
    const a = course(o.after?.split);
    if (!a) return null;
    const cell = obj(v.at).cell;
    const name = v.name ? ` "${short(v.name)}"` : "";
    return `split at cell ${num(cell)}: the upper part is a new ${short(v.type ?? "river", 20)}${name}; this river now rises there (${a.n} cells)`;
  },
  merge: (o: Op) => {
    const b = course(o.before?.merge);
    return b ? `merged into the river it continues (its ${b.n} cells from cell ${b.source} now head that river)` : null;
  },
  end: (o: Op) => {
    const cell = obj(obj(o.set?.end).at).cell;
    const a = course(o.after?.end);
    const b = course(o.before?.end);
    if (!a || !b) return null;
    if (o.after?.end === o.before?.end) return `already ended at cell ${num(cell)} (unchanged)`;
    return `now ends at cell ${num(cell)}: ${b.n} -> ${a.n} cells, mouth ${b.mouth} -> ${a.mouth}`;
  },
  joinAt: (o: Op) => {
    const v = obj(o.set?.joinAt);
    const a = course(o.after?.joinAt);
    const b = course(o.before?.joinAt);
    if (!a || !b) return null;
    const at = num(obj(v.at).cell);
    if (o.after?.joinAt === o.before?.joinAt) return `already joined river ${num(v.ref)} at cell ${at} (unchanged)`;
    return `now joins river ${num(v.ref)} at cell ${at}: ${b.n} -> ${a.n} cells, mouth ${b.mouth} -> ${a.mouth}`;
  },
  reroute: (o: Op) => {
    const cells = obj(o.set?.reroute).cells;
    const a = course(o.after?.reroute);
    const b = course(o.before?.reroute);
    if (!Array.isArray(cells) || !cells.length || !a || !b) return null;
    if (o.after?.reroute === o.before?.reroute)
      return `reroute through ${cells.length} cells it already held (unchanged)`;
    const ends: string[] = [];
    if (a.source !== b.source) ends.push(`source ${b.source} -> ${a.source}`);
    if (a.mouth !== b.mouth) ends.push(`mouth ${b.mouth} -> ${a.mouth}`);
    return `rerouted through ${cells.length} cells (${num(cells[0])} -> ${num(cells[cells.length - 1])}): ${b.n} -> ${a.n} cells${ends.length ? `, ${ends.join(", ")}` : ""}`;
  }
};
