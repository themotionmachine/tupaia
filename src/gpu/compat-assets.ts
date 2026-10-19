// Clone-only definition closure. Generated COAs are copied into every compatibility raster; keep every owner of a
// referenced descendant, not merely SVGs named by <use>. Unknown stylesheet/reference syntax keeps the original tree.
import { EMBLEM_RULES } from "../renderers/emblems/styles";

const generated = /^(burg|state|province)COA\d+$/;
const identifier = /^[\w.:-]+$/;
const unchanged = () => {};
// Export copies these fixed, definitions-independent app rules. Exact matching deliberately rejects user CSS.
const neutralStyles = new Set([
  EMBLEM_RULES,
  "#armies text {stroke: none; fill: #fff; text-shadow: 0 0 4px #000; dominant-baseline: central; text-anchor: middle; font-family: Helvetica; fill-opacity: 1;}#armies text.regimentIcon {font-size: .8em;}",
  ".viewport-culled{display:none!important;pointer-events:none!important}"
]);

function safeStyles(root: Element): boolean {
  for (const style of root.querySelectorAll("style")) {
    const text = style.textContent || "";
    if (neutralStyles.has(text)) continue;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      // Font declarations cannot select siblings or depend on the number/order of definitions.
      if (!sheet.cssRules.length || [...sheet.cssRules].some(rule => rule.type !== CSSRule.FONT_FACE_RULE))
        return false;
    } catch {
      return false;
    }
  }
  return true;
}

// Returns an exact restoration function. The caller must restore synchronously before yielding/reusing the clone.
export function isolateEmblemDefinitions(root: Element): () => void {
  if (!safeStyles(root) || root.querySelector("script,foreignObject,animate,animateMotion,animateTransform,set"))
    return unchanged;
  const candidates = [...root.querySelectorAll("defs > svg[id]")].filter(element => generated.test(element.id));
  if (!candidates.length) return unchanged;
  const candidateSet = new Set(candidates);
  for (const candidate of candidates)
    for (let parent = candidate.parentElement; parent; parent = parent.parentElement)
      if (candidateSet.has(parent)) return unchanged;
  const owner = new Map<Element, Element>();
  const ids = new Map<string, Set<Element>>();
  for (const candidate of candidates) {
    for (const element of [candidate, ...candidate.querySelectorAll("*")]) {
      owner.set(element, candidate);
      if (!element.id) continue;
      if (!identifier.test(element.id)) return unchanged;
      const owners = ids.get(element.id) || new Set<Element>();
      owners.add(candidate);
      ids.set(element.id, owners);
    }
  }
  const retained = new Set<Element>();
  const queue: Element[] = [];
  const retain = (candidate: Element) => {
    if (retained.has(candidate)) return;
    retained.add(candidate);
    queue.push(candidate);
  };
  let unknown = false;
  const references = (text: string) => {
    if (text.includes("\\")) {
      unknown = true;
      return;
    }
    const strings = [text];
    if (/%[\da-f]{2}/i.test(text)) {
      // A geometry value such as 100% is not an encoded reference. Preserve ordinary percent signs when
      // an attribute also contains an encoded fragment (e.g. a CSS variable URL alongside a percentage).
      try {
        strings.push(decodeURIComponent(text.replace(/%(?![\da-f]{2})/gi, "%25")));
      } catch {
        unknown = true;
        return;
      }
    }
    for (const value of strings)
      for (const match of value.matchAll(/#([\w.:-]+)/g))
        for (const candidate of ids.get(match[1]) || []) retain(candidate);
  };
  const scan = (element: Element) => {
    for (const attribute of element.attributes) references(attribute.value);
    if (element.tagName.toLowerCase() === "style") references(element.textContent || "");
  };
  // Every stylesheet stays in its original owner/location, including the final shared canonical COA sheet.
  for (const candidate of candidates) if (candidate.querySelector("style,link,font,font-face")) retain(candidate);
  for (const element of [root, ...root.querySelectorAll("*")]) if (!owner.has(element)) scan(element);
  while (queue.length && !unknown) {
    const candidate = queue.pop()!;
    for (const element of [candidate, ...candidate.querySelectorAll("*")]) scan(element);
  }
  if (unknown) return unchanged;
  const removed: [Element, Element, Node | null][] = [];
  for (const candidate of candidates) {
    if (retained.has(candidate) || !candidateSet.has(candidate) || !candidate.parentElement) continue;
    removed.push([candidate.parentElement, candidate, candidate.nextSibling]);
    candidate.remove();
  }
  return () => {
    for (let i = removed.length - 1; i >= 0; i--) {
      const [parent, element, next] = removed[i];
      parent.insertBefore(element, next);
    }
  };
}
