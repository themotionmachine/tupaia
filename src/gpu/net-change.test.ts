// @vitest-environment happy-dom
// D13 net-change test (W3 LIFE3): an editor session that leaves svg#map as it found it is "unchanged" whatever it did
// in between; anything else is "changed", and what the tracker cannot account for is "unsure".
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NetChange, type NetRecord, undo } from "./net-change";

const SVG_NS = "http://www.w3.org/2000/svg";
let svg: SVGSVGElement;
let observer: MutationObserver;
let net: NetChange;

const $ = (selector: string) => svg.querySelector(selector) as Element;
// one observer batch, as the renderer's callback (or a takeRecords drain) would deliver it
const batch = () => net.note(observer.takeRecords());
const verdict = () => {
  batch();
  return net.end(svg);
};

beforeEach(() => {
  svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.id = "map";
  svg.innerHTML = `<g id="viewbox" transform="translate(0 0) scale(1)">
    <g id="icons"><g id="town"><image data-burg-vectors="&lt;use href=&quot;#icon&quot; x=&quot;1&quot;&gt;&lt;/use&gt;" href="data:png1" x="0"/></g></g>
    <g id="markers"><svg id="marker0" class="draggable"><use href="#marker-icon"/></svg><svg id="marker1"/></g>
    <g id="labels"><text id="label0">Ash</text></g>
    <g id="debug"></g>
  </g>`;
  document.body.append(svg);
  observer = new MutationObserver(() => {});
  observer.observe(svg, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
    characterData: true,
    characterDataOldValue: true
  });
  net = new NetChange();
  net.begin();
});

afterEach(() => {
  observer.disconnect();
  svg.remove();
});

