// Page-side functions of the reuse fidelity check (reuse-fidelity.ts). Each is serialized into the page by
// page.evaluate, so it must not close over anything.

export interface DefinitionEdit {
  // distinct definitions the family paints through that were recoloured (set) or put back (unset)
  definitions: string[];
  shapes: number;
}

/**
 * The `definition` edit: change every definition that elements under #id (or the groups above it) paint through. A
 * definition here is a pattern, symbol, gradient, marker, mask, filter or clip path, or a coat of arms (an <svg> in #coas),
 * that the family names with `url(#x)` or `href="#x"`. Inline styles with !important (they beat presentation attributes
 * and stylesheet rules) do it, so the SVG visibly changes while the family's own subtree is untouched: paint shapes
 * (pattern, symbol, marker, coat of arms) get a magenta `fill`/`stroke` (`stop-color` for a gradient stop), a mask's shapes
 * go black (what it let through is hidden), a filter's primitives get `flood-color` magenta, a clip path's shapes move
 * by (40, 40). `set: false` puts back what was there. Nothing to change is `definitions: []`.
 */
export function editDefinitions(args: { id: string; set: boolean }): DefinitionEdit {
  const w = globalThis as any;
  const PAINT_TAGS = new Set(["path", "rect", "circle", "ellipse", "polygon", "polyline", "line", "text", "stop"]);
  // a pattern, symbol, gradient, marker, mask, filter or clip path (a coat of arms, an <svg> in #coas, is added below)
  const DEFINITION_TAGS = new Set(["pattern", "symbol", "lineargradient", "radialgradient", "marker", "mask", "filter", "clippath"]);
  const saved: Array<{ el: HTMLElement; prop: string; value: string; priority: string }> = w.__reuseDefinitions ?? [];
  if (!args.set) {
    for (const { el, prop, value, priority } of saved.reverse()) {
      if (value) el.style.setProperty(prop, value, priority);
      else el.style.removeProperty(prop);
    }
    const names = [...new Set<string>(w.__reuseDefinitionNames ?? [])];
    w.__reuseDefinitions = null;
    w.__reuseDefinitionNames = null;
    return { definitions: names, shapes: saved.length };
  }
  const root = document.getElementById(args.id);
  if (!root) return { definitions: [], shapes: 0 };
  const referenced = new Set<string>();
  const scan = (text: string | null) => {
    if (!text) return;
    for (const match of text.matchAll(/url\(\s*["']?#([^"')\s]+)/g)) referenced.add(match[1]);
  };
  // the layer's own subtree and its ancestors (a mask, clip path or filter is often set on the group)
  const elements: Element[] = [root, ...Array.from(root.querySelectorAll("*")).slice(0, 5000)];
  for (let el = root.parentElement; el && el.id !== "map"; el = el.parentElement) elements.push(el);
  for (const el of elements) {
    for (const name of el.getAttributeNames()) {
      const value = el.getAttribute(name);
      if ((name === "href" || name === "xlink:href") && value?.startsWith("#")) referenced.add(value.slice(1));
      else scan(value);
    }
  }
  const targets: Element[] = [];
  for (const id of referenced) {
    const target = document.getElementById(id);
    if (target && (DEFINITION_TAGS.has(target.localName.toLowerCase()) || target.closest("#coas, #defElements")) && !root.contains(target)) targets.push(target);
    if (targets.length >= 6) break;
  }
  const recorded: typeof saved = [];
  const names: string[] = [];
  const set = (el: HTMLElement, prop: string, value: string) => {
    recorded.push({ el, prop, value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop) });
    el.style.setProperty(prop, value, "important");
  };
  for (const target of targets) {
    names.push(`${target.localName}#${target.id}`);
    const kind = target.localName.toLowerCase();
    for (const shape of Array.from(target.querySelectorAll("*")).slice(0, 200)) {
      const el = shape as HTMLElement;
      const tag = shape.localName.toLowerCase();
      if (kind === "filter") set(el, "flood-color", "#ff00ff"); // feFlood / feDropShadow; other primitives ignore it
      else if (kind === "clippath") set(el, "transform", "translate(40px, 40px)"); // the clipped region moves
      else if (kind === "mask") {
        if (PAINT_TAGS.has(tag)) set(el, "fill", "#000000"); // luminance mask: what it let through is hidden
      } else if (PAINT_TAGS.has(tag)) {
        const props = tag === "stop" ? ["stop-color"] : ["fill", "stroke"];
        for (const prop of props) {
          if (prop === "stroke" && !el.getAttribute("stroke") && !el.style.getPropertyValue("stroke")) continue; // never invent a stroke
          set(el, prop, "#ff00ff");
        }
      }
    }
  }
  w.__reuseDefinitions = recorded;
  w.__reuseDefinitionNames = names;
  return { definitions: names, shapes: recorded.length };
}

/** Per family: the definitions its subtree paints through (what editDefinitions would recolour), without changing anything. */
export function listDefinitions(args: { id: string }): string[] {
  const root = document.getElementById(args.id);
  if (!root) return [];
  const found = new Set<string>();
  const elements: Element[] = [root, ...Array.from(root.querySelectorAll("*")).slice(0, 5000)];
  for (let el = root.parentElement; el && el.id !== "map"; el = el.parentElement) elements.push(el);
  for (const el of elements)
    for (const name of el.getAttributeNames()) {
      const value = el.getAttribute(name) ?? "";
      const ids = name === "href" || name === "xlink:href" ? (value.startsWith("#") ? [value.slice(1)] : []) : Array.from(value.matchAll(/url\(\s*["']?#([^"')\s]+)/g)).map(m => m[1]);
      for (const id of ids) {
        const t = document.getElementById(id);
        if (t && (/^(pattern|symbol|lineargradient|radialgradient|marker|mask|filter|clippath)$/i.test(t.localName) || t.closest("#coas, #defElements")) && !root.contains(t)) found.add(`${t.localName}#${id}`);
      }
    }
  return [...found];
}
