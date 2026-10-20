import { describe, expect, it } from "vitest";
import {
  BACKDROP_CLEAR,
  backdropPrimitives,
  canvasBackdrop,
  editorState,
  type FilterSource,
  hiddenReason,
  rootFilter
} from "./lifecycle";

const shown = {
  prepared: true,
  lost: false,
  sourceCurrent: true,
  printing: false,
  editor: "",
  root: "",
  markersPending: false
};

describe("[LIFE] editorState (rows 24, 25, 29)", () => {
  it("names every customization mode, which wins over a dialog", () => {
    for (const mode of [1, 2, 3, 4]) {
      expect(editorState(mode, false)).toBe(`editor customization ${mode}`);
      expect(editorState(mode, true)).toBe(`editor customization ${mode}`);
    }
  });

  it("reports an open dialog, and nothing when idle", () => {
    expect(editorState(0, true)).toBe("editor dialog open");
    expect(editorState(0, false)).toBe("");
  });

  it("ignores a missing or non-numeric customization binding", () => {
    expect(editorState(undefined, false)).toBe("");
    expect(editorState("1", false)).toBe("");
    expect(editorState(null, true)).toBe("editor dialog open");
  });
});

describe("[LIFE] hiddenReason (active())", () => {
  it("shows a prepared frame with nothing in the way", () => {
    expect(hiddenReason(shown)).toBe("");
  });

  it("hides for each cause on its own", () => {
    expect(hiddenReason({ ...shown, sourceCurrent: false })).toBe("source replaced");
    expect(hiddenReason({ ...shown, lost: true })).toBe("context lost");
    expect(hiddenReason({ ...shown, prepared: false })).toBe("not prepared");
    expect(hiddenReason({ ...shown, printing: true })).toBe("printing");
    expect(hiddenReason({ ...shown, editor: "editor customization 1" })).toBe("editor customization 1");
    expect(hiddenReason({ ...shown, root: "root filter #x missing" })).toBe("root filter #x missing");
    expect(hiddenReason({ ...shown, markersPending: true })).toBe("trade markers loading");
  });

  it("names the most structural cause first (row 33: a replaced source outranks everything)", () => {
    const all = {
      prepared: false,
      lost: true,
      sourceCurrent: false,
      printing: true,
      editor: "editor dialog open",
      root: "root filter blur(2px)",
      markersPending: true
    };
    expect(hiddenReason(all)).toBe("source replaced");
    expect(hiddenReason({ ...all, sourceCurrent: true })).toBe("context lost");
    expect(hiddenReason({ ...all, sourceCurrent: true, lost: false })).toBe("not prepared");
    expect(hiddenReason({ ...shown, printing: true, editor: "editor dialog open" })).toBe("printing");
    expect(hiddenReason({ ...shown, editor: "editor dialog open", root: "x" })).toBe("editor dialog open");
  });
});

interface Fake {
  tagName: string;
  getAttribute(name: string): string | null;
  children: Fake[];
}
const el = (tagName: string, attributes: Record<string, string> = {}, children: Fake[] = []): Fake => ({
  tagName,
  getAttribute: name => attributes[name] ?? null,
  children
});
// the four map filters of src/index.html (#mapFilters buttons; the monochrome preset uses grayscale)
const BUILT_IN: Record<string, Fake> = {
  "filter-grayscale": el("filter", {}, [
    el("feColorMatrix", {
      values: "0.3333 0.3333 0.3333 0 0 0.3333 0.3333 0.3333 0 0 0.3333 0.3333 0.3333 0 0 0 0 0 1 0"
    })
  ]),
  "filter-sepia": el("filter", {}, [
    el("feColorMatrix", { values: "0.393 0.769 0.189 0 0 0.349 0.686 0.168 0 0 0.272 0.534 0.131 0 0 0 0 0 1 0" })
  ]),
  "filter-dingy": el("filter", {}, [el("feColorMatrix", { values: "1 0 0 0 0 0 1 0 0 0 0 0.3 0.3 0 0 0 0 0 1 0" })]),
  "filter-tint": el("filter", {}, [
    el("feColorMatrix", { values: "1.1 0 0 0 0  0 1.1 0 0 0  0 0 0.9 0 0  0 0 0 1 0" })
  ]),
  blur5: el("filter", {}, [el("feGaussianBlur", { stdDeviation: "5" })]),
  alpha: el("filter", {}, [el("feColorMatrix", { type: "luminanceToAlpha" })]),
  halfAlpha: el("filter", {}, [el("feColorMatrix", { values: "1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 0.5 0" })]),
  saturate: el("filter", {}, [el("feColorMatrix", { type: "saturate", values: "0.2" })]),
  transfer: el("filter", {}, [el("feComponentTransfer", {}, [el("feFuncR", { type: "gamma" })])]),
  transferAlpha: el("filter", {}, [el("feComponentTransfer", {}, [el("feFuncA", { type: "table" })])]),
  notAFilter: el("g")
};
const lookup = (id: string) => (BUILT_IN[id] as unknown as FilterSource) ?? null;

