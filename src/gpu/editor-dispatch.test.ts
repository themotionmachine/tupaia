import { describe, expect, it } from "vitest";
import {
  type ClickRouteDeps,
  clickedBranch,
  createTelemetry,
  dispatchTarget,
  READY_KINDS,
  recoverClick,
  routeClick
} from "./editor-dispatch";
import type { GpuSelection, SelectionKind } from "./selection";

// Stable-identity element tree: the ancestry, closest() and the label querySelector the adapter reads.
interface Node {
  tagName: string;
  id: string;
  isConnected: boolean;
  parentElement: Node | null;
  children: Node[];
  closest(tag: string): Node | null;
  querySelector(selector: string): Node | null;
}
function node(tagName: string, id = "", kids: Element[] = []): Element {
  const self: Node = {
    tagName,
    id,
    isConnected: true,
    parentElement: null,
    children: kids as unknown as Node[],
    closest(tag: string) {
      for (let n: Node | null = self; n; n = n.parentElement) if (n.tagName === tag) return n;
      return null;
    },
    querySelector(selector: string) {
      if (selector !== ":scope > textPath > tspan") throw new Error(selector);
      return self.children.find(c => c.tagName === "textPath")?.children.find(c => c.tagName === "tspan") ?? null;
    }
  };
  for (const kid of self.children) kid.parentElement = self;
  return self as unknown as Element;
}
// a leaf nested under groups with the given ids (outermost first) inside div > svg#map > g#viewbox
function under(leaf: Element, ...ids: string[]): Element {
  let child = leaf;
  for (const id of ids.reverse()) child = node("g", id, [child]);
  node("div", "", [node("svg", "map", [node("g", "viewbox", [child])])]);
  return leaf;
}

const selection = (over: Partial<GpuSelection>): GpuSelection =>
  ({ kind: "none", id: "", branch: "none", via: "none", ...over }) as GpuSelection;

const click = (target: Element | null) => {
  const event = {
    type: "click",
    target,
    currentTarget: null,
    clientX: 110,
    clientY: 220,
    pageX: 110,
    pageY: 220,
    screenX: 0,
    screenY: 0,
    button: 0,
    buttons: 0,
    detail: 1,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    prevented: 0,
    preventDefault() {
      event.prevented++;
    },
    stopPropagation() {}
  };
  return event as unknown as MouseEvent & { prevented: number };
};

function deps(over: Partial<ClickRouteDeps> & { selected: GpuSelection }) {
  const calls = { select: [] as [number, number][], sync: 0, resolve: 0 };
  const d: ClickRouteDeps = {
    select: (x, y) => {
      calls.select.push([x, y]);
      return over.selected;
    },
    origin: () => [10, 20],
    stale: () => false,
    sync: () => calls.sync++,
    resolve: () => {
      calls.resolve++;
      return null;
    },
    ready: new Set<SelectionKind>(),
    ...over
  };
  return { d, calls };
}

describe("clickedBranch", () => {
  it("replicates clicked()'s fixed-depth branches in order", () => {
    const route = under(node("path", "route5"), "routes", "roads");
    expect(clickedBranch(route)).toBe("routes");
    const tspan = node("tspan");
    under(node("text", "stateLabel3", [node("textPath", "", [tspan])]), "labels", "states");
    expect(clickedBranch(tspan)).toBe("labels");
    // a <text> is not the tspan clicked() opens the label editor for
    expect(clickedBranch(tspan.parentElement!.parentElement)).toBe("fallback");
    const markerLeaf = node("path");
    under(node("svg", "marker7", [markerLeaf]), "markers");
    expect(clickedBranch(markerLeaf)).toBe("markers");
    const burg = under(node("use", "burg4"), "burgIcons", "towns");
    expect(clickedBranch(burg)).toBe("burgIcons");
    expect(clickedBranch(under(node("path", "river2"), "rivers"))).toBe("rivers");
    expect(clickedBranch(under(node("use"), "terrain"))).toBe("terrain");
    // emblems precede routes: a grand #emblems wins whatever the parent
    expect(clickedBranch(under(node("use"), "emblems", "burgEmblems"))).toBe("emblems");
    expect(clickedBranch(under(node("path", "cell"), "cells"))).toBe("fallback");
    // markets: a <path> under #markets fails clicked()'s tagName test and falls through (here to the fallback leg)
    expect(clickedBranch(under(node("use"), "markets", "marketItems"))).toBe("markets");
    expect(clickedBranch(under(node("path"), "markets", "marketItems"))).toBe("fallback");
    expect(clickedBranch(node("svg", "map", [node("g")]).children[0] as Element)).toBe("ignored");
    expect(clickedBranch(null)).toBe("ignored");
  });
});

