// Every generated COA keeps these rules in its markup so a standalone SVG clone is self-contained.
// Hundreds of identical live sheets make browser style invalidation needlessly expensive.
export const EMBLEM_RULES = `
      g.secondary,path.secondary {fill: var(--secondary);}
      g.tertiary,path.tertiary {fill: var(--tertiary);}
    `;

const SHARED = "data-emblem-shared-style";
const SVG_NS = "http://www.w3.org/2000/svg";
const sharedSheets = new WeakMap<Element, SVGStyleElement>();

function embeddedStyles(root: ParentNode): SVGStyleElement[] {
  return [...root.querySelectorAll<SVGStyleElement>("svg[id] > defs > style")].filter(style => {
    const owner = style.parentElement?.parentElement;
    return (
      !!owner &&
      /^(burg|state|province)COA\d+$/.test(owner.id) &&
      style.attributes.length === 0 &&
      style.textContent === EMBLEM_RULES
    );
  });
}

// Disabling the CSSStyleSheet, rather than changing/removing the style element, preserves standalone
// cloneNode/XMLSerializer exports: the new document gets an enabled sheet from the unchanged markup.
// The shared sheet sits just after the latest generated COA, preserving the generated rules' cascade order.
// A cleared/replaced #coas needs no explicit reset: a missing shared child triggers a fresh scan.
export function maintainEmblemStyles(root: Element, added?: Element): void {
  let shared = sharedSheets.get(root);
  if (shared?.parentElement !== root) shared = undefined;
  if (!shared) {
    const styles = embeddedStyles(root);
    if (!styles.length) return;
    shared = document.createElementNS(SVG_NS, "style");
    shared.setAttribute(SHARED, "");
    shared.textContent = EMBLEM_RULES;
    const lastOwner = styles[styles.length - 1].parentElement!.parentElement!;
    lastOwner.after(shared);
    sharedSheets.set(root, shared);
    for (const style of styles) if (style.sheet) style.sheet.disabled = true;
  } else if (added) {
    // draw() appends a generated COA; its rules would otherwise be the last generated rules in source order.
    added.after(shared);
    for (const style of embeddedStyles(added)) if (style.sheet) style.sheet.disabled = true;
  }
}

// Export clones need enabled markup, not live CSSStyleSheet state. Retaining the LAST identical generated
// sheet at its original position preserves cascade precedence even when other (unknown) sheets intervene.
export function compactEmblemCloneStyles(root: ParentNode): void {
  const styles = embeddedStyles(root);
  for (let i = 0; i < styles.length - 1; i++) styles[i].remove();
}
