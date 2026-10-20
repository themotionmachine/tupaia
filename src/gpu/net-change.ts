// D13 refinement (W3 LIFE3): did an editor session change the model DOM, net? The revision rule (renderer.ts
// suspensionEnded) holds the SVG after any DOM revision during a suspension, so an editor that only opens and closes
// (burg: icon rasters swapped for vectors and back; marker: its element raised and re-classed) held the SVG for
// seconds although the GPU frame from before it still shows the same map. This tracker replays the session's
// mutation records against the live tree and answers whether the svg#map subtree it observed ended where it began:
// - attribute values: the first oldValue seen for (element, name) is the original;
// - child lists: a parent's original list is rebuilt the first time it is touched, by undoing that batch's records for
//   it in reverse (the observer delivers a batch after all of its mutations, so the live list is the batch's end);
// - text: the first oldValue seen (the observer must ask for characterDataOldValue).
// At the end each touched unit is compared with what is live now, nodes by deep structural equality, so a subtree
// replaced by an identical copy (innerHTML round trips) counts as unchanged.
//
// It fails towards "changed": anything it cannot account for makes the verdict "unsure" (the caller keeps the revision
// rule): a node re-attached in a later batch than it was removed (it may have changed while unobserved), a record the
// undo cannot place, too many units, or a cause outside the records (fail()). What it does not count, because the
// renderer itself or the camera owns it, or the prepared frame provably does not draw it differently (markers.ts
// neutral): the #viewbox transform, the root filter (forwarded live to the canvas), viewport-culled class tokens,
// dense-zoom overlays and anything inside them, and the href of a burg-icon raster whose vector markup is unchanged
// (burg-canvas.ts re-rasterizes the same markup asynchronously after an editor closes).

export type NetVerdict = "unchanged" | "changed" | "unsure";

export interface NetRecord {
  type: string;
  target: Node;
  attributeName?: string | null;
  oldValue?: string | null;
  addedNodes: ArrayLike<Node>;
  removedNodes: ArrayLike<Node>;
  previousSibling?: Node | null;
  nextSibling?: Node | null;
}

// Beyond these the session was clearly an edit (or too large to compare cheaply): unsure, so the revision rule holds.
export const NET_UNIT_LIMIT = 20_000;
export const NET_COMPARE_LIMIT = 200_000;

const NEUTRAL_CLASSES = new Set(["viewport-culled"]);
const ROOT_FORWARDED = new Set(["filter", "data-filter"]);
const ELEMENT = 1;
const TEXT = 3;

const isElement = (node: Node): node is Element => node.nodeType === ELEMENT;
const inOverlay = (node: Node | null): boolean => {
  for (let element = node && (isElement(node) ? node : node.parentElement); element; element = element.parentElement)
    if (element.hasAttribute("data-dense-zoom")) return true;
  return false;
};
const classTokens = (value: string | null) =>
  (value ?? "")
    .split(/\s+/)
    .filter(token => token && !NEUTRAL_CLASSES.has(token))
    .sort()
    .join(" ");

export class NetChange {
  private active = false;
  private reason = ""; // non-empty: unsure
  private batch = 0;
  private attrs = new Map<Element, Map<string, string | null>>();
  private texts = new Map<Node, string | null>();
  private lists = new Map<Node, Node[]>();
  private removedIn = new Map<Node, number>(); // batch a node was last removed in
  private addedIn = new Map<Node, number>(); // batch a node was last added in
  private born = new Set<Node>(); // nodes whose first record was an insertion: not in the tree at begin()
  private units = 0;
  private compared = 0;
  last: { verdict: NetVerdict; detail: string } | null = null;

  get tracking(): boolean {
    return this.active;
  }

  begin(): void {
    this.reset();
    this.active = true;
  }

  // A cause the records cannot show (a definition outside svg#map changed, records processed before the start).
  fail(reason: string): void {
    if (this.active && !this.reason) this.reason = reason;
  }

