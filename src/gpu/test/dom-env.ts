// DOM test seam for the GPU scene classifier (buildScene). Use from a test file that starts with
// `// @vitest-environment happy-dom`; the global vitest environment stays "node".
//
// happy-dom has no SVG presentation-attribute cascade, so `getComputedStyle` is replaced by a small stub that is
// just sufficient for scene.ts routing: initial values, inheritance of the inherited SVG properties, presentation
// attributes < injected stylesheet rules (document order, no specificity) < inline `style`. Colors are not
// normalized (real browsers return rgb()); use hex or rgb() in fixtures. happy-dom has no canvas 2D context, so named
// colors (parseColor's canvas fallback) classify as compat "fill <name>" here; in a browser they would be native.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import { buildScene, type Draw, type Scene, type SceneOptions } from "../scene";

export const SVG_NS = "http://www.w3.org/2000/svg";

export interface StyleRule {
  selector: string;
  declarations: Record<string, string>;
}

const INHERITED = new Set([
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-opacity",
  "stroke-width",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linejoin",
  "stroke-linecap",
  "visibility",
  "pointer-events",
  "text-shadow"
]);
const INITIAL: Record<string, string> = {
  display: "inline",
  visibility: "visible",
  opacity: "1",
  fill: "rgb(0, 0, 0)",
  "fill-opacity": "1",
  "fill-rule": "nonzero",
  stroke: "none",
  "stroke-opacity": "1",
  "stroke-width": "1px",
  "stroke-dasharray": "none",
  "stroke-dashoffset": "0px",
  "stroke-linejoin": "miter",
  "stroke-linecap": "butt",
  filter: "none",
  "clip-path": "none",
  mask: "none",
  "vector-effect": "none",
  "pointer-events": "auto",
  "text-shadow": "none"
};
const camel = (name: string) => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function inlineStyle(element: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (element.getAttribute("style") || "").split(";")) {
    const i = part.indexOf(":");
    if (i > 0)
      out[part.slice(0, i).trim()] = part
        .slice(i + 1)
        .replace(/!important/i, "")
        .trim();
  }
  return out;
}

function resolve(element: Element | null, name: string, rules: StyleRule[]): string {
  if (!element || element.nodeType !== 1) return INITIAL[name] ?? "";
  let value: string | undefined = element.getAttribute(name) ?? undefined;
  for (const rule of rules) {
    let hit = false;
    try {
      hit = name in rule.declarations && element.matches(rule.selector);
    } catch {
      hit = false;
    }
    if (hit) value = rule.declarations[name];
  }
  value = inlineStyle(element)[name] ?? value;
  if (value === undefined || value === "inherit" || (value === "" && INHERITED.has(name)))
    return INHERITED.has(name) || value === "inherit"
      ? resolve(element.parentElement, name, rules)
      : (INITIAL[name] ?? "");
  return value;
}

export function computedStyleStub(rules: StyleRule[]) {
  return (element: Element) => {
    const style: Record<string, unknown> = {
      getPropertyValue: (name: string) => resolve(element, name, rules)
    };
    for (const name of Object.keys(INITIAL)) style[camel(name)] = resolve(element, name, rules);
    style.pointerEvents = resolve(element, "pointer-events", rules);
    style.overflow = resolve(element, "overflow", rules) || "visible";
    return style as unknown as CSSStyleDeclaration;
  };
}

// Layer order and initially-hidden groups mirror public/main.js (the default layer stack).
const DEFAULT_ORDER: [string, string[]?][] = [
  ["ocean", ["oceanLayers", "oceanPattern"]],
  ["landmass"],
  ["texture"],
  ["terrs", ["oceanHeights", "landHeights"]],
  ["lakes", ["freshwater", "salt", "sinkhole", "frozen", "lava", "dry"]],
  ["biomes"],
  ["cells"],
  ["gridOverlay"],
  ["coordinates"],
  ["compass"],
  ["rivers"],
  ["terrain"],
  ["relig"],
  ["cults"],
  ["regions", ["statesBody", "statesHalo"]],
  ["provs"],
  ["zones"],
  ["borders", ["stateBorders", "provinceBorders"]],
  ["routes", ["roads", "trails", "searoutes"]],
  ["temperature"],
  ["coastline", ["sea_island", "lake_island"]],
  ["ice"],
  ["goods"],
  ["markets"],
  ["tradeAnimation"],
  ["prec"],
  ["population"],
  ["emblems"],
  ["icons", ["burgIcons", "anchors"]],
  ["labels", ["states", "addedLabels", "burgLabels"]],
  ["armies"],
  ["markers"],
  ["fogging-cont", ["fogging"]],
  ["ruler"],
  ["debug"]
];
const HIDDEN_AT_START = new Set(["compass", "goods", "prec", "emblems", "fogging", "ruler"]);

