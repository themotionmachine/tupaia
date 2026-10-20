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

// W3c: the canvas clears to the first painted background from svg#map up (renderer clearColor); `own` says whether
// that is the svg's own. A root filter grades the svg's own background with its content, but never an ancestor's:
// under a transparent svg the SVG arm is the filtered content composited over the ancestor, so the canvas must not
// clear to the ancestor's colour and then grade it with the frame (every anti-aliased edge would be blended before
// the filter instead of after it: the monochrome preset's population bars over a white page, 20 levels darker).
export function canvasBackdrop(backgrounds: ArrayLike<string>): {
  color: [number, number, number, number];
  own: boolean;
} {
  for (let i = 0; i < backgrounds.length; i++) {
    const match = backgrounds[i].match(/[\d.]+/g)?.map(Number);
    if (match && match.length >= 3 && (match[3] ?? 1) > 0)
      return { color: [match[0] / 255, match[1] / 255, match[2] / 255, match[3] ?? 1], own: i === 0 };
  }
  return { color: [1, 1, 1, 1], own: false };
}

// The id of the renderer's own copy of a root filter that ends over an ancestor's backdrop (backdropPrimitives).
export const ROOT_BACKDROP_FILTER = "gpu-root-filter-backdrop";

// The faint clear under the backdrop-ending copy (renderer frameClear): every canvas pixel the frame owns has some
// alpha, so the copy can tell the canvas's own area (painted) from nothing at all. A canvas hidden with
// visibility:hidden (a canonical preview) still runs its CSS filter on empty input, and a bare feFlood would then
// cover the SVG; flooding only where the canvas painted cannot. 1/255 of black under the frame moves a colour by at
// most one level.
export const BACKDROP_CLEAR: readonly [number, number, number, number] = [0, 0, 0, 1 / 255];

export interface FilterPrimitive {
  tag: string;
  attributes: Record<string, string>;
  children?: FilterPrimitive[];
}

// What the renderer appends to its copy of a forwarded root filter when the backdrop is an ancestor's
// (canvasBackdrop own = false): the canvas clears to BACKDROP_CLEAR, its copy of the filter grades what the frame
// drew, and these primitives composite that over the backdrop colour, flooded where the canvas painted, in sRGB, as
// the page composites the filtered svg over its ancestor; the canvas stays an opaque cover. `lastResult` names the
// source's last primitive's output. Null for a filter without primitives.
export function backdropPrimitives(
  source: FilterSource,
  backdrop: readonly [number, number, number, number]
): { lastResult: string; primitives: FilterPrimitive[] } | null {
  const children = Array.from(source.children);
  if (!children.length) return null;
  const lastResult = children[children.length - 1].getAttribute("result") || "gpu-filtered";
  const [r, g, b] = backdrop.slice(0, 3).map(v => Math.round(Math.min(1, Math.max(0, v)) * 255));
  const srgb = { "color-interpolation-filters": "sRGB" };
  return {
    lastResult,
    primitives: [
      {
        tag: "feComponentTransfer",
        attributes: { in: "SourceAlpha", result: "gpu-painted" },
        children: [{ tag: "feFuncA", attributes: { type: "linear", slope: "255", intercept: "0" } }]
      },
      {
        tag: "feFlood",
        attributes: {
          "flood-color": `rgb(${r}, ${g}, ${b})`,
          "flood-opacity": String(backdrop[3]),
          result: "gpu-flood",
          ...srgb
        }
      },
      {
        tag: "feComposite",
        attributes: { in: "gpu-flood", in2: "gpu-painted", operator: "in", result: "gpu-backdrop", ...srgb }
      },
      { tag: "feComposite", attributes: { in: lastResult, in2: "gpu-backdrop", operator: "over", ...srgb } }
    ]
  };
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
