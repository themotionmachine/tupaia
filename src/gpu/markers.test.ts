import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classify,
  MARKER_FLOATS,
  type MarkerElementLike,
  type MutationLike,
  markerIssue,
  markerKind,
  type NodeLike,
  overlayRoot,
  writeMarker
} from "./markers";
import { type Affine, multiply, parseTransform } from "./raster";

const node = (tagName: string, parentElement: NodeLike | null, id = ""): NodeLike => ({
  tagName,
  id,
  parentElement,
  isConnected: true
});
const viewbox = node("g", null, "viewbox");
const layer = node("g", viewbox, "tradeAnimation");
const group = node("g", layer);
const use = node("use", group);
const roads = node("g", viewbox, "roads");

const attribute = (target: NodeLike, attributeName: string): MutationLike => ({
  type: "attributes",
  target,
  attributeName,
  addedNodes: [],
  removedNodes: []
});
const childList = (target: NodeLike, added: NodeLike[], removed: NodeLike[] = []): MutationLike => ({
  type: "childList",
  target,
  addedNodes: added,
  removedNodes: removed
});

describe("markerKind", () => {
  it("accepts only the two trade symbols", () => {
    expect(markerKind("#trade-marker-land")).toBe("land");
    expect(markerKind("#trade-marker-water")).toBe("water");
    expect(markerKind("#trade-marker-air")).toBeNull();
    expect(markerKind("trade-marker-land")).toBeNull();
    expect(markerKind("#trade-marker-land2")).toBeNull();
    expect(markerKind(null)).toBeNull();
  });
});

const element = (
  tagName: string,
  attributes: Record<string, string>,
  children: MarkerElementLike[] = []
): MarkerElementLike => ({ tagName, getAttribute: name => attributes[name] ?? null, children });
// what the D3 controller writes: one <use> of a trade symbol plus an invisible hit circle
const d3Group = (use: Record<string, string> = {}, group: Record<string, string> = {}) =>
  element("g", { transform: "translate(5, 6) rotate(30)", ...group }, [
    element("use", { href: "#trade-marker-water", width: "8", height: "8", x: "-4", y: "-4", ...use }),
    element("circle", { r: "3", fill: "none", stroke: "none", style: "cursor: pointer;" })
  ]);

describe("markerIssue", () => {
  it("accepts the controller's markers", () => {
    expect(markerIssue(d3Group())).toBeNull();
    expect(markerIssue(element("g", {}, [element("use", { "xlink:href": "#trade-marker-land" })]))).toBeNull();
    expect(markerIssue(element("g", {}, []))).toBeNull();
  });

  it("names unknown symbols instead of dropping them", () => {
    expect(markerIssue(d3Group({ href: "#trade-marker-air" }))).toBe("marker symbol #trade-marker-air");
    expect(markerIssue(element("g", {}, [element("use", {})]))).toBe("marker symbol (none)");
  });

  it("refuses effects the instanced pass cannot apply", () => {
    expect(markerIssue(d3Group({}, { filter: "url(#blur)" }))).toBe("marker group filter");
    expect(markerIssue(d3Group({}, { opacity: "0.5" }))).toBe("marker group opacity");
    expect(markerIssue(d3Group({}, { style: "cursor: pointer; mask: url(#m)" }))).toBe("marker group mask");
    expect(markerIssue(d3Group({ "clip-path": "url(#c)" }))).toBe("marker <use> clip-path");
    expect(markerIssue(d3Group({ style: "opacity: 0.3" }))).toBe("marker <use> opacity");
  });

  it("refuses other children, painted circles and unparsable transforms", () => {
    expect(markerIssue(element("g", {}, [element("path", { d: "M0 0" })]))).toBe("marker child <path>");
    expect(markerIssue(element("g", {}, [element("circle", { stroke: "none" })]))).toBe("painted marker circle");
    expect(markerIssue(element("g", {}, [element("circle", { fill: "none", stroke: "red" })]))).toBe(
      "painted marker circle"
    );
    expect(markerIssue(d3Group({}, { transform: "matrix(1 0" }))).toBe("marker transform unparsable");
    expect(markerIssue(d3Group({ transform: "skewQ(3)" }))).toBe("marker <use> transform unparsable");
  });
});