describe("dispatchTarget", () => {
  it("dispatches a label's tspan, other kinds' target, and nothing for a detached or missing target", () => {
    const tspan = node("tspan");
    const text = under(node("text", "stateLabel3", [node("textPath", "", [tspan])]), "labels", "states");
    expect(dispatchTarget(selection({ kind: "label", branch: "labels", via: "index", target: text }))).toBe(tspan);
    const route = under(node("path", "route5"), "routes", "roads");
    expect(dispatchTarget(selection({ kind: "route", branch: "routes", via: "index", target: route }))).toBe(route);
    (route as unknown as Node).isConnected = false;
    expect(dispatchTarget(selection({ kind: "route", branch: "routes", via: "index", target: route }))).toBeNull();
    expect(dispatchTarget(selection({ kind: "burg", branch: "pickBurg", via: "pickBurg" }))).toBeNull();
  });
});

describe("routeClick", () => {
  it("ships with marker as the only ready kind: the one kind the picking matrix admitted", () => {
    expect([...READY_KINDS]).toEqual(["marker"]);
  });

  it("current camera: legacy dispatch of the native event, GPU selection in shadow only", () => {
    const route = under(node("path", "route5"), "routes", "roads");
    const other = under(node("path", "route6"), "routes", "roads");
    const telemetry = createTelemetry();
    const { d, calls } = deps({
      selected: selection({ kind: "route", id: "route5", branch: "routes", via: "index", target: route }),
      ready: new Set(["route"])
    });
    expect(routeClick(d, click(route), telemetry)).toBeNull();
    expect(calls.select).toEqual([[100, 200]]); // SVG-local CSS px
    expect(routeClick(d, click(other), telemetry)).toBeNull();
    expect(calls.sync).toBe(0);
    expect(calls.resolve).toBe(0);
    expect(telemetry.byKind.route).toMatchObject({ legacy: 2, agree: 1, disagree: 1, routed: 0 });
    expect(telemetry.disagreements[0]).toEqual({ kind: "route", native: "path#route6", gpu: "path#route5" });
  });

  it("agrees on the editor subject, not the exact leaf (a label's tspan, a marker's svg)", () => {
    const tspan = node("tspan");
    const text = under(node("text", "stateLabel3", [node("textPath", "", [tspan])]), "labels", "states");
    const telemetry = createTelemetry();
    const { d } = deps({ selected: selection({ kind: "label", branch: "labels", via: "index", target: text }) });
    routeClick(d, click(tspan), telemetry);
    expect(telemetry.byKind.label).toMatchObject({ agree: 1, disagree: 0 });
    // fallbacks agree only with a native click clicked() also sends down the fallback leg
    const cell = under(node("path", "cell"), "cells");
    const burg = deps({ selected: selection({ kind: "burg", id: "4", branch: "pickBurg", via: "pickBurg" }) });
    routeClick(burg.d, click(cell), telemetry);
    routeClick(burg.d, click(tspan), telemetry);
    expect(telemetry.byKind.burg).toMatchObject({ agree: 1, disagree: 1 });
  });

  it("stale camera, ready kind: syncs the canonical camera, then routes the GPU target once", () => {
    const route = under(node("path", "route5"), "routes", "roads");
    const stray = under(node("path", "cell"), "cells");
    const telemetry = createTelemetry();
    const { d, calls } = deps({
      selected: selection({ kind: "route", id: "route5", branch: "routes", via: "index", target: route }),
      stale: () => true,
      ready: new Set(["route"])
    });
    const native = click(stray);
    const routed = routeClick(d, native, telemetry);
    expect(routed ? routed.target : routed).toBe(route);
    expect(routed && [routed.clientX, routed.pageY, routed.type]).toEqual([110, 220, "click"]);
    if (routed) routed.preventDefault();
    expect(native.prevented).toBe(1);
    expect(calls.sync).toBe(1);
    expect(calls.resolve).toBe(0);
    expect(telemetry.byKind.route).toMatchObject({ routed: 1, legacy: 0 });
  });

  it("stale camera, unready kind: syncs, then takes the legacy path at the current camera", () => {
    const route = under(node("path", "route5"), "routes", "roads");
    const stray = under(node("path", "cell"), "cells");
    const telemetry = createTelemetry();
    const order: string[] = [];
    const { d } = deps({
      selected: selection({ kind: "route", id: "route5", branch: "routes", via: "index", target: route }),
      stale: () => true,
      sync: () => order.push("sync"),
      resolve: (x, y) => {
        order.push(`resolve ${x},${y}`);
        return route;
      }
    });
    const routed = routeClick(d, click(stray), telemetry);
    expect(order).toEqual(["sync", "resolve 110,220"]); // the SVG hit test re-runs only after the camera is written
    expect(routed ? routed.target : routed).toBe(route);
    expect(telemetry.byKind.route).toMatchObject({ routed: 0, resynced: 1, agree: 1 });
  });

  it("stale camera: an unavailable index, a branch mismatch or a canvas fallback never routes a GPU target", () => {
    const telemetry = createTelemetry();
    const unavailable = deps({
      selected: selection({ branch: "unavailable", unavailable: "suspended: editor dialog open" }),
      stale: () => true,
      ready: new Set(["route", "marker", "burg"])
    });
    expect(routeClick(unavailable.d, click(null), telemetry)).toBe(false);
    expect(unavailable.calls.sync).toBe(1);
    expect(telemetry.byKind.unavailable).toMatchObject({ unavailable: 1, dropped: 1, agree: 0, disagree: 0 });
    // a depth-0 marker <svg> target fails clicked()'s own markers test: not routed even when marker is ready
    const marker = under(node("svg", "marker7"), "markers");
    const mismatch = deps({
      selected: selection({ kind: "marker", id: "marker7", branch: "markers", via: "index", target: marker }),
      stale: () => true,
      ready: new Set(["marker"])
    });
    expect(routeClick(mismatch.d, click(null), telemetry)).toBe(false);
    expect(telemetry.byKind.marker).toMatchObject({ routed: 0, dropped: 1 });
    const fallback = deps({
      selected: selection({ kind: "burg", id: "4", branch: "pickBurg", via: "pickBurg" }),
      stale: () => true,
      ready: new Set(["burg"])
    });
    expect(routeClick(fallback.d, click(null), telemetry)).toBe(false);
    expect(telemetry.byKind.burg).toMatchObject({ routed: 0, dropped: 1 });
  });
});

