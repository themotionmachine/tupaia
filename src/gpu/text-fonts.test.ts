// @vitest-environment happy-dom
// Row 41: a web font that fails, is unparsable or is slow must cost only the labels that use it (named compat
// fallback), never the whole GPU renderer; and the renderer must learn when such a face finally arrives.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FONT_LOAD_TIMEOUT, fontFamily, fontReady, GlyphAtlas, layoutLabels } from "./text";

const SVG_NS = "http://www.w3.org/2000/svg";

// A FontFaceSet whose per-family behaviour the test sets: "ok", "fail" (rejects), "never" (pending forever),
// "missing" (resolves but check() stays false), or a deferred promise the test settles.
type Behaviour = "ok" | "fail" | "never" | "missing" | { promise: Promise<FontFace[]> };
function fakeFonts(behaviours: Record<string, Behaviour>) {
  const loaded = new Set<string>();
  const loads: string[] = [];
  const familyOf = (font: string) => fontFamily(font).replace(/^"|"$/g, "");
  const set = {
    loads,
    loaded,
    load(font: string): Promise<FontFace[]> {
      loads.push(font);
      const family = familyOf(font);
      if (family === "bad syntax") throw new DOMException("bad font", "SyntaxError");
      const behaviour = behaviours[family] ?? "ok";
      if (behaviour === "ok") {
        loaded.add(family);
        return Promise.resolve([]);
      }
      if (behaviour === "fail") return Promise.reject(new DOMException("network", "NetworkError"));
      if (behaviour === "never") return new Promise(() => {});
      if (behaviour === "missing") return Promise.resolve([]);
      return behaviour.promise.then(faces => {
        loaded.add(family);
        return faces;
      });
    },
    check: (font: string) => loaded.has(familyOf(font))
  };
  return set as typeof set & FontFaceSet;
}