export function defaultLayerMarkup(): string {
  return DEFAULT_ORDER.map(([id, kids = []]) => {
    const inner = kids
      .map(kid => `<g id="${kid}"${HIDDEN_AT_START.has(kid) ? ' style="display:none"' : ""}></g>`)
      .join("");
    const attrs = `${id === "fogging-cont" ? ' mask="url(#fog)"' : ""}${HIDDEN_AT_START.has(id) ? ' style="display:none"' : ""}`;
    return `<g id="${id}"${attrs}>${inner}</g>`;
  }).join("");
}

// The #deftemp content the classifier depends on (src/index.html): land/water/fog masks, the oceanic pattern and
// the feature path the land/water masks `<use>`. #land and #water carry one feature so they classify as stencil masks.
export function defaultDefsMarkup(): string {
  return `<path id="featurePaths-f1" d="M0,0h100v100h-100z"/>
<g id="masks"><mask id="land"><use href="#featurePaths-f1" fill="white"/></mask><mask id="water"><rect x="0" y="0" width="100%" height="100%" fill="white"/><use href="#featurePaths-f1" fill="black"/></mask><mask id="fog" style="stroke-width: 10; stroke: black; stroke-linejoin: round; stroke-opacity: 0.1"><rect x="0" y="0" width="100%" height="100%" fill="white" stroke="none"/></mask></g>
<pattern id="oceanic" width="100" height="100" patternUnits="userSpaceOnUse"><image id="oceanicPattern" href="./images/pattern1.png" opacity="0.2"/></pattern>
<mask id="vignette-mask"><rect x="0" y="0" width="100%" height="100%" fill="white"/><rect id="vignette-rect" fill="black"/></mask>
<symbol id="icon-town"><path d="M0,0h1v1z"/></symbol><symbol id="icon-anchor"><path d="M0,0h1v1z"/></symbol>`;
}

/**
 * Apply a shipped style preset (public/styles/<name>.json: `{"#id": {attr: value|null}}`) the way style-presets.js
 * does, as attributes on the matching layer elements. Missing ids are skipped; null removes the attribute.
 */
export function applyStylePreset(env: Pick<MapEnv, "svg">, name = "default"): void {
  const file = join(import.meta.dirname, "../../../public/styles", `${name}.json`);
  const preset = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, string | number | null>>;
  for (const [selector, attrs] of Object.entries(preset)) {
    const el = env.svg.querySelector(selector);
    if (!el) continue;
    for (const [attr, value] of Object.entries(attrs))
      if (value === null) el.removeAttribute(attr);
      else el.setAttribute(attr, String(value));
  }
}

export interface MapEnvOptions {
  /** Raw #viewbox innerHTML. Default: the empty default layer stack (`defaultLayerMarkup`). */
  viewbox?: string;
  /** Raw innerHTML of #deftemp. Default: `defaultDefsMarkup()` (masks, oceanic pattern, icon symbols). */
  defs?: string;
  /** Stylesheet stub rules, applied in order (no specificity). */
  rules?: StyleRule[];
}

export interface MapEnv {
  svg: SVGSVGElement;
  viewbox: SVGGElement;
  defs: SVGDefsElement;
  /** Element by id inside the map. */
  layer(id: string): Element;
  /** Replace a layer's children with markup. */
  fill(id: string, markup: string): Element;
  /** Set attributes (or inline style properties via `style`) on a layer. */
  set(id: string, attributes: Record<string, string>): Element;
  /** Add stylesheet stub rules at runtime. */
  rule(selector: string, declarations: Record<string, string>): void;
  build(options?: SceneOptions): Scene;
  dispose(): void;
}

