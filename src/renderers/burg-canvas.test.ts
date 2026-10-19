import { afterEach, expect, it, vi } from "vitest";
import { compactBurgIcons, restoreBurgVectorsIn } from "./burg-canvas";

afterEach(() => vi.unstubAllGlobals());
it("keeps exact editable glyphs while replacing live settlement nodes with a bounded raster", async () => {
  const markup = '<use id="burg1" data-id="1" href="#icon-circle" x="100" y="200"/>';
  const attributes = new Map<string, string>();
  let child: unknown;
  let html = markup;
  const use = {
    classList: { remove: vi.fn() },
    getAttribute: (name: string) => ({ x: "100", y: "200", href: "#icon-circle" })[name]
  };
  const group = {
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
      child = undefined;
    },
    querySelectorAll: () => (child ? [] : [use]),
    dataset: { icon: "#icon-circle" },
    replaceChildren: vi.fn((image: unknown) => {
      child = image;
      html = "<image/>";
    })
  };
  const image = {
    parentNode: group,
    parentElement: group,
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value);
    },
    getAttribute: (name: string) => attributes.get(name) || null
  };
  const context = { drawImage: vi.fn() };
  const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: () => "data:image/png;base64,test" };
  vi.stubGlobal("document", {
    getElementById: () => group,
    querySelectorAll: (selector: string) => (selector.includes("image[") ? (child ? [image] : []) : [group]),
    querySelector: () => ({ outerHTML: '<symbol id="icon-circle" viewBox="0 0 10 10"><circle r="5"/></symbol>' }),
    createElementNS: () => image,
    createElement: () => canvas
  });
  vi.stubGlobal("getComputedStyle", () => ({ fontSize: "3px", strokeWidth: "1px", getPropertyValue: () => "black" }));
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
    }
  );
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      async decode() {}
    }
  );
  compactBurgIcons();
  await window.burgRenderReady;
  expect(group.replaceChildren).toHaveBeenCalledTimes(1);
  expect(attributes.get("data-burg-vectors")).toBe(markup);
  expect(attributes.get("pointer-events")).toBe("none");
  expect(attributes.get("href")).toBe("data:image/png;base64,test");
  expect(context.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 72, 72);
  restoreBurgVectorsIn(document);
  expect(group.innerHTML).toBe(markup);
});
