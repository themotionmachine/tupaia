import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BinaryMapArchive, encodeBinaryMap } from "../io/binary-map";
import { decodeXml, parseSceneNodes, SceneDocument, SceneParseError, XLINK_NS } from "./scene-document";

const SVG = [
  '<svg id="map" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"',
  ' xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="10" height=\'20\' data-x="1">',
  "<!-- top comment with <tags> & stuff -->",
  '<defs id="deffs"><pattern id="hatch" width="4" height="4"><path d="M0 0L4 4" stroke="#000"/></pattern>',
  '<symbol id="glyph" viewBox="0 0 1 1"><circle r=".5"/></symbol>',
  "<style><![CDATA[ .a > .b { fill: red } ]]></style></defs>",
  '<g id="viewbox"><g id="labels" font-size="12" style="fill: rgb(1, 2, 3); stroke:none" data-size="22.5">',
  '<text id="label1" x="1" y="2" data-custom="a&amp;b &quot;q&quot;">Fish &amp; Chips &#x263A; &lt;b&gt;</text>',
  '<g id="burgIcons"><use xlink:href="#glyph" href="#glyph" x="3"/><use xlink:href="#missing"/></g></g>',
  '<g id="zones" inkscape:label="Zones" unknown-attr = "kept" ><foo:bar xmlns:foo="urn:foo" foo:a="1"/>',
  '<polygon points="0,0 1,1" fill="url(#hatch)"   /><blink>legacy</blink></g>',
  '<g id="ruler" data-layer-off="1"></g></g>\n\t<?app hint?></svg>'
].join("");

describe("SceneDocument lossless roundtrip", () => {
  it("serializes byte-identically, including quoting, spacing, comments, CDATA, PI and entities", () => {
    const doc = new SceneDocument(SVG);
    expect(doc.serialize()).toBe(SVG);
    expect(new SceneDocument(doc.serialize()).serialize()).toBe(SVG);
  });

  it("keeps a doctype, XML declaration and trailing whitespace outside the root", () => {
    const source = '<?xml version="1.0"?>\n<!DOCTYPE svg [<!ENTITY a "x>y">]>\n<svg/>\n';
    const doc = new SceneDocument(source);
    expect(doc.serialize()).toBe(source);
    expect(doc.nodes.map(n => n.kind)).toEqual(["pi", "text", "doctype", "text", "element", "text"]);
    expect(doc.root?.name).toBe("svg");
  });

  it("preserves unknown attributes and elements and reports them in the census", () => {
    const doc = new SceneDocument(SVG),
      census = doc.census();
    const zones = doc.getElementById("zones")!;
    expect(doc.getAttribute(zones, "unknown-attr")).toBe("kept");
    expect(zones.attrs.find(a => a.name === "unknown-attr")?.eq).toBe(" = ");
    expect(census.unknownElements).toEqual({ "foo:bar": 1, blink: 1 });
    expect(census.elements.use).toBe(2);
    expect(census.attributes["inkscape:label"]).toBe(1);
    expect(census.dataAttributes).toEqual({ "data-x": 1, "data-size": 1, "data-custom": 1, "data-layer-off": 1 });
    expect(census.comments).toBe(1);
    expect(census.cdata).toBe(1);
    expect(census.inlineStyles).toBe(1);
    expect(census.unresolvedHrefs).toEqual(["#missing"]);
  });

  it("decodes text and attribute entities without altering their stored form", () => {
    const doc = new SceneDocument(SVG),
      label = doc.getElementById("label1")!;
    expect(doc.textContent(label)).toBe("Fish & Chips ☺ <b>");
    expect(label.children[0]).toMatchObject({ kind: "text", raw: "Fish &amp; Chips &#x263A; &lt;b&gt;" });
    expect(doc.getAttribute(label, "data-custom")).toBe('a&b "q"');
    expect(doc.textContent(doc.getElementById("deffs")!)).toContain(".a > .b");
    expect(decodeXml("&unknown; &#65;")).toBe("&unknown; A");
  });

  it("resolves namespaces, defs and use references", () => {
    const doc = new SceneDocument(SVG),
      uses = [...doc.elements()].filter(e => e.name === "use");
    expect(doc.defs().map(d => doc.getAttribute(d, "id"))).toEqual(["deffs"]);
    expect(doc.resolveHref(uses[0])).toBe(doc.getElementById("glyph"));
    expect(doc.namespaceOf(uses[1], "xlink:href", true)).toBe(XLINK_NS);
    expect(doc.namespaceOf(uses[1], "x", true)).toBeNull();
    const foreign = [...doc.elements()].find(e => e.name === "foo:bar")!;
    expect(doc.namespaceOf(foreign)).toBe("urn:foo");
    expect(doc.namespaceOf(doc.getElementById("zones")!, "inkscape:label", true)).toBe(
      "http://www.inkscape.org/namespaces/inkscape"
    );
  });

  it("keeps inline style text exactly", () => {
    const doc = new SceneDocument(SVG);
    expect(doc.getAttribute(doc.getElementById("labels")!, "style")).toBe("fill: rgb(1, 2, 3); stroke:none");
  });
});

