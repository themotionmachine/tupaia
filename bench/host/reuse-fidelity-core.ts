// Verdicts for the compat reuse fidelity check (bench/host/reuse-fidelity.ts). No I/O, no DOM.
//
// Compat raster reuse (src/gpu/compat-reuse.ts) keeps a run's raster across prepares when nothing that can reach its
// pixels changed. Its failure mode is a stale raster: an edit the tracker missed, drawn from pixels cut before it. The
// check makes that visible per layer family: the family is isolated, an edit is applied, and the frame that reused
// the family's rasters across the edit is measured against the SVG of the same DOM state (D1, GPU against SVG, never
// GPU against GPU). The same state is then prepared with no reuse at all and measured against the SVG again: the
// reused frame must be as close to the SVG as the fresh one (the on-state margins of the toggle census), and inside D1
// when the fresh one is. A cell where no raster of the family was reused is reported, not judged: it proves nothing.
import { judgeOnStateFidelity, type OnStateMetrics } from "./census-core.ts";

export interface ReuseObservation {
  edit: string;
  family: string;
  layerId: string;
  // reuse telemetry of the prepare that drew the measured frame (lastPrepare.reuse)
  kept: { worldKept: number; keptLayers: string[] } | null;
  // the fresh control: no raster may be reused there
  freshKept: number | null;
  reused: OnStateMetrics;
  fresh: OnStateMetrics;
  gpu: { active: string | null; timedOut?: boolean; fallbackReason?: string };
  // the `definition` edit only: how many pixels of the SVG arm the edit changed (isolated family, before vs after). A
  // definition edit proves nothing unless it is visible, and whether the raster was kept is not the point: the frame after
  // it must show the new definition, kept or re-cut. Absent for the other edits.
  visiblePx?: number;
}

// An edit of a definition must change at least this many SVG pixels of the isolated family to count as exercised.
export const DEFINITION_VISIBLE_PX = 100;

export type ReuseVerdict = { status: "PASS" | "FAIL" | "INFO"; problems: string[]; exercised: boolean };

export function judgeReuse(o: ReuseObservation): ReuseVerdict {
  const label = `${o.edit}/${o.family}`;
  const definition = o.visiblePx !== undefined;
  const exercised = definition ? o.visiblePx! >= DEFINITION_VISIBLE_PX : !!o.kept?.keptLayers.includes(o.layerId);
  const problems: string[] = [];
  if (o.freshKept !== null && o.freshKept > 0) problems.push(`${label}: the fresh control reused ${o.freshKept} raster(s)`);
  if (!exercised) {
    if (problems.length) return { status: "FAIL", problems, exercised };
    return {
      status: "INFO",
      problems: [definition ? `${label}: the definition edit changed ${o.visiblePx} SVG px of #${o.layerId} (needs ${DEFINITION_VISIBLE_PX})` : `${label}: no raster of #${o.layerId} was reused across the edit`],
      exercised
    };
  }
  problems.push(...judgeOnStateFidelity({ label, before: o.fresh, after: o.reused, gpu: o.gpu }));
  return { status: problems.length ? "FAIL" : "PASS", problems, exercised };
}

// A cell that raced a redraw is not a measurement: it is a failure (the check retried and could not get a still frame).
export function judgeRaced(label: string, raced: readonly string[]): string[] {
  return raced.length ? [`${label}: the canvas redrew while its screenshot was taken, in every attempt (${raced.join(", ")}); not measured`] : [];
}

// An edit no family's cell reused across proves nothing: the check would pass vacuously.
export function judgeExercised(edit: string, verdicts: ReuseVerdict[]): string[] {
  return verdicts.some(v => v.exercised) ? [] : [`${edit}: no family ${edit === "definition" ? "showed a visible definition edit" : "reused a raster across the edit"} (check is vacuous)`];
}
