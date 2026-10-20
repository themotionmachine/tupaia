// Per-run reuse of compat rasters across prepares (PERF-A).
//
// A compat run's raster, and its settle-time detail, depends only on these inputs:
// - the run's elements and their subtrees;
// - the attributes of their ancestors (inherited style, transforms, effects);
// - every definition the export clone carries (<defs>, patterns, filters, symbols, masks, #defElements, #coas);
// - the stylesheets and the fonts;
// - the raster key (world region, resolution and bucket, or viewport size and DPR).
// The tracker records every pixel-relevant change with an epoch. A raster is stamped with the epoch of the DOM state
// it was cut from. A run is clean when nothing that can reach its pixels changed after its stamp.
//
// It fails closed. A change to a stylesheet or a font dirties every run. A change to a definition dirties the runs that
// paint through it: the ids its change can reach are matched against each run's reference closure (the ids its subtree,
// its ancestors and the definitions they reach name), and every run when a stylesheet names one of them. An ancestor
// attribute dirties the runs under that ancestor. When a stylesheet rule can make a map element
// depend on its siblings (structural pseudo-classes, sibling combinators, :has), any change outside the runs, ancestor
// attributes included, dirties every run.

export interface ReuseNode {
  tagName?: string;
  nodeName?: string;
  id?: string;
  parentElement: ReuseNode | null;
  getAttribute?(name: string): string | null;
  querySelector?(selectors: string): unknown;
}

export interface ReuseRecord {
  type: string;
  target: ReuseNode;
  attributeName?: string | null;
  oldValue?: string | null;
  addedNodes: ArrayLike<ReuseNode>;
  removedNodes: ArrayLike<ReuseNode>;
}

const ATTR = 1;
const CHILDREN = 2;
const TEXT = 4;
const ADDED = 8;

// Elements whose content other elements paint by reference, or that style the document.
const DEFINITION_TAGS =
  "defs,style,link,filter,pattern,clipPath,mask,symbol,linearGradient,radialGradient,marker,font,font-face";
const definitionTags = new Set(DEFINITION_TAGS.toLowerCase().split(","));
// Containers outside #map whose content the export clone copies (export.ts prepareMapClone)
const SOURCE_IDS = new Set(["defElements", "coas"]);
const SOURCES = `${DEFINITION_TAGS},#defElements,#coas`;

const tagOf = (node: ReuseNode) => (node.tagName ?? node.nodeName ?? "").toLowerCase();
export const describeNode = (node: ReuseNode) => `<${tagOf(node) || "?"}${node.id ? `#${node.id}` : ""}>`;

// The node or an ancestor is a definition or a definition source.
export function inDefinitions(node: ReuseNode | null): boolean {
  for (; node; node = node.parentElement)
    if (definitionTags.has(tagOf(node)) || SOURCE_IDS.has(node.id ?? "")) return true;
  return false;
}

const holdsDefinitions = (node: ReuseNode) =>
  definitionTags.has(tagOf(node)) || SOURCE_IDS.has(node.id ?? "") || !!node.querySelector?.(SOURCES);

// Definitions that act on the whole document rather than by id: a change to one dirties every run. A <style> added or
// removed with a definition (each generated COA carries one) is keyed by the stylesheet state instead (styleState).
const DOCUMENT_TAGS = new Set(["style", "link", "font", "font-face"]);
const DOCUMENT_SOURCES = "link,font,font-face";
const DEFINITION_ID_LIMIT = 20_000;

interface IdNode extends ReuseNode {
  querySelectorAll?(selectors: string): ArrayLike<ReuseNode>;
}

