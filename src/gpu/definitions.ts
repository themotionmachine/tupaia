// Definitions outside svg#map that the GPU frame paints (W3 LIFE3). svg#defElements holds what the map references by
// id but does not contain: the coats of arms (#coas, rendered lazily: a COA <svg> is appended when its charges have
// been fetched, after the emblem <use> already names it), relief and burg icon symbols, hatching and grid patterns, the
// compass rose, goods icons. The compat clone copies them at prepare time (io/export.ts prepareMapClone) and the scene
// resolves some through the document, so a frame prepared before one arrived or changed keeps the old pixels until
// something else forces a prepare (emblems at k4: 79K GPU px against 173K SVG px). The renderer observes svg#map only;
// this watches svg#defElements and reports a change the map can see as a static revision.
//
// "Can see": an id on the changed node's ancestor chain (or on an added/removed node or its descendants) that svg#map
// references by href or url(#id), directly or through another definition outside it. A stylesheet change outside #coas
// always counts (<style> applies document-wide); one inside #coas (the shared emblem sheet, re-appended after each new
// COA) counts while the map shows an emblem, unless the sheets added, moved or removed there carry exactly the shared
// emblem rules (a COA drawn for an editor's preview appends its own copy and moves the shared sheet after it: the
// rules in force are the same). Anything else (a COA rendered for a dialog preview while the emblem layer is off) is
// ignored.

import { EMBLEM_RULES } from "../renderers/emblems/styles";

const REFERENCING =
  '[clip-path],[mask],[filter],[fill*="url("],[stroke*="url("],[style*="url("],[marker-start],[marker-mid],[marker-end],' +
  "[href],use,textPath,pattern,linearGradient,radialGradient,feImage,image,tref";
const URL_ID = /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/g;
const STYLE = "style,link";
// an added subtree's ids are collected up to this many (a load inserting a whole icon set is a change either way)
const ID_SCAN_LIMIT = 5000;

export function references(root: Element, out: Set<string> | string[]): void {
  const push = (id: string) => (Array.isArray(out) ? out.push(id) : out.add(id));
  for (const node of [root, ...root.querySelectorAll(REFERENCING)])
    for (const { name, value } of Array.from(node.attributes)) {
      if (name === "href" || name === "xlink:href") {
        if (value.startsWith("#")) push(value.slice(1));
      } else if (value.includes("url(")) for (const match of value.matchAll(URL_ID)) push(match[1]);
    }
}

export interface DefinitionStats {
  revisions: number;
  ignored: number;
  last: string;
}

export class DefinitionWatch {
  private observer: MutationObserver;
  private observed: Element | null = null;
  private direct: { epoch: number; ids: Set<string> } | null = null;
  private epoch = 0;
  readonly stats: DefinitionStats = { revisions: 0, ignored: 0, last: "" };

  constructor(
    private map: () => Element,
    private changed: (reason: string) => void
  ) {
    this.observer = new MutationObserver(records => this.check(records));
    this.attach();
  }

  // (Re)attaches to the document's svg#defElements, if it was replaced.
  attach(): void {
    const definitions = document.getElementById("defElements");
    if (definitions === this.observed) return;
    this.observer.disconnect();
    this.observed = definitions;
    if (definitions)
      this.observer.observe(definitions, { subtree: true, childList: true, attributes: true, characterData: true });
  }

  // svg#map changed in a way that can change what it references: the cached reference set is stale.
  mapChanged(): void {
    this.epoch++;
  }

  // Drains queued records now (a prepare about to clone, a suspension ending).
  flush(): void {
    const records = this.observer.takeRecords();
    if (records.length) this.check(records);
  }

  dispose(): void {
    this.observer.disconnect();
    this.observed = null;
  }

  check(records: ArrayLike<MutationRecord>): void {
    const ids = new Set<string>();
    let sheet = false;
    let emblemSheet = false;
    // `inCoas`: where the node is (an added one) or was (a removed one: detached, it has no ancestors to ask)
    const collect = (node: Node, inCoas: boolean) => {
      if (!(node instanceof Element)) {
        if (node.parentElement?.closest(STYLE)) sheet = true;
        return;
      }
      if (node.id) ids.add(node.id);
      const sheets = node.matches(STYLE) ? [node] : Array.from(node.querySelectorAll(STYLE));
      for (const style of sheets) {
        if (!inCoas) sheet = true;
        else if (!(style.localName === "style" && style.textContent === EMBLEM_RULES)) emblemSheet = true;
      }
      if (ids.size < ID_SCAN_LIMIT) for (const inner of node.querySelectorAll("[id]")) ids.add(inner.id);
    };
    for (const record of Array.from(records)) {
      const target = record.target;
      const element = target instanceof Element ? target : target.parentElement;
      for (let node = element; node && node !== this.observed; node = node.parentElement) if (node.id) ids.add(node.id);
      if (element?.closest(STYLE)) {
        if (element.closest("#coas")) emblemSheet = true;
        else sheet = true;
      }
      const inCoas = !!element?.closest("#coas");
      for (const node of Array.from(record.addedNodes)) collect(node, inCoas);
      for (const node of Array.from(record.removedNodes)) collect(node, inCoas);
    }
    const hit = sheet
      ? "<style>"
      : emblemSheet && this.map().querySelector("#emblems use[href]")
        ? "emblem <style>"
        : this.referenced(ids);
    if (!hit) {
      this.stats.ignored++;
      return;
    }
    this.stats.revisions++;
    this.stats.last = `definition ${hit}`;
    this.changed(this.stats.last);
  }

  // The first of `ids` the map references, directly or through definitions outside it; null when none.
  private referenced(ids: Set<string>): string | null {
    if (!ids.size) return null;
    const map = this.map();
    if (this.direct?.epoch !== this.epoch) {
      const direct = new Set<string>();
      references(map, direct);
      this.direct = { epoch: this.epoch, ids: direct };
    }
    const direct = this.direct.ids;
    for (const id of ids) if (direct.has(id)) return `#${id}`;
    // nested: a definition outside the map that the map references, naming one of these (not cached: the definitions
    // themselves are what just changed)
    const queue = [...direct];
    const seen = new Set<string>();
    while (queue.length) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (ids.has(id)) return `#${id}`;
      const target = document.getElementById(id);
      if (target && !map.contains(target)) references(target, queue);
    }
    return null;
  }
}
