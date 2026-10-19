import { afterEach, expect, it, vi } from "vitest";
import { compactPathLayer } from "./path-layer-canvas";

afterEach(() => vi.unstubAllGlobals());
it("rasterizes fill rules, transforms and dashed strokes while preserving exact vector snapshot", () => {
  const context = {
    scale: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    transform: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineJoin: "",
    lineCap: "",
    lineDashOffset: 0
  };
  const attributes = new Map<string, string>();
  const image = {
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value);
    }
  };
  const element = {
    tagName: "path",
    getAttribute: (name: string) => (name === "d" ? "M0,0L10,0L0,10Z" : null),
    hasAttribute: () => false,
    transform: { baseVal: { consolidate: () => ({ matrix: { a: 1, b: 0, c: 0, d: 1, e: 2, f: 3 } }) } }
  };
  const group = {
    children: [element],
    innerHTML: "<path d='M0,0L10,0L0,10Z'/>",
    querySelectorAll: () => [element],
    replaceChildren: vi.fn()
  };
  vi.stubGlobal("graphWidth", 100);
  vi.stubGlobal("graphHeight", 100);
  vi.stubGlobal("Path2D", class {});
  vi.stubGlobal("getComputedStyle", () => ({
    fill: "red",
    fillOpacity: "0.5",
    fillRule: "evenodd",
    stroke: "black",
    strokeOpacity: "1",
    strokeWidth: "1px",
    strokeLinejoin: "round",
    strokeLinecap: "round",
    strokeDasharray: "2px, 3px",
    strokeDashoffset: "1px"
  }));
  vi.stubGlobal("document", {
    getElementById: () => group,
    createElement: () => ({ getContext: () => context, toDataURL: () => "data:image/png;base64,test" }),
    createElementNS: () => image
  });
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  compactPathLayer("biomes");
  expect(context.fill).toHaveBeenCalledWith(expect.anything(), "evenodd");
  expect(context.transform).toHaveBeenCalledWith(1, 0, 0, 1, 2, 3);
  expect(context.setLineDash).toHaveBeenCalledWith([2, 3]);
  expect(attributes.get("data-path-vectors")).toBe(group.innerHTML);
  expect(group.replaceChildren).toHaveBeenCalledWith(image);
});
