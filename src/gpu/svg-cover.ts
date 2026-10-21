// ---- PANEND (W4b): the SVG cover. Chrome re-layerizes the whole document for any DOM write while the model SVG
// paints under the canvas (PaintArtifactCompositor::Update, ~155 ms on the parity world with every layer on at k 2):
// the exact camera update at the end of every gesture, the culling and #coordinates writes at rest, a trade-caravan
// change. Under an opaque GPU frame the model's paint is never seen, so the cover stops it: #viewbox becomes
// visibility:hidden (no paint chunks, Layerize ~0) with SVG2 pointer-events:painted, which keeps native hit testing
// independent of visibility (painted = visiblePainted for every element whose canonical visibility is visible).
// Text stays visible: its computed style is read by the glyph layout (text.ts, glyph-fine.ts), and find-in-page and
// accessibility keep working; labels are a few paint chunks.
//
// Only a model whose canonical visibility and hit semantics the cover cannot change qualifies (eligible below, fail
// closed): no explicit hidden visibility the inherited `painted` would make hittable, no explicit visible* pointer-events
// (hidden + visiblePainted would no longer hit), no links, focus targets, SMIL or running animations, and no author rule
// that would do the same. The selectors start with `svg#map`, so the export and compat clones (svg#fantasyMap) never
// match them and compat-reuse's MAP_SCOPED style key ignores the sheet; the rules are inserted and deleted rather than
// the sheet disabled (the reuse key includes the disabled flag).
const COVER_RULES = [
  "svg#map > #viewbox {visibility:hidden!important;pointer-events:painted!important}",
  "svg#map > #viewbox text {visibility:visible}"
];

// pointer-events values whose hit area needs visibility:visible (SVG2 §15.6): an element that sets one of them stops
// hitting under the cover
const VISIBLE_POINTER = new Set(["auto", "visiblepainted", "visiblefill", "visiblestroke", "visible"]);
const SPECIAL = "a,[tabindex],[contenteditable],foreignObject,script,animate,animateMotion,animateTransform,set";
const EXPLICIT = '[visibility],[pointer-events],[style*="visibility" i],[style*="pointer-events" i]';
const dynamicState = /:(?:hover|active|focus-visible|focus-within|focus|visited|link|target)\b/g;

const covers = new Set<SvgCover>();

// A read that must see the canonical computed visibility of the model (scene.ts buildScene): the active covers are
// lifted for its synchronous duration (two style recalcs, no frame in between, so no layerize).
export function withCanonicalVisibility<T>(read: () => T): T {
  const active = [...covers].filter(cover => cover.active);
  for (const cover of active) cover.set(false);
  try {
    return read();
  } finally {
    for (const cover of active) cover.set(true);
  }
}

// Whether an active cover alone explains a hidden computed visibility of `element`: inside a covered #viewbox and not
// hidden by its own declaration (the only explicit hidden the cover admits). Its canonical visibility is then visible.
export function coverHides(element: Element): boolean {
  for (const cover of covers) {
    if (!cover.active) continue;
    const viewbox = cover.viewbox;
    if (!viewbox?.contains(element)) continue;
    const own = (element as SVGElement).style?.visibility || element.getAttribute("visibility") || "";
    return !/^(hidden|collapse)$/i.test(own.trim());
  }
  return false;
}

export interface CoverStatus {
  active: boolean;
  issue: string;
  checks: number; // full checks (eligible)
  lastCheckMs: number | null;
  localChecks: number; // record-local checks while covered (checkLocal)
  lastLocalMs: number | null;
  applied: number;
  revealed: number;
}

export class SvgCover {
  private style: HTMLStyleElement;
  private on = false;
  viewbox: Element | null = null;
  // author rules that could matter (visibility other than visible, a visible* pointer-events, an animation), with their
  // selector stripped of interaction state; null = rescan the sheets
  private rules: { selector: string; text: string }[] | null = null;
  // every <use> reference the last full check followed: a local check meeting a new one asks for a full check
  private hrefs = new Set<string>();
  // references that resolved to nothing at the last full check (a COA the app inserts into #coas later): one that
  // appears is checked like an added subtree (resolved)
  private unresolved = new Set<string>();
  issue = "unchecked";
  private stats = {
    checks: 0,
    lastCheckMs: null as number | null,
    localChecks: 0,
    lastLocalMs: null as number | null,
    applied: 0,
    revealed: 0
  };

