// P0 shadow model of the serialized #map SVG. SVG stays canonical: nothing here is used by save/load or rendering.
// The parser keeps every byte of the source (attribute quoting and spacing, raw entities, comments, CDATA,
// processing instructions, doctype) so serialize(parse(source)) === source for well-formed XML input.

export interface SceneAttribute {
  lead: string;
  name: string;
  eq: string;
  quote: '"' | "'";
  raw: string;
}
export interface SceneElement {
  kind: "element";
  name: string;
  attrs: SceneAttribute[];
  children: SceneNode[];
  selfClosing: boolean;
  tail: string;
  close: string;
  parent: SceneElement | null;
  revision: number;
}
export interface SceneText {
  kind: "text";
  raw: string;
  parent: SceneElement | null;
}
export interface SceneRaw {
  kind: "comment" | "cdata" | "pi" | "doctype";
  raw: string;
  parent: SceneElement | null;
}
export type SceneNode = SceneElement | SceneText | SceneRaw;

export interface SceneCensus {
  elements: Record<string, number>;
  attributes: Record<string, number>;
  dataAttributes: Record<string, number>;
  unknownElements: Record<string, number>;
  inlineStyles: number;
  comments: number;
  cdata: number;
  duplicateIds: string[];
  unresolvedHrefs: string[];
}

export const XLINK_NS = "http://www.w3.org/1999/xlink";
export const SVG_NS = "http://www.w3.org/2000/svg";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

// Elements the SVG renderer is expected to produce. Anything else is still kept verbatim and reported.
const KNOWN_SVG = new Set(
  (
    "svg g path rect circle ellipse line polyline polygon text tspan textPath defs use symbol pattern image marker " +
    "linearGradient radialGradient stop clipPath mask filter style title desc metadata foreignObject a switch view " +
    "feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap " +
    "feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode " +
    "feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence"
  ).split(" ")
);

export class SceneParseError extends Error {
  constructor(
    message: string,
    readonly offset: number
  ) {
    super(`${message} at offset ${offset}`);
  }
}

const NAME_END = /[\s/>=]/;
function readName(source: string, start: number): number {
  let i = start;
  while (i < source.length && !NAME_END.test(source[i])) i++;
  if (i === start) throw new SceneParseError("Expected name", start);
  return i;
}
function readSpace(source: string, start: number): number {
  let i = start;
  while (i < source.length && /\s/.test(source[i])) i++;
  return i;
}
function find(source: string, token: string, from: number, start: number): number {
  const at = source.indexOf(token, from);
  if (at < 0) throw new SceneParseError(`Unterminated ${token}`, start);
  return at + token.length;
}
function findDoctypeEnd(source: string, start: number): number {
  let depth = 0,
    quote = "";
  for (let i = start + 2; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === ">" && depth <= 0) return i + 1;
  }
  throw new SceneParseError("Unterminated doctype", start);
}

export function parseSceneNodes(source: string): SceneNode[] {
  const roots: SceneNode[] = [],
    stack: SceneElement[] = [];
  const push = (node: SceneNode) => {
    const parent = stack[stack.length - 1] || null;
    node.parent = parent;
    (parent ? parent.children : roots).push(node);
  };
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt !== i) {
      const end = lt < 0 ? source.length : lt;
      push({ kind: "text", raw: source.slice(i, end), parent: null });
      i = end;
      continue;
    }
    if (source.startsWith("<!--", i)) {
      const end = find(source, "-->", i + 4, i);
      push({ kind: "comment", raw: source.slice(i, end), parent: null });
      i = end;
    } else if (source.startsWith("<![CDATA[", i)) {
      const end = find(source, "]]>", i + 9, i);
      push({ kind: "cdata", raw: source.slice(i, end), parent: null });
      i = end;
    } else if (source.startsWith("<?", i)) {
      const end = find(source, "?>", i + 2, i);
      push({ kind: "pi", raw: source.slice(i, end), parent: null });
      i = end;
    } else if (source.startsWith("<!", i)) {
      const end = findDoctypeEnd(source, i);
      push({ kind: "doctype", raw: source.slice(i, end), parent: null });
      i = end;
    } else if (source.startsWith("</", i)) {
      const nameEnd = readName(source, i + 2),
        name = source.slice(i + 2, nameEnd),
        gt = readSpace(source, nameEnd);
      if (source[gt] !== ">") throw new SceneParseError("Malformed end tag", i);
      const open = stack.pop();
      if (!open || open.name !== name) throw new SceneParseError(`Mismatched </${name}>`, i);
      open.close = source.slice(i, gt + 1);
      i = gt + 1;
    } else {
      const nameEnd = readName(source, i + 1),
        element: SceneElement = {
          kind: "element",
          name: source.slice(i + 1, nameEnd),
          attrs: [],
          children: [],
          selfClosing: false,
          tail: "",
          close: "",
          parent: null,
          revision: 0
        };
      let j = nameEnd;
      for (;;) {
        const spaceEnd = readSpace(source, j);
        if (source.startsWith("/>", spaceEnd) || source[spaceEnd] === ">") {
          element.tail = source.slice(j, spaceEnd);
          element.selfClosing = source[spaceEnd] === "/";
          j = spaceEnd + (element.selfClosing ? 2 : 1);
          break;
        }
        if (spaceEnd === j) throw new SceneParseError("Expected whitespace before attribute", j);
        const attrEnd = readName(source, spaceEnd),
          eqEnd = readSpace(source, readSpace(source, attrEnd) + 1),
          quote = source[eqEnd];
        if (source[readSpace(source, attrEnd)] !== "=" || (quote !== '"' && quote !== "'"))
          throw new SceneParseError("Expected quoted attribute value", attrEnd);
        const valueEnd = source.indexOf(quote, eqEnd + 1);
        if (valueEnd < 0) throw new SceneParseError("Unterminated attribute value", eqEnd);
        element.attrs.push({
          lead: source.slice(j, spaceEnd),
          name: source.slice(spaceEnd, attrEnd),
          eq: source.slice(attrEnd, eqEnd),
          quote,
          raw: source.slice(eqEnd + 1, valueEnd)
        });
        j = valueEnd + 1;
      }
      push(element);
      if (!element.selfClosing) stack.push(element);
      i = j;
    }
  }
  if (stack.length) throw new SceneParseError(`Unclosed <${stack[stack.length - 1].name}>`, source.length);
  return roots;
}

