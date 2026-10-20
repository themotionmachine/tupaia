import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/lazy-loaders", () => ({ lazy: {} }));

import { caravanTransform, setCaravanDomPaused } from "./caravan-poses";
import { clear, draw, keepSingleContainer, stripCloneCaravans } from "./draw-trade-animation";

afterEach(() => {
  setCaravanDomPaused(false);
  vi.unstubAllGlobals();
});

// a d3-like selection where every call chains; node() and remove() reach the backing fake node
function chain(node?: { remove(): void }): any {
  const selection: any = new Proxy(
    {},
    {
      get: (_, key) => {
        if (key === "node") return () => node;
        if (key === "remove")
          return () => {
            node?.remove();
            return selection;
          };
        return () => selection;
      }
    }
  );
  return selection;
}

function container() {
  const interrupted: unknown[] = [];
  return {
    interrupted,
    append: () => chain({ remove: vi.fn() }),
    selectAll: (selector: string | (() => unknown[])) => ({
      interrupt() {
        if (typeof selector === "function") interrupted.push(...selector());
        return this;
      },
      remove() {}
    })
  };
}

function stubWorld(layer: ReturnType<typeof container>) {
  vi.stubGlobal("tradeAnimation", layer);
  vi.stubGlobal("options", { trade: { animation: { markerSize: 4, duration: 250, landDurationModifier: 5 } } });
  vi.stubGlobal("document", {
    getElementById: () => ({ querySelector: () => ({}), querySelectorAll: () => [] }), // marker symbols present: no fetch
    createElementNS: () => ({ setAttribute() {}, getTotalLength: () => 10, getPointAtLength: () => ({ x: 0, y: 0 }) })
  });
}

const batch = { id: "1-2", deals: [], startBurgId: 1, endBurgId: 2, type: "local" as const };
const segments = [{ type: "land" as const, points: [[0, 0] as [number, number], [10, 0] as [number, number]] }];

it("keeps the first of duplicate #tradeAnimation containers and is idempotent", () => {
  const nodes = [{ remove: vi.fn() }, { remove: vi.fn() }, { remove: vi.fn() }];
  keepSingleContainer({ querySelectorAll: () => nodes } as unknown as ParentNode);
  expect(nodes.map(node => node.remove.mock.calls.length)).toEqual([0, 1, 1]);
  keepSingleContainer({ querySelectorAll: () => nodes.slice(0, 1) } as unknown as ParentNode);
  expect(nodes[0].remove).not.toHaveBeenCalled();
});

it("clear() removes caravans left in a replaced world's container, once", async () => {
  const before = container();
  stubWorld(before);
  const removes: ReturnType<typeof vi.fn>[] = [];
  before.append = () => {
    const node = { remove: vi.fn() };
    removes.push(node.remove);
    return chain(node);
  };
  await draw(batch, segments);
  await draw(batch, segments);
  expect(removes).toHaveLength(2);

  const after = container(); // a load swaps the container; the old groups are out of its reach
  stubWorld(after);
  clear();
  expect(removes.map(remove => remove.mock.calls.length)).toEqual([1, 1]);
  expect(after.interrupted).toHaveLength(2);

  clear();
  expect(removes.map(remove => remove.mock.calls.length)).toEqual([1, 1]);
  expect(after.interrupted).toHaveLength(2);
});

