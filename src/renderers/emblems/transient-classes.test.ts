import { describe, expect, it } from "vitest";
import {
  emblemSourceClass,
  forgetEmblemClass,
  rememberEmblemClass,
  restoreHiddenEmblemClasses
} from "./transient-classes";

function element(value: string | null): Element {
  const attributes = new Map<string, string>();
  if (value !== null) attributes.set("class", value);
  return {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, next: string) => attributes.set(name, next),
    removeAttribute: (name: string) => attributes.delete(name)
  } as unknown as Element;
}

function tree(elements: Element[]): Element {
  return { querySelectorAll: () => elements } as unknown as Element;
}

describe("canonical emblem class snapshots", () => {
  it.each([null, "", "  author second  "])("restores the exact original attribute %j on a clone", original => {
    const source = element(original);
    rememberEmblemClass(source, original);
    source.setAttribute("class", `${original ?? ""} viewport-culled`);
    const copy = element(source.getAttribute("class"));
    restoreHiddenEmblemClasses(tree([source]), tree([copy]));
    expect(copy.getAttribute("class")).toBe(original);
    expect(source.getAttribute("class")).toContain("viewport-culled");
    forgetEmblemClass(source);
    expect(emblemSourceClass(source)).toBeUndefined();
  });

  it("preserves author edits made while the optional presentation owns the class snapshot", () => {
    const source = element("author");
    rememberEmblemClass(source, "author");
    source.setAttribute("class", "author viewport-culled added");
    const copy = element(source.getAttribute("class"));
    restoreHiddenEmblemClasses(tree([source]), tree([copy]));
    expect(copy.getAttribute("class")).toBe("author added");
    expect(source.getAttribute("class")).toBe("author viewport-culled added");
    forgetEmblemClass(source);
  });

  it("leaves classes owned by other renderers untouched", () => {
    const source = element("viewport-culled author");
    const copy = element(source.getAttribute("class"));
    restoreHiddenEmblemClasses(tree([source]), tree([copy]));
    expect(copy.getAttribute("class")).toBe("viewport-culled author");
  });
});
