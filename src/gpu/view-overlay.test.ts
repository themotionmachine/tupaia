// @vitest-environment happy-dom
// PANEND (W4b): the #coordinates in-place lane. Layout and hit geometry are faked (text.ts and compat-pick.ts have
// their own tests): these pin when the lane patches the frame and what it touches, and that it answers "full" for
// anything it cannot patch exactly.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PickIndex } from "./pick";
import type { Prepared } from "./prepare";
import { GLYPH_FLOATS } from "./text";
import { refreshView, snapshotView, viewSignature } from "./view-overlay";

const layout = vi.hoisted(() => ({ calls: 0, grow: false, fail: "" }));
vi.mock("./text", async original => ({
  ...(await original<typeof import("./text")>()),
  // one instance per character; at.x/at.y are the text's x/y
  layoutLabels: async (elements: SVGTextElement[], _scale: number, atlas: { size: number; grow(): void }) => {
    layout.calls++;
    if (layout.grow) atlas.grow();
    if (layout.fail)
      return {
        instances: new Float32Array(),
        count: 0,
        boxes: [],
        failed: [{ element: elements[0], reason: layout.fail }]
      };
    const text = elements[0];
    const n = text.textContent!.length;
    const out = new Float32Array(n * GLYPH_FLOATS);
    for (let i = 0; i < n; i++) {
      out[i * GLYPH_FLOATS] = Number(text.getAttribute("x"));
      out[i * GLYPH_FLOATS + 1] = Number(text.getAttribute("y"));
    }
    return { instances: out, count: n, boxes: [], failed: [] };
  }
}));
vi.mock("./compat-pick", async original => ({
  ...(await original<typeof import("./compat-pick")>()),
  compatShapes: (text: SVGTextElement) => {
    const x = Number(text.getAttribute("x"));
    const y = Number(text.getAttribute("y"));
    return [{ id: "coordinateLabels", fill: { rings: [[x, y, x + 5, y, x + 5, y + 5, x, y + 5]], evenOdd: false } }];
  }
}));

const NS = "http://www.w3.org/2000/svg";
let root: Element;
// drawCoordinates: everything removed and re-appended; labels pinned to the viewport edge at `edge`
const draw = (edge: number, size = "12", step = "M0 0L100 0") => {
  root.replaceChildren();
  root.setAttribute("font-size", size);
  const grid = document.createElementNS(NS, "g");
  grid.id = "coordinateGrid";
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", step);
  grid.append(path);
  const labels = document.createElementNS(NS, "g");
  labels.id = "coordinateLabels";
  for (const [i, text] of ["10°N", "20°N"].entries()) {
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", String(edge));
    label.setAttribute("y", String(100 * (i + 1)));
    label.textContent = text;
    labels.append(label);
  }
  root.append(grid, labels);
};

const released: unknown[] = [];
const uploads: Float32Array[] = [];
const device = {
  updateBuffer: (_buffer: unknown, data: Float32Array) => uploads.push(Float32Array.from(data)),
  release: (resource: unknown) => released.push(resource)
};
const atlas = {
  generation: 3,
  size: 40,
  grow() {
    this.size++;
  }
};

function prepare(): Prepared {
  const texts = [...root.querySelectorAll("text")] as SVGTextElement[];
  const pick = new PickIndex(1000, 1000);
  pick.addFill("ocean", "ocean", [[0, 0, 1000, 0, 1000, 1000, 0, 1000]], false);
  const glyphs = new Float32Array(8 * GLYPH_FLOATS);
  const glyphLabels = texts.map((element, i) => {
    const x = Number(element.getAttribute("x"));
    const y = Number(element.getAttribute("y"));
    const from = pick.size;
    pick.addFill("coordinates", "coordinateLabels", [[x, y, x + 5, y, x + 5, y + 5, x, y + 5]], false);
    for (let g = 0; g < 4; g++) glyphs.set([x, y], (i * 4 + g) * GLYPH_FLOATS);
    return { element, first: i * 4, count: 4, pick: [from, 1] as [number, number] };
  });
  return {
    bucket: 4,
    pick,
    picking: true,
    glyphLabels,
    runs: [{ elements: [root.querySelector("#coordinateGrid")!] }],
    payload: { glyphs, glyphCount: 8, atlasGeneration: 3 },
    frame: { glyphs: { id: "glyphs" }, fineGlyphs: { id: "fine" }, fineAtlas: { id: "fine atlas" }, fineScale: 3 }
  } as unknown as Prepared;
}

