// Pure prepare/settle scheduling decisions for GpuRenderer (no DOM, timers or GL), unit-tested in motion.test.ts.
// A full prepare is main-thread work (seconds on large worlds, with long synchronous chunks), so it never starts or
// completes while a gesture moves a drawable frame: it is deferred, not dropped, and runs once motion settles (an
// exact camera, or the renderer's idle watchdog when no update arrives for MOTION_IDLE ms).
import type { MutationLike } from "./markers";

export const MOTION_IDLE = 1000;

export interface PrepareState {
  preparing: boolean;
  lost: boolean;
  hasFrame: boolean; // a drawable prepared frame exists (a replaced/restored world has none and must prepare)
  moving: boolean;
  suspended: boolean; // an open editor hides the canvas (a frame could never be shown)
}

// "defer" records the prepare as wanted; the next settle runs it. "suspend" records it as wanted for the editor's close.
// A frame-less renderer still runs under an editor: its first frame or world must not wait on a dialog.
export function prepareStart(state: PrepareState): "skip" | "suspend" | "defer" | "run" {
  if (state.preparing || state.lost) return "skip";
  if (state.suspended && state.hasFrame) return "suspend";
  return state.moving && state.hasFrame ? "defer" : "run";
}

export interface PrepareJob {
  generation: number;
  revision: number;
  hadFrame: boolean;
}

export interface RendererNow {
  generation: number;
  revision: number;
  moving: boolean;
  lost: boolean;
  disposed: boolean;
  suspended: boolean;
}

// Why an in-flight prepare must stop at its next checkpoint; "motion" leaves the previous frame drawing and the job
// wanted again at settle. A job without a previous frame keeps going during motion: nothing else could be drawn.
// "suspended": an editor opened mid-job; the previous frame stays and the job is wanted again when the editor closes.
export function prepareStale(job: PrepareJob, now: RendererNow): "" | "superseded" | "motion" | "suspended" {
  if (job.generation !== now.generation || job.revision !== now.revision || now.lost || now.disposed)
    return "superseded";
  if (job.hadFrame && now.suspended) return "suspended";
  return job.hadFrame && now.moving ? "motion" : "";
}

export interface SettleState {
  wanted: boolean; // a prepare was deferred or aborted for motion
  revisionCurrent: boolean; // prepared.revision === revision
  bucketCurrent: boolean; // prepared.bucket === bucket()
  refinable: boolean; // the frame has world compat runs
}

export function settleAction(state: SettleState): "prepare" | "refine" | "none" {
  if (state.wanted || !state.revisionCurrent || !state.bucketCurrent) return "prepare";
  return state.refinable ? "refine" : "none";
}

// Short description of the record that forced a full prepare (telemetry; locates unexpected DOM writes).
export function describeMutation(record: MutationLike): string {
  const { target } = record;
  const what = record.type === "attributes" ? `@${record.attributeName}` : record.type;
  const parent = target.parentElement?.id ? ` in #${target.parentElement.id}` : "";
  return `${what} <${target.tagName ?? "#text"}${target.id ? `#${target.id}` : ""}>${parent}`;
}
