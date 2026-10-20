// @vitest-environment happy-dom
// The export/compat clone's style text keeps an inline-style property over the same presentation attribute (legacy
// maps saved mid-fade: <g id="ice" opacity="0.9" style="opacity: 0.04"> showed at 0.9 in exports and on the GPU).
import { describe, expect, it } from "vitest";

import { computedStyleText, namedKeys } from "./inline-style";

const ns = "http://www.w3.org/2000/svg";

function group(attributes: Record<string, string>): SVGGElement {
  const g = document.createElementNS(ns, "g");
  for (const [name, value] of Object.entries(attributes)) g.setAttribute(name, value);
  return g;
}

// a computed style as the browser reports it: what the element's inline style says, else the attribute
function computed(_element: SVGGElement, values: Record<string, string>): CSSStyleDeclaration {
  const keys = Object.keys(values);
  const declaration = { length: keys.length, getPropertyValue: (key: string) => values[key] ?? "" } as Record<
    string | number,
    unknown
  >;
  keys.forEach((key, i) => {
    declaration[i] = key;
  });
  return declaration as unknown as CSSStyleDeclaration;
}

const baseline = (key: string) => ({ opacity: "1", fill: "rgb(0, 0, 0)" })[key] ?? "";
const parse = (text: string) =>
  Object.fromEntries(
    text
      .split(";")
      .filter(Boolean)
      .map(item => item.split(":") as [string, string])
  );

describe("computedStyleText", () => {
  it("keeps an inline-style opacity over the opacity attribute", () => {
    const ice = group({ opacity: "0.9", style: "opacity: 0.04" });
    const text = computedStyleText(ice, computed(ice, { opacity: "0.04", fill: "rgb(1, 2, 3)" }), baseline);
    expect(parse(text)).toMatchObject({ opacity: "0.04", fill: "rgb(1, 2, 3)" });
  });

  it("leaves a property the attribute alone sets to the attribute, and skips baseline values and the cursor", () => {
    const ice = group({ opacity: "0.9", style: "fill: red" });
    const text = computedStyleText(
      ice,
      computed(ice, { opacity: "0.9", fill: "rgb(255, 0, 0)", cursor: "pointer", stroke: "" }),
      baseline
    );
    expect(parse(text)).toEqual({ fill: "rgb(255, 0, 0)" });
  });
});

// COST2: the for-in pass reads only the keys that can name a property; the text is unchanged
describe("namedKeys", () => {
  // a declaration as CSSOM enumerates it: indices, property names and their camelCase aliases; getPropertyValue
  // lowercases its argument, so an alias reads ""
  function enumerated(values: Record<string, string>): CSSStyleDeclaration {
    const declaration: Record<string | number, unknown> = {};
    const keys = Object.keys(values);
    keys.forEach((key, i) => {
      declaration[i] = key;
    });
    for (const key of [...keys, "font", "marker"]) {
      declaration[key] = values[key] ?? "";
      declaration[key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = "";
    }
    Object.defineProperty(declaration, "length", { value: keys.length, enumerable: true });
    Object.defineProperty(declaration, "getPropertyValue", {
      value: (key: string) => values[key.toLowerCase()] ?? "",
      enumerable: true
    });
    return declaration as unknown as CSSStyleDeclaration;
  }
  const values = { fill: "rgb(1, 2, 3)", "font-size": "12px", "stroke-width": "2", font: "12px serif", opacity: "1" };

  it("drops indices and camelCase aliases", () => {
    const keys = namedKeys(enumerated(values));
    expect(keys).toEqual(expect.arrayContaining(["fill", "font-size", "stroke-width", "font", "marker", "length"]));
    expect(keys.some(key => /[A-Z]/.test(key) || /^\d+$/.test(key))).toBe(false);
  });

  it("gives the same text as the full for-in", () => {
    const g = group({ "stroke-width": "2" });
    const declaration = enumerated(values);
    const full = computedStyleText(g, declaration, baseline);
    expect(computedStyleText(g, declaration, baseline, namedKeys(declaration))).toBe(full);
    expect(full).toContain("font-size:12px;");
  });
});