describe("routeClick outcomes and telemetry", () => {
  const route = under(node("path", "route5"), "routes", "roads");
  const stray = under(node("path", "cell"), "cells");

  it("every drop carries a reason: a re-run hit outside #viewbox is outside-viewbox", () => {
    const telemetry = createTelemetry();
    const { d } = deps({
      selected: selection({ kind: "route", id: "route5", branch: "routes", via: "index", target: route }),
      stale: () => true
    });
    expect(routeClick(d, click(stray), telemetry)).toBe(false);
    expect(telemetry.dropReasons).toEqual({ "outside-viewbox": 1, error: 0 });
    expect(telemetry.byKind.route).toMatchObject({ dropped: 1, resynced: 0, routed: 0 });
  });

  it("rendering-only mode re-hits canonical SVG after sync without querying GPU geometry", () => {
    const telemetry = createTelemetry();
    const order: string[] = [];
    const { d, calls } = deps({ selected: selection({}), stale: () => true });
    d.select = null;
    d.origin = () => {
      throw new Error("GPU coordinates must not be read");
    };
    d.sync = () => order.push("sync");
    d.resolve = () => {
      order.push("resolve");
      return route;
    };
    expect(routeClick(d, click(stray), telemetry)).toMatchObject({ target: route });
    expect(order).toEqual(["sync", "resolve"]);
    expect(calls.select).toEqual([]);
    expect(telemetry.byKind.canonical).toMatchObject({ resynced: 1, routed: 0, errors: 0, disagree: 0 });
  });

  it("rendering-only mode preserves current native clicks and drops stale hits outside the map", () => {
    const telemetry = createTelemetry();
    const { d, calls } = deps({ selected: selection({}) });
    d.select = null;
    expect(routeClick(d, click(route), telemetry)).toBeNull();
    expect(calls.sync).toBe(0);
    expect(calls.resolve).toBe(0);
    d.stale = () => true;
    expect(routeClick(d, click(stray), telemetry)).toBe(false);
    expect(telemetry.byKind.canonical).toMatchObject({ legacy: 1, dropped: 1, routed: 0 });
    expect(telemetry.dropReasons["outside-viewbox"]).toBe(1);
  });

  it("a throwing select on a current view is counted under error and dispatches the native event", () => {
    const telemetry = createTelemetry();
    const native = click(route);
    const { d } = deps({ selected: selection({}) });
    d.select = () => {
      throw new Error("pick index unavailable");
    };
    expect(routeClick(d, native, telemetry)).toBeNull();
    expect(native.prevented).toBe(0);
    expect(telemetry.errors).toBe(1);
    expect(telemetry.byKind.error).toMatchObject({ errors: 1, legacy: 1, dropped: 0 });
  });

  it("a throwing select on a stale view is treated as unready: sync, then the SVG re-run hit", () => {
    const telemetry = createTelemetry();
    const order: string[] = [];
    const { d } = deps({ selected: selection({}), stale: () => true });
    d.select = () => {
      throw new Error("pick index unavailable");
    };
    d.sync = () => order.push("sync");
    d.resolve = (x, y) => {
      order.push(`resolve ${x},${y}`);
      return route;
    };
    expect(routeClick(d, click(stray), telemetry)).toMatchObject({ target: route });
    expect(order).toEqual(["sync", "resolve 110,220"]);
    expect(telemetry.errors).toBe(1);
    expect(telemetry.byKind.error).toMatchObject({ errors: 1, resynced: 1 });
  });

  it("fails closed on a stale view when sync or resolve throws: no stale native target, a counted error drop", () => {
    for (const fail of ["sync", "resolve"] as const) {
      const telemetry = createTelemetry();
      const native = click(stray);
      const { d } = deps({
        selected: selection({ kind: "route", id: "route5", branch: "routes", via: "index", target: route }),
        stale: () => true
      });
      const boom = () => {
        throw new Error(fail);
      };
      if (fail === "sync") d.sync = boom;
      else d.resolve = boom;
      expect(routeClick(d, native, telemetry)).toBe(false);
      expect(native.prevented).toBe(0);
      expect(telemetry.dropReasons).toEqual({ "outside-viewbox": 0, error: 1 });
      expect(telemetry.errors).toBe(1);
      expect(telemetry.byKind.route).toMatchObject({ dropped: 1, errors: 1, routed: 0 });
    }
  });

  it("fails closed when the camera state itself cannot be read", () => {
    const telemetry = createTelemetry();
    const { d } = deps({ selected: selection({}) });
    d.stale = () => {
      throw new Error("no renderer");
    };
    expect(routeClick(d, click(stray), telemetry)).toBe(false);
    expect(telemetry.dropReasons.error).toBe(1);
  });

  it("world replacement: a target detached by a rebuilt #map is never routed and never held", () => {
    const telemetry = createTelemetry();
    const replaced = under(node("path", "route5"), "routes", "roads");
    (replaced as unknown as Node).isConnected = false; // the world was rebuilt; this element is no longer in the DOM
    const fresh = under(node("path", "route5"), "routes", "roads");
    const { d } = deps({
      selected: selection({ kind: "route", id: "route5", branch: "routes", via: "index", target: replaced }),
      stale: () => true,
      ready: new Set(["route"]),
      resolve: () => fresh
    });
    const routed = routeClick(d, click(stray), telemetry);
    expect(routed ? routed.target : routed).toBe(fresh); // the live SVG hit, not the detached GPU target
    expect(telemetry.byKind.route).toMatchObject({ routed: 0, resynced: 1 });
    // the telemetry holds strings only: no element (the fake tree is cyclic, so a reference would fail to serialize)
    expect(() => JSON.stringify(telemetry)).not.toThrow();
  });

  it("dialog open (index unavailable) on a stale view never routes a GPU target", () => {
    const telemetry = createTelemetry();
    const { d } = deps({
      selected: selection({ branch: "unavailable", unavailable: "suspended: editor dialog open" }),
      stale: () => true,
      ready: new Set(["marker"]),
      resolve: () => route
    });
    expect(routeClick(d, click(stray), telemetry)).toMatchObject({ target: route });
    expect(telemetry.byKind.unavailable).toMatchObject({ unavailable: 1, resynced: 1, routed: 0 });
  });

  it("a click on the current view is not prevented or re-targeted (gesture-cancelled clicks never reach here)", () => {
    // d3-zoom/d3-drag swallow the click of a completed drag on window capture, before #viewbox and the document
    // capture listener run, so routeClick only ever sees real clicks. A click that does arrive is left untouched.
    const telemetry = createTelemetry();
    const native = click(route);
    const { d } = deps({
      selected: selection({ kind: "route", id: "route5", branch: "routes", via: "index", target: route }),
      stale: () => false
    });
    expect(routeClick(d, native, telemetry)).toBeNull();
    expect(native.prevented).toBe(0);
  });
});

