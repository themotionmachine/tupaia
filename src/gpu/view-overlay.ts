// ---- PANEND (W4b): the in-place lane for view overlays (markers.ts VIEW_OVERLAYS: #coordinates).
//
// drawCoordinates (public/modules/ui/layers.js) removes and re-appends the whole #coordinates subtree at every exact
// camera update: the graticule <path> (non-scaling stroke: the same `d` at the same scale) and one <text> per grid line
// pinned to the viewport's top and left edges. Every pan therefore used to end in a full re-prepare. When the new
// subtree differs from the one the frame was prepared from only in its labels' x/y (same scale, same step, same text),
// the frame is patched instead:
// - compat runs and labels are pointed at the new nodes (same DOM order and shape, so the raster of the graticule run
//   is unchanged and later refinements resolve the live nodes);
// - each label is laid out again at the frame's bucket into the renderer's atlas, which must already hold every glyph
//   (no atlas growth, the atlas generation the frame was laid out at), with the same instance count, and the glyph
//   instance buffer is re-uploaded;
// - its hit items are replaced in place (PickIndex.replaceRange: same count, same paint order);
// - the GLYPHZ fine set is dropped (its atlas is gone; the next settle re-cuts it).
// Anything else (another scale, a label that would route to compat, a compat run holding a label, no snapshot) is
// "full": the caller makes it a revision, as before.
import { type CompatRoot, compatShapes, pickTolerance } from "./compat-pick";
import type { GpuDevice } from "./device";
import { PickIndex } from "./pick";
import type { Prepared } from "./prepare";
import { GLYPH_FLOATS, type GlyphAtlas, layoutLabels } from "./text";

// The view-overlay subtree a frame was prepared from: every element in DOM order (root first) and its signature.
export interface ViewSnapshot {
  root: Element;
  nodes: Element[];
  signature: string;
}

// The subtree as markup with every <text>'s own x and y left out (the only attributes drawCoordinates pins to the
// viewport), so two draws at the same scale compare equal.
export function viewSignature(root: Element): string {
  const copy = root.cloneNode(true) as Element;
  for (const text of copy.querySelectorAll("text")) {
    text.removeAttribute("x");
    text.removeAttribute("y");
  }
  return copy.outerHTML;
}

export function snapshotView(root: Element): ViewSnapshot {
  return { root, nodes: [root, ...root.querySelectorAll("*")], signature: viewSignature(root) };
}

export interface ViewContext {
  device: GpuDevice;
  atlas: GlyphAtlas;
  viewbox: SVGGraphicsElement;
  screen: { dpr: number };
  camera: { k: number };
  stale(): boolean;
}

export type ViewRefresh = { outcome: "committed"; snapshot: ViewSnapshot } | { outcome: "stale" | "full"; why: string };

// Patches `prepared` for the live `root` against `before`, the snapshot of the subtree it was prepared from.
export async function refreshView(
  prepared: Prepared,
  before: ViewSnapshot | undefined,
  root: Element,
  ctx: ViewContext
): Promise<ViewRefresh> {
  const full = (why: string): ViewRefresh => ({ outcome: "full", why });
  if (!before || before.root !== root || !root.isConnected) return full("no snapshot");
  const after = snapshotView(root);
  if (after.signature !== before.signature || after.nodes.length !== before.nodes.length) return full("changed");
  const moved = new Map<Element, Element>();
  before.nodes.forEach((node, i) => {
    if (node !== after.nodes[i]) moved.set(node, after.nodes[i]);
  });
  if (!moved.size) return { outcome: "committed", snapshot: after };
  const inside = new Set(before.nodes);
  // a compat raster that holds a label (or the whole layer) would keep the old positions
  for (const run of prepared.runs)
    for (const element of run.elements)
      if (inside.has(element) && (element.tagName.toLowerCase() === "text" || element.querySelector("text")))
        return full("label in a compat run");
  const labels = prepared.glyphLabels ?? [];
  const patched = labels.filter(label => moved.has(label.element));
  const texts = before.nodes.filter(node => node.tagName.toLowerCase() === "text" && moved.has(node));
  if (patched.length !== texts.length) return full("label not native");
  const { payload } = prepared;
  if (patched.some(label => !label.pick && prepared.picking !== false)) return full("no hit range");
  if (ctx.atlas.generation !== payload.atlasGeneration || !prepared.frame.glyphs) return full("atlas replaced");
  // lay out first, then check, then write: nothing is changed unless every label fits
  const size = ctx.atlas.size;
  const laid: Float32Array[] = [];
  for (const label of patched) {
    const element = moved.get(label.element) as SVGTextElement;
    const batch = await layoutLabels([element], prepared.bucket, ctx.atlas);
    if (ctx.stale()) return { outcome: "stale", why: "stale" };
    if (batch.failed.length) return full(`label ${batch.failed[0].reason}`);
    if (batch.count !== label.count) return full("instance count");
    laid.push(batch.instances);
  }
  if (ctx.atlas.size !== size) return full("atlas grew");
  if (prepared.picking !== false) {
    const tolerance = pickTolerance(prepared.bucket, ctx.screen.dpr, ctx.camera.k);
    const hits = patched.map(label =>
      compatShapes(moved.get(label.element) as unknown as CompatRoot, ctx.viewbox, tolerance)
    );
    // every label's new hit items must match its range before any is replaced
    const fits = patched.every((label, i) => {
      const scratch = new PickIndex(1, 1);
      for (const shape of hits[i]) scratch.addShape("", shape);
      return scratch.size === label.pick![1];
    });
    if (!fits) return full("hit items");
    for (const [i, label] of patched.entries())
      prepared.pick.replaceRange(label.pick![0], label.pick![1], (index, layer) => {
        for (const shape of hits[i]) index.addShape(layer, shape);
      });
  }
  patched.forEach((label, i) => {
    payload.glyphs.set(laid[i], label.first * GLYPH_FLOATS);
    label.element = moved.get(label.element) as SVGTextElement;
  });
  ctx.device.updateBuffer(prepared.frame.glyphs, payload.glyphs);
  for (const run of prepared.runs) run.elements = run.elements.map(element => moved.get(element) ?? element);
  const { frame } = prepared;
  if (frame.fineGlyphs || frame.fineAtlas) {
    ctx.device.release(frame.fineGlyphs ?? null);
    ctx.device.release(frame.fineAtlas ?? null);
    frame.fineGlyphs = frame.fineAtlas = null;
    frame.fineScale = 0;
  }
  return { outcome: "committed", snapshot: after };
}
