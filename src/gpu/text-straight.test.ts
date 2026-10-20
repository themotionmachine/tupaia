// Straight <text> (outside #labels) helpers: what goes native as glyphs, and what stays on the compat lane and why.
import { describe, expect, it } from "vitest";
import { emojiContent, kerningFor, parseTextShadows, planStraightText, straightTextReason } from "./text";

// A minimal element: attributes and text/element children, as planStraightText reads them.
function text(attrs: Record<string, string>, content: string | null, children: "element"[] = []) {
  const nodes = [
    ...(content === null ? [] : [{ nodeType: 3, data: content }]),
    ...children.map(() => ({ nodeType: 1 }))
  ];
  return {
    getAttribute: (name: string) => attrs[name] ?? null,
    childNodes: nodes,
    textContent: content ?? ""
  } as unknown as Element;
}

// Computed style as Chromium reports it for #temperature text (index.css + the default preset).
const temperature = {
  fill: "rgb(0, 0, 0)",
  fillOpacity: "1",
  stroke: "none",
  strokeWidth: "1.8px",
  strokeOpacity: "1",
  opacity: "1",
  fontSize: "8px",
  fontFamily: "Helvetica, Arial, sans-serif",
  fontWeight: "700",
  textAnchor: "middle",
  dominantBaseline: "central",
  textShadow: "rgb(255, 255, 255) 0px 0px 10px",
  letterSpacing: "normal",
  textRendering: "auto",
  visibility: "visible"
};

describe("parseTextShadows", () => {
  it("reads Chromium's computed form, color first, in CSS px", () => {
    expect(parseTextShadows("rgb(255, 255, 255) 0px 0px 10px")).toEqual([
      { color: [1, 1, 1, 1], x: 0, y: 0, blur: 10 }
    ]);
    expect(parseTextShadows("rgb(157, 170, 201) 1px 1px 1px")?.[0]).toMatchObject({ x: 1, y: 1, blur: 1 });
    expect(parseTextShadows("rgb(0, 0, 0) -2px 3.5px")).toEqual([{ color: [0, 0, 0, 1], x: -2, y: 3.5, blur: 0 }]);
  });

  it("splits a list on top-level commas only", () => {
    const list = parseTextShadows("rgba(0, 0, 0, 0.5) 1px 1px 2px, rgb(255, 0, 0) 0px 0px 4px");
    expect(list).toHaveLength(2);
    expect(list?.[0].color[3]).toBeCloseTo(0.5);
    expect(list?.[1]).toMatchObject({ color: [1, 0, 0, 1], blur: 4 });
  });

  it("none is no shadow; a transparent shadow paints nothing; anything else unreadable is null", () => {
    expect(parseTextShadows("none")).toEqual([]);
    expect(parseTextShadows(undefined)).toEqual([]);
    expect(parseTextShadows("rgba(0, 0, 0, 0) 1px 1px 1px")).toEqual([]);
    expect(parseTextShadows("rgb(0, 0, 0) 1em 1px")).toBeNull();
    expect(parseTextShadows("rgb(0, 0, 0) 1px")).toBeNull();
    expect(parseTextShadows("rgb(0, 0, 0) 1px 1px -2px")).toBeNull();
  });
});

describe("emojiContent", () => {
  it("keeps color glyphs off the coverage atlas: regiment, market and marker emoji", () => {
    for (const s of ["⚔️", "⚔", "👑", "🏹", "⚓", "⚖️", "🛡️", "1️⃣"]) expect(emojiContent(s), s).toBe(true);
  });

  it("wind arrows, degree units and plain text are text glyphs", () => {
    for (const s of ["⇉", "⇇", "⇊", "⇈", "72°F", "40K mi²", "2748 mi", "75°W"]) expect(emojiContent(s), s).toBe(false);
  });
});

it("kerningFor: Chromium computes text-rendering in lower case; optimizeSpeed turns kerning off", () => {
  expect(kerningFor("optimizespeed")).toBe("none");
  expect(kerningFor("optimizeSpeed")).toBe("none");
  expect(kerningFor("auto")).toBe("auto");
  expect(kerningFor("geometricprecision")).toBe("auto");
  expect(kerningFor(undefined)).toBe("auto");
});