export function serializeSceneNode(node: SceneNode): string {
  if (node.kind !== "element") return node.raw;
  let out = `<${node.name}`;
  for (const a of node.attrs) out += `${a.lead}${a.name}${a.eq}${a.quote}${a.raw}${a.quote}`;
  out += node.tail;
  if (node.selfClosing) return `${out}/>`;
  out += ">";
  for (const child of node.children) out += serializeSceneNode(child);
  return out + node.close;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
export function decodeXml(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] !== "#") return ENTITIES[body] ?? match;
    const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}
export function encodeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
export function encodeXmlAttribute(value: string, quote: '"' | "'" = '"'): string {
  const text = encodeXmlText(value).replace(/\t/g, "&#9;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");
  return quote === '"' ? text.replace(/"/g, "&quot;") : text.replace(/'/g, "&apos;");
}

function prefixOf(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? "" : name.slice(0, colon);
}
function localOf(name: string): string {
  return name.slice(name.indexOf(":") + 1);
}

export class SceneDocument {
  readonly nodes: SceneNode[];
  readonly root: SceneElement | null;
  revision = 0;
  readonly layerRevisions = new Map<string, number>();
  private ids = new Map<string, SceneElement>();
  private duplicates = new Set<string>();

  constructor(readonly source: string) {
    this.nodes = parseSceneNodes(source);
    this.root = (this.nodes.find(node => node.kind === "element") as SceneElement | undefined) || null;
    this.reindex();
  }

  serialize(): string {
    let out = "";
    for (const node of this.nodes) out += serializeSceneNode(node);
    return out;
  }

  *elements(from: SceneNode[] = this.nodes): Generator<SceneElement> {
    for (const node of from) {
      if (node.kind !== "element") continue;
      yield node;
      yield* this.elements(node.children);
    }
  }

  getAttribute(element: SceneElement, name: string): string | null {
    const attr = element.attrs.find(a => a.name === name);
    return attr ? decodeXml(attr.raw) : null;
  }

  getElementById(id: string): SceneElement | null {
    return this.ids.get(id) || null;
  }

  get duplicateIds(): string[] {
    return [...this.duplicates];
  }

  // Resolves a qualified element or attribute name against in-scope xmlns declarations.
  // Unprefixed attributes have no namespace (XML Namespaces §6.2); unprefixed elements take the default namespace.
  namespaceOf(element: SceneElement, qualifiedName = element.name, isAttribute = false): string | null {
    const prefix = prefixOf(qualifiedName);
    if (!prefix && isAttribute) return null;
    if (prefix === "xml") return XML_NS;
    if (prefix === "xmlns") return "http://www.w3.org/2000/xmlns/";
    const declaration = prefix ? `xmlns:${prefix}` : "xmlns";
    for (let node: SceneElement | null = element; node; node = node.parent) {
      const value = this.getAttribute(node, declaration);
      if (value !== null) return value || null;
    }
    return null;
  }

  localName(element: SceneElement): string {
    return localOf(element.name);
  }

  // href (SVG 2) wins over xlink:href (SVG 1.1), matching browser behaviour.
  href(element: SceneElement): string | null {
    const plain = this.getAttribute(element, "href");
    if (plain !== null) return plain;
    for (const attr of element.attrs)
      if (localOf(attr.name) === "href" && this.namespaceOf(element, attr.name, true) === XLINK_NS)
        return decodeXml(attr.raw);
    return null;
  }

  resolveHref(element: SceneElement): SceneElement | null {
    const href = this.href(element);
    return href?.startsWith("#") ? this.getElementById(href.slice(1)) : null;
  }

  defs(): SceneElement[] {
    return [...this.elements()].filter(element => this.localName(element) === "defs");
  }

  // Layer key used for per-layer revisions: the direct child of #viewbox containing the element, else the
  // nearest ancestor (or self) with an id, else "root".
  layerOf(element: SceneElement): string {
    let fallback = "";
    for (let node: SceneElement | null = element; node; node = node.parent) {
      const id = this.getAttribute(node, "id");
      if (node.parent && this.getAttribute(node.parent, "id") === "viewbox" && id) return id;
      if (!fallback && id) fallback = id;
    }
    return fallback || "root";
  }

  setAttribute(element: SceneElement, name: string, value: string): void {
    const existing = element.attrs.find(a => a.name === name);
    if (existing) {
      const raw = encodeXmlAttribute(value, existing.quote);
      if (raw === existing.raw) return;
      existing.raw = raw;
    } else element.attrs.push({ lead: " ", name, eq: "=", quote: '"', raw: encodeXmlAttribute(value) });
    this.touch(element, name === "id");
  }

  removeAttribute(element: SceneElement, name: string): void {
    const index = element.attrs.findIndex(a => a.name === name);
    if (index < 0) return;
    element.attrs.splice(index, 1);
    this.touch(element, name === "id");
  }

  setText(element: SceneElement, text: string): void {
    const children = this.subtreeHasId(element.children);
    element.children = text ? [{ kind: "text", raw: encodeXmlText(text), parent: element }] : [];
    if (element.selfClosing && text) {
      element.selfClosing = false;
      element.close = `</${element.name}>`;
    }
    this.touch(element, children);
  }

  textContent(element: SceneElement): string {
    let out = "";
    for (const child of element.children)
      if (child.kind === "text") out += decodeXml(child.raw);
      else if (child.kind === "cdata") out += child.raw.slice(9, -3);
      else if (child.kind === "element") out += this.textContent(child);
    return out;
  }

  census(): SceneCensus {
    const census: SceneCensus = {
      elements: {},
      attributes: {},
      dataAttributes: {},
      unknownElements: {},
      inlineStyles: 0,
      comments: 0,
      cdata: 0,
      duplicateIds: this.duplicateIds,
      unresolvedHrefs: []
    };
    const bump = (map: Record<string, number>, key: string) => {
      map[key] = (map[key] || 0) + 1;
    };
    const visit = (nodes: SceneNode[]) => {
      for (const node of nodes) {
        if (node.kind === "comment") census.comments++;
        else if (node.kind === "cdata") census.cdata++;
        if (node.kind !== "element") continue;
        bump(census.elements, node.name);
        if (this.namespaceOf(node) !== SVG_NS || !KNOWN_SVG.has(this.localName(node)))
          bump(census.unknownElements, node.name);
        for (const attr of node.attrs) {
          bump(census.attributes, attr.name);
          if (attr.name.startsWith("data-")) bump(census.dataAttributes, attr.name);
          if (attr.name === "style") census.inlineStyles++;
        }
        const href = this.href(node);
        if (href?.startsWith("#") && !this.resolveHref(node)) census.unresolvedHrefs.push(href);
        visit(node.children);
      }
    };
    visit(this.nodes);
    return census;
  }

  private subtreeHasId(nodes: SceneNode[]): boolean {
    for (const element of this.elements(nodes)) if (element.attrs.some(a => a.name === "id")) return true;
    return false;
  }

  private touch(element: SceneElement, reindex: boolean): void {
    this.revision++;
    element.revision = this.revision;
    this.layerRevisions.set(this.layerOf(element), this.revision);
    if (reindex) this.reindex();
  }

  private reindex(): void {
    this.ids.clear();
    this.duplicates.clear();
    for (const element of this.elements()) {
      const id = this.getAttribute(element, "id");
      if (id === null) continue;
      if (this.ids.has(id)) this.duplicates.add(id);
      else this.ids.set(id, element);
    }
  }
}

export interface SceneShadowReport {
  ok: boolean;
  bytes: number;
  elements: number;
  roundtripExact: boolean;
  parseMs: number;
  error?: string;
  census?: SceneCensus;
}

// Diagnostic only. Serializes the live #map exactly as the browser would and checks the shadow model reproduces it.
// Never called by save/load; does not mutate the DOM.
export function captureSceneShadow(root?: Element | null): { report: SceneShadowReport; document?: SceneDocument } {
  const target = root ?? (typeof document === "undefined" ? null : document.getElementById("map"));
  if (!target || typeof XMLSerializer === "undefined")
    return { report: { ok: false, bytes: 0, elements: 0, roundtripExact: false, parseMs: 0, error: "No #map" } };
  const source = new XMLSerializer().serializeToString(target),
    started = performance.now();
  try {
    const scene = new SceneDocument(source),
      parseMs = performance.now() - started,
      elements = [...scene.elements()].length;
    const report = { ok: true, bytes: source.length, elements, roundtripExact: scene.serialize() === source, parseMs };
    return { report: { ...report, census: scene.census() }, document: scene };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      report: { ok: false, bytes: source.length, elements: 0, roundtripExact: false, parseMs: 0, error: message }
    };
  }
}

declare global {
  interface Window {
    captureSceneShadow: typeof captureSceneShadow;
  }
}
window.captureSceneShadow = captureSceneShadow;
