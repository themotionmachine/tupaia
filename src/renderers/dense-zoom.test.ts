import { quadtree } from "d3";
import { afterEach, expect, it, vi } from "vitest";
import { clearDenseZoom } from "./dense-zoom";

const imageSelector = "image[data-relief],image[data-burg-vectors]";
let currentRoot: MiniNode | null = null;
let pending: unknown[] = [];
let observedAttributes: string[] = [];
let mutation: (records: unknown[]) => void = () => {};
class MiniNode {
  attrs = new Map<string, string>();
  children: MiniNode[] = [];
  parentElement: MiniNode | null = null;
  connected = false;
  original = "";
  style = {
    visibility: "",
    display: "",
    removeProperty: (name: string) => {
      if (name === "visibility") this.style.visibility = "";
      if (name === "display") this.style.display = "";
    }
  };
  constructor(public tagName: string) {}
  get isConnected(): boolean {
    return this.parentElement ? this.parentElement.isConnected : this.connected;
  }
  get firstChild(): MiniNode | null {
    return this.children[0] || null;
  }
  get firstElementChild(): MiniNode | null {
    return this.firstChild;
  }
  get nextSibling(): MiniNode | null {
    if (!this.parentElement) return null;
    return this.parentElement.children[this.parentElement.children.indexOf(this) + 1] || null;
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
    if (this.isConnected && observedAttributes.includes(name))
      pending.push({ type: "attributes", target: this, attributeName: name });
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
  }
  hasAttribute(name: string) {
    return this.attrs.has(name);
  }
  contains(node: MiniNode): boolean {
    return node === this || this.children.some(child => child.contains(node));
  }
  closest(selector: string): MiniNode | null {
    if (this.matches(selector)) return this;
    return this.parentElement?.closest(selector) || null;
  }
  matches(selector: string): boolean {
    if (selector === imageSelector)
      return this.tagName === "image" && (this.hasAttribute("data-relief") || this.hasAttribute("data-burg-vectors"));
    if (selector === "use") return this.tagName === "use";
    if (selector === "[data-dense-zoom]") return this.hasAttribute("data-dense-zoom");
    if (selector === "image[data-zoom-hidden]")
      return this.tagName === "image" && this.hasAttribute("data-zoom-hidden");
    return false;
  }
  querySelectorAll(selector: string): MiniNode[] {
    return this.children.flatMap(child => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }
  querySelector(selector: string): MiniNode | null {
    return this.querySelectorAll(selector)[0] || null;
  }
  insertBefore(node: MiniNode, next: MiniNode | null) {
    node.remove();
    const index = next ? this.children.indexOf(next) : this.children.length;
    this.children.splice(index, 0, node);
    node.parentElement = this;
    return node;
  }
  after(node: MiniNode) {
    this.parentElement!.insertBefore(node, this.nextSibling);
  }
  remove() {
    if (this.parentElement) {
      const list = this.parentElement.children;
      list.splice(list.indexOf(this), 1);
    }
    this.parentElement = null;
  }
  set innerHTML(markup: string) {
    for (const child of [...this.children]) child.remove();
    for (const match of markup.matchAll(/<use\b[^>]*(?:\/>|>[\s\S]*?<\/use>)/g)) {
      const node = new MiniNode("use");
      node.original = match[0];
      for (const attr of match[0].matchAll(/([\w:-]+)="([^"]*)"/g))
        node.attrs.set(
          attr[1],
          attr[2]
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&")
        );
      this.insertBefore(node, null);
    }
  }
  get outerHTML() {
    return this.original;
  }
}
function setup(data: unknown[]) {
  pending = [];
  observedAttributes = [];
  const root = new MiniNode("svg");
  root.connected = true;
  currentRoot = root;
  const group = new MiniNode("g");
  root.insertBefore(group, null);
  const image = new MiniNode("image");
  image.setAttribute("data-relief", JSON.stringify(data));
  group.insertBefore(image, null);
  vi.stubGlobal("document", {
    getElementById: () => currentRoot,
    createElementNS: vi.fn((_namespace: string, tag: string) => new MiniNode(tag))
  });
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: (records: unknown[]) => void) {
        mutation = callback;
      }
      observe(_target: unknown, options: { attributeFilter?: string[] }) {
        observedAttributes = options.attributeFilter || [];
      }
      disconnect() {}
      takeRecords() {
        return pending.splice(0);
      }
    }
  );
  return { root, group, image };
}
function glyph(x: number, i = "#hill") {
  return { x, y: 10, s: 3, i };
}
function zoom(x = 0, k = 8) {
  window.refreshDenseZoom(k, x, 0, 800, 600);
}
afterEach(() => {
  if (currentRoot) clearDenseZoom(currentRoot as unknown as ParentNode);
  currentRoot = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("preserves overlay and glyph identity with no spatial or DOM queries on interior pans", () => {
  const { root, group } = setup([glyph(20), glyph(70)]);
  zoom();
  const overlay = group.querySelector("[data-dense-zoom]")!;
  const nodes = [...overlay.children];
  const queries = vi.spyOn(root, "querySelectorAll");
  const visit = vi.spyOn(Object.getPrototypeOf(quadtree()), "visit");
  const insertion = vi.spyOn(overlay, "insertBefore");
  zoom(-20);
  zoom(-40);
  expect(group.querySelector("[data-dense-zoom]")).toBe(overlay);
  expect(overlay.children[0]).toBe(nodes[0]);
  expect(overlay.children[1]).toBe(nodes[1]);
  expect(queries).not.toHaveBeenCalled();
  expect(visit).not.toHaveBeenCalled();
  expect(insertion).not.toHaveBeenCalled();
});
it("reconciles boundary membership in original order while retaining unchanged nodes", () => {
  const { group } = setup([glyph(140, "#far"), glyph(40, "#near"), glyph(90, "#middle")]);
  zoom();
  const overlay = group.querySelector("[data-dense-zoom]")!;
  const near = overlay.children[0],
    middle = overlay.children[1];
  expect(overlay.children.map(node => node.getAttribute("href"))).toEqual(["#near", "#middle"]);
  zoom(-400);
  expect(overlay.children.map(node => node.getAttribute("href"))).toEqual(["#far", "#near", "#middle"]);
  expect(overlay.children[1]).toBe(near);
  expect(overlay.children[2]).toBe(middle);
  const far = overlay.children[0];
  zoom(-900);
  expect(overlay.children.map(node => node.getAttribute("href"))).toEqual(["#far", "#middle"]);
  expect(overlay.children[0]).toBe(far);
  expect(overlay.children[1]).toBe(middle);
  expect(near.parentElement).toBe(null);
});
it("restores the overview bitmap and invalidates edited metadata", () => {
  const { group, image } = setup([glyph(20)]);
  zoom();
  const old = group.querySelector("[data-dense-zoom]")!;
  image.setAttribute("data-relief", JSON.stringify([glyph(60, "#edited")]));
  mutation([{ type: "attributes", target: image, attributeName: "data-relief" }]);
  zoom();
  const fresh = group.querySelector("[data-dense-zoom]")!;
  expect(fresh).not.toBe(old);
  expect(old.parentElement).toBe(null);
  expect(fresh.children[0].getAttribute("href")).toBe("#edited");
  expect(fresh.children[0].getAttribute("x")).toBe("60");
  zoom(0, 4);
  expect(group.querySelector("[data-dense-zoom]")).toBe(fresh);
  expect(fresh.style.display).toBe("none");
  expect(image.style.visibility).toBe("");
  expect(image.hasAttribute("data-zoom-hidden")).toBe(false);
});
it("releases detached map roots and replaces cached images after edits", () => {
  const first = setup([glyph(20)]);
  zoom();
  const overlay = first.group.querySelector("[data-dense-zoom]")!;
  first.root.connected = false;
  const second = setup([glyph(30)]);
  zoom();
  expect(overlay.parentElement).toBe(null);
  expect(first.image.style.visibility).toBe("");
  const old = second.group.querySelector("[data-dense-zoom]")!;
  second.image.remove();
  const replacement = new MiniNode("image");
  replacement.setAttribute("data-relief", JSON.stringify([glyph(50)]));
  second.group.insertBefore(replacement, null);
  zoom();
  expect(old.parentElement).toBe(null);
  expect(second.group.querySelector("[data-dense-zoom]")!.children[0].getAttribute("x")).toBe("50");
});
it("escapes relief references and retains custom burg vector attributes", () => {
  const { group, image } = setup([glyph(20, '#hill&"<')]);
  zoom();
  const node = group.querySelector("[data-dense-zoom]")!.children[0];
  expect(node.getAttribute("href")).toBe('#hill&"<');
  image.removeAttribute("data-relief");
  const markup = '<use id="burg7" href="#square" x="20" y="10" style="fill:red" transform="rotate(5)"/>';
  image.setAttribute("data-burg-vectors", markup);
  mutation([{ type: "attributes", target: image, attributeName: "data-burg-vectors" }]);
  zoom();
  expect(group.querySelector("[data-dense-zoom]")!.children[0].outerHTML).toBe(markup);
  image.setAttribute("data-burg-vectors", "");
  image.setAttribute("data-relief", JSON.stringify([{ i: "#bad", x: '" invalid="yes', y: 1, s: 2 }]));
  zoom();
  expect(group.querySelector("[data-dense-zoom]")).toBe(null);
  expect(image.style.visibility).toBe("");
});

it("reuses overlay and glyph nodes across the overview threshold and trims oversized caches", () => {
  const { group, image } = setup([glyph(20, "#near"), glyph(120, "#far")]);
  zoom();
  const overlay = group.querySelector("[data-dense-zoom]")!;
  const near = overlay.children[0];
  expect(overlay.children.length).toBe(2);
  zoom(0, 4);
  expect(overlay.style.display).toBe("none");
  expect(image.style.visibility).toBe("");
  zoom();
  expect(group.querySelector("[data-dense-zoom]")).toBe(overlay);
  expect(overlay.children[0]).toBe(near);
  expect(overlay.style.display).toBe("");
  zoom(0, 32);
  expect(overlay.children.length).toBe(1);
  expect(overlay.children[0]).toBe(near);
});
it("drains synchronous metadata mutations without reading map-sized attributes on ordinary frames", () => {
  const { image, group } = setup([glyph(20)]);
  zoom();
  const read = vi.spyOn(image, "getAttribute");
  zoom(-20);
  zoom(-40);
  expect(read).not.toHaveBeenCalled();
  image.setAttribute("data-relief", JSON.stringify([glyph(50, "#sync-edit")]));
  zoom();
  expect(group.querySelector("[data-dense-zoom]")!.children[0].getAttribute("href")).toBe("#sync-edit");
  expect(read).toHaveBeenCalled();
});

it("restores exact original inline visibility and style absence in snapshot clones", () => {
  for (const original of [null, "opacity:.5;visibility:visible !important"]) {
    const hidden = "opacity:0.5;visibility:hidden;";
    const attrs = new Map<string, string>([
      ["style", hidden],
      ["data-zoom-hidden", ""],
      ["data-zoom-visibility", JSON.stringify([original, "visible", "important", hidden])]
    ]);
    const image = {
      getAttribute: (key: string) => attrs.get(key) ?? null,
      setAttribute: (key: string, value: string) => attrs.set(key, value),
      removeAttribute: (key: string) => attrs.delete(key),
      style: { removeProperty: vi.fn() }
    };
    const clone = { querySelectorAll: (selector: string) => (selector.startsWith("image") ? [image] : []) };
    clearDenseZoom(clone as unknown as ParentNode);
    expect(attrs.get("style") ?? null).toBe(original);
    expect(attrs.has("data-zoom-hidden")).toBe(false);
    expect(attrs.has("data-zoom-visibility")).toBe(false);
  }
});

it("releases an enhanced image synchronously when source geometry or opacity changes", () => {
  vi.stubGlobal("graphWidth", 1000);
  vi.stubGlobal("graphHeight", 800);
  const edits = [
    ["x", "15"],
    ["y", "15"],
    ["width", "700"],
    ["height", "500"],
    ["opacity", "0.5"]
  ];
  for (const [attribute, value] of edits) {
    const { group, image } = setup([glyph(20)]);
    zoom();
    const overlay = group.querySelector("[data-dense-zoom]")!;
    expect(image.hasAttribute("data-zoom-hidden")).toBe(true);
    image.setAttribute(attribute, value);
    // No observer callback is delivered: refresh must drain its configured attribute records.
    zoom();
    expect(overlay.parentElement).toBe(null);
    expect(group.querySelector("[data-dense-zoom]")).toBe(null);
    expect(image.getAttribute(attribute)).toBe(value);
    expect(image.style.visibility).toBe("");
    expect(image.hasAttribute("data-zoom-hidden")).toBe(false);
  }
});