describe("writeMarker", () => {
  it("maps the centered <use> box through the D3 translate+rotate", () => {
    const m = multiply(parseTransform("translate(10, 20) rotate(90)")!, parseTransform(null)!);
    const out = new Float32Array(MARKER_FLOATS);
    expect(writeMarker(out, 0, m, { x: -5, y: -5, width: 10, height: 10 })).toBe(true);
    // origin = top-left corner after rotation; u follows +x rotated to +y, v follows +y rotated to -x
    [15, 15, 0, 10, -10, 0].forEach((value, i) => {
      expect(out[i]).toBeCloseTo(value);
    });
  });

  it("keeps non-uniform box size and root scale", () => {
    const m = multiply(parseTransform("scale(2)")!, parseTransform("translate(3, 4)")!);
    const out = new Float32Array(MARKER_FLOATS * 2);
    expect(writeMarker(out, MARKER_FLOATS, m, { x: -1, y: -2, width: 2, height: 4 })).toBe(true);
    expect(Array.from(out.subarray(0, MARKER_FLOATS))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(Array.from(out.subarray(MARKER_FLOATS))).toEqual([4, 4, 4, 0, 0, 8]);
  });

  it("rejects degenerate boxes and non-finite transforms", () => {
    const out = new Float32Array(MARKER_FLOATS);
    const identity = parseTransform(null)!;
    const broken: Affine = [1, 0, 0, 1, Number.POSITIVE_INFINITY, 0];
    expect(writeMarker(out, 0, identity, { x: 0, y: 0, width: 0, height: 4 })).toBe(false);
    expect(writeMarker(out, 0, identity, { x: 0, y: 0, width: 4, height: -1 })).toBe(false);
    expect(writeMarker(out, 0, identity, { x: Number.NaN, y: 0, width: 4, height: 4 })).toBe(false);
    expect(writeMarker(out, 0, broken, { x: 0, y: 0, width: 4, height: 4 })).toBe(false);
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe("classify", () => {
  it("ignores empty batches and the camera-owned viewbox transform", () => {
    expect(classify([])).toBe("none");
    expect(classify([attribute(viewbox, "transform")])).toBe("none");
  });

  it("treats marker ticks, spawns and removals as dynamic", () => {
    expect(classify([attribute(group, "transform")])).toBe("dynamic");
    expect(classify([attribute(use, "href")])).toBe("dynamic");
    expect(classify([childList(layer, [node("g", layer)])])).toBe("dynamic");
    expect(classify([childList(layer, [], [group])])).toBe("dynamic");
    expect(classify([childList(group, [node("circle", group)])])).toBe("dynamic");
    expect(classify([attribute(viewbox, "transform"), attribute(group, "transform")])).toBe("dynamic");
  });

  it("treats layer-level and unrelated changes as static", () => {
    expect(classify([childList(layer, [node("path", layer)])])).toBe("static");
    expect(classify([childList(layer, [node("g", layer)], [node("path", layer)])])).toBe("static");
    expect(classify([attribute(layer, "style")])).toBe("static");
    expect(classify([attribute(layer, "transform")])).toBe("static");
    expect(classify([attribute(node("g", roads), "transform")])).toBe("static");
    expect(classify([attribute(viewbox, "style")])).toBe("static");
  });

  it("lets one static record win over any number of dynamic ones", () => {
    const ticks = Array.from({ length: 50 }, () => attribute(group, "transform"));
    expect(classify([...ticks, attribute(roads, "opacity")])).toBe("static");
  });

  it("skips records on nodes detached later in the batch", () => {
    const detached = { ...node("path", null), isConnected: false };
    expect(classify([attribute(detached, "d")])).toBe("none");
    expect(classify([attribute(detached, "d"), attribute(group, "transform")])).toBe("dynamic");
  });
});

it("ignores rewritten attributes whose final value has not changed", () => {
  const target = { ...roads, getAttribute: (name: string) => (name === "opacity" ? "0.5" : null) };
  const unchanged = { ...attribute(target, "opacity"), oldValue: "0.5" };
  expect(classify([unchanged])).toBe("none");
  expect(classify([{ ...unchanged, oldValue: "1" }])).toBe("static");
});

describe("classify: pixel-neutral viewport decoration", () => {
  const element = (tagName: string, parent: NodeLike | null, attributes: Record<string, string>): NodeLike => ({
    ...node(tagName, parent),
    getAttribute: name => attributes[name] ?? null
  });
  const changed = (target: NodeLike, attributeName: string, oldValue: string | null): MutationLike => ({
    ...attribute(target, attributeName),
    oldValue
  });
  const hatch = (value: string) =>
    element("pattern", viewbox, { "data-zone-hatch-clone": "", patternTransform: value });
  const label = (value: string) => element("text", viewbox, { class: value });

  it("skips zone-hatch clone scale() rewrites and counts them", () => {
    const skipped: MutationLike[] = [];
    const record = changed(hatch("scale(0.25)"), "patternTransform", "scale(0.5)");
    expect(classify([record], undefined, r => skipped.push(r))).toBe("none");
    expect(skipped).toEqual([record]);
  });

  it("keeps non-scale hatch transforms and ordinary patterns static", () => {
    expect(classify([changed(hatch("rotate(45)"), "patternTransform", "scale(0.5)")])).toBe("static");
    expect(classify([changed(hatch("scale(2) rotate(45)"), "patternTransform", "scale(2)")])).toBe("static");
    const plain = element("pattern", viewbox, { patternTransform: "scale(0.25)" });
    expect(classify([changed(plain, "patternTransform", "scale(0.5)")])).toBe("static");
  });

  it("skips a camera scale change on a transformed clone only while the inherited tail is identical", () => {
    const rotated = changed(
      hatch("scale(0.2857142857142857) rotate(45 0 0)"),
      "patternTransform",
      "scale(0.125) rotate(45 0 0)"
    );
    expect(classify([rotated])).toBe("none");
    const custom = changed(
      hatch("scale(2e-1) scale(3) translate(4 5)"),
      "patternTransform",
      "scale(1) scale(3) translate(4 5)"
    );
    expect(classify([custom])).toBe("none");
    // semantic edits of the tail (angle, spacing, offset) still invalidate
    expect(
      classify([changed(hatch("scale(0.25) rotate(30 0 0)"), "patternTransform", "scale(0.5) rotate(45 0 0)")])
    ).toBe("static");
    expect(
      classify([changed(hatch("scale(0.25) rotate(45 0 0)"), "patternTransform", "scale(0.25) rotate(-45 0 0)")])
    ).toBe("static");
    expect(classify([changed(hatch("scale(0.25) scale(2)"), "patternTransform", "scale(0.25) scale(3)")])).toBe(
      "static"
    );
    expect(classify([changed(hatch("scale(0.25) rotate(45)"), "patternTransform", "scale(0.25)")])).toBe("static");
    // the camera term must stay a positive finite scale
    expect(classify([changed(hatch("scale(0) rotate(45)"), "patternTransform", "scale(0.5) rotate(45)")])).toBe(
      "static"
    );
    expect(classify([changed(hatch("scale(-1) rotate(45)"), "patternTransform", "scale(0.5) rotate(45)")])).toBe(
      "static"
    );
    expect(classify([changed(hatch("scale(0.25)rotate(45)"), "patternTransform", "scale(0.5)rotate(45)")])).toBe(
      "static"
    );
  });

  it("keeps user-config and original pattern transforms static even when only the scale changes", () => {
    const grid = element("pattern", viewbox, { id: "pattern_square", patternTransform: "scale(0.5) translate(1 2)" });
    expect(classify([changed(grid, "patternTransform", "scale(0.25) translate(1 2)")])).toBe("static");
    const original = element("pattern", viewbox, { id: "hatch1", patternTransform: "scale(0.5) rotate(45 0 0)" });
    expect(classify([changed(original, "patternTransform", "scale(0.25) rotate(45 0 0)")])).toBe("static");
    const marked = element("g", viewbox, { "data-zone-hatch-clone": "", patternTransform: "scale(0.5)" });
    expect(classify([changed(marked, "patternTransform", "scale(0.25)")])).toBe("static");
  });

  it("lets a semantic pattern edit in a batch of rotated camera rewrites win", () => {
    const camera = Array.from({ length: 12 }, () =>
      changed(hatch("scale(0.5) rotate(45 0 0)"), "patternTransform", "scale(0.25) rotate(45 0 0)")
    );
    const edit = changed(hatch("scale(0.5) rotate(30 0 0)"), "patternTransform", "scale(0.5) rotate(45 0 0)");
    expect(classify([...camera, edit, ...camera])).toBe("static");
    expect(classify([...camera, attribute(group, "transform")])).toBe("dynamic");
    expect(classify(camera)).toBe("none");
  });

  it("skips viewport-culled toggles but not hiding classes", () => {
    expect(classify([changed(label("burg viewport-culled"), "class", "burg")])).toBe("none");
    expect(classify([changed(label("burg"), "class", "burg viewport-culled")])).toBe("none");
    expect(classify([changed(label("burg hidden"), "class", "burg")])).toBe("static");
    // the scene draws culled elements regardless of display, so an uncull beside `hidden` would become visible
    expect(classify([changed(label("burg hidden"), "class", "burg hidden viewport-culled")])).toBe("static");
    expect(classify([changed(label("burg viewport-culled big"), "class", "burg")])).toBe("static");
  });

  it("skips dense-zoom overlays and their contents", () => {
    const overlay = element("g", viewbox, { "data-dense-zoom": "" });
    expect(classify([childList(viewbox, [overlay])])).toBe("none");
    expect(classify([childList(viewbox, [], [overlay])])).toBe("none");
    expect(classify([changed(overlay, "style", "display: none")])).toBe("none");
    expect(classify([changed(element("image", overlay, { href: "b" }), "href", "a")])).toBe("none");
    expect(classify([childList(viewbox, [overlay, element("path", viewbox, {})])])).toBe("static");
  });

  it("skips a dense-zoom overlay swapping its own content but not a plain sibling group", () => {
    const terrain = element("g", viewbox, { id: "terrain" });
    const overlay = element("g", terrain, { "data-dense-zoom": "" });
    const [next, previous] = [element("image", overlay, { href: "b" }), element("image", overlay, { href: "a" })];
    expect(classify([childList(overlay, [next], [previous])])).toBe("none");
    const plain = element("g", terrain, {});
    expect(classify([childList(plain, [element("use", plain, {})])])).toBe("static");
    expect(classify([childList(overlay, [next]), childList(terrain, [element("image", terrain, {})])])).toBe("static");
  });

  describe("dense-zoom visibility handoff on the canonical image", () => {
    afterEach(() => vi.unstubAllGlobals());
    const terrain = element("g", viewbox, { id: "terrain" });
    const relief = (attributes: Record<string, string>) =>
      element("image", terrain, { "data-relief": "[]", width: "10", ...attributes });
    const hidden = { style: "visibility: hidden;", "data-zoom-hidden": "", "data-zoom-visibility": '[null,"","",""]' };
    const show = (image: NodeLike, style: string | null = null) => [
      changed(image, "style", style),
      changed(image, "data-zoom-visibility", null),
      changed(image, "data-zoom-hidden", null)
    ];
    const parentVisibility = (visibility: string) => vi.stubGlobal("getComputedStyle", () => ({ visibility }));

    it("skips show and restore while the image stays drawn", () => {
      parentVisibility("visible");
      expect(classify(show(relief(hidden)))).toBe("none");
      const restored = relief({});
      expect(
        classify([
          changed(restored, "style", "visibility: hidden;"),
          changed(restored, "data-zoom-visibility", '[null,"","",""]'),
          changed(restored, "data-zoom-hidden", "")
        ])
      ).toBe("none");
      // other declarations survive the handoff unchanged, modulo CSSOM spacing
      expect(classify(show(relief({ ...hidden, style: "fill: red; visibility: hidden;" }), "fill:red"))).toBe("none");
    });

    it("keeps real visibility and style edits static", () => {
      parentVisibility("visible");
      // a user hiding the image, without the zoom marker
      expect(classify([changed(relief({ style: "visibility: hidden;" }), "style", null)])).toBe("static");
      // a co-written declaration change
      expect(classify(show(relief({ ...hidden, style: "opacity: 0.5; visibility: hidden;" })))).toBe("static");
      // the marker dropped while the style still hides the image
      expect(classify([changed(relief({ style: "visibility: hidden;" }), "data-zoom-hidden", "")])).toBe("static");
      // not a dense-zoom canonical image
      expect(classify(show(element("image", terrain, hidden)))).toBe("static");
    });

    it("compares against the inherited visibility and refuses when it is unknown", () => {
      parentVisibility("hidden");
      // under a hidden parent the marker makes the GPU draw an image it did not draw before
      expect(classify(show(relief(hidden)))).toBe("static");
      vi.stubGlobal("getComputedStyle", undefined);
      expect(classify(show(relief(hidden)))).toBe("static");
    });
  });

  it("lets any real change in a batch of neutral records win", () => {
    const neutral = Array.from({ length: 20 }, () => changed(hatch("scale(0.25)"), "patternTransform", "scale(0.5)"));
    expect(classify([...neutral, attribute(group, "transform")])).toBe("dynamic");
    expect(classify([...neutral, changed(label("burg hidden"), "class", "burg")])).toBe("static");
  });
});

describe("classify: screen-overlay lane", () => {
  const body = node("body", null);
  const map = node("svg", body, "map");
  const mapViewbox = node("g", map, "viewbox");
  const scaleBar = node("g", map, "scaleBar");
  const bar = node("g", scaleBar, "scaleBarBack");
  const tick = node("line", bar);
  const ruler = node("g", map, "ruler");
  const collect = () => {
    const roots: NodeLike[] = [];
    return { roots, overlay: (root: NodeLike) => roots.push(root) };
  };

  it("resolves the root svg#map child outside #viewbox", () => {
    expect(overlayRoot(scaleBar)).toBe(scaleBar);
    expect(overlayRoot(tick)).toBe(scaleBar);
    expect(overlayRoot(ruler)).toBe(ruler);
    expect(overlayRoot(map)).toBeNull();
    expect(overlayRoot(mapViewbox)).toBeNull();
    expect(overlayRoot(node("path", node("g", mapViewbox)))).toBeNull();
    expect(overlayRoot(node("pattern", node("defs", map)))).toBeNull();
    expect(overlayRoot(node("style", map))).toBeNull();
    expect(overlayRoot(node("g", node("svg", body, "other")))).toBeNull();
    expect(overlayRoot(null)).toBeNull();
  });

  it("routes scale-bar redraws, transforms and styles to the overlay lane with their root", () => {
    const { roots, overlay } = collect();
    const redraw = [childList(scaleBar, [node("g", scaleBar)], [bar]), attribute(scaleBar, "transform")];
    expect(classify([...redraw, attribute(tick, "style")], undefined, undefined, overlay)).toBe("overlay");
    expect(roots).toEqual([scaleBar, scaleBar, scaleBar]);
  });

  it("keeps overlay changes static for callers without an overlay lane", () => {
    expect(classify([attribute(scaleBar, "transform")])).toBe("static");
    expect(classify([childList(scaleBar, [node("g", scaleBar)])])).toBe("static");
  });

  it("orders precedence static > overlay > dynamic", () => {
    const { overlay } = collect();
    const redraw = attribute(scaleBar, "transform");
    expect(classify([redraw, attribute(group, "transform")], undefined, undefined, overlay)).toBe("overlay");
    expect(classify([attribute(group, "transform"), redraw], undefined, undefined, overlay)).toBe("overlay");
    expect(classify([redraw, attribute(roads, "opacity")], undefined, undefined, overlay)).toBe("static");
    expect(classify([attribute(roads, "opacity"), redraw], undefined, undefined, overlay)).toBe("static");
  });

  it("keeps canonical edits, root svg structure and #viewbox styles static", () => {
    const { roots, overlay } = collect();
    expect(classify([attribute(node("path", mapViewbox), "d")], undefined, undefined, overlay)).toBe("static");
    // adding or removing an overlay changes the prepared run list: a full prepare
    expect(classify([childList(map, [node("g", map, "scaleBar")])], undefined, undefined, overlay)).toBe("static");
    expect(classify([attribute(map, "style")], undefined, undefined, overlay)).toBe("static");
    expect(classify([attribute(mapViewbox, "style")], undefined, undefined, overlay)).toBe("static");
    expect(classify([attribute(node("g", node("defs", map)), "fill")], undefined, undefined, overlay)).toBe("static");
    expect(roots).toEqual([]);
  });
});

describe("classify: same-position raise pairs", () => {
  const cell = node("g", roads);
  const before = node("path", cell);
  const mark = node("use", cell);
  const other = node("use", cell);
  const pair = (removed: NodeLike, added: NodeLike, previousSibling: NodeLike | null, nextSibling: NodeLike | null) =>
    [
      { ...childList(cell, [], [removed]), previousSibling, nextSibling },
      { ...childList(cell, [added]), previousSibling, nextSibling }
    ] as MutationLike[];

  it("skips the removal and insertion of a no-op raise", () => {
    const skipped: MutationLike[] = [];
    const records = pair(mark, mark, before, null);
    expect(classify(records, undefined, r => skipped.push(r))).toBe("none");
    expect(skipped).toEqual(records);
  });

  it("keeps a real reorder static", () => {
    const next = node("path", cell);
    const records = [
      { ...childList(cell, [], [mark]), previousSibling: before, nextSibling: next },
      { ...childList(cell, [mark]), previousSibling: before, nextSibling: null }
    ];
    expect(classify(records)).toBe("static");
  });

  it("keeps a plain removal static", () => {
    expect(classify([{ ...childList(cell, [], [mark]), previousSibling: before, nextSibling: null }])).toBe("static");
  });

  it("keeps a pair whose insertion is a different node static", () => {
    expect(classify(pair(mark, other, before, null))).toBe("static");
  });

  it("still lets an unrelated static record win beside a raise pair", () => {
    expect(classify([...pair(mark, mark, before, null), attribute(roads, "opacity")])).toBe("static");
  });
});
