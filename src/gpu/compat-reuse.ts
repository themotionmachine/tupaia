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
// It fails closed. A change to a definition, a stylesheet, a font or a source outside #map that the clone reads dirties
// every run; an ancestor attribute dirties the runs under that ancestor. When a stylesheet rule can make a map element
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
    let at = 0;
    for (const record of records) {
      if (!at) at = ++this.epoch;
      const { target } = record;
      if (inDefinitions(target)) {
        this.mark(at, `definition ${describeNode(target)}`);
        continue;
      }
      if (record.type === "childList") {
        const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
        const definition = nodes.find(holdsDefinitions);
        if (definition) {
          this.mark(at, `definition ${describeNode(definition)} moved`);
          continue;
        }
        this.touch(target, CHILDREN, at);
        for (const node of Array.from(record.addedNodes)) this.touch(node, ADDED, at);
      } else if (record.type === "characterData") this.touch(target, TEXT, at);
      else if (!neutralAttribute(record)) this.touch(target, ATTR, at);
    }
    if (this.touched.size > this.limit) this.all("tracker overflow");
  }

  // Forgets entries no live raster can need: every stamp still in use is at least `floor`.
  prune(floor: number): void {
    for (const [node, entry] of this.touched) if (entry.at <= floor) this.touched.delete(node);
  }

  get size(): number {
    return this.touched.size;
  }

  // Why each run is dirty ("" when clean). `structural`: a stylesheet rule can make a map element depend on its
  // siblings, so a change outside the runs can still reach them.
  evaluate(runs: readonly Stamped[], structural: boolean): string[] {
    const why = runs.map(run => (run.stamp < this.globalAt ? `global: ${this.globalWhy}` : ""));
    const live = runs.flatMap((_, i) => (why[i] ? [] : [i]));
    if (!live.length) return why;
    const floor = Math.min(...live.map(i => runs[i].stamp));
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
    if (!inDefinitions(target)) return `#${id}`;
    const definition = target as unknown as Partial<ReferenceElement>;
    if (!definition.getAttributeNames || !definition.querySelectorAll) continue;
    references(definition as ReferenceElement, ids);
    const descendants = definition.querySelectorAll("*");
    for (let i = 0; i < descendants.length; i++) references(descendants[i], ids);
  }
  return null;
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
}

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
  for (const item of sheets) sheet(item);
  return { key, structural };
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
// ancestors) and font loads; each change dirties every run. Returns the disposer. A document-wide observer: the
// renderer installs it only while reuse is enabled (compatReuseEnabled), never on the default input path.
export function watchCompatInputs(dirt = compatDirt): () => void {
  const outside = (node: Node | null): boolean => {
    const element = node instanceof Element ? node : node?.parentElement;
    return !element?.closest("svg#map, #fantasyMap");
  };
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (!outside(record.target)) continue;
      const target = record.target as Element;
      const map = document.getElementById("map");
      const root = target === document.documentElement || target === document.body || (!!map && target.contains?.(map));
      const nodes = [...record.addedNodes, ...record.removedNodes].filter(
        node => !(node instanceof Element && node.id === "fantasyMap")
      );
      const node =
        inDefinitions(target as unknown as ReuseNode) || (root && record.type === "attributes")
          ? target
          : nodes.find(item => holdsDefinitions(item as unknown as ReuseNode));
      if (node) {
        dirt.all(`outside #map ${record.type} ${describeNode(node as unknown as ReuseNode)}`);
        return;
      }
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
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
