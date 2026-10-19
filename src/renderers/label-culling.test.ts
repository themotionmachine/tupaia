import { afterEach, expect, it, vi } from "vitest";
import "./label-culling";
afterEach(() => vi.unstubAllGlobals());
it("culls distant settlement glyphs and restores them when the viewport pans", () => {
  function glyph(x: number) {
    const classes = new Set<string>();
    return {
      classes,
      getAttribute: (name: string) => String(name === "x" ? x : 10),
      classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) }
    };
  }
  const near = glyph(10),
    far = glyph(1000);
  const root = {};
  const layer = {};
  const map = { appendChild: vi.fn() };
  vi.stubGlobal("document", {
    getElementById: (id: string) => (id === "map" ? map : id === "viewbox" ? root : layer),
    querySelectorAll: () => [near, far],
    createElementNS: () => ({ textContent: "" })
  });
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  window.cullMapLabels(1, 0, 0, 100, 100);
  expect(near.classes.has("viewport-culled")).toBe(false);
  expect(far.classes.has("viewport-culled")).toBe(true);
  window.cullMapLabels(1, -900, 0, 100, 100);
  expect(near.classes.has("viewport-culled")).toBe(true);
  expect(far.classes.has("viewport-culled")).toBe(false);
});

it("reindexes transformed labels after text and font bounds edits in one frame", () => {
  let offset = 1000;
  let callback: (records: unknown[]) => void = () => {};
  let frame: (() => void) | undefined;
  const classes = new Set<string>();
  const label = {
    getAttribute: (name: string) => (name === "x" ? "0" : name === "y" ? "10" : null),
    parentElement: { getAttribute: () => "10" },
    getBBox: () => ({ x: 0, y: 0, width: 20, height: 20 }),
    getCTM: () => ({ a: 1, b: 0, c: 0, d: 1, e: offset, f: 0 }),
    classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) }
  };
  const root = { getCTM: () => ({ inverse: () => ({ multiply: (matrix: unknown) => matrix }) }) };
  const layer = {};
  vi.stubGlobal("getComputedStyle", () => ({ fontSize: "10" }));
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((run: () => void) => {
      frame = run;
      return 1;
    })
  );
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(run: (records: unknown[]) => void) {
        callback = run;
      }
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal("document", {
    getElementById: (id: string) => (id === "viewbox" ? root : layer),
    querySelectorAll: () => [label],
    createElementNS: () => ({})
  });
  window.cullMapLabels(1, 0, 0, 100, 100);
  expect(classes.has("viewport-culled")).toBe(true);
  offset = 0;
  callback([{ target: label, type: "attributes", attributeName: "transform" }]);
  callback([{ target: label, type: "characterData" }]);
  expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  frame?.();
  expect(classes.has("viewport-culled")).toBe(false);
  offset = 1000;
  callback([{ target: label, type: "attributes", attributeName: "font-size" }]);
  frame?.();
  expect(classes.has("viewport-culled")).toBe(true);
});

it("ignores isolated zoom hatch clones but remeasures labels for real or mixed defs edits", () => {
  let callback: (records: unknown[]) => void = () => {};
  let frame: (() => void) | undefined;
  const box = vi.fn(() => ({ x: 0, y: 0, width: 20, height: 20 }));
  const label = {
    getAttribute: () => null,
    getBBox: box,
    parentElement: { getAttribute: () => "10" },
    classList: { add() {}, remove() {} }
  };
  const root = {};
  const layer = {};
  const clone = { hasAttribute: (name: string) => name === "data-zone-hatch-clone" };
  const descendant = { closest: () => clone };
  const realGlyph = { hasAttribute: () => false };
  vi.stubGlobal("getComputedStyle", () => ({ fontSize: "10" }));
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((run: () => void) => {
      frame = run;
      return 1;
    })
  );
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(run: (records: unknown[]) => void) {
        callback = run;
      }
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal("document", {
    getElementById: (id: string) => (id === "viewbox" ? root : layer),
    querySelectorAll: () => [label],
    createElementNS: () => ({})
  });
  window.cullMapLabels(1, 0, 0, 100, 100);
  callback([{ target: layer, type: "childList", addedNodes: [clone], removedNodes: [] }]);
  callback([{ target: descendant, type: "attributes", attributeName: "transform" }]);
  callback([{ target: layer, type: "childList", addedNodes: [], removedNodes: [clone] }]);
  window.cullMapLabels(2, 0, 0, 100, 100);
  expect(box).toHaveBeenCalledTimes(1);
  expect(requestAnimationFrame).not.toHaveBeenCalled();
  callback([{ target: realGlyph, type: "attributes", attributeName: "d" }]);
  frame?.();
  expect(box).toHaveBeenCalledTimes(2);
  callback([{ target: layer, type: "childList", addedNodes: [clone, realGlyph], removedNodes: [] }]);
  frame?.();
  expect(box).toHaveBeenCalledTimes(3);
});

it("unculls all labels before measuring bounds and reculls only after all reads", () => {
  const order: string[] = [];
  const labels = ["near", "far"].map((name, index) => ({
    getAttribute: () => null,
    getBBox: () => {
      order.push(`read:${name}`);
      return { x: index * 1000, y: 0, width: 20, height: 20 };
    },
    classList: {
      remove: () => {
        order.push(`write:${name}`);
      },
      add: () => {
        order.push(`cull:${name}`);
      }
    }
  }));
  const root = {};
  const layer = {};
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal("getComputedStyle", () => ({ fontSize: "10" }));
  vi.stubGlobal("document", {
    getElementById: (id: string) => (id === "viewbox" ? root : layer),
    querySelectorAll: () => labels,
    createElementNS: () => ({})
  });
  window.cullMapLabels(1, 0, 0, 100, 100);
  expect(order.slice(0, 4)).toEqual(["write:near", "write:far", "read:near", "read:far"]);
  expect(order.at(-1)).toBe("cull:far");
});

it("resets hidden bounds after a genuine text edit and replaces a saved visibility-only culling rule", () => {
  let callback: (records: unknown[]) => void = () => {};
  let frame: (() => void) | undefined;
  let width = 20;
  const classes = new Set<string>(["viewport-culled"]);
  const measure = vi.fn(() => ({ x: 500, y: 0, width: classes.has("viewport-culled") ? 0 : width, height: 20 }));
  const label = {
    getAttribute: () => null,
    getBBox: measure,
    classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) }
  };
  const root = {};
  const layer = {};
  const css = { textContent: ".viewport-culled{visibility:hidden!important}" };
  vi.stubGlobal("getComputedStyle", () => ({ fontSize: "10" }));
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => {
    frame = run;
    return 1;
  });
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(run: (records: unknown[]) => void) {
        callback = run;
      }
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal("document", {
    getElementById: (id: string) => (id === "viewbox" ? root : id === "map-label-culling-style" ? css : layer),
    querySelectorAll: () => [label],
    createElementNS: () => ({})
  });
  window.cullMapLabels(1, 0, 0, 100, 100);
  expect(css.textContent.includes("display:none!important")).toBe(true);
  expect(classes.has("viewport-culled")).toBe(true);
  width = 600;
  callback([{ target: label, type: "characterData" }]);
  frame?.();
  expect(measure).toHaveBeenCalledTimes(2);
  window.cullMapLabels(1, -900, 0, 100, 100);
  expect(classes.has("viewport-culled")).toBe(false);
});
