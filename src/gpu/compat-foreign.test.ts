// @vitest-environment happy-dom
// [RES] A <foreignObject> must never reach a compat raster's SVG image: Chrome taints the decode canvas and the texture
// upload fails the whole frame ("Tainted canvases may not be loaded", the heightmap editor's #heights). A hosted canvas
// is drawn as an <image> of its live pixels; anything else is left out of the serialization, and the clone is restored.
import { describe, expect, it, vi } from "vitest";

vi.mock("../io/export", () => ({ prepareMapClone: vi.fn() }));

import { bridgeForeignObjects, pinViewportPercentages } from "./compat";

const ns = "http://www.w3.org/2000/svg";
const xhtml = "http://www.w3.org/1999/xhtml";

function map(markup: string) {
  const svg = document.createElementNS(ns, "svg");
  svg.innerHTML = markup;
  return svg;
}

function hostCanvas(host: Element, width = 20, height = 10) {
  const canvas = document.createElementNS(xhtml, "canvas") as HTMLCanvasElement;
  canvas.width = width * 2;
  canvas.height = height * 2;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  host.appendChild(canvas);
  return canvas;
}

describe("bridgeForeignObjects", () => {
  it("draws a hosted canvas as an image of the live pixels over its CSS box, and undoes exactly", () => {
    const markup =
      '<g id="viewbox"><g id="heights"><foreignObject width="20" height="10" pointer-events="none"/></g></g>';
    const live = map(markup);
    const canvas = hostCanvas(live.querySelector("foreignObject")!);
    const clone = map(markup);
    hostCanvas(clone.querySelector("foreignObject")!); // cloneNode copies the element, not its pixels
    const before = clone.outerHTML;
    const encode = vi.fn((source: HTMLCanvasElement) => (source === canvas ? "data:image/png;base64,LIVE" : "blank"));
    const undo = bridgeForeignObjects(
      clone,
      [clone.querySelector("#heights")!],
      [live.querySelector("#heights")!],
      encode
    );
    expect(clone.querySelector("foreignObject")).toBeNull();
    const image = clone.querySelector("#heights > image")!;
    expect(image.getAttribute("href")).toBe("data:image/png;base64,LIVE");
    expect([image.getAttribute("width"), image.getAttribute("height")]).toEqual(["20", "10"]);
    expect(image.getAttribute("preserveAspectRatio")).toBe("none");
    expect(encode).toHaveBeenCalledTimes(1);
    undo();
    expect(clone.outerHTML).toBe(before);
  });

  it("leaves out a foreignObject that hosts anything but one canvas, or whose live canvas cannot be read", () => {
    const markup =
      '<g id="viewbox"><g id="a"><foreignObject width="5" height="5"/></g><g id="b"><foreignObject width="5" height="5"/></g>' +
      '<g id="other"><foreignObject width="5" height="5"/></g></g>';
    const live = map(markup);
    const [hosted, tainted] = [...live.querySelectorAll("foreignObject")];
    hosted.appendChild(document.createElementNS(xhtml, "div"));
    hostCanvas(tainted);
    const clone = map(markup);
    const before = clone.outerHTML;
    const kept = [clone.querySelector("#a")!, clone.querySelector("#b")!];
    const undo = bridgeForeignObjects(clone, kept, [live.querySelector("#a")!, live.querySelector("#b")!], () => {
      throw new Error("tainted");
    });
    expect(clone.querySelectorAll("foreignObject").length).toBe(0); // #other too: nothing may taint the decode
    expect(clone.querySelectorAll("image").length).toBe(0);
    undo();
    expect(clone.outerHTML).toBe(before);
  });

  it("is a no-op without foreignObjects", () => {
    const clone = map('<g id="viewbox"><path d="M0,0h1v1z"/></g>');
    const before = clone.outerHTML;
    bridgeForeignObjects(clone, [clone.querySelector("path")!], undefined)();
    expect(clone.outerHTML).toBe(before);
  });
});

