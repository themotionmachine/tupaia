// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { flattenPath } from "./svg-path";
import { basicShapePath, isIdentityTransform, nearestViewport } from "./svg-shapes";

const NS = "http://www.w3.org/2000/svg";
const el = (tag: string, attributes: Record<string, string | number>) => {
  const element = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
};

describe("basicShapePath", () => {
  it("circle starts at (cx + r, cy), runs clockwise (y down) and stays on the circle", () => {
    const d = basicShapePath(el("circle", { cx: 10, cy: 20, r: 5 }))!;
    const [ring] = flattenPath(d, 0.01);
    expect(ring.closed).toBe(true);
    expect(ring.points.slice(0, 2)).toEqual([15, 20]);
    // first step heads toward +y (SVG2 §10.4 path equivalent: cx+r,cy -> cx,cy+r)
    expect(ring.points[3]).toBeGreaterThan(20);
    for (let i = 0; i < ring.points.length; i += 2)
      expect(Math.hypot(ring.points[i] - 10, ring.points[i + 1] - 20)).toBeCloseTo(5, 6);
  });

  it("a tiny circle still flattens to at least an octagon at the scene tolerance", () => {
    const [ring] = flattenPath(basicShapePath(el("circle", { cx: 0, cy: 0, r: 0.1 }))!, 0.2);
    expect(ring.points.length / 2).toBeGreaterThanOrEqual(8);
  });

  it("ellipse uses rx along x and ry along y", () => {
    const [ring] = flattenPath(basicShapePath(el("ellipse", { cx: 0, cy: 0, rx: 4, ry: 2 }))!, 0.01);
    const xs = ring.points.filter((_, i) => i % 2 === 0);
    const ys = ring.points.filter((_, i) => i % 2 === 1);
    expect(Math.max(...xs)).toBeCloseTo(4, 6);
    expect(Math.max(...ys)).toBeCloseTo(2, 3);
  });

  it("zero radii render nothing; negative, auto-ellipse and non-px units refuse", () => {
    expect(basicShapePath(el("circle", { r: 0 }))).toBe("");
    expect(basicShapePath(el("circle", {}))).toBe("");
    expect(basicShapePath(el("circle", { r: -1 }))).toBeNull();
    expect(basicShapePath(el("ellipse", { rx: 2 }))).toBeNull();
    expect(basicShapePath(el("ellipse", { rx: 2, ry: "auto" }))).toBeNull();
    expect(basicShapePath(el("circle", { r: "2em" }))).toBeNull();
    expect(basicShapePath(el("circle", { r: "2px", cx: "1px" }))).not.toBeNull();
  });

  it("plain rect keeps the existing path form; rx alone rounds both axes; radii clamp to half the side", () => {
    expect(basicShapePath(el("rect", { x: 1, y: 2, width: 3, height: 4 }))).toBe("M1,2h3v4h-3Z");
    expect(basicShapePath(el("rect", { width: 3, height: 4, rx: 0 }))).toBe("M0,0h3v4h-3Z");
    expect(basicShapePath(el("rect", { x: 0, y: 0, width: 10, height: 4, rx: 1 }))).toBe(
      "M1,0H9A1,1 0 0 1 10,1V3A1,1 0 0 1 9,4H1A1,1 0 0 1 0,3V1A1,1 0 0 1 1,0Z"
    );
    const clamped = basicShapePath(el("rect", { width: 10, height: 4, rx: 50, ry: 50 }))!;
    expect(clamped.startsWith("M5,0H5A5,2 ")).toBe(true);
    expect(basicShapePath(el("rect", { width: -1, height: 4 }))).toBeNull();
    expect(basicShapePath(el("rect", { width: 1, height: 4, rx: -1 }))).toBeNull();
  });

  it("percentages resolve only against a given viewport", () => {
    const rect = el("rect", { x: 0, y: 0, width: "100%", height: "50%" });
    expect(basicShapePath(rect)).toBeNull();
    expect(basicShapePath(rect, { width: 1000, height: 800 })).toBe("M0,0h1000v400h-1000Z");
    const circle = el("circle", { cx: "50%", cy: "50%", r: "10%" });
    const d = basicShapePath(circle, { width: 300, height: 400 })!;
    // r% uses the normalized diagonal sqrt((w^2 + h^2) / 2)
    expect(d.startsWith(`M${150 + 0.1 * Math.sqrt((300 ** 2 + 400 ** 2) / 2)},200`)).toBe(true);
  });

  it("line is an open two-point path", () => {
    expect(basicShapePath(el("line", { x1: 1, y1: 2, x2: 3, y2: 4 }))).toBe("M1,2L3,4");
    expect(basicShapePath(el("line", { x2: 3 }))).toBe("M0,0L3,0");
  });
});

describe("isIdentityTransform", () => {
  it("accepts empty and identity-only lists", () => {
    for (const t of [
      null,
      "",
      "  ",
      "translate(0,0)",
      "translate(0 0)",
      "translate(0)",
      "rotate(0)",
      "rotate(0, 12.5, 7)",
      "scale(1)",
      "scale(1 1)",
      "matrix(1 0 0 1 0 0)",
      "skewX(0) skewY(0)",
      "rotate(0) translate(0,0)",
      "rotate(-0)"
    ])
      expect(isIdentityTransform(t), String(t)).toBe(true);
  });

  it("rejects anything that moves geometry or does not parse", () => {
    for (const t of [
      "rotate(30)",
      "rotate(360)",
      "translate(1,0)",
      "scale(1 2)",
      "matrix(1 0 0 1 0 1)",
      "rotate(0) translate(1)",
      "rotate(0, 1)",
      "rotate(x)",
      "bogus(0)",
      "rotate(0"
    ])
      expect(isIdentityTransform(t), t).toBe(false);
  });
});

describe("nearestViewport", () => {
  it("uses the viewBox when present, else the svg's own size", () => {
    document.body.innerHTML = `<svg xmlns="${NS}" width="1000" height="800"><defs><mask id="m"><rect/></mask></defs></svg>`;
    const mask = document.getElementById("m")!;
    expect(nearestViewport(mask)).toEqual({ width: 1000, height: 800 });
    mask.closest("svg")!.setAttribute("viewBox", "0 0 50 40");
    expect(nearestViewport(mask)).toEqual({ width: 50, height: 40 });
    mask.closest("svg")!.removeAttribute("viewBox");
    mask.closest("svg")!.setAttribute("width", "100%");
    expect(nearestViewport(mask)).toBeNull(); // no layout in happy-dom: unknown, so callers keep compat
  });
});
