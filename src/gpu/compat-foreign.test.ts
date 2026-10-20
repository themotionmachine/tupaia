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

// [RES] corpus demo-v1.112: #water's 100% rect resolves against the live viewport (1280x720), not the raster's region
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
    expect(svg.querySelector("#plain")!.getAttribute("width")).toBe("100%"); // not mask content: the raster's own viewport
    undo();
    expect(svg.innerHTML).toBe(before);
  });

  it("does nothing without a numeric live viewport", () => {
    const svg = map('<mask id="water"><rect width="100%" height="100%"/></mask>');
    pinViewportPercentages(svg, Number.NaN, 720)();
    expect(svg.querySelector("rect")!.getAttribute("width")).toBe("100%");
    pinViewportPercentages(svg, Number(null), 720);
    expect(svg.querySelector("rect")!.getAttribute("width")).toBe("100%");
  });
});