describe("planStraightText", () => {
  it("plans a temperature label: middle anchor, central baseline, white glow, x/y plus dx/dy", () => {
    const plan = planStraightText(text({ x: "10", y: "20", dx: "1", dy: "-2" }, "72°F"), temperature);
    expect(plan).toMatchObject({
      content: "72°F",
      px: 8,
      x: 11,
      y: 18,
      fill: [0, 0, 0, 1],
      stroke: null,
      anchor: "middle",
      baseline: "central",
      shadows: [{ color: [1, 1, 1, 1], x: 0, y: 0, blur: 10 }]
    });
  });

  it("alphabetic is the auto baseline; middle/hanging are not modelled", () => {
    const style = { ...temperature, dominantBaseline: "alphabetic" };
    expect(planStraightText(text({ x: "0", y: "0" }, "Wal"), style)).toMatchObject({ baseline: "auto" });
    expect(straightTextReason(text({}, "a"), { ...temperature, dominantBaseline: "middle" })).toBe("baseline");
    expect(straightTextReason(text({}, "a"), { ...temperature, dominantBaseline: "hanging" })).toBe("baseline");
  });

  it("names what keeps a text on the compat lane", () => {
    const at = { x: "1", y: "1" };
    expect(straightTextReason(text(at, "a", ["element"]), temperature)).toBe("tspan structure");
    expect(straightTextReason(text({ ...at, transform: "rotate(3)" }, "a"), temperature)).toBe("text transform");
    expect(straightTextReason(text({ ...at, rotate: "10" }, "a"), temperature)).toBe("text positioning");
    expect(straightTextReason(text({ x: "50%", y: "1" }, "a"), temperature)).toBe("text positioning");
    expect(straightTextReason(text({ x: "1 2 3", y: "1" }, "abc"), temperature)).toBe("text positioning");
    expect(straightTextReason(text(at, "⚔️"), temperature)).toBe("emoji");
    expect(straightTextReason(text(at, " a"), temperature)).toBe("whitespace");
    expect(straightTextReason(text(at, "a"), { ...temperature, letterSpacing: "2px" })).toBe("letter-spacing");
    expect(straightTextReason(text(at, "a"), { ...temperature, fontSize: "1em" })).toBe("font-size");
    expect(straightTextReason(text(at, "a"), { ...temperature, textShadow: "rgb(0, 0, 0) 1em 0px" })).toBe(
      "text-shadow"
    );
    expect(straightTextReason(text(at, "a"), { ...temperature, fill: "url(#hatch)" })).toBe("paint server text");
    expect(straightTextReason(text(at, "a"), { ...temperature, writingMode: "vertical-rl" })).toBe("writing-mode");
  });

  it("a shadow is modelled only under a plain opaque fill", () => {
    const at = { x: "1", y: "1" };
    expect(straightTextReason(text(at, "a"), { ...temperature, stroke: "rgb(255, 0, 0)" })).toBe(
      "text-shadow over stroke"
    );
    expect(straightTextReason(text(at, "a"), { ...temperature, fillOpacity: "0.5" })).toBe(
      "text-shadow over translucent fill"
    );
    expect(straightTextReason(text(at, "a"), { ...temperature, fill: "none" })).toBe(
      "text-shadow over translucent fill"
    );
    // a zero-width stroke paints nothing and does not count
    expect(
      straightTextReason(text(at, "a"), { ...temperature, stroke: "rgb(212, 212, 212)", strokeWidth: "0px" })
    ).toBe("");
  });

  it("group-style opacity over two paint passes stays compat; over one pass it folds into the color", () => {
    const plain = { ...temperature, textShadow: "none", opacity: "0.5" };
    expect(planStraightText(text({}, "a"), plain)).toMatchObject({ fill: [0, 0, 0, 0.5] });
    expect(straightTextReason(text({}, "a"), { ...plain, stroke: "rgb(255, 255, 255)" })).toBe(
      "opacity over fill and stroke"
    );
  });
});
