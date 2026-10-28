// @vitest-environment happy-dom
// PANEND (W4b) SVG cover: the eligibility rules (fail closed) and the sheet toggling. Native hit testing under
// pointer-events:painted is a browser property: bench/host/native-recovery.ts and the picking gate check it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coverHides, SvgCover, withCanonicalVisibility } from "./svg-cover";

const NS = "http://www.w3.org/2000/svg";
let cover: SvgCover;
let svg: SVGSVGElement;
let viewbox: SVGGElement;

const node = <T extends Element>(tag: string, parent: Element, attributes: Record<string, string> = {}) => {
  const element = document.createElementNS(NS, tag) as unknown as T;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  parent.append(element);
  return element;
};

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  svg = node<SVGSVGElement>("svg", document.body, { id: "map", style: "overflow:hidden" });
  viewbox = node<SVGGElement>("g", svg, { id: "viewbox" });
  const layer = node("g", viewbox, { id: "rivers" });
  node("path", layer, { d: "M0 0L10 10" });
  node("text", node("g", viewbox, { id: "labels" }), { x: "5", y: "5" }).textContent = "Label";
  cover = new SvgCover();
});

afterEach(() => cover.dispose());

describe("[PANEND] SvgCover", () => {
  it("covers an ordinary model, and its rules leave text visible", () => {
    expect(cover.eligible(svg)).toBe(true);
    expect(cover.issue).toBe("");
    cover.apply(true);
    expect(cover.active).toBe(true);
    const sheet = document.head.querySelector<HTMLStyleElement>("style[data-gpu-renderer='svg-cover']")!.sheet!;
    // one `@media screen` block (print never sees a hidden map), holding both rules
    expect(sheet.cssRules.length).toBe(1);
    const media = sheet.cssRules[0] as CSSMediaRule;
    expect(media.media.mediaText).toBe("screen");
    expect([...media.cssRules].map(rule => rule.cssText.replace(/\s+/g, " "))).toEqual([
      expect.stringMatching(
        /^svg#map > #viewbox \{ ?visibility: hidden ?!important; ?pointer-events: painted ?!important;? ?\}$/
      ),
      expect.stringMatching(/^svg#map > #viewbox text \{ ?visibility: visible;? ?\}$/)
    ]);
    // toggled again (withCanonicalVisibility lifts and re-applies): still exactly one block
    cover.set(false);
    cover.set(true);
    expect(sheet.cssRules.length).toBe(1);
    cover.apply(false);
    expect(sheet.cssRules.length).toBe(0);
    expect(cover.status()).toMatchObject({ applied: 1, revealed: 1, checks: 1 });
  });

  it("refuses an explicit hidden the inherited painted would make hittable, unless click-through and childless", () => {
    const hidden = node("path", viewbox.querySelector("#rivers")!, { d: "M0 0", visibility: "hidden" });
    expect(cover.eligible(svg)).toBe(false);
    expect(cover.issue).toMatch(/explicit visibility hidden on path/);
    hidden.setAttribute("style", "pointer-events:none");
    expect(cover.eligible(svg)).toBe(true); // the dense-zoom images hide their source <image> this way
    node("path", hidden, {});
    expect(cover.eligible(svg)).toBe(false);
  });

  it("refuses visible* pointer-events (hidden + visiblePainted no longer hits), links and focus targets", () => {
    const path = viewbox.querySelector("path")!;
    path.setAttribute("pointer-events", "visibleFill");
    expect(cover.eligible(svg)).toBe(false);
    expect(cover.issue).toMatch(/pointer-events visiblefill/);
    path.setAttribute("pointer-events", "all"); // independent of visibility
    expect(cover.eligible(svg)).toBe(true);
    path.setAttribute("style", "pointer-events: auto");
    expect(cover.eligible(svg)).toBe(false);
    path.removeAttribute("style");
    node("a", viewbox, {});
    expect(cover.eligible(svg)).toBe(false);
    expect(cover.issue).toBe("interactive or animated model content");
  });

  it("refuses author rules that hide model content or need it visible, and rescans sheets only when told", () => {
    const style = document.createElement("style");
    style.textContent = "#rivers path { visibility: collapse } #options i { visibility: hidden }";
    document.head.append(style);
    cover.sheetsChanged();
    expect(cover.eligible(svg)).toBe(false);
    expect(cover.issue).toBe("author CSS: #rivers path");
    style.textContent = "#options i { visibility: hidden } body.tour *:hover { pointer-events: auto }";
    cover.sheetsChanged();
    expect(cover.eligible(svg)).toBe(true); // matches nothing in the model (interaction state stripped: still none)
    document.body.classList.add("tour");
    expect(cover.eligible(svg)).toBe(false);
  });

  it("follows <use> references out of the model", () => {
    const defs = node("svg", document.body, { id: "defElements" });
    const symbol = node("symbol", node("defs", defs), { id: "icon" });
    node("path", symbol, { d: "M0 0", visibility: "hidden" });
    node("use", viewbox, { href: "#icon" });
    expect(cover.eligible(svg)).toBe(false);
    expect(cover.issue).toMatch(/explicit visibility hidden/);
  });

  it("checks only what records touched while covered, and asks for a full check on a new reference", () => {
    expect(cover.eligible(svg)).toBe(true);
    const added = node("g", viewbox, {});
    node("path", added, { d: "M0 0" });
    expect(cover.checkLocal([added])).toBe("");
    node("path", added, { "pointer-events": "visible" });
    expect(cover.checkLocal([added])).toMatch(/pointer-events visible/);
    const other = node("g", viewbox, {});
    node("use", other, { href: "#nowhere" });
    expect(cover.checkLocal([other])).toBe("full");
  });

  it("lifts every active cover for a canonical read, also when the read throws", () => {
    cover.eligible(svg);
    cover.apply(true);
    const states: boolean[] = [];
    withCanonicalVisibility(() => states.push(cover.active));
    expect(states).toEqual([false]);
    expect(cover.active).toBe(true);
    expect(() =>
      withCanonicalVisibility(() => {
        throw new Error("probe");
      })
    ).toThrow("probe");
    expect(cover.active).toBe(true);
  });

  it("explains a hidden computed visibility inside the covered model, never an element's own hidden", () => {
    cover.eligible(svg);
    const layer = viewbox.querySelector("#rivers")!;
    expect(coverHides(layer)).toBe(false); // not covered
    cover.apply(true);
    expect(coverHides(layer)).toBe(true);
    expect(coverHides(svg)).toBe(false);
    layer.setAttribute("visibility", "hidden");
    expect(coverHides(layer)).toBe(false);
  });
});
