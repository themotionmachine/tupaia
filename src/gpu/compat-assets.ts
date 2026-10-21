// Clone-only definition closure. Generated COAs are copied into every compatibility raster; keep every owner of a
// referenced descendant, not merely SVGs named by <use>. Unknown stylesheet/reference syntax keeps the original tree.
import { EMBLEM_RULES } from "../renderers/emblems/styles";

const generated = /^(burg|state|province)COA\d+$/;
// Map-wide definitions that matter only to the runs that name them (W4b HEIGHT): the feature outlines drawFeatures writes
// (#featurePaths, about 270 of the 340 KB every parity raster serialized, parsed again by each decode) and the masks
// beside them (#land and #water name every outline; #fog). Pruned on the same terms as an unused COA: nothing kept names
// them or anything inside them, through any chain of definitions.
const SHARED_DEFINITIONS = "defs #deftemp > #featurePaths, defs #deftemp > mask[id]";
const identifier = /^[\w.:-]+$/;
const unchanged = () => {};
// Export copies these fixed, definitions-independent app rules. Exact matching deliberately rejects user CSS.
const neutralStyles = new Set([
  EMBLEM_RULES,
  "#armies text {stroke: none; fill: #fff; text-shadow: 0 0 4px #000; dominant-baseline: central; text-anchor: middle; font-family: Helvetica; fill-opacity: 1;}#armies text.regimentIcon {font-size: .8em;}",
  ".viewport-culled{display:none!important;pointer-events:none!important}"
]);

// A stylesheet's verdict, kept per <style> element while its text is the same: the export clone embeds the map's fonts
// as one large @font-face sheet, and parsing it again for every raster cost about 20 ms a cut on the 100k world.
const styleVerdicts = new WeakMap<Element, { text: string; safe: boolean }>();

function safeStyle(style: Element): boolean {
  const text = style.textContent || "";
  if (neutralStyles.has(text)) return true;
  const known = styleVerdicts.get(style);
  if (known?.text === text) return known.safe;
  let safe = true;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    // Font declarations cannot select siblings or depend on the number/order of definitions.
    if (!sheet.cssRules.length || [...sheet.cssRules].some(rule => rule.type !== CSSRule.FONT_FACE_RULE)) safe = false;
  } catch {
    safe = false;
  }
  styleVerdicts.set(style, { text, safe });
  return safe;
}

function safeStyles(root: Element): boolean {
  for (const style of root.querySelectorAll("style")) if (!safeStyle(style)) return false;
  return true;
}

// What the candidates (generated COA <svg>s) hold, which depends on nothing outside them: built once per root and set of
// candidates (W4 RESUME). The export clone is cut many times per revision and its definitions never change in between
// (isolation only detaches and reinserts nodes outside <defs>), and walking every element of every COA for each cut cost
// up to 25 ms a raster on the 100k world. `bail`: a candidate id outside `identifier`, so every cut keeps the tree.
// `edges`: the candidates each candidate's own subtree names; `unknown`: candidates whose subtree holds a reference
// this scan cannot read (an escape, a malformed encoding), which keeps the tree once such a candidate is retained.
interface CandidateGraph {
  candidates: Element[];
  bail: boolean;
  ids: Map<string, Set<Element>>;
  edges: Map<Element, Set<Element>>;
  unknown: Set<Element>;
  styled: Element[]; // candidates holding a stylesheet: always retained
}
const graphs = new WeakMap<Element, CandidateGraph>();