// The ids a definition change can reach, or null when it can reach every run: the ids on the target and its
// ancestors (a referenced element's content changed), on the subtree of a changed element, on the nodes added or
// removed and their subtrees, and the previous id of a renamed element.
export function definitionIds(record: ReuseRecord): Set<string> | null {
  const ids = new Set<string>();
  for (let node: ReuseNode | null = record.target; node; node = node.parentElement) {
    if (DOCUMENT_TAGS.has(tagOf(node))) return null;
    if (node.id) ids.add(node.id);
  }
  const subtree = (node: IdNode): boolean => {
    if ((node.nodeName ?? "").startsWith("#")) return true; // text, comment
    if (DOCUMENT_TAGS.has(tagOf(node)) && tagOf(node) !== "style") return false;
    if (node.id) ids.add(node.id);
    if (!node.querySelectorAll) return false;
    if (node.querySelector?.(DOCUMENT_SOURCES)) return false;
    const descendants = node.querySelectorAll("[id]");
    for (let i = 0; i < descendants.length; i++) if (descendants[i].id) ids.add(descendants[i].id as string);
    return true;
  };
  if (record.type === "childList") {
    for (const node of [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)])
      if (!subtree(node as IdNode)) return null;
  } else if (record.type === "attributes") {
    if (!subtree(record.target as IdNode)) return null;
    if ((record.attributeName ?? "").toLowerCase() === "id") {
      if (record.oldValue === undefined) return null;
      if (record.oldValue) ids.add(record.oldValue);
    }
  }
  return ids.size > DEFINITION_ID_LIMIT ? null : ids;
}

// Presentation that never reaches a raster: editors toggle the cursor and hit-testing on map groups.
const NEUTRAL = new Set(["cursor", "pointer-events"]);

function declarations(style: string | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const rule of (style || "").split(";")) {
    const colon = rule.indexOf(":");
    if (colon > 0) map.set(rule.slice(0, colon).trim().toLowerCase(), rule.slice(colon + 1).trim());
  }
  return map;
}

// An attribute write that cannot change pixels: a neutral attribute, or a style attribute whose declarations differ
// only in neutral properties. Compared against the current value, so consecutive records chain correctly.
export function neutralAttribute(record: ReuseRecord): boolean {
  const name = (record.attributeName || "").toLowerCase();
  if (NEUTRAL.has(name)) return true;
  if (name !== "style" || record.oldValue === undefined || !record.target.getAttribute) return false;
  const [before, after] = [declarations(record.oldValue), declarations(record.target.getAttribute("style"))];
  for (const key of new Set([...before.keys(), ...after.keys()]))
    if (!NEUTRAL.has(key) && before.get(key) !== after.get(key)) return false;
  return true;
}

export interface Stamped {
  elements: readonly ReuseNode[];
  stamp: number;
}

export class CompatDirt {
  private epoch = 1;
  private globalAt = 0;
  private globalWhy = "";
  private touched = new Map<ReuseNode, { at: number; kinds: number }>();
  // definition ids a change reached, with its epoch and why (definitionIds)
  private defined = new Map<string, { at: number; why: string }>();

  constructor(private readonly limit = 100_000) {}

  // The epoch of the current DOM state: a raster cut now reflects every change noted so far.
  now(): number {
    return this.epoch;
  }

  // Dirties every run rasterized before now.
  all(reason: string): void {
    this.epoch++;
    this.mark(this.epoch, reason);
  }

  private mark(at: number, reason: string): void {
    this.globalAt = at;
    this.globalWhy = reason;
    // older entries can only dirty runs stamped before `at`, which are dirty anyway
    this.touched.clear();
    this.defined.clear();
  }

  private define(at: number, record: ReuseRecord, reason: string): void {
    if (blindTracker() === "definitions") return; // self-test: definition changes reach no run
    const ids = definitionIds(record);
    if (!ids) {
      this.mark(at, reason);
      return;
    }
    for (const id of ids) this.defined.set(id, { at, why: reason });
  }

  // Changes to the definitions the clone copies from outside svg#map (watchCompatInputs), one epoch per batch.
  noteDefinitions(records: Iterable<ReuseRecord>, reason: string): void {
    if (blindTracker() === "stale") return;
    let at = 0;
    for (const record of records) {
      if (!at) at = ++this.epoch;
      this.define(at, record, `${reason} ${describeNode(record.target)}`);
    }
    this.overflow();
  }

