import { afterEach, expect, it, vi } from "vitest";
import { normalizeZoneHatching, restoreZoneHatching, updateZoneHatching } from "./zone-hatching";

let root: Svg | null = null;
let records: unknown[] = [];
let outside: Svg[] = [];
class Svg {
  attrs = new Map<string, string>();
  children: Svg[] = [];
  parentElement: Svg | null = null;
  inline = "";
  style: { fill: string };
  constructor(public tagName: string) {
    const node = this;
    this.style = {
      get fill() {
        return node.inline;
      },
      set fill(value: string) {
        node.inline = value.replace(/^url\(#([^)]*)\)$/, 'url("#$1")');
        if (value) node.attrs.set("style", `fill:${node.inline}`);
        else node.attrs.delete("style");
        node.notify("style");
      }
    };
  }
  get id() {
    return this.getAttribute("id") || "";
  }
  set id(value: string) {
    this.setAttribute("id", value);
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attrs.has(name);
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
    this.notify(name);
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
    this.notify(name);
  }
  notify(name: string) {
    if (["fill", "style"].includes(name) && this.closestZones())
      records.push({ type: "attributes", target: this, attributeName: name });
  }
  closestZones(): Svg | null {
    return this.id === "zones" ? this : this.parentElement?.closestZones() || null;
  }
  contains(node: Svg): boolean {
    return this === node || this.children.some(child => child.contains(node));
  }
  nodes(): Svg[] {
    return this.children.flatMap(child => [child, ...child.nodes()]);
  }
  matches(selector: string): boolean {
    if (selector === "[fill], [style]") return this.hasAttribute("fill") || this.hasAttribute("style");
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    const match = /^(pattern)?\[([^\]]+)\]$/.exec(selector);
    return !!match && (!match[1] || this.tagName === match[1]) && this.hasAttribute(match[2]);
  }
  querySelectorAll(selector: string): Svg[] {
    return this.nodes().filter(node => node.matches(selector));
  }
  querySelector(selector: string): Svg | null {
    if (selector === ":scope > defs") return this.children.find(node => node.tagName === "defs") || null;
    return this.querySelectorAll(selector)[0] || null;
  }
  appendChild(node: Svg) {
    node.remove();
    this.children.push(node);
    node.parentElement = this;
    if (this.closestZones()) records.push({ type: "childList", target: this, addedNodes: [node], removedNodes: [] });
    return node;
  }
  remove() {
    if (this.parentElement) {
      const parent = this.parentElement;
      parent.children.splice(parent.children.indexOf(this), 1);
      if (parent.closestZones())
        records.push({ type: "childList", target: parent, addedNodes: [], removedNodes: [this] });
    }
    this.parentElement = null;
  }
  cloneNode(deep: boolean): Svg {
    const clone = new Svg(this.tagName);
    clone.attrs = new Map(this.attrs);
    clone.inline = this.inline;
    if (deep) for (const child of this.children) clone.appendChild(child.cloneNode(true));
    return clone;
  }
  get outerHTML(): string {
    return `<${this.tagName}${[...this.attrs].map(([key, value]) => ` ${key}="${value}"`).join("")}>${this.children.map(child => child.outerHTML).join("")}</${this.tagName}>`;
  }
}
function pattern(id: string, rotation = "rotate(45)", dots = false): Svg {
  const pattern = new Svg("pattern");
  pattern.id = id;
  pattern.setAttribute("patternUnits", "userSpaceOnUse");
  pattern.setAttribute("width", dots ? "5" : "6");
  pattern.setAttribute("height", dots ? "5" : "6");
  if (rotation) pattern.setAttribute("patternTransform", rotation);
  const child = new Svg(dots ? "circle" : "line");
  child.setAttribute("stroke", "red");
  child.setAttribute("stroke-width", "0.8");
  if (dots) child.setAttribute("r", "0.6");
  pattern.appendChild(child);
  return pattern;
}
function setup(source = pattern("zp-raid")) {
  records = [];
  outside = [];
  root = new Svg("svg");
  root.id = "map";
  const defs = root.appendChild(new Svg("defs"));
  defs.appendChild(source);
  const zones = root.appendChild(new Svg("g"));
  zones.id = "zones";
  const path = new Svg("path");
  path.setAttribute("fill", `url(#${source.id})`);
  zones.appendChild(path);
  records = [];
  vi.stubGlobal("document", {
    getElementById: (id: string) => [root!, ...root!.nodes(), ...outside].find(node => node.id === id) || null
  });
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
      takeRecords() {
        return records.splice(0);
      }
    }
  );
  return { root, defs, zones, path, source };
}
function clones(node: Svg) {
  return node.querySelectorAll("pattern[data-zone-hatch-clone]");
}
afterEach(() => {
  if (root) restoreZoneHatching(root as unknown as ParentNode);
  vi.unstubAllGlobals();
});
it("keeps rotated lines and dots screen constant at scales one, two and eight without changing originals", () => {
  for (const dots of [false, true]) {
    const f = setup(pattern(dots ? "zp-dot" : "zp-raid", dots ? "" : "rotate(45)", dots));
    const original = f.source.outerHTML;
    for (const k of [1, 2, 8]) {
      updateZoneHatching(k);
      const clone = clones(f.root)[0];
      const value = clone.getAttribute("patternTransform")!;
      expect(value).toBe(`scale(${1 / k})${dots ? "" : " rotate(45)"}`);
      expect(Number(clone.getAttribute("width")) * (1 / k) * k).toBe(Number(f.source.getAttribute("width")));
      expect(Number(clone.children[0].getAttribute("stroke-width")) * (1 / k) * k).toBe(0.8);
      expect(clone.children[0].getAttribute("stroke")).toBe("red");
      expect(f.source.outerHTML).toBe(original);
      expect(f.path.getAttribute("data-zone-hatch-fill")).toBe(`url(#${f.source.id})`);
    }
    restoreZoneHatching(f.root as unknown as ParentNode);
  }
});
it("honors synchronous custom fill edits and leaves unsupported fills unchanged", () => {
  const f = setup();
  updateZoneHatching(8);
  const custom = pattern("zp-shared", "rotate(-45)", true);
  f.defs.appendChild(custom);
  f.path.setAttribute("fill", "url(#zp-shared)");
  updateZoneHatching(8);
  expect(f.path.getAttribute("data-zone-hatch-fill")).toBe("url(#zp-shared)");
  expect(clones(f.root)[0].getAttribute("patternTransform")).toBe("scale(0.125) rotate(-45)");
  for (const value of ["red", "url(https://example.com/pat.svg#x)", "url(#missing)"]) {
    f.path.setAttribute("fill", value);
    updateZoneHatching(8);
    expect(f.path.getAttribute("fill")).toBe(value);
    expect(f.path.hasAttribute("data-zone-hatch-fill")).toBe(false);
  }
  const bounding = pattern("bbox");
  bounding.setAttribute("patternUnits", "objectBoundingBox");
  f.defs.appendChild(bounding);
  f.path.setAttribute("fill", "url(#bbox)");
  updateZoneHatching(8);
  expect(f.path.getAttribute("fill")).toBe("url(#bbox)");
});
it("normalizes full-map saves while viewport exports keep rendering and remove only markers", () => {
  const f = setup();
  updateZoneHatching(8);
  const clone = f.root.cloneNode(true),
    viewport = f.root.cloneNode(true);
  normalizeZoneHatching(clone as unknown as ParentNode, true);
  expect(clones(clone).length).toBe(0);
  expect(clone.querySelector("#zones")!.children[0].getAttribute("fill")).toBe("url(#zp-raid)");
  expect(clone.querySelector("[data-zone-hatch-fill]")).toBe(null);
  const actual = viewport.querySelector("#zones")!.children[0].getAttribute("fill");
  normalizeZoneHatching(viewport as unknown as ParentNode, false);
  expect(viewport.querySelector("#zones")!.children[0].getAttribute("fill")).toBe(actual);
  expect(viewport.querySelector("[data-zone-hatch-fill]")).toBe(null);
  expect(clones(viewport).length).toBe(0);
  expect(viewport.querySelector(":scope > defs")!.children.length).toBe(2);
  expect(clones(f.root).length).toBe(1);
});
it("handles CSSOM-normalized inline fills and editing groups without cloning private clones", () => {
  const f = setup();
  f.path.removeAttribute("fill");
  f.path.style.fill = "url(#zp-raid)";
  const preview = f.zones.appendChild(new Svg("g"));
  preview.setAttribute("fill", "url(#zp-raid)");
  preview.appendChild(new Svg("polygon"));
  updateZoneHatching(2);
  const clone = clones(f.root)[0];
  updateZoneHatching(2);
  updateZoneHatching(8);
  expect(clones(f.root).length).toBe(1);
  expect(clones(f.root)[0]).toBe(clone);
  expect(f.path.style.fill).toBe(`url("#${clone.id}")`);
  expect(preview.getAttribute("fill")).toBe(`url(#${clone.id})`);
  restoreZoneHatching(f.root as unknown as ParentNode);
  expect(f.path.style.fill).toBe('url("#zp-raid")');
  expect(preview.getAttribute("fill")).toBe("url(#zp-raid)");
});
it("restores private attribute ownership before a new inline override and root replacement", () => {
  const f = setup();
  updateZoneHatching(8);
  const custom = pattern("override", "rotate(10)");
  f.defs.appendChild(custom);
  f.path.style.fill = "url(#override)";
  updateZoneHatching(8);
  expect(f.path.getAttribute("fill")).toBe("url(#zp-raid)");
  expect(f.path.getAttribute("data-zone-hatch-fill")).toBe('url("#override")');
  f.path.style.fill = "red";
  updateZoneHatching(8);
  expect(f.path.style.fill).toBe("red");
  expect(f.path.getAttribute("fill")).toBe("url(#zp-raid)");
  expect(f.path.hasAttribute("data-zone-hatch-fill")).toBe(false);
  expect(clones(f.root).length).toBe(0);
  f.path.style.fill = "";
  updateZoneHatching(8);
  expect(clones(f.root).length).toBe(1);
  const next = setup(pattern("next", "rotate(15)"));
  updateZoneHatching(2);
  expect(clones(f.root).length).toBe(0);
  expect(f.path.getAttribute("fill")).toBe("url(#zp-raid)");
  expect(clones(next.root)[0].getAttribute("patternTransform")).toBe("scale(0.5) rotate(15)");
});
it("inherits local pattern units and transforms, protects stock defs, and avoids unchanged-scale DOM writes", () => {
  const f = setup();
  const stock = pattern("stock", "rotate(30)");
  outside.push(stock);
  const child = new Svg("pattern");
  child.id = "derived";
  child.setAttribute("href", "#stock");
  f.defs.appendChild(child);
  f.path.setAttribute("fill", "url(#derived)");
  const original = stock.outerHTML;
  updateZoneHatching(8);
  const clone = clones(f.root)[0];
  expect(clone.getAttribute("href")).toBe("#stock");
  expect(clone.getAttribute("patternTransform")).toBe("scale(0.125) rotate(30)");
  expect(stock.outerHTML).toBe(original);
  const writes = vi.spyOn(clone, "setAttribute"),
    queries = vi.spyOn(f.zones, "querySelectorAll");
  updateZoneHatching(8);
  updateZoneHatching(8);
  expect(writes).not.toHaveBeenCalled();
  expect(queries).not.toHaveBeenCalled();
});