describe("SceneDocument revisions", () => {
  it("bumps document, element and layer revisions only on real changes", () => {
    const doc = new SceneDocument(SVG),
      label = doc.getElementById("label1")!;
    expect(doc.revision).toBe(0);
    expect(doc.layerOf(label)).toBe("labels");
    doc.setAttribute(label, "x", "1");
    expect(doc.revision).toBe(0);
    doc.setAttribute(label, "x", "5");
    expect(doc.revision).toBe(1);
    expect(label.revision).toBe(1);
    expect(doc.layerRevisions.get("labels")).toBe(1);
    doc.setText(label, "A<B");
    expect(doc.serialize()).toContain(">A&lt;B</text>");
    doc.setAttribute(doc.getElementById("zones")!, "data-note", 'say "hi"\n');
    expect(doc.serialize()).toContain('data-note="say &quot;hi&quot;&#10;"');
    expect(doc.layerRevisions.get("zones")).toBe(3);
    expect(doc.layerRevisions.get("labels")).toBe(2);
    doc.removeAttribute(label, "y");
    expect(doc.revision).toBe(4);
    expect(new SceneDocument(doc.serialize()).serialize()).toBe(doc.serialize());
  });

  it("keeps the id index consistent across id edits and duplicate ids", () => {
    const doc = new SceneDocument('<svg><g id="a"/><g id="a"/><g id="b"><g id="c"/></g></svg>');
    expect(doc.duplicateIds).toEqual(["a"]);
    const b = doc.getElementById("b")!;
    doc.setAttribute(b, "id", "renamed");
    expect(doc.getElementById("b")).toBeNull();
    expect(doc.getElementById("renamed")).toBe(b);
    doc.setText(b, "");
    expect(doc.getElementById("c")).toBeNull();
    expect(doc.layerOf(doc.root!)).toBe("root");
  });

  it("uses single-quote escaping for single-quoted attributes", () => {
    const doc = new SceneDocument("<svg a='x'/>");
    doc.setAttribute(doc.root!, "a", "it's");
    expect(doc.serialize()).toBe("<svg a='it&apos;s'/>");
  });
});

describe("SceneDocument rejects malformed input instead of guessing", () => {
  it.each([
    ["<svg><g></svg>", /Mismatched/],
    ["<svg>", /Unclosed/],
    ["<svg a=b/>", /quoted attribute/],
    ["<svg a/>", /quoted attribute/],
    ['<svg a="1"b="2"/>', /whitespace/],
    ["<svg><!-- x</svg>", /Unterminated/]
  ])("%s", (source, message) => {
    expect(() => parseSceneNodes(source)).toThrow(SceneParseError);
    expect(() => parseSceneNodes(source)).toThrow(message);
  });
});

describe("demo.map corpus (I1, I3, I10, I14)", () => {
  const text = readFileSync(new URL("../../tests/fixtures/demo.map", import.meta.url), "utf8");
  const sections = text.split("\r\n");

  it("preserves the legacy fixture’s 40 CRLF sections with the SVG at index 5", () => {
    expect(sections).toHaveLength(40);
    expect(sections[5].startsWith('<svg id="map"')).toBe(true);
  });

  it("shadow-parses the fixture SVG and reserializes it byte-identically", () => {
    const doc = new SceneDocument(sections[5]);
    expect(doc.serialize()).toBe(sections[5]);
    expect(doc.getElementById("viewbox")).not.toBeNull();
    const census = doc.census(),
      total = Object.values(census.elements).reduce((sum, count) => sum + count, 0);
    expect(total).toBe([...doc.elements()].length);
    expect(census.duplicateIds).toEqual(doc.duplicateIds);
  });

  it("leaves the existing text and binary IO paths untouched by shadow capture", async () => {
    const before = text.slice();
    new SceneDocument(sections[5]).census();
    expect(text).toBe(before);
    const archive = new BinaryMapArchive(await encodeBinaryMap(text));
    expect(await archive.text()).toBe(text);
    expect(await archive.section(5)).toBe(sections[5]);
  });
});
