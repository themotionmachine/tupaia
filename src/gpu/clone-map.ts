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

// Indexes live and clone siblings once per synchronous batch. Nothing survives this call: rasterization can
// restructure the export clone between runs, even when the map revision itself has not changed.
export function resolveManyInClone(lives: readonly Element[], clone: Element): (Element | string)[] {
  interface Position {
    tagOrdinal: number;
    idOrdinal: number;
    transientBefore: boolean;
  }
  interface Children {
    tags: Map<string, Element[]>;
    ids: Map<string, Map<string, Element[]>>;
    positions: Map<Element, Position>;
    dense: boolean;
  }
  const parents = new Map<Element, Children>();
  const childrenOf = (parent: Element): Children => {
    const cached = parents.get(parent);
    if (cached) return cached;
    const result: Children = { tags: new Map(), ids: new Map(), positions: new Map(), dense: false };
    let transientBefore = false;
    for (const child of parent.children) {
      let tags = result.tags.get(child.tagName);
      if (!tags) {
        tags = [];
        result.tags.set(child.tagName, tags);
      }
      let ids = result.ids.get(child.tagName);
      if (!ids) {
        ids = new Map();
        result.ids.set(child.tagName, ids);
      }
      let matches = ids.get(child.id);
      if (!matches) {
        matches = [];
        ids.set(child.id, matches);
      }
      result.positions.set(child, { tagOrdinal: tags.length, idOrdinal: matches.length, transientBefore });
      tags.push(child);
      matches.push(child);
      transientBefore ||= transient(child);
      result.dense ||= child.hasAttribute("data-dense-zoom");
    }
    parents.set(parent, result);
    return result;
  };
  return lives.map(live => {
    const chain: Element[] = [];
    let node: Element | null = live;
    while (node && !(node.tagName === "svg" && node.id === "map")) {
      chain.push(node);
      node = node.parentElement;
    }
    if (!node) return "detached element";
    let target = clone;
    for (let i = chain.length - 1; i >= 0; i--) {
      const source = chain[i];
      const siblings = childrenOf(source.parentElement!);
      const position = siblings.positions.get(source)!;
      if (!source.id && (position.transientBefore || siblings.dense)) return "restructured parent";
      const candidates = childrenOf(target);
      const matches = source.id
        ? candidates.ids.get(source.tagName)?.get(source.id)
        : candidates.tags.get(source.tagName);
      const next = matches?.[source.id ? position.idOrdinal : position.tagOrdinal];
      if (!next) return source.id ? `missing #${source.id}` : `unresolved <${source.tagName}>`;
      target = next;
    }
    return target;
  });
}