  private overflow(): void {
    if (this.touched.size + this.defined.size > this.limit) this.all("tracker overflow");
  }

  private touch(node: ReuseNode, kind: number, at: number): void {
    const entry = this.touched.get(node);
    if (entry) {
      entry.at = at;
      entry.kinds |= kind;
    } else this.touched.set(node, { at, kinds: kind });
  }

  // Records that classify() counts as pixel changes (markers.ts pixelRecords), one epoch per batch.
  note(records: Iterable<ReuseRecord>): void {
    if (blindTracker() === "stale") return;
    let at = 0;
    for (const record of records) {
      if (!at) at = ++this.epoch;
      const { target } = record;
      if (inDefinitions(target)) {
        this.define(at, record, `definition ${describeNode(target)}`);
        continue;
      }
      if (record.type === "childList") {
        const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
        const definition = nodes.find(holdsDefinitions);
        // a definition moved with a map group: the runs that paint through it, and the group's own change below
        if (definition) this.define(at, record, `definition ${describeNode(definition)} moved`);
        this.touch(target, CHILDREN, at);
        for (const node of Array.from(record.addedNodes)) this.touch(node, ADDED, at);
      } else if (record.type === "characterData") this.touch(target, TEXT, at);
      else if (!neutralAttribute(record)) this.touch(target, ATTR, at);
    }
    this.overflow();
  }

  // Forgets entries no live raster can need: every stamp still in use is at least `floor`.
  prune(floor: number): void {
    for (const [node, entry] of this.touched) if (entry.at <= floor) this.touched.delete(node);
    for (const [id, entry] of this.defined) if (entry.at <= floor) this.defined.delete(id);
  }

  get size(): number {
    return this.touched.size + this.defined.size;
  }