  note(records: ArrayLike<NetRecord>): void {
    if (!this.active || this.reason || !records.length) return;
    const batch = ++this.batch;
    const fresh = new Map<Node, NetRecord[]>(); // parents first touched in this batch, with their records in order
    for (const record of Array.from(records)) {
      if (record.type === "attributes") {
        const target = record.target as Element;
        let map = this.attrs.get(target);
        if (!map) {
          map = new Map();
          this.attrs.set(target, map);
        }
        const name = record.attributeName ?? "";
        if (!map.has(name)) {
          map.set(name, record.oldValue ?? null);
          this.units++;
        }
      } else if (record.type === "characterData") {
        if (!this.texts.has(record.target)) {
          this.texts.set(record.target, record.oldValue ?? null);
          this.units++;
        }
      } else if (record.type === "childList") {
        for (const node of Array.from(record.removedNodes)) this.removedIn.set(node, batch);
        for (const node of Array.from(record.addedNodes)) {
          if (!this.removedIn.has(node) && !this.addedIn.has(node)) this.born.add(node);
          this.addedIn.set(node, batch);
        }
        if (this.lists.has(record.target)) continue;
        const list = fresh.get(record.target);
        if (list) list.push(record);
        else fresh.set(record.target, [record]);
      }
    }
    for (const [parent, own] of fresh) {
      const original = undo([...parent.childNodes], own);
      if (!original) {
        this.fail("child list could not be rebuilt");
        return;
      }
      this.lists.set(parent, original);
      this.units++;
    }
    if (this.units > NET_UNIT_LIMIT) this.fail(`over ${NET_UNIT_LIMIT} changed units`);
  }

  // Ends the session: whether the subtree of `root` is, net, what it was at begin().
  end(root: Element): NetVerdict {
    if (!this.active) return "unsure";
    const verdict = this.reason ? "unsure" : this.judge(root);
    this.last = { verdict, detail: this.reason };
    this.reset();
    return verdict;
  }

  private reset(): void {
    this.active = false;
    this.reason = "";
    this.batch = this.units = this.compared = 0;
    this.attrs.clear();
    this.texts.clear();
    this.lists.clear();
    this.removedIn.clear();
    this.addedIn.clear();
    this.born.clear();
  }

  private judge(root: Element): NetVerdict {
    // a unit inside content inserted during the session is compared as part of that content, by its parent's list
    const inserted = (node: Node) => {
      for (let at: Node | null = node; at && at !== root; at = at.parentNode) if (this.born.has(at)) return true;
      return false;
    };
    const live = (node: Node) => node.isConnected && root.contains(node) && !inOverlay(node) && !inserted(node);
    const changed = (detail: string): NetVerdict => {
      this.reason = detail;
      return "changed";
    };
    try {
      for (const [parent, original] of this.lists) {
        if (!live(parent)) continue; // its own parent's list covers it
        if (!this.sameLists(original, [...parent.childNodes])) return changed(`children of ${describe(parent)}`);
      }
      for (const [element, names] of this.attrs) {
        if (!live(element)) continue;
        for (const [name, before] of names)
          if (!this.sameAttribute(element, name, before, element, element.getAttribute(name), root))
            return changed(`@${name} of ${describe(element)}`);
      }
      for (const [text, before] of this.texts)
        if (live(text) && before !== (text as CharacterData).data) return changed(`text in ${describe(text)}`);
    } catch (error) {
      if (error instanceof Unsure) {
        this.reason = error.message;
        return "unsure";
      }
      throw error;
    }
    return "unchanged";
  }

