// Native SVG remains the canonical event target while an opaque GPU frame paints the same emblems.
// SVG2 pointer-events:painted keeps painted-shape hits independent of visibility. Only known default
// visibility/pointer semantics qualify; custom content fails closed to the ordinary visible native copy.
const presentations = new Set<HiddenEmblemPaint>();

export function withCanonicalEmblemPaint<T>(read: () => T): T {
  const active = [...presentations].filter(owner => owner.active);
  for (const owner of active) owner.set(false);
  try {
    return read();
  } finally {
    for (const owner of active) owner.set(true);
  }
}

const dynamicState = /:(?:hover|active|focus-visible|focus-within|focus|visited|link)\b/g;

export class HiddenEmblemPaint {
  private style: HTMLStyleElement;
  private enabled = false;
  issue = "";

  constructor() {
    this.style = document.createElement("style");
    document.head.append(this.style);
    presentations.add(this);
  }

  get active(): boolean {
    return this.enabled;
  }

  set(enabled: boolean): void {
    if (enabled === this.enabled) return;
    const sheet = this.style.sheet;
    if (!sheet) {
      this.enabled = false;
      return;
    }
    while (sheet.cssRules.length) sheet.deleteRule(0);
    if (enabled) sheet.insertRule("svg#map #emblems {visibility:hidden!important;pointer-events:painted!important}", 0);
    this.enabled = enabled;
  }

  eligible(root: SVGSVGElement, layer: Element | null, definitions: Element | null): boolean {
    this.issue = "";
    const reject = (issue: string) => {
      this.issue = issue;
      return false;
    };
    if (!layer || !definitions || root.id !== "map" || this.enabled) return reject("missing canonical source");
    if (
      getComputedStyle(layer).visibility !== "visible" ||
      !["auto", "visiblepainted"].includes(getComputedStyle(layer).pointerEvents.toLowerCase())
    )
      return reject("non-default root visibility/pointer-events");
    if (!["hidden", "clip"].includes(getComputedStyle(root).overflow))
      return reject("native SVG ink can escape opaque canvas bounds");
    // Follow referenced SVG assets as well as COA descendants; a custom hidden charge outside #coas must not
    // become hittable merely because its outer <use> inherits painted. Local cycles are safe and bounded by IDs.
    const parents: Element[] = [layer, definitions];
    const seen = new Set<Element>();
    for (let i = 0; i < parents.length; i++) {
      const parent = parents[i];
      for (const use of [parent, ...parent.querySelectorAll("use")]) {
        if (use.tagName !== "use" || seen.has(use)) continue;
        seen.add(use);
        const href = use.getAttribute("href") ?? use.getAttribute("xlink:href") ?? "";
        if (!href) continue; // deferred COA placeholders have no referenced paint or native painted-shape hit
        if (!/^#[^\s]+$/.test(href)) return reject(`nonlocal use reference: ${href}`);
        const asset = document.getElementById(href.slice(1));
        if (!asset || !(asset instanceof SVGElement)) return reject(`unresolved use reference: ${href}`);
        if (!parents.some(owner => owner.contains(asset))) {
          if (!asset.closest("defs")) return reject("referenced asset outside observed definitions");
          parents.push(asset);
        }
      }
    }
    const relevant = (element: Element) => parents.some(parent => parent.contains(element) || element.contains(parent));
    const special = "a,[tabindex],[contenteditable],foreignObject,script,animate,animateMotion,animateTransform,set";
    if (
      parents.some(parent => parent.matches(special) || parent.querySelector(special)) ||
      (document.activeElement && layer.contains(document.activeElement))
    )
      return reject("interactive or animated source");
    // Explicit source visibility and pointer rules can change shadow-tree hit semantics when inherited visibility
    // changes. Never override them. Normal offscreen culling has display:none and retains pointer-events:none.
    for (const parent of parents) {
      for (const element of [parent, ...parent.querySelectorAll("*")]) {
        if (element.hasAttribute("visibility") || element.hasAttribute("pointer-events"))
          return reject(`explicit attribute: ${element.tagName}#${element.id}`);
        const style = (element as SVGElement).style;
        if (style?.visibility || style?.pointerEvents)
          return reject(`explicit inline style: ${element.tagName}#${element.id}`);
        if (element.getAnimations().some(animation => animation.playState !== "finished"))
          return reject("active source animation");
      }
    }
    for (const parent of parents) {
      for (let ancestor = parent.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = (ancestor as SVGElement | HTMLElement).style;
        if (
          ancestor.hasAttribute("visibility") ||
          ancestor.hasAttribute("pointer-events") ||
          style?.visibility ||
          style?.pointerEvents
        )
          return reject("explicit referenced ancestor visibility/pointer rule");
      }
    }
    const inspect = (rules: CSSRuleList): boolean => {
      for (const rule of rules) {
        if (rule instanceof CSSImportRule) {
          if (!rule.styleSheet || !inspect(rule.styleSheet.cssRules)) return false;
        } else if (rule instanceof CSSStyleRule) {
          if (
            !rule.style.visibility &&
            !rule.style.pointerEvents &&
            (!rule.style.animationName || rule.style.animationName === "none")
          )
            continue;
          if (
            rule.selectorText === ".viewport-culled" &&
            rule.style.display === "none" &&
            rule.style.pointerEvents === "none" &&
            !rule.style.visibility
          )
            continue;
          // Strip interaction state before querying so a currently inactive hover/focus rule cannot slip through.
          const selector = rule.selectorText.replace(dynamicState, "");
          if ([...document.querySelectorAll(selector)].some(relevant))
            return reject(`author CSS: ${rule.selectorText}`);
        } else if ("cssRules" in rule && !inspect((rule as CSSGroupingRule).cssRules)) return false;
      }
      return true;
    };
    try {
      for (const sheet of document.styleSheets) {
        if (sheet === this.style.sheet || sheet.disabled) continue;
        if (!inspect(sheet.cssRules)) return false;
      }
    } catch {
      // Cross-origin sheets, unsupported selectors or CSSOM failures leave the native copy untouched.
      return reject("inaccessible stylesheet or unsupported selector");
    }
    return true;
  }

  dispose(): void {
    this.set(false);
    presentations.delete(this);
    this.style.remove();
  }
}
