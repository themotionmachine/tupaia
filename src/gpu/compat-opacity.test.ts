// @vitest-environment happy-dom
// [COMPAT] A compat raster must not carry the opacity of the GPU group it is composited in (provinces drew at 0.7²).
import { describe, expect, it, vi } from "vitest";

vi.mock("../io/export", () => ({ prepareMapClone: vi.fn() }));

import { liftGroupOpacity } from "./compat";

const ns = "http://www.w3.org/2000/svg";
function tree() {
  const svg = document.createElementNS(ns, "svg");
  svg.innerHTML =
    '<g id="viewbox" opacity="0.5"><g id="provs" opacity="0.7" style="fill:red;opacity:0.7">' +
    '<g id="body" style="opacity:0.6"><text id="label" opacity="0.9">P</text></g></g>' +
    '<g id="plain"><text id="other">Q</text></g></g>';
  document.body.append(svg);
  const $ = (id: string) => svg.querySelector(`#${id}`)!;
  return { svg, $ };
}

describe("liftGroupOpacity", () => {
  it("sets every ancestor below #viewbox to opacity 1, keeps the element's own, and undoes exactly", () => {
    const { svg, $ } = tree();
    const before = svg.outerHTML;
    const undo = liftGroupOpacity($("viewbox"), [$("label"), $("other")]);
    for (const id of ["provs", "body"]) {
      expect($(id).getAttribute("opacity")).toBe("1");
      expect(($(id) as SVGElement).style.getPropertyValue("opacity")).not.toMatch(/0\./);
    }
    expect(($("provs") as SVGElement).style.getPropertyValue("fill")).toBe("red");
    expect($("label").getAttribute("opacity")).toBe("0.9");
    expect($("viewbox").getAttribute("opacity")).toBe("0.5"); // #viewbox itself is not a scene group
    expect($("plain").hasAttribute("opacity")).toBe(false);
    undo();
    expect(svg.outerHTML).toBe(before);
    svg.remove();
  });

  it("is a no-op for a run with no translucent ancestor", () => {
    const { svg, $ } = tree();
    const before = svg.outerHTML;
    const undo = liftGroupOpacity($("viewbox"), [$("other")]);
    expect(svg.outerHTML).toBe(before);
    undo();
    expect(svg.outerHTML).toBe(before);
    svg.remove();
  });
});

describe("isolate keeps what the kept elements reference", () => {
  it("holds a pruned clip target in a <defs> and restores the tree exactly", async () => {
    const { isolate } = await import("./compat");
    const svg = document.createElementNS(ns, "svg");
    svg.innerHTML =
      '<defs><g id="statePaths"><clipPath id="clip0"><use href="#state0"/></clipPath></g></defs>' +
      '<g id="viewbox"><g id="regions"><g id="statesBody"><path id="state0" d="M0,0h9v9z"/></g>' +
      '<g id="statesHalo"><path id="border0" d="M0,0h9v9z" clip-path="url(#clip0)"/></g></g>' +
      '<g id="other"><path id="unrelated" d="M0,0h1v1z"/></g></g>';
    const before = svg.outerHTML;
    const halo = svg.querySelector("#statesHalo")!;
    const undo = isolate(svg, new Set([halo]));
    expect(svg.querySelector("#other")).toBeNull();
    // the clip target is referable but sits in a definition, so it is not painted
    const held = svg.querySelector("#state0");
    expect(held).not.toBeNull();
    expect(held!.closest("defs")).not.toBeNull();
    expect(svg.querySelector("#viewbox #statesBody")).toBeNull();
    undo();
    expect(svg.outerHTML).toBe(before);
  });

  it("holds nothing when nothing pruned is referenced", async () => {
    const { isolate } = await import("./compat");
    const svg = document.createElementNS(ns, "svg");
    svg.innerHTML = '<g id="viewbox"><g id="a"><path id="p"/></g><g id="b"/></g>';
    const before = svg.outerHTML;
    const undo = isolate(svg, new Set([svg.querySelector("#a")!]));
    expect(svg.querySelectorAll("defs").length).toBe(0);
    undo();
    expect(svg.outerHTML).toBe(before);
  });
});

describe("scaleTextShadows", () => {
  it("scales px lengths of text-shadow in style attributes and rules, nothing else", async () => {
    const { scaleTextShadows } = await import("./compat");
    const markup =
      "<style>#armies text {stroke: none; text-shadow: 0 0 4px #000; font-size: 4px}</style>" +
      '<g style="text-shadow:rgb(0, 0, 0) 1px -2px 0.5px;stroke-width:3px"><text>x</text></g>';
    expect(scaleTextShadows(markup, 2)).toBe(
      "<style>#armies text {stroke: none; text-shadow: 0 0 8px #000; font-size: 4px}</style>" +
        '<g style="text-shadow:rgb(0, 0, 0) 2px -4px 1px;stroke-width:3px"><text>x</text></g>'
    );
    expect(scaleTextShadows(markup, 1)).toBe(markup);
  });
});