  // Why each run is dirty ("" when clean). `structural`: a stylesheet rule can make a map element depend on its
  // siblings, so a change outside the runs can still reach them. `references[i]`: the ids run i paints through
  // (referenceClosure); a run without one is dirtied by any definition change. `styleReferences`: the ids the
  // stylesheets name (StyleState.references); a change to one of them dirties every run.
  evaluate(
    runs: readonly Stamped[],
    structural: boolean,
    references?: readonly (ReadonlySet<string> | null | undefined)[],
    styleReferences?: ReadonlySet<string>
  ): string[] {
    const why = runs.map(run => (run.stamp < this.globalAt ? `global: ${this.globalWhy}` : ""));
    const live = runs.flatMap((_, i) => (why[i] ? [] : [i]));
    if (!live.length) return why;
    const floor = Math.min(...live.map(i => runs[i].stamp));
    if (this.defined.size) {
      let everyAt = 0;
      let everyWhy = "";
      for (const [id, { at, why: reason }] of this.defined)
        if (at > floor && at > everyAt && styleReferences?.has(id)) {
          everyAt = at;
          everyWhy = `${reason} (#${id} named by a stylesheet)`;
        }
      for (const i of live) {
        if (everyAt > runs[i].stamp) {
          why[i] = everyWhy;
          continue;
        }
        const named = references?.[i];
        if (!named) {
          for (const { at, why: reason } of this.defined.values())
            if (at > runs[i].stamp) {
              why[i] = reason;
              break;
            }
          continue;
        }
        const [small, large] = named.size < this.defined.size ? [named, this.defined] : [this.defined, named];
        for (const id of small.keys()) {
          const entry = this.defined.get(id);
          if (large.has(id) && entry && entry.at > runs[i].stamp) {
            why[i] = `${entry.why} (#${id})`;
            break;
          }
        }
      }
    }
    const owner = new Map<ReuseNode, number>();
    runs.forEach((run, i) => {
      for (const element of run.elements) owner.set(element, i);
    });
    const above = new Set<ReuseNode>();
    for (const i of live)
      for (const element of runs[i].elements)
        for (let node = element.parentElement; node && !above.has(node); node = node.parentElement) above.add(node);
    const dirty = (i: number, at: number, reason: string) => {
      if (!why[i] && at > runs[i].stamp) why[i] = reason;
    };
    const every = (at: number, reason: string) => {
      for (const i of live) dirty(i, at, reason);
    };
    const under = (run: Stamped, ancestor: ReuseNode) =>
      run.elements.some(element => {
        for (let n = element.parentElement; n; n = n.parentElement) if (n === ancestor) return true;
        return false;
      });
    const added = new Map<ReuseNode, number>();
    for (const [node, { at, kinds }] of this.touched) {
      if (at <= floor) continue;
      let run = -1;
      for (let n: ReuseNode | null = node; n && run < 0; n = n.parentElement) run = owner.get(n) ?? -1;
      if (run >= 0) {
        dirty(run, at, `changed ${describeNode(node)}`);
        continue;
      }
      if (kinds & ADDED) added.set(node, at);
      if (above.has(node)) {
        // Subtree rule: an attribute reaches the pixels of its own subtree only (inheritance, transforms, effects and
        // descendant selectors all flow downwards). The ways it can reach further are each closed elsewhere: sibling
        // combinators and :has() make the stylesheet `structural` (every run dirty, below), and a run that paints
        // through an id outside the definitions is never reused (externalReference). The zoom-end label font-size
        // write on #labels > g#states therefore dirties the label runs under it, not every run (PERF-A stop-loss).
        // Known gap: an ancestor id change that makes a url(#id) or href elsewhere resolve to another element.
        if (kinds & ATTR) {
          if (structural) every(at, `ancestor ${describeNode(node)} (structural CSS)`);
          else for (const i of live) if (under(runs[i], node)) dirty(i, at, `ancestor ${describeNode(node)}`);
        } else if (structural && kinds & (CHILDREN | TEXT))
          every(at, `children of ${describeNode(node)} (structural CSS)`);
      } else if (structural && kinds & (ATTR | CHILDREN | TEXT)) every(at, `${describeNode(node)} (structural CSS)`);
    }
    if (added.size)
      for (const i of live) {
        if (why[i]) continue;
        search: for (const element of runs[i].elements)
          for (let node = element.parentElement; node; node = node.parentElement) {
            const at = added.get(node);
            if (at !== undefined && at > runs[i].stamp) {
              why[i] = `moved with ${describeNode(node)}`;
              break search;
            }
          }
      }
    return why;
  }
}

// Self-test of the reuse fidelity check (bench/host/reuse-fidelity.ts, REUSE_BREAK): ?gpu-compat-reuse-break=stale makes
// the tracker ignore every DOM edit, so a reused raster can be stale; =definitions blinds only the definition path
// (define: the ids a definition change reaches, matched against each run's reference closure) and leaves every other
// edit tracked. The check must catch both.
type Blind = "stale" | "definitions" | null;
let blind: Blind | undefined;
function blindTracker(): Blind {
  if (blind === undefined)
    try {
      const mode = new URLSearchParams(globalThis.location?.search ?? "").get("gpu-compat-reuse-break");
      blind = mode === "stale" || mode === "definitions" ? mode : null;
    } catch {
      blind = null;
    }
  return blind;
}

export const compatDirt = new CompatDirt();

// ---- references -------------------------------------------------------------------------------------------------

interface ReferenceElement extends ReuseNode {
  getAttributeNames(): string[];
  getAttribute(name: string): string | null;
  querySelectorAll(selectors: string): ArrayLike<ReferenceElement>;
}

