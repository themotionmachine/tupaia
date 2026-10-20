// The style text the export clone (also the GPU compat clone) writes on an element from its computed style: every
// property that differs from the baseline (an empty <g>'s computed style), except the cursor and properties the
// element's presentation attribute already holds. The style attribute is rewritten with this text, so a property the
// element's own inline style sets is kept even when the attribute is present too: inline style beats the attribute, and
// skipping it would fall back to the attribute (legacy maps saved mid-fade carry
// <g id="ice" opacity="0.9" style="opacity: 0.04">, which the live map shows at 0.04 and exports drew at 0.9).
//
// `named`: the keys of a for-in over a computed declaration that can name a property (namedKeys), computed once per
// clone. The for-in also yields every camelCase alias and index (about 1100 keys in Chrome against 83 named ones), and
// getPropertyValue reads those as "" whatever the element, the same as the baseline, so they never add text: the
// result is identical and the clone's inline pass about 2.5x faster (parity world: 257 to 97 ms, COST2).
export function computedStyleText(
  element: Element,
  computed: CSSStyleDeclaration,
  baseline: (key: string) => string,
  named?: readonly string[]
): string {
  const own = new Set(Array.from((element as SVGElement).style ?? []));
  let style = "";
  const add = (key: string) => {
    if (key === "cursor") return; // cursor should be default
    if (element.hasAttribute(key) && !own.has(key)) return;
    const value = computed.getPropertyValue(key);
    if (value === baseline(key)) return;
    style += `${key}:${value};`;
  };
  for (let i = 0; i < computed.length; i++) add(computed[i]);
  if (named) for (const key of named) add(key);
  else for (const key in computed) add(key);
  return style;
}

// The for-in keys of a declaration that getPropertyValue can resolve: a property name is ASCII lowercase (CSSOM
// lowercases the argument, so a camelCase alias never matches a property) and is not an index.
export function namedKeys(declaration: CSSStyleDeclaration): string[] {
  const keys: string[] = [];
  for (const key in declaration) if (!/[A-Z]/.test(key) && !/^\d+$/.test(key)) keys.push(key);
  return keys;
}