// The candidate owners `text` names through a #fragment, into `out`; false when the text cannot be read safely.
function referencesIn(
  text: string,
  ids: ReadonlyMap<string, Set<Element>>,
  out: (candidate: Element) => void
): boolean {
  if (text.includes("\\")) return false;
  if (!text.includes("#") && !text.includes("%")) return true; // nothing to name (an encoded # is %23)
  const strings = [text];
  if (/%[\da-f]{2}/i.test(text)) {
    // A geometry value such as 100% is not an encoded reference. Preserve ordinary percent signs when
    // an attribute also contains an encoded fragment (e.g. a CSS variable URL alongside a percentage).
    try {
      strings.push(decodeURIComponent(text.replace(/%(?![\da-f]{2})/gi, "%25")));
    } catch {
      return false;
    }
  }
  for (const value of strings)
    for (const match of value.matchAll(/#([\w.:-]+)/g)) for (const candidate of ids.get(match[1]) || []) out(candidate);
  return true;
}

// The references an element's attributes (and a <style>'s text) make; false when one cannot be read safely.
function scanElement(element: Element, ids: ReadonlyMap<string, Set<Element>>, out: (candidate: Element) => void) {
  for (const attribute of element.attributes) if (!referencesIn(attribute.value, ids, out)) return false;
  if (element.tagName.toLowerCase() === "style" && !referencesIn(element.textContent || "", ids, out)) return false;
  return true;
}

function candidateGraph(root: Element, candidates: Element[]): CandidateGraph {
  const cached = graphs.get(root);
  if (
    cached &&
    cached.candidates.length === candidates.length &&
    cached.candidates.every((c, i) => c === candidates[i])
  )
    return cached;
  const graph: CandidateGraph = {
    candidates,
    bail: false,
    ids: new Map(),
    edges: new Map(),
    unknown: new Set(),
    styled: []
  };
  graphs.set(root, graph);
  for (const candidate of candidates)
    for (const element of [candidate, ...candidate.querySelectorAll("*")]) {
      if (!element.id) continue;
      if (!identifier.test(element.id)) {
        graph.bail = true;
        return graph;
      }
      const owners = graph.ids.get(element.id) || new Set<Element>();
      owners.add(candidate);
      graph.ids.set(element.id, owners);
    }
  for (const candidate of candidates) {
    const named = new Set<Element>();
    const add = (target: Element) => named.add(target);
    for (const element of [candidate, ...candidate.querySelectorAll("*")])
      if (!scanElement(element, graph.ids, add)) {
        graph.unknown.add(candidate);
        break;
      }
    graph.edges.set(candidate, named);
    if (candidate.querySelector("style,link,font,font-face")) graph.styled.push(candidate);
  }
  return graph;
}

// Returns an exact restoration function. The caller must restore synchronously before yielding/reusing the clone.
export function isolateEmblemDefinitions(root: Element): () => void {
  if (!safeStyles(root) || root.querySelector("script,foreignObject,animate,animateMotion,animateTransform,set"))
    return unchanged;
  const candidates = [
    ...[...root.querySelectorAll("defs > svg[id]")].filter(element => generated.test(element.id)),
    ...root.querySelectorAll(SHARED_DEFINITIONS)
  ];
  if (!candidates.length) return unchanged;
  const candidateSet = new Set(candidates);
  for (const candidate of candidates)
    for (let parent = candidate.parentElement; parent; parent = parent.parentElement)
      if (candidateSet.has(parent)) return unchanged;
  const graph = candidateGraph(root, candidates);
  if (graph.bail) return unchanged;
  const retained = new Set<Element>();
  const queue: Element[] = [];
  const retain = (candidate: Element) => {
    if (retained.has(candidate)) return;
    retained.add(candidate);
    queue.push(candidate);
  };
  // Every stylesheet stays in its original owner/location, including the final shared canonical COA sheet.
  for (const candidate of graph.styled) retain(candidate);
  // every element outside the candidates (their subtrees are the graph's), in document order
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: node => (candidateSet.has(node as Element) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  });
  for (let node: Node | null = root; node; node = walker.nextNode())
    if (!scanElement(node as Element, graph.ids, retain)) return unchanged;
  while (queue.length) {
    const candidate = queue.pop()!;
    if (graph.unknown.has(candidate)) return unchanged;
    for (const target of graph.edges.get(candidate) ?? []) retain(target);
  }
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
