import type { Selection } from "d3";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./draw-scalebar";
interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
  parent?: Node;
  datum?: number;
  text?: string;
  getBBox(): { width: number; height: number };
}
class Nodes {
  constructor(
    readonly nodes: Node[],
    private create: (tag: string) => Node,
    private parents: Node[] = []
  ) {}
  size() {
    return this.nodes.length;
  }
  node() {
    return this.nodes[0];
  }
  style() {
    return "block";
  }
  attr(name: string, value?: string | number | ((datum: number) => string | number)) {
    if (value === undefined) return this.node()?.attrs[name] ?? null;
    for (const node of this.nodes) node.attrs[name] = String(typeof value === "function" ? value(node.datum!) : value);
    return this;
  }
  select(selector: string) {
    const search = (nodes: Node[]): Node | undefined => {
      for (const node of nodes) {
        if (selector[0] === "#" ? node.attrs.id === selector.slice(1) : node.tag === selector) return node;
        const found = search(node.children);
        if (found) return found;
      }
    };
    const found = search(this.nodes.flatMap(node => node.children));
    return new Nodes(found ? [found] : [], this.create);
  }
  selectAll() {
    return new Nodes([], this.create, this.nodes);
  }
  data(values: number[]) {
    return {
      enter: () => ({
        append: (tag: string) => {
          const nodes = values.map(datum => {
            const node = this.create(tag);
            node.datum = datum;
            node.parent = this.parents[0];
            node.parent.children.push(node);
            return node;
          });
          return new Nodes(nodes, this.create);
        }
      })
    };
  }
  append(tag: string) {
    return new Nodes(
      this.nodes.map(parent => {
        const node = this.create(tag);
        node.parent = parent;
        node.datum = parent.datum;
        parent.children.push(node);
        return node;
      }),
      this.create
    );
  }
  text(value: string | ((datum: number) => string)) {
    for (const node of this.nodes) node.text = typeof value === "function" ? value(node.datum!) : value;
    return this;
  }
  remove() {
    for (const node of this.nodes) if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
  }
}
function fixture() {
  let bounds = { width: 220, height: 40 };
  const measure = vi.fn(() => bounds);
  const create = (tag: string): Node => ({ tag, attrs: {}, children: [], getBBox: measure });
  const node = create("g");
  node.attrs = {
    "data-bar-size": "2",
    "data-label": "Long custom caption",
    "data-x": "90",
    "data-y": "80",
    "font-family": "Custom font",
    "font-size": "17"
  };
  const back = create("rect");
  back.attrs = { id: "scaleBarBack", "data-left": "3", "data-top": "4", "data-right": "5", "data-bottom": "6" };
  back.parent = node;
  node.children.push(back);
  const selection = new Nodes([node], create) as unknown as Selection<SVGGElement, unknown, HTMLElement, unknown>;
  vi.stubGlobal("distanceUnitInput", { value: "km" });
  vi.stubGlobal("distanceScale", 3);
  return {
    node,
    back,
    selection,
    measure,
    bounds: (value: typeof bounds) => {
      bounds = value;
    }
  };
}
function content(node: Node) {
  return node.children.find(child => child.attrs.id === "scaleBarContent")!;
}
function geometry(node: Node): unknown {
  return { tag: node.tag, attrs: node.attrs, text: node.text, children: node.children.map(geometry) };
}
afterEach(() => vi.unstubAllGlobals());
describe("motion scale bar", () => {
  it("keeps distance labels and lines exact without measuring after priming; settled refresh uses exact custom bounds", () => {
    const f = fixture();
    window.drawScaleBar(f.selection, 2);
    expect(f.measure).toHaveBeenCalledTimes(1);
    window.drawScaleBarFast(f.selection, 4);
    expect(f.measure).toHaveBeenCalledTimes(1);
    const [lines, labels] = content(f.node).children;
    expect(Number(lines.children[1].attrs.x2)).toBeCloseTo(800 / 3 + 2);
    expect(labels.children.map(node => node.text)).toEqual([
      "0",
      "40",
      "80",
      "120",
      "160",
      "200 km",
      "Long custom caption"
    ]);
    expect(Number(f.back.attrs.width)).toBeCloseTo(800 / 3 + 20 + 5);
    expect(f.back.attrs.height).toBe("46");
    const fastGeometry = geometry(content(f.node));
    f.bounds({ width: 340, height: 55 });
    window.drawScaleBar(f.selection, 4);
    expect(f.measure).toHaveBeenCalledTimes(2);
    expect(geometry(content(f.node))).toEqual(fastGeometry);
    expect(f.back.attrs.width).toBe("345");
    expect(f.back.attrs.height).toBe("61");
    expect(f.back.attrs.x).toBe("-3");
    expect(f.back.attrs.y).toBe("-4");
    const exact = fixture();
    exact.bounds({ width: 340, height: 55 });
    window.drawScaleBar(exact.selection, 4);
    expect(geometry(f.node)).toEqual(geometry(exact.node));
  });
  it("measures once when fast mode has no cache, then fits numeric rectangles without native geometry", () => {
    const f = fixture();
    window.drawScaleBarFast(f.selection, 2);
    expect(f.measure).toHaveBeenCalledTimes(1);
    window.fitScaleBar(f.selection, 1000, 500);
    expect(f.measure).toHaveBeenCalledTimes(1);
    expect(f.node.attrs.transform).toBe("translate(685,374)");
    f.back.attrs.width = "50%";
    f.bounds({ width: 500, height: 46 });
    window.fitScaleBar(f.selection, 1000, 500);
    expect(f.measure).toHaveBeenCalledTimes(2);
    expect(f.node.attrs.transform).toBe("translate(410,374)");
  });
});