describe("[LIFE] fontReady (row 41 guard)", () => {
  it("is ready for a loaded face, and without a FontFaceSet at all", async () => {
    expect(await fontReady("normal 400 12px Serif", "Abc", fakeFonts({}))).toBe("");
    expect(await fontReady("normal 400 12px Serif", "Abc", undefined)).toBe("");
  });

  it("names a rejected load instead of throwing", async () => {
    const fonts = fakeFonts({ Broken: "fail" });
    expect(await fontReady("normal 400 12px Broken", "Abc", fonts)).toBe("font load failed (Broken)");
  });

  it("names an unparsable font string instead of throwing", async () => {
    const fonts = fakeFonts({});
    expect(await fontReady("normal 400 12px bad syntax", "Abc", fonts)).toBe("font load failed (bad syntax)");
  });

  it("names a face that resolved but is still not measurable", async () => {
    const fonts = fakeFonts({ Ghost: "missing" });
    expect(await fontReady("normal 400 12px Ghost", "Abc", fonts)).toBe("font unavailable (Ghost)");
  });

  it("gives up on a slow face after the timeout and does not wait for it again while it is pending", async () => {
    vi.useFakeTimers();
    try {
      let arrive!: (faces: FontFace[]) => void;
      const promise = new Promise<FontFace[]>(resolve => {
        arrive = resolve;
      });
      const fonts = fakeFonts({ Slow: { promise } });
      const first = fontReady("normal 400 12px Slow", "Abc", fonts);
      await vi.advanceTimersByTimeAsync(FONT_LOAD_TIMEOUT);
      expect(await first).toBe("font load timeout (Slow)");
      // a later label with the same font answers at once
      expect(await fontReady("normal 400 12px Slow", "Def", fonts)).toBe("font loading (Slow)");
      expect(fonts.loads).toHaveLength(1);
      arrive([]);
      await vi.advanceTimersByTimeAsync(0);
      expect(await fontReady("normal 400 12px Slow", "Def", fonts)).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("extracts the family from a canvas font string", () => {
    expect(fontFamily('italic 700 12.5px "Almendra SC", serif')).toBe('"Almendra SC", serif');
    expect(fontFamily("normal 400 9px Georgia")).toBe("Georgia");
  });
});

// --- layoutLabels with a stubbed Canvas2D and computed style (happy-dom has neither) ---

function fakeContext() {
  let font = "";
  return {
    get font() {
      return font;
    },
    set font(value: string) {
      font = value;
    },
    fontKerning: "auto",
    fillStyle: "",
    strokeStyle: "",
    textBaseline: "alphabetic",
    lineJoin: "round",
    miterLimit: 4,
    lineWidth: 1,
    measureText: (text: string) => {
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10);
      return {
        width: [...text].length * px * 0.6,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: px * 0.6,
        actualBoundingBoxAscent: px * 0.8,
        actualBoundingBoxDescent: px * 0.2,
        fontBoundingBoxAscent: px * 0.9,
        fontBoundingBoxDescent: px * 0.3
      };
    },
    clearRect() {},
    save() {},
    restore() {},
    translate() {},
    fillText() {},
    strokeText() {}
  };
}

const STYLE: Record<string, string> = {
  fill: "#000000",
  stroke: "none",
  fillOpacity: "1",
  strokeOpacity: "1",
  opacity: "1",
  strokeWidth: "0",
  strokeLinejoin: "miter",
  strokeMiterlimit: "4",
  fontStyle: "normal",
  fontWeight: "400",
  fontSize: "12px",
  letterSpacing: "normal",
  textRendering: "auto",
  dominantBaseline: "auto",
  textAnchor: "middle",
  paintOrder: "normal"
};

function label(id: string, family: string, content: string): SVGTextElement {
  const svg = document.querySelector("svg")!;
  const path = document.createElementNS(SVG_NS, "path");
  path.id = `${id}-path`;
  path.setAttribute("d", "M0,0 C30,20 70,20 100,0");
  const text = document.createElementNS(SVG_NS, "text") as SVGTextElement;
  text.id = id;
  text.dataset.family = family;
  const textPath = document.createElementNS(SVG_NS, "textPath");
  textPath.setAttribute("href", `#${path.id}`);
  const tspan = document.createElementNS(SVG_NS, "tspan");
  tspan.textContent = content;
  textPath.append(tspan);
  text.append(textPath);
  svg.append(path, text);
  return text;
}

describe("[LIFE] layoutLabels with one bad web font (row 41)", () => {
  beforeAll(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => fakeContext() as unknown as CanvasRenderingContext2D
    );
    vi.spyOn(window, "getComputedStyle").mockImplementation(element => {
      const family = (element.closest("text") as HTMLElement | null)?.dataset.family ?? "Serif";
      return { ...STYLE, fontFamily: family } as unknown as CSSStyleDeclaration;
    });
    document.body.innerHTML = `<svg xmlns="${SVG_NS}"></svg>`;
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "fonts");
  });

  const install = (fonts: FontFaceSet) =>
    Object.defineProperty(document, "fonts", { value: fonts, configurable: true });

  it("sends only the labels with the failing font to compat, under a named reason", async () => {
    install(fakeFonts({ Broken: "fail" }));
    const atlas = new GlyphAtlas();
    const good = label("good", "Serif", "Good");
    const bad = label("bad", "Broken", "Bad");
    const batch = await layoutLabels([good, bad, label("good2", "Serif", "Fine")], 1, atlas);
    expect(batch.failed.map(({ element, reason }) => [element.id, reason])).toEqual([
      ["bad", "font load failed (Broken)"]
    ]);
    expect([...new Set(batch.boxes.map(box => box.id))]).toEqual(["good", "good2"]);
    expect(batch.count).toBeGreaterThan(0);
    expect(atlas.fontIssues.size).toBe(1);
    expect(bad.isConnected).toBe(true);
  });

  it("records a slow face so its arrival can re-prepare; the atlas clears the record per prepare", async () => {
    vi.useFakeTimers();
    try {
      let arrive!: (faces: FontFace[]) => void;
      const fonts = fakeFonts({
        Late: {
          promise: new Promise<FontFace[]>(resolve => {
            arrive = resolve;
          })
        }
      });
      install(fonts);
      const atlas = new GlyphAtlas();
      const pending = layoutLabels([label("late", "Late", "Late")], 1, atlas);
      await vi.advanceTimersByTimeAsync(FONT_LOAD_TIMEOUT);
      const batch = await pending;
      expect(batch.failed[0].reason).toBe("font load timeout (Late)");
      expect(atlas.fontsArrived(fonts)).toBe(false);
      arrive([]);
      await vi.advanceTimersByTimeAsync(0);
      expect(atlas.fontsArrived(fonts)).toBe(true);
      atlas.clear();
      expect(atlas.fontsArrived(fonts)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never re-prepares for a face the layout itself awaited", async () => {
    const fonts = fakeFonts({});
    install(fonts);
    const atlas = new GlyphAtlas();
    const batch = await layoutLabels([label("plain", "Serif", "Plain")], 1, atlas);
    expect(batch.failed).toEqual([]);
    expect(atlas.fontIssues.size).toBe(0);
    expect(atlas.fontsArrived(fonts)).toBe(false);
  });
});