const ctx = () => ({
  device: device as never,
  atlas: atlas as never,
  viewbox: {} as SVGGraphicsElement,
  screen: { dpr: 2 },
  camera: { k: 2 },
  stale: () => false
});

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElementNS(NS, "g");
  root.id = "coordinates";
  document.body.append(root);
  layout.calls = 0;
  layout.grow = layout.fail = false as never;
  layout.fail = "";
  atlas.size = 40;
  atlas.generation = 3;
  released.length = uploads.length = 0;
});

describe("[PANEND] view overlay in place", () => {
  it("ignores the labels' own x/y in the signature, nothing else", () => {
    draw(10);
    const at10 = viewSignature(root);
    draw(250);
    expect(viewSignature(root)).toBe(at10);
    draw(250, "13");
    expect(viewSignature(root)).not.toBe(at10);
  });

  it("patches a pan: labels re-laid out and re-hit, runs and labels on the new nodes, fine set dropped", async () => {
    draw(10);
    const prepared = prepare();
    const before = snapshotView(root);
    draw(250);
    const result = await refreshView(prepared, before, root, ctx());
    expect(result.outcome).toBe("committed");
    const texts = [...root.querySelectorAll("text")];
    expect(prepared.glyphLabels!.map(label => label.element)).toEqual(texts);
    expect(prepared.runs[0].elements).toEqual([root.querySelector("#coordinateGrid")]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0][0]).toBe(250);
    expect(uploads[0][4 * GLYPH_FLOATS + 1]).toBe(200);
    expect(prepared.pick.pick(12, 102)?.id).toBe("ocean");
    expect(prepared.pick.pick(252, 102)?.id).toBe("coordinateLabels");
    expect(prepared.frame.fineGlyphs).toBe(null);
    expect(released).toHaveLength(2);
    // the next patch compares against the new snapshot
    draw(400);
    expect(
      (await refreshView(prepared, (result as unknown as { snapshot: never }).snapshot, root, ctx())).outcome
    ).toBe("committed");
    expect(prepared.pick.pick(402, 202)?.id).toBe("coordinateLabels");
  });

  it("answers full for another scale, a grown atlas, a label that would route to compat or a label in a raster", async () => {
    draw(10);
    let prepared = prepare();
    let before = snapshotView(root);
    draw(250, "12", "M0 0L50 0");
    expect(await refreshView(prepared, before, root, ctx())).toEqual({ outcome: "full", why: "changed" });
    draw(10);
    prepared = prepare();
    before = snapshotView(root);
    draw(250);
    layout.grow = true;
    expect(await refreshView(prepared, before, root, ctx())).toEqual({ outcome: "full", why: "atlas grew" });
    layout.grow = false;
    layout.fail = "textPath reference";
    expect(await refreshView(prepared, before, root, ctx())).toMatchObject({ outcome: "full" });
    layout.fail = "";
    draw(10);
    prepared = prepare();
    prepared.runs[0].elements.push(root.querySelector("#coordinateLabels")!);
    before = snapshotView(root);
    draw(250);
    expect(await refreshView(prepared, before, root, ctx())).toEqual({ outcome: "full", why: "label in a compat run" });
    expect(uploads).toHaveLength(0); // nothing was written by any of them
    expect(await refreshView(prepared, undefined, root, ctx())).toEqual({ outcome: "full", why: "no snapshot" });
  });
});