// [RES] corpus demo-v1.112: #water's 100% rect resolves against the live viewport (1280x720), not the raster's region.
// [RES2] Scoped to what resolves against svg#map, and extended to plain viewport-% content (#fogging-cont's rects).
describe("pinViewportPercentages", () => {
  it("pins percentage mask and clip rects to the live viewport, leaves other lengths, and undoes exactly", () => {
    const svg = map(
      '<defs><mask id="water"><rect x="0" y="0" width="100%" height="100%" fill="white"/><use href="#f"/></mask>' +
        '<clipPath id="c"><rect x="10%" y="-5%" width="50.5%" height="20"/></clipPath></defs>' +
        '<g id="viewbox"><rect id="plain" width="100%" height="100%"/></g>'
    );
    const before = svg.innerHTML;
    const undo = pinViewportPercentages(svg, 1280, 720);
    const water = svg.querySelector("#water rect")!;
    expect([water.getAttribute("x"), water.getAttribute("width"), water.getAttribute("height")]).toEqual([
      "0",
      "1280",
      "720"
    ]);
    const clip = svg.querySelector("#c rect")!;
    expect([
      clip.getAttribute("x"),
      clip.getAttribute("y"),
      clip.getAttribute("width"),
      clip.getAttribute("height")
    ]).toEqual(["128", "-36", "646.4", "20"]);
    undo();
    expect(svg.innerHTML).toBe(before);
  });

  // main.js:128-134: #fogging-cont > #fogging holds two x 0 y 0 100% rects. Live they span svgWidth x svgHeight user
  // units; in a raster they spanned the region, and in a settle detail (region = the view, e.g. x 400..720 at k 4) a
  // rect over x 0..320 missed the view entirely.
  it("pins viewport-% content of a world run (the fog rects), not only mask and clip content", () => {
    const svg = map(
      '<g id="viewbox"><g id="fogging-cont" mask="url(#fog)"><g id="fogging">' +
        '<rect x="0" y="0" width="100%" height="100%"/><rect x="0" y="0" width="100%" height="100%" fill="#e8f0f6"/>' +
        '</g></g><circle id="dot" cx="50%" cy="25%" r="10%"/><line id="ln" x1="0" y1="0" x2="100%" y2="50%"/>' +
        '<rect id="rounded" width="100%" height="100%" rx="5%" ry="5%"/></g>'
    );
    const undo = pinViewportPercentages(svg, 1280, 720);
    for (const rect of svg.querySelectorAll("#fogging rect"))
      expect([rect.getAttribute("width"), rect.getAttribute("height")]).toEqual(["1280", "720"]);
    const dot = svg.querySelector("#dot")!;
    expect([dot.getAttribute("cx"), dot.getAttribute("cy")]).toEqual(["640", "180"]);
    expect(Number(dot.getAttribute("r"))).toBeCloseTo(0.1 * Math.sqrt((1280 ** 2 + 720 ** 2) / 2), 6);
    expect([svg.querySelector("#ln")!.getAttribute("x2"), svg.querySelector("#ln")!.getAttribute("y2")]).toEqual([
      "1280",
      "360"
    ]);
    const rounded = svg.querySelector("#rounded")!;
    expect([rounded.getAttribute("rx"), rounded.getAttribute("ry")]).toEqual(["64", "36"]);
    undo();
    expect(svg.querySelector("#fogging rect")!.getAttribute("width")).toBe("100%");
    expect(svg.querySelector("#dot")!.getAttribute("r")).toBe("10%");
  });

  // An emblem is an <svg viewBox="0 0 200 200"> (coa-renderer): its % lengths resolve against that viewport, so a
  // quarter or canton rect drawn at 50% must stay 50% of the emblem, never become 640 map units. Same for a <symbol>.
  it("leaves lengths under a nested viewport (emblem <svg>, <symbol>) and in patterns, markers and filters", () => {
    const svg = map(
      '<defs><symbol id="sym" viewBox="0 0 10 10"><rect id="in-symbol" width="50%" height="50%"/></symbol>' +
        '<pattern id="pat" width="10" height="10" patternUnits="userSpaceOnUse"><rect id="in-pattern" width="50%" height="100%"/></pattern>' +
        '<marker id="mk"><circle id="in-marker" r="50%"/></marker>' +
        '<filter id="fl" x="-10%" width="120%"><feFlood/></filter>' +
        '<clipPath id="emblem-clip"><svg viewBox="0 0 200 200"><rect id="in-clip-svg" width="100%" height="100%"/></svg></clipPath></defs>' +
        '<g id="viewbox"><g id="burgEmblems"><svg id="coa" x="10" y="10" width="20" height="20" viewBox="0 0 200 200">' +
        '<rect id="quarter" x="0" y="0" width="50%" height="50%"/><clipPath id="inner"><rect id="inner-clip" width="50%" height="50%"/></clipPath>' +
        '</svg><svg id="pct-svg" x="0" y="0" width="50%" height="50%" viewBox="0 0 10 10"/></g></g>'
    );
    const before = svg.innerHTML;
    const undo = pinViewportPercentages(svg, 1280, 720);
    for (const id of ["in-symbol", "in-pattern", "quarter", "inner-clip", "in-clip-svg"])
      expect(svg.querySelector(`#${id}`)!.getAttribute("width"), id).toMatch(/%$/);
    expect(svg.querySelector("#in-marker")!.getAttribute("r")).toBe("50%");
    expect(svg.querySelector("#fl")!.getAttribute("width")).toBe("120%");
    // the nested <svg> element itself sits in svg#map's viewport: its own box resolves against it
    expect([
      svg.querySelector("#pct-svg")!.getAttribute("width"),
      svg.querySelector("#pct-svg")!.getAttribute("height")
    ]).toEqual(["640", "360"]);
    undo();
    expect(svg.innerHTML).toBe(before);
  });

  it("leaves objectBoundingBox content and a mask's own bounding-box region, pins a userSpaceOnUse mask region", () => {
    const svg = map(
      '<defs><mask id="bbox" maskContentUnits="objectBoundingBox"><rect id="bbox-rect" width="100%" height="100%"/></mask>' +
        '<clipPath id="bbox-clip" clipPathUnits="objectBoundingBox"><rect id="bbox-clip-rect" width="50%" height="50%"/></clipPath>' +
        '<mask id="default-region" x="-10%" y="-10%" width="120%" height="120%"><rect id="user" width="100%" height="100%"/></mask>' +
        '<mask id="user-region" maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%"/></defs>'
    );
    const undo = pinViewportPercentages(svg, 1280, 720);
    expect(svg.querySelector("#bbox-rect")!.getAttribute("width")).toBe("100%");
    expect(svg.querySelector("#bbox-clip-rect")!.getAttribute("width")).toBe("50%");
    expect(svg.querySelector("#default-region")!.getAttribute("width")).toBe("120%");
    expect(svg.querySelector("#user")!.getAttribute("width")).toBe("1280"); // userSpaceOnUse content (the default)
    expect([
      svg.querySelector("#user-region")!.getAttribute("width"),
      svg.querySelector("#user-region")!.getAttribute("height")
    ]).toEqual(["1280", "720"]);
    undo();
    expect(svg.querySelector("#user-region")!.getAttribute("width")).toBe("100%");
  });

  it("does nothing without a numeric live viewport", () => {
    const svg = map('<mask id="water"><rect width="100%" height="100%"/></mask>');
    pinViewportPercentages(svg, Number.NaN, 720)();
    expect(svg.querySelector("rect")!.getAttribute("width")).toBe("100%");
    pinViewportPercentages(svg, Number(null), 720);
    expect(svg.querySelector("rect")!.getAttribute("width")).toBe("100%");
  });
});