describe("[LIFE3] net-change test (D13)", () => {
  it("a session with no records, or whose edits were undone, is unchanged", () => {
    expect(verdict()).toBe("unchanged");
    net.begin();
    $("#label0").setAttribute("font-size", "12");
    batch();
    $("#label0").removeAttribute("font-size");
    expect(verdict()).toBe("unchanged");
  });

  it("a changed attribute, child list or text is changed", () => {
    $("#label0").setAttribute("fill", "red");
    expect(verdict()).toBe("changed");
    net.begin();
    $("#markers").append(document.createElementNS(SVG_NS, "svg"));
    expect(verdict()).toBe("changed");
    net.begin();
    ($("#label0").firstChild as Text).data = "Ashford";
    expect(verdict()).toBe("changed");
    expect(net.last).toEqual({ verdict: "changed", detail: "text in <text#label0>" });
  });

  it("an editor overlay added on open and removed on close is unchanged", () => {
    const points = document.createElementNS(SVG_NS, "g");
    points.id = "controlPoints";
    $("#debug").append(points);
    for (let i = 0; i < 3; i++) points.append(document.createElementNS(SVG_NS, "circle"));
    batch();
    points.remove();
    expect(verdict()).toBe("unchanged");
  });

  it("a marker raised and re-classed (open) then restored (close) is unchanged", () => {
    const marker = $("#marker0");
    marker.parentElement!.append(marker); // d3 raise()
    marker.setAttribute("class", "draggable selected");
    batch();
    marker.setAttribute("class", "draggable");
    $("#markers").insertBefore(marker, $("#marker1"));
    expect(verdict()).toBe("unchanged");
  });

  it("a subtree replaced by an identical copy (innerHTML round trip) is unchanged; a different copy is changed", () => {
    const markers = $("#markers");
    const markup = markers.innerHTML;
    markers.innerHTML = markup;
    expect(verdict()).toBe("unchanged");
    net.begin();
    markers.innerHTML = markers.innerHTML.replace("marker-icon", "other-icon");
    expect(verdict()).toBe("changed");
  });

  it("burg icons swapped to vectors on open and re-rasterized on close are unchanged, the raster href aside", () => {
    // burg-canvas.ts: open restores the vectors from data-burg-vectors; close re-cuts the raster from the same markup
    // (the attribute holds what the serializer wrote, so the round trip is stable)
    const town = $("#town");
    const markup = town.firstElementChild!.getAttribute("data-burg-vectors")!;
    town.innerHTML = markup;
    $("#label0").setAttribute("class", ""); // the burg editor's label class write: "" is no class
    batch();
    const image = document.createElementNS(SVG_NS, "image");
    image.setAttribute("data-burg-vectors", town.innerHTML);
    image.setAttribute("href", "data:image/svg+xml,vectors");
    image.setAttribute("x", "0");
    town.replaceChildren(image);
    expect(verdict()).toBe("unchanged");
    // the same, but the editor moved the burg: different markup
    net.begin();
    town.innerHTML = markup.replace('x="1"', 'x="2"');
    batch();
    const moved = document.createElementNS(SVG_NS, "image");
    moved.setAttribute("data-burg-vectors", town.innerHTML);
    moved.setAttribute("href", "data:png2");
    moved.setAttribute("x", "0");
    town.replaceChildren(moved);
    expect(verdict()).toBe("changed");
  });

  it("ignores the camera transform, viewport-culled tokens and dense-zoom overlays", () => {
    $("#viewbox").setAttribute("transform", "translate(5 5) scale(2)");
    $("#label0").setAttribute("class", "viewport-culled");
    const overlay = document.createElementNS(SVG_NS, "g");
    overlay.setAttribute("data-dense-zoom", "");
    $("#icons").append(overlay);
    batch();
    overlay.append(document.createElementNS(SVG_NS, "image"));
    expect(verdict()).toBe("unchanged");
  });

  it("a node detached in one batch and re-attached in a later one is unsure (it may have changed unobserved)", () => {
    const marker = $("#marker1");
    const parent = marker.parentElement!;
    marker.remove();
    batch();
    marker.setAttribute("opacity", "0.5"); // detached: no record reaches the observer
    batch();
    parent.append(marker);
    expect(verdict()).toBe("unsure");
  });

  it("fail() makes the session unsure; end() without begin() is unsure", () => {
    net.fail("definition #burgCOA1");
    expect(verdict()).toBe("unsure");
    expect(net.last).toEqual({ verdict: "unsure", detail: "definition #burgCOA1" });
    expect(net.end(svg)).toBe("unsure");
  });

  it("undo rebuilds a child list from its records in reverse", () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map(id => ({ id }) as unknown as Node);
    // [a b c] -> remove b -> [a c] -> add d after c -> [a c d]
    const records = [
      { type: "childList", target: a, addedNodes: [], removedNodes: [b], previousSibling: a, nextSibling: c },
      { type: "childList", target: a, addedNodes: [d], removedNodes: [], previousSibling: c, nextSibling: null }
    ];
    expect(undo([a, c, d], records)).toEqual([a, b, c]);
    expect(undo([a, c], records)).toBeNull(); // d is not there: the records do not describe this list
  });

  // the reference the linked list replaced: Array.indexOf per node, splice per record
  const reference = (
    list: Node[],
    records: readonly {
      addedNodes: ArrayLike<Node>;
      removedNodes: ArrayLike<Node>;
      previousSibling?: Node | null;
      nextSibling?: Node | null;
    }[]
  ): Node[] | null => {
    const out = [...list];
    for (let r = records.length - 1; r >= 0; r--) {
      const record = records[r];
      for (const node of Array.from(record.addedNodes)) {
        const at = out.indexOf(node);
        if (at < 0) return null;
        out.splice(at, 1);
      }
      const removed = Array.from(record.removedNodes);
      if (!removed.length) continue;
      let at: number;
      if (record.previousSibling) {
        const previous = out.indexOf(record.previousSibling);
        if (previous < 0) return null;
        at = previous + 1;
      } else if (record.nextSibling) {
        at = out.indexOf(record.nextSibling);
        if (at < 0) return null;
      } else at = out.length === 0 ? 0 : -1;
      if (at < 0) return null;
      out.splice(at, 0, ...removed);
    }
    return out;
  };

  it("undo agrees with the indexOf reference on random edit sequences (including ones that do not describe the list)", () => {
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 300; round++) {
      const pool = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` }) as unknown as Node);
      const live: Node[] = pool.slice(0, 1 + random(8));
      const records: NetRecord[] = [];
      const outside = new Set(pool.filter(n => !live.includes(n)));
      for (let step = 0; step < 1 + random(6); step++) {
        if (random(2) && outside.size) {
          const node = [...outside][random(outside.size)];
          const at = random(live.length + 1);
          records.push({
            type: "childList",
            target: pool[0],
            addedNodes: [node],
            removedNodes: [],
            previousSibling: live[at - 1] ?? null,
            nextSibling: live[at] ?? null
          });
          live.splice(at, 0, node);
          outside.delete(node);
        } else if (live.length) {
          const at = random(live.length);
          const [node] = live.splice(at, 1);
          records.push({
            type: "childList",
            target: pool[0],
            addedNodes: [],
            removedNodes: [node],
            previousSibling: live[at - 1] ?? null,
            nextSibling: live[at] ?? null
          });
          outside.add(node);
        }
      }
      expect(undo([...live], records)).toEqual(reference([...live], records));
      // a corrupted list: the same verdict (null or the same list) as the reference
      const wrong = live.slice(1);
      expect(undo([...wrong], records)).toEqual(reference([...wrong], records));
    }
  });

  it("undo is linear in the records: tens of thousands of children under one parent finish within a time bound", () => {
    const parent = { id: "p" } as unknown as Node;
    const kids = Array.from({ length: 200_000 }, (_, i) => ({ id: `k${i}` }) as unknown as Node);
    // 50k appended one at a time
    const appended = kids.slice(0, 50_000);
    const appends: NetRecord[] = appended.map((node, i) => ({
      type: "childList",
      target: parent,
      addedNodes: [node],
      removedNodes: [],
      previousSibling: appended[i - 1] ?? null,
      nextSibling: null
    }));
    let t = performance.now();
    expect(undo([...appended], appends)).toEqual([]);
    expect(performance.now() - t).toBeLessThan(500);
    // 200k appended in a loop of one-node records (the quadratic shape took seconds here)
    const many: NetRecord[] = kids.map((node, i) => ({
      type: "childList",
      target: parent,
      addedNodes: [node],
      removedNodes: [],
      previousSibling: kids[i - 1] ?? null,
      nextSibling: null
    }));
    t = performance.now();
    expect(undo([...kids], many)).toEqual([]);
    expect(performance.now() - t).toBeLessThan(1500);
    // 50k removed one at a time from the front (replaceChildren / remove-all), restored in order
    const removals: NetRecord[] = appended.map(node => ({
      type: "childList",
      target: parent,
      addedNodes: [],
      removedNodes: [node],
      previousSibling: null,
      nextSibling: null
    }));
    // removing from an emptying list: every record sees previousSibling null and nextSibling null only for the last one
    removals.forEach((record, i) => {
      record.nextSibling = appended[i + 1] ?? null;
    });
    t = performance.now();
    expect(undo([], removals)).toEqual(appended);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
