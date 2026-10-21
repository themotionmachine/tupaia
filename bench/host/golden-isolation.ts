// Page-side layer isolation for the per-layer golden (layer-golden.ts) and the SMOKE_ONLY_LAYER diagnostic of
// gpu-smoke.ts / gpu-fidelity.ts. Pass the function to page.evaluate; it must stay self-contained (it is serialised).
//
// Both arms of a golden are captured from this one DOM state (GPU canvas shown, then hidden), so the isolation is
// symmetric by construction as long as it only edits the live SVG, which both renderers read. It:
//   - hides every other direct child of #viewbox AND every other rendering child of svg#map (#scaleBar, #vignette,
//     #legend), which the old SMOKE_ONLY_LAYER code left visible in both arms, so overlay differences polluted every
//     layer's numbers;
//   - paints the backdrop on svg#map's PARENT and makes svg#map itself transparent, instead of prepending a <rect>
//     to #viewbox: the GPU clears to the first opaque background up the chain (renderer.ts clearColor) and the SVG
//     shows the parent through, so no extra element enters the scene the classifier and the census see. The colour
//     must not sit on svg#map: the compat lane rasterizes an export clone that keeps the root's inline style, so an
//     opaque root background would turn every compat raster into an opaque sheet over the native draws (seen: the
//     ocean pattern run hid the native ocean fill). `transparent` on the root is what compat sees normally anyway;
//   - never forces the target visible: a family is turned on through the app's own toggle first, so a layer the app
//     hides stays hidden in both arms and shows up as empty (a failure) instead of being drawn behind the app's back.
// Re-applying it is idempotent (zoom handlers may touch layer styles), and `id: null` hides everything (the blank).
// `restore: true` puts every inline display value and the background back.

export interface IsolateArgs {
  id: string | null;
  root?: boolean; // the family is a direct child of svg#map rather than of #viewbox
  bg?: string;
  restore?: boolean;
}

export function isolateLayer(args: IsolateArgs): { target: boolean; hidden: number } {
  const page = globalThis as any;
  const svg = document.querySelector<SVGSVGElement>("svg#map");
  const view = svg?.querySelector(":scope > #viewbox");
  if (!svg || !view) throw Error("isolateLayer: svg#map > #viewbox not found");
  const backdrop = svg.parentElement as HTMLElement;
  const state: { saved: Map<Element, string>; bg: [string, string, string, string] | null; applied: string | null } =
    (page.__goldenIsolation ??= { saved: new Map(), bg: null, applied: null });
  const put = (element: Element, value: string) => ((element as SVGElement).style.display = value);
  if (args.restore) {
    for (const [element, value] of state.saved) put(element, value);
    if (state.bg) {
      svg.style.setProperty("background-color", state.bg[0], state.bg[1]);
      backdrop.style.setProperty("background-color", state.bg[2], state.bg[3]);
    }
    delete page.__goldenIsolation;
    return { target: false, hidden: 0 };
  }
  const parent = args.root ? svg : view;
  const target = args.id ? parent.querySelector(`:scope > #${CSS.escape(args.id)}`) : null;
  if (args.id && !target) throw Error(`isolateLayer: missing layer #${args.id}`);
  const inert = new Set(["defs", "style", "script", "title", "desc", "metadata"]);
  const wanted = new Set<Element>();
  for (const element of view.children) if (element !== target) wanted.add(element);
  for (const element of svg.children) if (element !== view && element !== target && !inert.has(element.tagName)) wanted.add(element);
  for (const [element, value] of [...state.saved]) {
    if (wanted.has(element)) continue;
    put(element, value); // hidden for an earlier family, wanted back now
    state.saved.delete(element);
  }
  for (const element of wanted) {
    if (!state.saved.has(element)) state.saved.set(element, (element as SVGElement).style.display);
    if ((element as SVGElement).style.display !== "none") put(element, "none");
  }
  // set once per colour: re-writing the style attribute would be a mutation, and so a GPU re-prepare
  if (args.bg && state.applied !== args.bg) {
    const read = (el: HTMLElement | SVGElement) => [el.style.getPropertyValue("background-color"), el.style.getPropertyPriority("background-color")];
    state.bg ??= [...read(svg), ...read(backdrop)] as [string, string, string, string];
    svg.style.setProperty("background-color", "transparent", "important");
    backdrop.style.setProperty("background-color", args.bg, "important");
    state.applied = args.bg;
  }
  return { target: !!target, hidden: wanted.size };
}

// Sets the target family root's inline opacity (FAINT: the golden lifts a faint layer to opacity 0.99, and its self-test
// makes a normal layer faint). Page-side like isolateLayer, self-contained, and it only writes the live SVG, which both
// arms read. `value: null` puts every opacity this function changed back (the original inline value and priority,
// removed if there was none); the first change to an element records what was there. The element's `opacity` attribute
// is left alone: the inline style wins over it, as for the app's own opacity slider.
// `liftOnly`: only ever raise the opacity. When the element's COMPUTED opacity (inline style, attribute or inherited
// default) is already at `value` or above, nothing is written and `skipped` is true: the layer is faint by colour, not by
// opacity, so there is nothing to lift (an unchanged DOM would never make the GPU prepare again, and the caller must not
// wait for it to).
export interface OpacityArgs {
  id: string | null;
  root?: boolean;
  value: string | null;
  liftOnly?: boolean;
}
export function setLayerOpacity(args: OpacityArgs): { found: boolean; before: string; after: string; computed?: number; skipped?: boolean } {
  const page = globalThis as any;
  const svg = document.querySelector<SVGSVGElement>("svg#map");
  const view = svg?.querySelector(":scope > #viewbox");
  if (!svg || !view) throw Error("setLayerOpacity: svg#map > #viewbox not found");
  const saved: Map<SVGElement, [string, string]> = (page.__goldenOpacity ??= new Map());
  if (args.value === null) {
    for (const [element, [value, priority]] of saved) {
      if (value) element.style.setProperty("opacity", value, priority);
      else element.style.removeProperty("opacity");
    }
    saved.clear();
    return { found: false, before: "", after: "" };
  }
  const parent = args.root ? svg : view;
  const target = args.id ? parent.querySelector<SVGElement>(`:scope > #${CSS.escape(args.id)}`) : null;
  if (!target) return { found: false, before: "", after: "" };
  const before = target.style.getPropertyValue("opacity");
  const computed = Number.parseFloat(getComputedStyle(target).opacity);
  if (args.liftOnly && computed >= Number(args.value)) return { found: true, before, after: before, computed, skipped: true };
  if (!saved.has(target)) saved.set(target, [before, target.style.getPropertyPriority("opacity")]);
  if (before !== args.value) target.style.setProperty("opacity", args.value);
  return { found: true, before, after: target.style.getPropertyValue("opacity"), computed };
}
