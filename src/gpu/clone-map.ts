// Match live map elements to canonical export clones without assuming globally unique IDs.
// IDs are resolved within each direct parent; anonymous children use same-tag order.
const transient = (element: Element) =>
  element.hasAttribute("data-dense-zoom") || (element.tagName === "image" && element.hasAttribute("data-path-vectors"));

export function resolveInClone(live: Element, clone: Element): Element | string {
  const chain: Element[] = [];
  for (let node: Element | null = live; node; node = node.parentElement) {
    chain.push(node);
    if (node.tagName === "svg" && node.id === "map") break;
  }
  const rootIndex = chain.findIndex(element => element.tagName === "svg" && element.id === "map");
  if (rootIndex < 0) return "detached element";
  let target: Element = clone;
  for (const source of chain.slice(0, rootIndex).reverse()) {
    const siblings = [...source.parentElement!.children];
    let matches: Element[];
    let ordinal: number;
    if (source.id) {
      matches = [...target.children].filter(child => child.id === source.id && child.tagName === source.tagName);
      ordinal = siblings.filter(child => child.id === source.id && child.tagName === source.tagName).indexOf(source);
    } else {
      const before = siblings.slice(0, siblings.indexOf(source));
      if (before.some(transient) || siblings.some(child => child.hasAttribute("data-dense-zoom")))
        return "restructured parent";
      matches = [...target.children].filter(child => child.tagName === source.tagName);
      ordinal = before.filter(child => child.tagName === source.tagName).length;
    }
    const next = matches[ordinal];
    if (!next) return source.id ? `missing #${source.id}` : `unresolved <${source.tagName}>`;
    target = next;
  }
  return target;
}