  private sameLists(before: Node[], now: Node[]): boolean {
    const [a, b] = [before.filter(kept), now.filter(kept)];
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!this.sameNode(a[i], b[i])) return false;
    return true;
  }

  // `before` as it was at begin() (its recorded originals over its live state), `now` as it is live.
  private sameNode(before: Node, now: Node): boolean {
    if (++this.compared > NET_COMPARE_LIMIT) throw new Unsure(`over ${NET_COMPARE_LIMIT} compared nodes`);
    if (before === now) {
      // same identity: its own units are compared on their own, unless it left the tree and came back in a later
      // batch (changes made to it while detached were never observed)
      const removed = this.removedIn.get(now);
      if (removed !== undefined && (this.addedIn.get(now) ?? removed) !== removed)
        throw new Unsure(`${describe(now)} re-attached after a later batch`);
      return true;
    }
    if (before.nodeType !== now.nodeType) return false;
    if (before.nodeType === TEXT) {
      const original = this.texts.has(before) ? this.texts.get(before) : (before as CharacterData).data;
      return original === (now as CharacterData).data;
    }
    if (!isElement(before) || !isElement(now)) return before.isEqualNode(now);
    if (before.namespaceURI !== now.namespaceURI || before.localName !== now.localName) return false;
    const recorded = this.attrs.get(before);
    const names = new Set<string>([
      ...before.getAttributeNames(),
      ...now.getAttributeNames(),
      ...(recorded?.keys() ?? [])
    ]);
    for (const name of names) {
      const value = recorded?.has(name) ? recorded.get(name)! : before.getAttribute(name);
      if (!this.sameAttribute(before, name, value, now, now.getAttribute(name), null)) return false;
    }
    const children = this.lists.get(before) ?? [...before.childNodes];
    return this.sameLists(children, [...now.childNodes]);
  }

  private sameAttribute(
    beforeElement: Element,
    name: string,
    before: string | null,
    now: Element,
    value: string | null,
    root: Element | null
  ): boolean {
    if (before === value) return true;
    if (name === "transform" && now.id === "viewbox") return true; // the camera (GPU-owned while it runs)
    if (root && now === root && ROOT_FORWARDED.has(name)) return true; // forwarded live as the canvas CSS filter
    if (name === "class") return classTokens(before) === classTokens(value);
    // a burg-icon raster is a cache of its vector markup: the same markup is the same pixels
    if (name === "href" && now.localName === "image") {
      const markup = now.getAttribute("data-burg-vectors");
      const recorded = this.attrs.get(beforeElement);
      const original = recorded?.has("data-burg-vectors")
        ? recorded.get("data-burg-vectors")
        : beforeElement.getAttribute("data-burg-vectors");
      return markup !== null && markup === original;
    }
    return false;
  }
}

class Unsure extends Error {}

// Dense-zoom overlays come and go with the zoom (the scene skips them); everything else is compared.
const kept = (node: Node) => !(isElement(node) && node.hasAttribute("data-dense-zoom"));

const describe = (node: Node): string => {
  const element = isElement(node) ? node : node.parentElement;
  if (!element) return "?";
  return `<${element.localName}${element.id ? `#${element.id}` : ""}>`;
};

// The parent's child list before `records` (its own childList records of one batch, in order), from the list after
// them. null when a record cannot be placed (the records and the list disagree). Linear in the list plus the records: the
// list is held as a doubly linked list keyed by node, so placing a record never scans (a redraw that appends or removes
// tens of thousands of children under one parent, the heightmap editor's #heights, used to cost Array.indexOf per node).
interface Link {
  node: Node;
  prev: Link | null;
  next: Link | null;
}

export function undo(list: Node[], records: readonly NetRecord[]): Node[] | null {
  const links = new Map<Node, Link>();
  let head: Link | null = null;
  let tail: Link | null = null;
  const append = (node: Node) => {
    const link: Link = { node, prev: tail, next: null };
    if (tail) tail.next = link;
    else head = link;
    tail = link;
    links.set(node, link);
  };
  for (const node of list) append(node);
  for (let r = records.length - 1; r >= 0; r--) {
    const record = records[r];
    for (const node of Array.from(record.addedNodes)) {
      const link = links.get(node);
      if (!link) return null;
      if (link.prev) link.prev.next = link.next;
      else head = link.next;
      if (link.next) link.next.prev = link.prev;
      else tail = link.prev;
      links.delete(node);
    }
    const removed = Array.from(record.removedNodes);
    if (!removed.length) continue;
    // the links the removed nodes go between
    let before: Link | null; // they go after this one (null: at the start)
    if (record.previousSibling) {
      before = links.get(record.previousSibling) ?? null;
      if (!before) return null;
    } else if (record.nextSibling) {
      const next = links.get(record.nextSibling);
      if (!next) return null;
      before = next.prev;
    } else if (!head) before = null;
    else return null;
    for (const node of removed) {
      const link: Link = { node, prev: before, next: before ? before.next : head };
      if (link.prev) link.prev.next = link;
      else head = link;
      if (link.next) link.next.prev = link;
      else tail = link;
      links.set(node, link);
      before = link;
    }
  }
  const out: Node[] = [];
  for (let link = head as Link | null; link; link = link.next) out.push(link.node);
  return out;
}
