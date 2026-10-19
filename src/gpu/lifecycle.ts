// Pure show/hide decisions for GpuRenderer (no GL, timers or DOM reads of their own), unit-tested in
// lifecycle.test.ts. The renderer gathers the inputs; these functions decide whether a prepared frame may be on
// screen and why not. The canvas is hidden (canonical SVG shown) whenever one of these answers is not "".

// Customization (heightmap, states, cultures... edit modes) is a top-level `let` in classic main.js: a global binding,
// not a window property, and no DOM mutation announces it. The renderer polls it (IDLE_WATCH_MS) and reads it per query.
export const IDLE_WATCH_MS = 250;

// Why an editor owns the live SVG ("" = none): a customization mode wins over an open jQuery UI dialog.
export function editorState(customization: unknown, dialogShown: boolean): string {
  if (typeof customization === "number" && customization) return `editor customization ${customization}`;
  return dialogShown ? "editor dialog open" : "";
}

// Reads the bare global without a ReferenceError where main.js never ran (tests, workers).
export function customizationMode(): unknown {
  return typeof customization === "undefined" ? undefined : customization;
}

export interface VisibilityState {
  prepared: boolean; // a drawable frame exists
  lost: boolean; // the WebGL context is lost
  sourceCurrent: boolean; // the renderer's <svg> is still the document's #map (a load replaces it before map:loaded)
  printing: boolean; // between beforeprint and afterprint the canonical SVG is the page
  editor: string; // editorState()
  root: string; // rootFilter().refused
  markersPending: boolean; // a trade-marker symbol texture is still loading
}

// Why the prepared frame must not be shown now ("" = it may). Order: the most structural cause first, so telemetry
// names the reason that would still hold if the others cleared.
export function hiddenReason(state: VisibilityState): string {
  if (!state.sourceCurrent) return "source replaced";
  if (state.lost) return "context lost";
  if (!state.prepared) return "not prepared";
  if (state.printing) return "printing";
  if (state.editor) return state.editor;
  if (state.root) return state.root;
  return state.markersPending ? "trade markers loading" : "";
}

const URL_REFERENCE = /^url\(\s*["']?#([^"')\s]+)["']?\s*\)$/;
// Primitives that recolour each pixel in place. Anything spatial (blur, offset, turbulence, morphology...) could leave
// partial alpha at the canvas edges, through which the SVG below would show doubled.
const POINTWISE = new Set(["fecolormatrix", "fecomponenttransfer"]);

interface FilterNode {
  tagName: string;
  getAttribute(name: string): string | null;
  children?: ArrayLike<FilterNode>;
}

export interface FilterSource {
  tagName: string;
  children: ArrayLike<FilterNode>;
}

// The root <svg id=map> filter (the Style tab's map filters; the monochrome preset's url(#filter-grayscale)). The scene
// walk starts below the root, so the GPU frame never contains it: it is forwarded to the canvas as the same CSS
// filter (`css`, "" for none), which the browser applies to the composited canvas exactly as it applies it to the SVG.
// A filter the canvas cannot reproduce exactly is `refused` and the canonical SVG is shown instead.
export function rootFilter(
  value: string | null | undefined,
  lookup: (id: string) => FilterSource | null
): { css: string; refused: string } {
  const filter = (value || "").trim();
  if (!filter || filter === "none") return { css: "", refused: "" };
  const id = URL_REFERENCE.exec(filter)?.[1];
  if (!id) return { css: "", refused: `root filter ${filter}` };
  const element = lookup(id);
  // a dangling reference: browsers disagree on whether the SVG is then drawn unfiltered or not at all
  if (!element || element.tagName.toLowerCase() !== "filter") return { css: "", refused: `root filter #${id} missing` };
  const primitives = Array.from(element.children);
  for (const primitive of primitives) {
    const tag = primitive.tagName.toLowerCase();
    if (!POINTWISE.has(tag)) return { css: "", refused: `root filter #${id} <${primitive.tagName}>` };
    if (!keepsAlpha(primitive)) return { css: "", refused: `root filter #${id} alpha` };
  }
  return { css: `url("#${id}")`, refused: "" };
}

// A primitive that leaves alpha alone, so an opaque canvas stays opaque: feColorMatrix whose alpha row is the identity
// (or a type that never touches alpha), feComponentTransfer without a non-identity feFuncA.
function keepsAlpha(primitive: FilterNode): boolean {
  if (primitive.tagName.toLowerCase() === "fecomponenttransfer")
    return Array.from(primitive.children ?? []).every(
      fn => fn.tagName.toLowerCase() !== "fefunca" || (fn.getAttribute("type") || "identity") === "identity"
    );
  const type = primitive.getAttribute("type") || "matrix";
  if (type === "saturate" || type === "hueRotate") return true;
  if (type !== "matrix") return false; // luminanceToAlpha
  const values = (primitive.getAttribute("values") || "")
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  if (!values.length) return true; // identity
  if (values.length !== 20 || values.some(n => !Number.isFinite(n))) return false;
  return values.slice(15).join(" ") === "0 0 0 1 0";
}