// happy-dom has no canvas 2D context; parseColor resolves named colors through one (`fillStyle` round trip). This
// stub knows the few names the shipped DOM uses (mask white/black, and a handful of CSS keywords).
const NAMED: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  gray: "#808080",
  grey: "#808080"
};
function installColorCanvas(): void {
  let current = "#000000";
  const context = {
    get fillStyle() {
      return current;
    },
    set fillStyle(value: string) {
      const named = NAMED[String(value).trim().toLowerCase()];
      if (named) current = named;
      else if (/^#[\da-f]{6}$/i.test(String(value).trim())) current = String(value).trim().toLowerCase();
    }
  };
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string, ...rest: unknown[]) =>
    tag === "canvas"
      ? ({ getContext: () => context } as unknown as HTMLCanvasElement)
      : (createElement as (...a: unknown[]) => unknown)(tag, ...rest)) as typeof document.createElement);
}

export function createMapEnv(options: MapEnvOptions = {}): MapEnv {
  const rules: StyleRule[] = [...(options.rules ?? [])];
  installColorCanvas();
  vi.stubGlobal("getComputedStyle", (element: Element) => computedStyleStub(rules)(element));
  document.body.innerHTML = `<svg id="map" xmlns="${SVG_NS}" width="1000" height="800"><defs id="deftemp">${options.defs ?? defaultDefsMarkup()}</defs><g id="viewbox">${options.viewbox ?? defaultLayerMarkup()}</g></svg>`;
  const svg = document.getElementById("map") as unknown as SVGSVGElement;
  const viewbox = document.getElementById("viewbox") as unknown as SVGGElement;
  const defs = document.getElementById("deftemp") as unknown as SVGDefsElement;
  const find = (id: string) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`no #${id} in test map`);
    return el as unknown as Element;
  };
  return {
    svg,
    viewbox,
    defs,
    layer: find,
    fill(id, markup) {
      const el = find(id);
      el.innerHTML = markup;
      return el;
    },
    set(id, attributes) {
      const el = find(id);
      for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
      return el;
    },
    rule(selector, declarations) {
      rules.push({ selector, declarations });
    },
    build: options => buildScene(viewbox, undefined, options),
    dispose: () => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      document.body.innerHTML = "";
    }
  };
}

/**
 * Compact routing label for a draw. Groups spell out `mask`/opacity and their children recursively:
 * `shape`, `cells`, `relief`, `label`, `compat(<reason>)`, `group{mask:2,op:0.4}[shape,shape]`, `trade[...]`.
 */
export function describe(draw: Draw): string {
  switch (draw.kind) {
    case "compat":
      return `compat(${draw.reason})`;
    case "group":
      return `group{${draw.mask ? `mask:${draw.mask.length}` : "mask:none"},op:${draw.opacity}}[${draw.children.map(describe).join(",")}]`;
    case "trade":
      return `trade[${draw.children.map(describe).join(",")}]`;
    case "cachedPaths":
      return `cachedPaths[${draw.paths.map(describe).join(",")}]`;
    default:
      return draw.kind;
  }
}

/** Top-level draws of one layer (the top-level `#viewbox` child id), in draw order, as `describe` strings. */
export function layerRouting(scene: Scene, layer: string): string[] {
  return scene.draws.filter(d => d.layer === layer).map(describe);
}

/** One `layer: description` line per top-level draw, in draw order (includes the always-present trade layer). */
export function routing(scene: Scene): string[] {
  return scene.draws.map(d => `${d.layer}: ${describe(d)}`);
}

/** Flatten nested group/trade/cachedPaths draws depth-first, parents before children. */
export function flatten(draws: Draw[]): Draw[] {
  return draws.flatMap(d => [
    d,
    ...("children" in d ? flatten(d.children) : []),
    ...(d.kind === "cachedPaths" ? flatten(d.paths) : []),
    ...(d.kind === "group" && d.mask ? flatten(d.mask) : [])
  ]);
}

/** Ids (or tag when id-less) of the elements a draw covers, in order. */
export function idsOf(draw: Draw): string[] {
  const els = draw.kind === "compat" ? draw.elements : [draw.element];
  return els.map(e => e.id || e.tagName);
}

/** Layer ids in top-level draw order, de-duplicated (adjacent runs of one layer collapse). */
export function layerOrder(scene: Scene): string[] {
  const out: string[] = [];
  for (const d of scene.draws) if (out[out.length - 1] !== d.layer) out.push(d.layer);
  return out;
}

/** Apply the default style preset to the current markup, then classify. */
export function buildStyled(env: MapEnv, preset = "default"): Scene {
  applyStylePreset(env, preset);
  return env.build();
}