describe("recoverClick", () => {
  const map = node("svg", "map");
  const marker = under(node("path"), "marker7", "markers");
  const legend = node("rect", "legendBox");
  function run(target: Element, stale: boolean, resolved: Element | null) {
    const telemetry = createTelemetry();
    const order: string[] = [];
    const result = recoverClick(
      {
        stale: () => stale,
        sync: () => order.push("sync"),
        background: el => el === map,
        resolve: (x, y) => {
          order.push(`resolve ${x},${y}`);
          return resolved;
        }
      },
      click(target),
      telemetry
    );
    return { result, order, telemetry };
  }

  it("stale view, bare #map hit: syncs, then re-dispatches to the SVG's re-run hit inside #viewbox", () => {
    const { result, order, telemetry } = run(map, true, marker);
    expect(result).toBe(marker);
    expect(order).toEqual(["sync", "resolve 110,220"]);
    expect([telemetry.recovered, telemetry.unrecovered]).toEqual([1, 0]);
    const outside = run(map, true, null); // still nothing of #viewbox there: the click stays on #map
    expect(outside.result).toBeNull();
    expect(outside.telemetry.unrecovered).toBe(1);
  });

  it("leaves current-camera clicks and hits outside the camera transform (legend) untouched", () => {
    expect(run(map, false, marker)).toMatchObject({ result: null, order: [] });
    expect(run(legend, true, marker)).toMatchObject({ result: null, order: [] });
    expect(run(marker, true, marker)).toMatchObject({ result: null, order: [] }); // clicked() handles it
  });

  it("an HTML overlay on top of the stale view keeps its click (not re-dispatched, not hijacked)", () => {
    // Decision: an overlay that is visibly on top is the element the user clicked, as in the SVG renderer. Only a
    // bare #map background hit is recovered; any other target (overlay, dialog, legend) is never redirected.
    const overlay = node("div", "dialogOverlay");
    const { result, order, telemetry } = run(overlay, true, marker);
    expect(result).toBeNull();
    expect(order).toEqual([]);
    expect(telemetry.recovered + telemetry.unrecovered + telemetry.errors).toBe(0);
  });

  it("an unrecovered background click is a counted drop; a throwing sync leaves the native click alone and is counted", () => {
    const missed = run(map, true, null);
    expect(missed.telemetry.dropReasons).toEqual({ "outside-viewbox": 1, error: 0 });
    const telemetry = createTelemetry();
    const result = recoverClick(
      {
        stale: () => true,
        sync: () => {
          throw new Error("camera");
        },
        background: el => el === map,
        resolve: () => marker
      },
      click(map),
      telemetry
    );
    expect(result).toBeNull();
    expect(telemetry.errors).toBe(1);
    expect(telemetry.recovered + telemetry.unrecovered).toBe(0);
  });
});