const URL_REFERENCE = /url\(\s*["']?#([^"')\s]+)/g;

function references(element: ReferenceElement, out: Set<string>): void {
  for (const name of element.getAttributeNames()) {
    const value = element.getAttribute(name) || "";
    if ((name === "href" || name === "xlink:href") && value.startsWith("#")) out.add(value.slice(1));
    if (value.includes("url(")) for (const match of value.matchAll(URL_REFERENCE)) out.add(match[1]);
  }
}

// The first id the run paints through (from its subtrees or its ancestors) that resolves outside the definitions,
// where the tracker would not see it change; null when every reference is to a definition or unresolved.
export function externalReference(
  elements: readonly ReferenceElement[],
  resolve: (id: string) => ReuseNode | null
): string | null {
  return referenceClosure(elements, resolve).external;
}

// Every id the run paints through: named by its subtrees or its ancestors, and by the definitions those reach,
// followed transitively (unresolved ids included: a definition added under one changes the run). `external`: the
// first that resolves outside the definitions (externalReference).
export function referenceClosure(
  elements: readonly ReferenceElement[],
  resolve: (id: string) => ReuseNode | null
): { ids: Set<string>; external: string | null } {
  let external: string | null = null;
  const ids = new Set<string>();
  const ancestors = new Set<ReuseNode>();
  for (const element of elements) {
    references(element, ids);
    const descendants = element.querySelectorAll("*");
    for (let i = 0; i < descendants.length; i++) references(descendants[i], ids);
    for (let node = element.parentElement; node && !ancestors.has(node); node = node.parentElement) {
      ancestors.add(node);
      if ("getAttributeNames" in node) references(node as ReferenceElement, ids);
    }
  }
  // Followed through the definitions (COMPAT): a state halo is clipped by a definition, <clipPath><use href="#state1">,
  // whose own target is a live #statesBody path; the raster now paints through it (compat.ts isolate holds it).
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const target = resolve(id);
    if (!target) continue;
    if (!inDefinitions(target)) {
      external ??= `#${id}`;
      continue;
    }
    const definition = target as unknown as Partial<ReferenceElement>;
    if (!definition.getAttributeNames || !definition.querySelectorAll) continue;
    references(definition as ReferenceElement, ids);
    const descendants = definition.querySelectorAll("*");
    for (let i = 0; i < descendants.length; i++) references(descendants[i], ids);
  }
  return { ids: seen, external };
}

// ---- stylesheets ------------------------------------------------------------------------------------------------

export interface RuleLike {
  cssText: string;
  selectorText?: string;
  cssRules?: ArrayLike<RuleLike>;
  styleSheet?: SheetLike | null;
  media?: { mediaText: string } | null; // @media (and @import) rules
}

export interface SheetLike {
  disabled: boolean;
  href: string | null;
  media?: { mediaText: string } | null;
  readonly cssRules: ArrayLike<RuleLike>;
  ownerNode?: { namespaceURI?: string | null; textContent?: string | null } | null;
}

// Splits at top-level occurrences of `separators` (outside brackets, parentheses and quotes).
function split(selector: string, separators: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (!depth && separators.includes(c)) {
      parts.push(selector.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts;
}

// The compound selector a complex selector matches (after its last combinator), without pseudo-classes or
// pseudo-elements: an over-approximation of the elements the rule can style.
export function subject(selector: string): string {
  const parts = split(selector.trim(), " >+~").filter(part => part.trim());
  const last = parts[parts.length - 1] ?? "";
  let out = "";
  let depth = 0;
  let pseudo = false;
  for (let i = 0; i < last.length; i++) {
    const c = last[i];
    if (pseudo) {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (!depth && /[.#[:]/.test(c)) {
        pseudo = false;
        i--;
      }
      continue;
    }
    if (c === ":") {
      pseudo = true;
      continue;
    }
    out += c;
  }
  return out.trim() || "*";
}

const STRUCTURAL = /[+~]|:(?:nth-|first-|last-|only-|empty|has\()/i;
// Rules scoped to the live map (`#map x`, `svg#map > x`): no element of the detached export clone can match them.
const MAP_SCOPED = /^\s*(?:svg)?#map(?=[\s>])/i;
const FONT_SHEET = /^https:\/\/fonts\.googleapis\.com\//;

export interface StyleState {
  key: string; // everything the rules can contribute to a clone raster
  structural: string; // a sibling-dependent selector that can match a map element ("" when none)
  references: Set<string>; // the ids the rules name (url(#id)): a change to one can reach any run
}

const SVG_NS = "http://www.w3.org/2000/svg";

// `applies(subject)`: whether a compound selector matches an element of the map (true when unsure). `matches(media)`:
// whether a media query holds now; the key records it, since a viewport resize or a color-scheme flip can switch the
// rules the clone's inlined computed styles come from without any rule text changing.
export function styleState(
  sheets: Iterable<SheetLike>,
  applies: (selector: string) => boolean,
  matches: (media: string) => boolean = () => true
): StyleState {
  const holds = (media: { mediaText: string } | null | undefined) =>
    media?.mediaText ? ` @holds ${matches(media.mediaText)}` : "";
  let key = "";
  let structural = "";
  const visit = (rules: ArrayLike<RuleLike>) => {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule.styleSheet) {
        sheet(rule.styleSheet);
        continue;
      }
      if (rule.selectorText !== undefined) {
        const selectors = split(rule.selectorText, ",");
        if (selectors.every(selector => MAP_SCOPED.test(selector))) continue;
        if (!structural)
          for (const selector of selectors)
            if (STRUCTURAL.test(selector) && !MAP_SCOPED.test(selector) && applies(subject(selector))) {
              structural = selector.trim();
              break;
            }
      }
      if (rule.cssRules && rule.selectorText === undefined) {
        key += `${rule.cssText.slice(0, rule.cssText.indexOf("{"))}${holds(rule.media)}{`;
        visit(rule.cssRules);
        key += "}";
      } else key += `${rule.cssText}\n`;
    }
  };
  const sheet = (item: SheetLike) => {
    key += `@sheet ${item.href ?? ""} ${item.disabled} ${item.media?.mediaText ?? ""}${holds(item.media)}{`;
    // a disabled <style> in an svg still styles a serialized clone of it: an emblem keeps its COA rules in its markup
    // and disables the live sheet (renderers/emblems/styles.ts)
    if (item.disabled && item.ownerNode?.namespaceURI === SVG_NS) key += `@text ${item.ownerNode.textContent ?? ""}`;
    if (!item.disabled) {
      let rules: ArrayLike<RuleLike> | null = null;
      try {
        rules = item.cssRules;
      } catch {
        // cross-origin: its rules cannot be read; only a font sheet is known not to style map elements
        if (!structural && !FONT_SHEET.test(item.href ?? "")) structural = `unreadable sheet ${item.href}`;
      }
      if (rules) visit(rules);
    }
    key += "}";
  };
  // Consecutive identical sheets cascade as one: each generated COA adds a disabled copy of the emblem rules, and the
  // one enabled shared copy moves after the latest (renderers/emblems/styles.ts); new emblems must not change the key.
  let last = "";
  let out = "";
  for (const item of sheets) {
    key = "";
    sheet(item);
    if (key !== last) out += key;
    last = key;
  }
  key = out;
  const references = new Set<string>();
  for (const match of key.matchAll(URL_REFERENCE)) references.add(match[1]);
  return { key, structural, references };
}

// services/fonts.ts `fonts`: the families the export clone may embed (null when unavailable).
function mapFonts(): { family: string; src?: string; unicodeRange?: string; variant?: string }[] | null {
  const list = (globalThis as { fonts?: unknown }).fonts;
  return Array.isArray(list) ? list : null;
}

// The live document's style state, judged against the map <svg>.
export function documentStyle(svg: Element): StyleState {
  const applies = (selector: string) => {
    try {
      return svg.matches(selector) || !!svg.querySelector(selector);
    } catch {
      return true;
    }
  };
  const matches = (media: string) => {
    try {
      return matchMedia(media).matches;
    } catch {
      return true;
    }
  };
  const state = styleState(
    [...Array.from(document.styleSheets), ...(document.adoptedStyleSheets ?? [])] as unknown as SheetLike[],
    applies,
    matches
  );
  // the font list the export clone embeds from (services/fonts.ts getUsedFonts): a font added or changed there
  state.key += `@fonts ${document.fonts?.size ?? 0} ${JSON.stringify(mapFonts() ?? "unknown")}`;
  return state;
}

// ---- inputs outside #map -----------------------------------------------------------------------------------------

// Watches what the clone reads outside svg#map (stylesheets, #defElements, #coas, any defs, the attributes of svg#map's
// ancestors) and font loads: a definition change dirties only the runs whose reference closure reaches it, anything
// else every run. Returns the disposer. A document-wide observer: the renderer installs it while reuse is enabled
// (compatReuseEnabled, on by default since W3 COST), so it is on the default GPU input path.
export function watchCompatInputs(dirt = compatDirt): () => void {
  const outside = (node: Node | null): boolean => {
    const element = node instanceof Element ? node : node?.parentElement;
    return !element?.closest("svg#map, #fantasyMap");
  };
  const observer = new MutationObserver(records => {
    const definitions: ReuseRecord[] = [];
    for (const record of records) {
      if (!outside(record.target)) continue;
      const target = record.target as Element;
      const map = document.getElementById("map");
      const root = target === document.documentElement || target === document.body || (!!map && target.contains?.(map));
      if (root && record.type === "attributes") {
        dirt.all(`outside #map ${record.type} ${describeNode(target as unknown as ReuseNode)}`);
        return;
      }
      const keep = (list: NodeList) =>
        [...list].filter(node => !(node instanceof Element && node.id === "fantasyMap")) as unknown as ReuseNode[];
      const [addedNodes, removedNodes] = [keep(record.addedNodes), keep(record.removedNodes)];
      if (
        inDefinitions(target as unknown as ReuseNode) ||
        [...addedNodes, ...removedNodes].some(item => holdsDefinitions(item))
      )
        definitions.push({
          type: record.type,
          target: target as unknown as ReuseNode,
          attributeName: record.attributeName,
          oldValue: record.oldValue,
          addedNodes,
          removedNodes
        });
    }
    // an emblem generated on zoom adds its COA to #coas: the runs that paint through it, not every run
    if (definitions.length) dirt.noteDefinitions(definitions, "outside #map");
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true, // an id renamed: the runs that named the old id
    characterData: true
  });
  // A raster embeds its fonts as data URIs from the map font list; a font outside it (an editor's icon font) cannot
  // reach one. Without the list every load counts.
  const fonts = (event: Event) => {
    const faces = (event as Event & { fontfaces?: readonly FontFace[] }).fontfaces ?? [];
    const families = faces.map(face => face.family.replace(/^["']|["']$/g, ""));
    const known = mapFonts();
    if (!known || !families.length || families.some(family => known.some(font => font.family === family)))
      dirt.all(`font load ${families.join(",")}`);
  };
  document.fonts?.addEventListener("loadingdone", fonts);
  document.fonts?.addEventListener("loadingerror", fonts);
  return () => {
    observer.disconnect();
    document.fonts?.removeEventListener("loadingdone", fonts);
    document.fonts?.removeEventListener("loadingerror", fonts);
  };
}

// ---- shared textures ---------------------------------------------------------------------------------------------

// A reused raster is drawn by the previous frame and the new one at once: each owner holds one reference and the
// texture is freed when the last one lets go. An unshared texture has one implicit reference.
const shares = new WeakMap<object, number>();

export function retain<T extends object>(texture: T): T {
  shares.set(texture, (shares.get(texture) ?? 1) + 1);
  return texture;
}

export interface Releaser<T> {
  release(resource: T | null | undefined): void;
}

export function releaseShared<T extends object>(device: Releaser<T>, texture: T | null | undefined): void {
  if (!texture) return;
  const count = shares.get(texture) ?? 1;
  if (count > 1) {
    shares.set(texture, count - 1);
    return;
  }
  shares.delete(texture);
  device.release(texture);
}

export const sharedReleaser = <T extends object>(device: Releaser<T>): Releaser<T> => ({
  release: texture => releaseShared(device, texture)
});