describe("[LIFE] rootFilter (row 28: root #map filter)", () => {
  it("forwards nothing without a filter", () => {
    for (const value of [null, undefined, "", "none", "  none "])
      expect(rootFilter(value, lookup)).toEqual({ css: "", refused: "" });
  });

  it("forwards every built-in map filter as the same CSS reference", () => {
    for (const id of ["filter-grayscale", "filter-sepia", "filter-dingy", "filter-tint"]) {
      expect(rootFilter(`url(#${id})`, lookup)).toEqual({ css: `url("#${id}")`, refused: "" });
      // computed style quotes the reference
      expect(rootFilter(`url("#${id}")`, lookup)).toEqual({ css: `url("#${id}")`, refused: "" });
    }
  });

  it("forwards pointwise filters that keep alpha", () => {
    expect(rootFilter("url(#saturate)", lookup).refused).toBe("");
    expect(rootFilter("url(#transfer)", lookup).refused).toBe("");
  });

  it("refuses what the canvas cannot reproduce exactly", () => {
    expect(rootFilter("url(#blur5)", lookup)).toEqual({ css: "", refused: "root filter #blur5 <feGaussianBlur>" });
    expect(rootFilter("url(#alpha)", lookup).refused).toBe("root filter #alpha alpha");
    expect(rootFilter("url(#halfAlpha)", lookup).refused).toBe("root filter #halfAlpha alpha");
    expect(rootFilter("url(#transferAlpha)", lookup).refused).toBe("root filter #transferAlpha alpha");
    expect(rootFilter("url(#nowhere)", lookup).refused).toBe("root filter #nowhere missing");
    expect(rootFilter("url(#notAFilter)", lookup).refused).toBe("root filter #notAFilter missing");
    expect(rootFilter("grayscale(1)", lookup).refused).toBe("root filter grayscale(1)");
    expect(rootFilter("url(#filter-sepia) blur(1px)", lookup).refused).toBe("root filter url(#filter-sepia) blur(1px)");
  });
});

describe("[LIFE] root filter over an ancestor's backdrop (W3c: monochrome over a transparent #map)", () => {
  it("says whose background the canvas clears to", () => {
    // the app: #map paints its own background (index.css #000)
    expect(canvasBackdrop(["rgb(0, 0, 0)", "rgb(255, 255, 255)"])).toEqual({ color: [0, 0, 0, 1], own: true });
    // the golden's isolation: #map transparent, its parent white
    expect(canvasBackdrop(["rgba(0, 0, 0, 0)", "rgb(255, 255, 255)"])).toEqual({ color: [1, 1, 1, 1], own: false });
    expect(canvasBackdrop(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"])).toEqual({ color: [1, 1, 1, 1], own: false });
  });

  it("composites the graded frame over the backdrop, flooded only where the canvas painted, in sRGB", () => {
    const plan = backdropPrimitives(BUILT_IN["filter-grayscale"] as unknown as FilterSource, [1, 1, 1, 1])!;
    expect(plan.lastResult).toBe("gpu-filtered");
    const [mask, flood, clip, over] = plan.primitives;
    // a canvas hidden by visibility runs the filter on empty input: no alpha, no flood over the SVG
    expect(mask).toEqual({
      tag: "feComponentTransfer",
      attributes: { in: "SourceAlpha", result: "gpu-painted" },
      children: [{ tag: "feFuncA", attributes: { type: "linear", slope: "255", intercept: "0" } }]
    });
    // the faint clear marks every pixel the frame owns: one 8-bit alpha step, which the mask lifts to 1
    expect(BACKDROP_CLEAR[3] * 255).toBeCloseTo(1);
    expect(flood.attributes).toMatchObject({
      "flood-color": "rgb(255, 255, 255)",
      "flood-opacity": "1",
      "color-interpolation-filters": "sRGB"
    });
    expect(clip.attributes).toMatchObject({
      in: "gpu-flood",
      in2: "gpu-painted",
      operator: "in",
      result: "gpu-backdrop"
    });
    expect(over.attributes).toMatchObject({
      in: "gpu-filtered",
      in2: "gpu-backdrop",
      operator: "over",
      "color-interpolation-filters": "sRGB"
    });
  });

  it("keeps a named last result, and has nothing to add to an empty filter", () => {
    const named = el("filter", {}, [el("feColorMatrix", { type: "saturate", values: "0", result: "grey" })]);
    expect(backdropPrimitives(named as unknown as FilterSource, [0, 0, 0, 1])!.primitives[3].attributes.in).toBe(
      "grey"
    );
    expect(backdropPrimitives(el("filter") as unknown as FilterSource, [1, 1, 1, 1])).toBeNull();
  });
});
