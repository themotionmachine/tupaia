// W5: the svg-cover (src/gpu/svg-cover.ts) is armed at rest from the first GPU frame, so every check that compares a
// GPU arm with an SVG arm from ONE page now runs under it. These helpers keep that honest:
//   - readCover(page): what the cover is doing now (page side; read right before a shot);
//   - coverProblems(gpu, svg): the GPU arm must be under an armed cover wherever the cover applies (an opaque frame
//     covering the whole SVG, an eligible model), and the SVG arm, shot with the canvas hidden, must never be: hiding
//     the canvas reveals the model synchronously (HiddenEmblemCulling's observer), so a covered SVG arm would mean
//     the reference was blank, not the SVG;
// DOM census reads (computed visibility, checkVisibility) that must see the model's canonical visibility while the
// canvas shows go through window.gpuCanonicalVisibility (renderer.ts), inlined in each page function since page
// functions are serialized: `(globalThis.gpuCanonicalVisibility ?? (f => f()))(() => ...)`.
// Pure apart from readCover, so `node --test bench/host/cover-state.test.ts` pins the verdict rules.
import type { Page } from "playwright";

export interface CoverState {
  gpu: boolean; // a GPU renderer is present on the page (false: an svg page, nothing to judge)
  canvasShown: boolean; // canvas display != none and visibility != hidden
  optedOut: boolean; // ?gpu-svg-cover=0 (the renderer reports cover null)
  armed: boolean;
  active: boolean;
  wanted: boolean;
  enabled: boolean; // HiddenEmblemCulling: an opaque frame on a canvas that covers the whole SVG
  issue: string; // why the model is not eligible ("" = eligible)
  viewboxVisibility: string | null; // computed visibility of svg#map > #viewbox
}

/** Page side: the cover state now. */
export function coverStateProbe(): CoverState {
  const w = globalThis as any;
  const gpu = w.rendererStatus?.()?.gpu ?? null;
  const renderer = w.gpuRenderer ?? null;
  const canvas = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
  const css = canvas ? getComputedStyle(canvas) : null;
  const culling = renderer?.emblemCulling?.status?.() ?? null;
  const cover = gpu?.cover ?? null;
  const viewbox = document.querySelector("svg#map > #viewbox");
  return {
    gpu: !!renderer && !!gpu,
    canvasShown: !!css && css.display !== "none" && css.visibility !== "hidden",
    optedOut: !!renderer && !!gpu && cover === null,
    armed: !!cover?.armed,
    active: !!cover?.active,
    wanted: !!cover?.wanted,
    enabled: !!culling?.enabled,
    issue: String(cover?.issue ?? ""),
    viewboxVisibility: viewbox ? getComputedStyle(viewbox).visibility : null
  };
}

export const readCover = (page: Page): Promise<CoverState> => page.evaluate(coverStateProbe);

/** Whether the cover applies to this GPU-arm state: what the renderer would cover (fail-closed otherwise). */
export function coverApplies(state: CoverState): boolean {
  return state.gpu && state.canvasShown && !state.optedOut && state.enabled && state.issue === "";
}

/**
 * Problems with the cover around one pair of shots: `gpu` read before the GPU shot (canvas shown), `svg` before the SVG
 * shot (canvas hidden). Empty = honest. A cover that does not apply (opted out, a filtered or transparent canvas, an
 * ineligible model) is not a problem: the renderer fails closed and the model paints, as it should.
 */
export function coverProblems(gpu: CoverState | null, svg: CoverState | null): string[] {
  const problems: string[] = [];
  if (gpu?.gpu && gpu.canvasShown && !gpu.optedOut) {
    if (!gpu.armed) problems.push("svg-cover: not armed at rest under a shown GPU frame (W5 arms it at the first frame)");
    else if (coverApplies(gpu) && !gpu.active) problems.push("svg-cover: applies (opaque frame, eligible model) but is not active in the GPU arm");
  }
  if (svg?.gpu && (svg.active || (svg.viewboxVisibility !== null && svg.viewboxVisibility !== "visible")))
    problems.push(`svg-cover: the SVG arm was shot under the cover (active ${svg.active}, #viewbox visibility ${svg.viewboxVisibility}): the reference would not be the SVG`);
  return problems;
}