  constructor() {
    this.style = document.createElement("style");
    this.style.dataset.gpuRenderer = "svg-cover";
    document.head.append(this.style);
    covers.add(this);
  }

  get active(): boolean {
    return this.on;
  }

  status(): CoverStatus {
    return { active: this.on, issue: this.issue, ...this.stats };
  }

  set(on: boolean): void {
    if (on === this.on) return;
    const sheet = this.style.sheet;
    if (!sheet) {
      this.on = false;
      return;
    }
    while (sheet.cssRules.length) sheet.deleteRule(0);
    if (on) for (const [i, rule] of COVER_RULES.entries()) sheet.insertRule(rule, i);
    this.on = on;
  }

  // Counted applications and reveals (telemetry), apart from the synchronous lifts of withCanonicalVisibility.
  apply(on: boolean): void {
    if (on === this.on) return;
    if (on) this.stats.applied++;
    else this.stats.revealed++;
    this.set(on);
  }

  // Stylesheets changed (a <style> or <link> added, removed or edited): the next check rescans them.
  sheetsChanged(): void {
    this.rules = null;
  }

  // Whether covering `root` leaves every canonical visibility and hit result as it is (`issue` says why not).
  eligible(root: SVGSVGElement): boolean {
    const started = performance.now();
    this.stats.checks++;
    try {
      this.issue = this.check(root);
    } catch (error) {
      // unsupported selectors or CSSOM failures leave the model painting
      this.issue = `check failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.stats.lastCheckMs = performance.now() - started;
    return this.issue === "";
  }

  // Whether the last full check followed a reference to `id` (a node taking that id may now be what a <use> draws).
  follows(id: string): boolean {
    return !!id && this.hrefs.has(`#${id}`);
  }

  // Definitions that appeared since the last full check under a reference it found unresolved: each is then a target
  // for checkLocal (its own content inherits the cover through the <use>).
  resolved(): Element[] {
    const found: Element[] = [];
    for (const id of this.unresolved) {
      const target = document.getElementById(id);
      if (!target) continue;
      this.unresolved.delete(id);
      found.push(target);
    }
    return found;
  }

  // While covered, a recheck of only what mutation records touched (`targets`: added subtrees, elements whose relevant
  // attributes changed), in the observer callback, before any later event reaches the model. "" = still eligible,
  // "full" = a reference the last full check did not follow (eligible() must decide), else why the cover must go.
  checkLocal(targets: Iterable<Element>): string {
    const started = performance.now();
    this.stats.localChecks++;
    let issue: string;
    try {
      issue = this.localIssue(targets);
    } catch (error) {
      issue = `check failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (issue && issue !== "full") this.issue = issue;
    this.stats.lastLocalMs = performance.now() - started;
    return issue;
  }

  private localIssue(targets: Iterable<Element>): string {
    const focused = document.activeElement;
    if (focused && this.viewbox?.contains(focused)) return "focus inside the model";
    const rules = this.authorRules();
    for (const element of targets) {
      if (!element.isConnected) continue;
      if (element.matches(SPECIAL) || element.querySelector(SPECIAL)) return "interactive or animated model content";
      for (const explicit of subtree(element, EXPLICIT)) {
        const issue = explicitIssue(explicit);
        if (issue) return issue;
      }
      for (const use of subtree(element, "use")) {
        const href = use.getAttribute("href") ?? use.getAttribute("xlink:href") ?? "";
        if (href && !this.hrefs.has(href)) return "full";
      }
      for (const { selector, text } of rules)
        if (element.matches(selector) || element.querySelector(selector)) return `author CSS: ${text}`;
    }
    return "";
  }

  private check(root: SVGSVGElement): string {
    const viewbox = root.querySelector(":scope > #viewbox");
    this.viewbox = viewbox;
    if (root.id !== "map" || !viewbox) return "missing svg#map > #viewbox";
    if (!["hidden", "clip"].includes(getComputedStyle(root).overflow)) return "model ink can escape the canvas";
    if (viewbox.matches(SPECIAL) || viewbox.querySelector(SPECIAL)) return "interactive or animated model content";
    const focused = document.activeElement;
    if (focused && viewbox.contains(focused)) return "focus inside the model";
    if ((viewbox.getAnimations?.({ subtree: true }) ?? []).some(animation => animation.playState !== "finished"))
      return "running animation in the model";
    // the model and every definition outside it a <use> instantiates (its shadow tree inherits the cover)
    const scopes: Element[] = [viewbox];
    const seen = new Set<string>();
    this.hrefs = seen;
    this.unresolved = new Set();
    for (let i = 0; i < scopes.length; i++) {
      for (const use of scopes[i].querySelectorAll("use")) {
        const href = use.getAttribute("href") ?? use.getAttribute("xlink:href") ?? "";
        if (!href || seen.has(href)) continue;
        seen.add(href);
        if (!href.startsWith("#")) continue; // external references draw nothing in this app; nothing to inherit
        const target = document.getElementById(href.slice(1));
        if (!target) this.unresolved.add(href.slice(1)); // draws and hits nothing until it appears
        if (!target || scopes.some(scope => scope.contains(target))) continue;
        if (target.matches(SPECIAL) || target.querySelector(SPECIAL)) return `interactive definition ${href}`;
        scopes.push(target);
      }
    }
    for (const scope of scopes) {
      for (const element of subtree(scope, EXPLICIT)) {
        const issue = explicitIssue(element);
        if (issue) return issue;
      }
    }
    const relevant = (element: Element) => scopes.some(scope => scope.contains(element));
    for (const { selector, text } of this.authorRules()) {
      for (const element of document.querySelectorAll(selector)) if (relevant(element)) return `author CSS: ${text}`;
    }
    return "";
  }

  private authorRules(): { selector: string; text: string }[] {
    if (this.rules) return this.rules;
    const rules: { selector: string; text: string }[] = [];
    const inspect = (list: CSSRuleList) => {
      for (const rule of list) {
        // duck-typed rule kinds (CSSImportRule, CSSStyleRule): what the CSSOM exposes, whatever the realm
        if ("styleSheet" in rule && "href" in rule) {
          const imported = (rule as CSSImportRule).styleSheet;
          if (imported) inspect(imported.cssRules);
        } else if ("selectorText" in rule && "style" in rule) {
          const style = rule as CSSStyleRule;
          if (style.cssRules?.length) inspect(style.cssRules); // nested rules
          const { visibility, pointerEvents, animationName } = style.style;
          const hides = !!visibility && visibility !== "visible";
          const needsVisible = !!pointerEvents && VISIBLE_POINTER.has(pointerEvents.toLowerCase());
          const animates = !!animationName && animationName !== "none";
          if (!hides && !needsVisible && !animates) continue;
          const selector = style.selectorText.replace(dynamicState, "").trim() || "*";
          rules.push({ selector, text: style.selectorText });
        } else if ("cssRules" in rule) inspect((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      if (sheet === this.style.sheet || sheet.disabled) continue;
      inspect(sheet.cssRules); // a cross-origin sheet throws: eligible() fails closed
    }
    this.rules = rules;
    return rules;
  }

  dispose(): void {
    this.set(false);
    covers.delete(this);
    this.style.remove();
  }
}

// `root` itself when it matches `selector`, then its matching descendants
function subtree(root: Element, selector: string): Element[] {
  const found = [...root.querySelectorAll(selector)];
  return root.matches(selector) ? [root, ...found] : found;
}

// Why one element that declares visibility or pointer-events itself (attribute or inline style) blocks the cover.
// An explicit hidden is admitted on a childless element that is click-through on its own (the dense-zoom images
// hide their source <image> this way): the inherited `painted` cannot reach it.
function explicitIssue(element: Element): string {
  const style = (element as SVGElement).style;
  const name = `${element.tagName}${element.id ? `#${element.id}` : ""}`;
  const pointer = (style?.pointerEvents || element.getAttribute("pointer-events") || "").trim().toLowerCase();
  if (VISIBLE_POINTER.has(pointer)) return `explicit pointer-events ${pointer} on ${name}`;
  const visibility = (style?.visibility || element.getAttribute("visibility") || "").trim().toLowerCase();
  if (visibility === "hidden" || visibility === "collapse") {
    if (element.firstElementChild || getComputedStyle(element).pointerEvents !== "none")
      return `explicit visibility ${visibility} on ${name}`;
  }
  return "";
}