// A minimal live tree: just enough Element for the container queries the module makes
class El {
  children: El[] = [];
  parentElement: El | null = null;
  interrupted = 0;
  attrs = new Map<string, string>();
  constructor(
    public tagName: string,
    public id = "",
    public className = ""
  ) {}
  add(child: El): El {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  remove(): void {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  all(): El[] {
    return this.children.flatMap(child => [child, ...child.all()]);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  querySelector(): object {
    return {}; // marker symbols present: no fetch
  }
  querySelectorAll(selector: string): El[] {
    if (selector === "#tradeAnimation") return this.all().filter(n => n.id === "tradeAnimation");
    if (selector === "#tradeAnimation > g")
      return this.all().filter(n => n.tagName === "g" && n.parentElement?.id === "tradeAnimation");
    throw new Error(selector);
  }
}

let ends: (() => void)[] = [];
let tweens: ((this: El) => (t: number) => void)[] = [];
let interrupts: ((this: El) => void)[] = [];

// d3-like selection over El nodes; transition/style calls chain, attributes land on the nodes, and "end"/interrupt
// handlers and tween factories are kept so tests can finish, interrupt and tick caravans
function selection(nodes: El[]): any {
  const own: any = {
    node: () => nodes[0],
    attr: (name: string, value: unknown) => {
      for (const node of nodes) node.setAttribute(name, String(value));
      return proxy;
    },
    tween: (_name: string, factory: (this: El) => (t: number) => void) => {
      tweens.push(factory);
      return proxy;
    },
    append: (tag: string) => selection(nodes.map(node => node.add(new El(tag)))),
    select: (pick: () => El) => selection([pick()]),
    selectAll: (arg: string | (() => El[])) =>
      selection(
        typeof arg === "function"
          ? arg()
          : nodes.flatMap(node =>
              node.children.filter(c => (arg === "g" ? c.tagName === "g" : c.className === "highlight"))
            )
      ),
    interrupt: () => {
      for (const node of nodes) node.interrupted++;
      return proxy;
    },
    remove: () => {
      for (const node of nodes) node.remove();
      return proxy;
    },
    on: (event: string, handler: () => void) => {
      if (event === "end") ends.push(handler);
      if (event === "interrupt.pose") interrupts.push(handler);
      return proxy;
    }
  };
  const proxy: any = new Proxy(own, { get: (target, key) => (key in target ? target[key] : () => proxy) });
  return proxy;
}

function world(containers = 1) {
  const map = new El("svg", "map");
  const viewbox = map.add(new El("g", "viewbox"));
  const routes = viewbox.add(new El("g", "routes"));
  routes.add(new El("g")); // an unrelated layer's group
  const list = Array.from({ length: containers }, () => viewbox.add(new El("g", "tradeAnimation")));
  return { map, viewbox, routes, list };
}

type World = ReturnType<typeof world>;

// makes `w` the document's live map; `container` is what the global selection currently holds
function live(w: World, container: El = w.list[0], ...attached: El[]) {
  vi.stubGlobal("viewbox", selection([w.viewbox]));
  vi.stubGlobal("tradeAnimation", selection([container]));
  vi.stubGlobal("options", { trade: { animation: { markerSize: 4, duration: 250, landDurationModifier: 5 } } });
  vi.stubGlobal("document", {
    getElementById: (id: string) => (id === "map" ? w.map : { querySelector: () => ({}) }),
    // a straight path along x: the sample at length l is (l, 0)
    createElementNS: () => ({
      setAttribute() {},
      getTotalLength: () => 10,
      getPointAtLength: (l: number) => ({ x: l, y: 0 })
    }),
    // document-wide, like the harness guard: the live map plus anything else attached (export clones)
    querySelectorAll: (selector: string) => [w.map, ...attached].flatMap(root => root.querySelectorAll(selector))
  });
}

const bound = () => (globalThis as any).tradeAnimation.node() as El;
const caravans = () => (globalThis as any).document.querySelectorAll("#tradeAnimation > g") as El[];

it("old-map duplicate container: draw rebinds the selection to the first container and drops the duplicate", async () => {
  ends = [];
  const w = world(2);
  w.list[1].add(new El("g")); // a static caravan saved inside the duplicate
  live(w, w.list[1]);
  await draw(batch, segments);
  expect(bound()).toBe(w.list[0]);
  expect(w.map.querySelectorAll("#tradeAnimation")).toEqual([w.list[0]]);
  expect(caravans()).toHaveLength(1);
  expect(caravans()[0].parentElement).toBe(w.list[0]);
  clear();
  expect(caravans()).toHaveLength(0);
});

it("stop cleanup interrupts and removes caravans in every live container, keeping highlights and other layers", () => {
  const w = world(2);
  const highlight = w.list[0].add(new El("path", "", "highlight"));
  const strays = [w.list[0].add(new El("g")), w.list[1].add(new El("g")), w.list[1].add(new El("g"))];
  live(w);
  clear();
  expect(caravans()).toHaveLength(0);
  expect(strays.every(stray => stray.interrupted > 0 && !stray.parentElement)).toBe(true);
  expect(w.list[0].children).toEqual([highlight]);
  expect(w.routes.children).toHaveLength(1);
  expect(w.map.querySelectorAll("#tradeAnimation")).toEqual([w.list[0]]);
  expect(bound()).toBe(w.list[0]);
});

// a deep copy of the live map with 30 caravans and a highlight, as prepareMapClone makes before attaching it
function mapCopy() {
  const clone = world();
  for (let i = 0; i < 30; i++) clone.list[0].add(new El("g"));
  clone.list[0].add(new El("path", "", "highlight"));
  return clone;
}

it("generated world: an attached GPU compat clone carries no caravans, so stop leaves none document-wide", async () => {
  ends = [];
  const w = world();
  live(w);
  for (let i = 0; i < 30; i++) await draw(batch, segments); // the default 30 concurrent caravans in flight
  const clone = mapCopy();
  stripCloneCaravans(clone.map as unknown as ParentNode, "gpu");
  live(w, w.list[0], clone.map);
  expect(caravans()).toHaveLength(30);
  clear();
  expect(caravans()).toHaveLength(0);
  expect(clone.list[0].children.map(c => c.className)).toEqual(["highlight"]);
  expect(clone.routes.children).toHaveLength(1);
});

it("user svg/png/jpeg/mesh exports keep the mid-flight caravan snapshot unchanged", () => {
  for (const type of ["svg", "png", "jpeg", "mesh"]) {
    const clone = mapCopy();
    const before = clone.list[0].children.slice();
    stripCloneCaravans(clone.map as unknown as ParentNode, type);
    expect(clone.list[0].children).toEqual(before);
    expect(clone.map.querySelectorAll("#tradeAnimation > g")).toHaveLength(30);
  }
});

it("repeated load/migration: stale caravans are stopped and resumed caravans land once in the new canonical container", async () => {
  ends = [];
  const first = world();
  live(first);
  await draw(batch, segments);
  await draw(batch, segments);
  const old = first.list[0].children.slice();

  // load 1: the world is replaced and load.ts re-selects the container; old groups are only reachable via liveGroups
  const second = world();
  keepSingleContainer(second.viewbox as unknown as ParentNode);
  live(second);
  clear();
  expect(old.every(group => group.interrupted > 0 && !group.parentElement)).toBe(true);

  // load 2: an old save with a duplicate container, and the selection still points at the previous world
  const third = world(2);
  live(third, second.list[0]);
  keepSingleContainer(third.viewbox as unknown as ParentNode);
  keepSingleContainer(third.viewbox as unknown as ParentNode); // idempotent
  await draw(batch, segments); // resume
  expect(bound()).toBe(third.list[0]);
  expect(caravans()).toHaveLength(1);
  expect(second.list[0].children).toHaveLength(0);

  ends.at(-1)!(); // the resumed caravan finishes and removes itself
  expect(caravans()).toHaveLength(0);
  clear();
  expect(bound()).toBe(third.list[0]);
});

it("GPU pause: ticks keep their pose off the DOM until resumed; exports copy and interrupts settle the live pose", async () => {
  ends = [];
  tweens = [];
  interrupts = [];
  const w = world();
  live(w);
  await draw(batch, segments);
  const [group] = caravans();
  expect(group.getAttribute("transform")).toBe("translate(0, 0)");
  const tick = tweens[0].call(group);
  tick(0.5); // SVG mode: written, as attrTween("transform") did
  expect(group.getAttribute("transform")).toBe("translate(5, 0) rotate(0)");

  setCaravanDomPaused(true); // the GPU canvas covers the SVG
  tick(0.8);
  expect(group.getAttribute("transform")).toBe("translate(5, 0) rotate(0)");
  expect(caravanTransform(group as unknown as Element)).toBe("translate(8, 0) rotate(0)");

  // a user export made meanwhile shows the caravan where the GPU drew it
  const copy = world();
  const copied = copy.list[0].add(new El("g"));
  copied.setAttribute("transform", "translate(5, 0) rotate(0)");
  stripCloneCaravans(copy.map as unknown as ParentNode, "png");
  expect(copied.getAttribute("transform")).toBe("translate(8, 0) rotate(0)");

  interrupts[0].call(group); // stop or a harness freeze: the group keeps the pose last drawn
  expect(group.getAttribute("transform")).toBe("translate(8, 0) rotate(0)");

  tick(0.9);
  setCaravanDomPaused(false); // the SVG is shown again: the pose is written before the next tick
  expect(group.getAttribute("transform")).toBe("translate(9, 0) rotate(0)");
  ends.at(-1)!();
  expect(caravans()).toHaveLength(0);
});
