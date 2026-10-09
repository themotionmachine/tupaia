// Token savers: compact find/inspect, changed-region screenshots, map_info diff counts and the
// compact `changes` of mutating tools. The first half is pure (no browser); the second drives the
// server against tests/fixtures/demo.map.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import vm from "node:vm";
import {
  boxToMap,
  CHANGES_FULL_MAX,
  CHANGES_SAMPLE,
  type CropView,
  compactChanges,
  compactFind,
  compactInspect,
  countChanges,
  cropScreenToMap,
  plainText,
  pngPerMap,
  pngToMap
} from "../src/compact.ts";
import { okResult, WithText } from "../src/result.ts";
import { alive, errorBody, type Harness, imageSize, MCP_ROOT, startServer, textOf } from "./helpers.ts";

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("compactFind (pure)", () => {
  const rows = [
    {
      i: 1,
      name: "Longong",
      state: 1,
      stateName: "Lohia",
      population: 15067,
      capital: true,
      port: 0,
      group: "capital",
      x: 216.9,
      y: 585.1,
      lat: 19.34,
      lon: -43.48
    },
    {
      i: 2,
      name: "Port Krar",
      state: 2,
      stateName: "Gazd",
      population: 30415,
      capital: false,
      port: 1,
      portName: "ocean",
      group: "city",
      x: 159.7,
      y: 496.3,
      lat: 23.17,
      lon: -45.94
    },
    {
      i: 3,
      name: "Odd=Name",
      state: 1,
      stateName: "Lohia",
      population: 9,
      capital: false,
      port: 0,
      group: null,
      x: 5,
      y: 6
    }
  ];
  const text = compactFind({ type: "burg", total: 753, offset: 0, returned: 3, matchedBy: null, rows });
  const lines = text.split("\n");

  test("header, one line per row, legend, paging line", () => {
    assert.equal(lines[0], "burg: 3 of 753");
    assert.equal(lines.filter(l => l.startsWith("burg ")).length, 3);
    assert.equal(lines.at(-1), "+750 more (offset=3)");
    assert.equal(lines.at(-2), "names: state 1=Lohia, 2=Gazd");
  });

  test("row format: pop alias, bare flags, absent false/null/port 0, rounded at", () => {
    assert.equal(lines[1], "burg 1 Longong state=1 pop=15067 capital group=capital at=(217,585)");
    // false flag, null group and nothing for the lat/lon; port is a feature id (1), kept
    assert.equal(lines[2], "burg 2 Port Krar state=2 pop=30415 port=1 group=city at=(160,496)");
    assert.equal(lines[3], 'burg 3 "Odd=Name" state=1 pop=9 at=(5,6)');
  });

  test("no ref names inline, no lat/lon", () => {
    assert.ok(!text.includes("stateName") && !text.includes("lat") && !text.includes("ocean"));
  });

  test("offset, matchedBy, near, distance and count-only", () => {
    const t = compactFind({
      type: "burg",
      total: 10,
      offset: 4,
      returned: 1,
      matchedBy: "contains",
      near: { x: 10.4, y: 20.6, cell: 5 },
      rows: [{ i: 7, name: "Ab", distance: 12.34, x: 11, y: 22 }]
    });
    assert.deepEqual(t.split("\n"), [
      "burg: 1 of 10 offset=4 matched=contains near=(10,21)",
      "burg 7 Ab dist=12.3 at=(11,22)",
      "+5 more (offset=5)"
    ]);
    assert.equal(
      compactFind({ type: "state", total: 20, offset: 0, returned: 0, rows: [] }),
      "state: 0 of 20\n+20 more (offset=0)"
    );
  });

  test("strings with spaces are quoted and long strings are cut; a ref-like Name field that is not a ref stays", () => {
    const t = compactFind({
      type: "state",
      total: 1,
      rows: [
        {
          i: 1,
          name: "Lohia",
          fullName: "Lohian Theocracy",
          form: "Theocracy",
          formName: "Theocracy",
          legend: "x".repeat(200)
        }
      ]
    });
    const row = t.split("\n")[1];
    assert.match(row, /fullName="Lohian Theocracy"/);
    assert.match(row, /formName=Theocracy/); // form is a string, so formName is a field, not a legend entry
    assert.ok(!t.includes("names:"));
    assert.ok(row.length < 200, `row ${row.length}`);
    assert.match(row, /…/);
  });

  test("fields: lat/lon appear when named, a name-repeating fullName/note is dropped, requested strings are whole", () => {
    const row = {
      i: 5,
      name: "Oom",
      fullName: "Oom",
      note: "Oom",
      legend: `<p>${"long text ".repeat(30)}</p>`,
      capital: false,
      x: 10.2,
      y: 20.7,
      lat: 19.38123,
      lon: -0.76123
    };
    const plain1 = compactFind({ type: "marker", total: 1, rows: [row] }).split("\n")[1];
    assert.ok(!plain1.includes("lat=") && !plain1.includes("fullName") && !plain1.includes("note="), plain1);
    assert.match(plain1, /legend="long text long text .*…\(\+\d+\)"/);
    const named = compactFind({ type: "marker", total: 1, rows: [row] }, ["lat", "lon", "legend"]).split("\n")[1];
    assert.match(named, /lat=19\.3812 lon=-0\.7612 at=\(10,21\)$/);
    assert.ok(!named.includes("…") && named.length > 300, `${named.length}`);
  });

  test("a requested field no row shows is reported once, not silently dropped", () => {
    const t = compactFind(
      {
        type: "burg",
        total: 2,
        rows: [
          { i: 1, name: "A", capital: false, x: 1, y: 2 },
          { i: 2, name: "B", x: 3, y: 4 }
        ]
      },
      ["capital", "bogus", "x"]
    );
    assert.deepEqual(t.split("\n").slice(-2), [
      "burg 2 B at=(3,4)",
      "empty in every row (false, null, 0 or not a field): capital, bogus"
    ]);
    assert.ok(!compactFind({ type: "burg", total: 1, rows: [{ i: 1, name: "A", x: 1, y: 2 }] }).includes("empty in"));
  });

  test("plainText: tags dropped, entities decoded, a bare < stays", () => {
    assert.equal(
      plainText("<b>Capital</b> city,&nbsp;pop 30&#44;000. It&#x27;s &amp; <i>big</i>.<br>Next"),
      "Capital city, pop 30,000. It's & big. Next"
    );
    assert.equal(plainText("a < b and c > d"), "a < b and c > d");
    assert.equal(plainText("Oom"), "Oom");
  });

  test("a third of the JSON size or better on a plain row set", () => {
    const json = JSON.stringify({ type: "burg", total: 753, offset: 0, returned: 3, matchedBy: null, rows });
    assert.ok(text.length < json.length * 0.6, `${text.length} vs ${json.length}`);
  });
});

describe("compactInspect (pure)", () => {
  const burg = {
    kind: "entity",
    type: "burg",
    i: 1,
    name: "Longong",
    x: 216.85,
    y: 585.12,
    lat: 19.3447,
    lon: -43.4806,
    cell: 4589,
    entity: {
      cell: 4589,
      x: 216.85,
      y: 585.12,
      i: 1,
      state: 1,
      name: "Longong",
      capital: 1,
      population: 15.067,
      lock: false,
      coa: { t1: "bendy-or-azure", division: { division: "perPale", t: "azure" }, shield: "heater" },
      production: Array.from({ length: 40 }, (_, k) => ({ dealId: k })),
      diplomacy: Array.from({ length: 21 }, () => "Enemy"),
      walls: 1,
      shanty: 0
    },
    relations: {
      state: { i: 1, name: "Lohia" },
      people: 15067,
      routes: [4, 137],
      neighbors: [{ i: 15, name: "Laupsland", relation: "Suspicion" }]
    }
  };

  test("entity: header, sections, key=value lines, nested data reduced to its shape", () => {
    const t = compactInspect(burg);
    const lines = t.split("\n");
    assert.equal(lines[0], "burg 1 Longong at=(216.85,585.12) lat=19.3447 lon=-43.4806 cell=4589");
    assert.ok(lines.includes("[entity]") && lines.includes("[relations]"));
    for (const l of lines.slice(1)) assert.ok(l.startsWith("[") || /^[A-Za-z.]+(=|$)/.test(l), `not key=value: ${l}`);
    assert.ok(lines.includes("pop=15067"), "people, named as in find"); // relations.people
    assert.ok(!lines.some(l => l.startsWith("population=")), "the thousands figure is not repeated");
    assert.ok(lines.includes("coa={t1,division,shield}"));
    assert.ok(lines.includes("production=[40 items]"));
    assert.ok(lines.includes("diplomacy=[21 items]"));
    assert.ok(lines.includes("shanty=0"), "zero is a value");
    assert.ok(!lines.some(l => l.startsWith("lock")), "false is left out");
    assert.ok(!lines.some(l => /^(cell|x|y|i|name)=/.test(l)), "header fields not repeated");
    assert.ok(lines.includes("state=1 (Lohia)"));
    assert.equal(lines.filter(l => l.startsWith("state=")).length, 1, "a key [relations] restates is shown once");
    assert.ok(lines.includes("routes=[4,137]"));
    assert.ok(lines.includes("neighbors=[15 (Laupsland) relation=Suspicion]"));
    assert.ok(!t.includes('{"'), "no nested JSON");
    assert.ok(t.length < JSON.stringify(burg).length * 0.45, `${t.length} vs ${JSON.stringify(burg).length}`);
  });

  test("fields keep only the named entity and relation keys", () => {
    const t = compactInspect(burg, ["population", "people", "state"]);
    assert.deepEqual(t.split("\n").slice(1), [
      "[entity]",
      "population=15.067", // named, so kept; the state is in [relations] with its name
      "[relations]",
      "pop=15067",
      "state=1 (Lohia)"
    ]);
    assert.deepEqual(compactInspect(burg, ["pop"]).split("\n").slice(1), ["[relations]", "pop=15067"]);
  });

  test("a named field is not cut; HTML is reduced to text; unnamed long strings are cut with the count", () => {
    const legend = `<b>Capital</b> city,&nbsp;pop 30,000. It&#x27;s <i>big</i>.<br>${"word ".repeat(60)}`;
    const note = { kind: "entity", type: "note", i: "burg1", name: "Longong", entity: { id: "burg1", legend } };
    const cut = compactInspect(note);
    assert.match(cut, /legend="Capital city, pop 30,000\. It's big\. word word/);
    assert.match(cut, /…\(\+\d+\)"$/, "says how much was left out");
    assert.ok(!cut.includes("<b>") && !cut.includes("&#x27;"));
    const whole = compactInspect(note, ["legend"]);
    assert.ok(whole.length > legend.length * 0.8 - 100 && !whole.includes("…"), `${whole.length}`);
    assert.ok(whole.trimEnd().endsWith('word"'));
  });

  test("a state: provinces/capital are in [relations] only; burgCount is not repeated next to burgs", () => {
    const state = {
      kind: "entity",
      type: "state",
      i: 3,
      name: "Tetelilco",
      entity: { capital: 3, provinces: [19, 20], burgs: 34, rural: 1017.021, cells: 199 },
      relations: {
        capital: { i: 3, name: "Tetzintza" },
        provinces: [
          { i: 19, name: "Tolololo" },
          { i: 20, name: "Calco" }
        ],
        burgCount: 34,
        rural: 1017021
      }
    };
    assert.deepEqual(compactInspect(state).split("\n").slice(1), [
      "[entity]",
      "burgs=34",
      "cells=199",
      "[relations]",
      "capital=3 (Tetzintza)",
      "provinces=[19 (Tolololo), 20 (Calco)]",
      "rural=1017021"
    ]);
  });

  test("place: header and one line per attribute, refs as i (name)", () => {
    const t = compactInspect({
      kind: "place",
      x: 216.9,
      y: 585.1,
      cell: 4589,
      lat: 19.3455,
      lon: -43.4785,
      via: "xy",
      height: 34,
      land: true,
      biome: { i: 12, name: "Wetland" },
      river: null,
      feature: { i: 23, type: "island", group: "continent", name: null },
      population: { rural: 34973, urban: 15067 },
      routes: [4],
      zones: [],
      markers: []
    });
    assert.deepEqual(t.split("\n"), [
      "place at=(216.9,585.1) cell=4589 lat=19.3455 lon=-43.4785",
      "height=34",
      "land",
      "biome=12 (Wetland)",
      "feature=23 type=island group=continent",
      "population.rural=34973",
      "population.urban=15067",
      "routes=[4]"
    ]);
  });
});

describe("changes helpers (pure)", () => {
  const entry = (n: number) => ({ i: n, name: `B${n}`, fields: { population: [n, n + 1] } });
  const big = {
    burg: {
      counts: { added: 0, removed: 0, modified: 30 },
      added: [],
      removed: [],
      modified: Array.from({ length: 8 }, (_, k) => entry(k + 1))
    },
    state: {
      counts: { added: 1, removed: 2, modified: 0 },
      added: [{ i: 9, name: "S9" }],
      removed: [3, 4],
      modified: []
    },
    cells: { h: 120, province: { resized: [10, 12] } }
  };

  test("countChanges: {added, removed, changed} per type, cells pass through", () => {
    assert.deepEqual(countChanges(big), {
      burg: { added: 0, removed: 0, changed: 30 },
      state: { added: 1, removed: 2, changed: 0 },
      cells: { h: 120, province: { resized: [10, 12] } }
    });
    assert.deepEqual(countChanges(undefined), {});
  });

  test("compactChanges: small diffs are untouched", () => {
    const small = {
      burg: {
        counts: { added: 0, removed: 0, modified: 3 },
        added: [],
        removed: [],
        modified: [entry(1), entry(2), entry(3)]
      }
    };
    // the same entries; the empty lists are not repeated
    assert.deepEqual(compactChanges(small), {
      burg: { counts: small.burg.counts, modified: small.burg.modified }
    });
    assert.equal(compactChanges(undefined), undefined);
    const edge = {
      burg: {
        counts: { added: 0, removed: 0, modified: CHANGES_FULL_MAX },
        added: [],
        removed: [],
        modified: Array.from({ length: CHANGES_FULL_MAX }, (_, k) => entry(k))
      }
    };
    assert.deepEqual(
      compactChanges(edge),
      { burg: { counts: edge.burg.counts, modified: edge.burg.modified } },
      "exactly CHANGES_FULL_MAX entries stay whole"
    );
  });

  test("compactChanges: large diffs keep exact counts, the first few entries and what is left", () => {
    const c = compactChanges(big) as Record<string, any>;
    assert.deepEqual(c.burg.counts, { added: 0, removed: 0, modified: 30 });
    assert.equal(c.burg.modified.length, CHANGES_SAMPLE);
    assert.deepEqual(c.burg.more, { modified: 27 });
    assert.ok(!("added" in c.burg), "empty lists are not repeated");
    assert.deepEqual(c.state.added, [{ i: 9, name: "S9" }]);
    assert.deepEqual(c.state.removed, [3, 4]);
    assert.equal(c.state.more, undefined, "nothing left over");
    assert.deepEqual(c.cells, big.cells);
    assert.ok(JSON.stringify(c).length < JSON.stringify(big).length);
  });
});

describe("crop maths (pure)", () => {
  const view: CropView = {
    full: false,
    pngW: 1280,
    pngH: 720,
    cssW: 1280,
    cssH: 720,
    graphWidth: 1680,
    graphHeight: 849,
    x: -862.609,
    y: -3333.913,
    scale: 6.2609
  };
  test("pngToMap inverts the view transform (css px = map px * scale + offset)", () => {
    const [mx, my] = pngToMap(640, 360, view);
    assert.ok(Math.abs(mx * view.scale + view.x - 640) < 1e-6);
    assert.ok(Math.abs(my * view.scale + view.y - 360) < 1e-6);
  });
  test("a retina capture (png 2x css) maps the same map point", () => {
    const [a] = pngToMap(640, 360, view);
    const [b] = pngToMap(1280, 720, { ...view, pngW: 2560, pngH: 1440 });
    assert.ok(Math.abs(a - b) < 1e-9);
    assert.equal(pngPerMap({ ...view, pngW: 2560, pngH: 1440 }), (view.scale * 2560) / 1280);
  });
  test("cropScreenToMap: a pixel of the cropped image maps through the crop box", () => {
    const rec = {
      full: false,
      pngW: 1280,
      pngH: 720,
      cssW: 1280,
      cssH: 720,
      graphWidth: 1680,
      graphHeight: 849,
      view: { x: view.x, y: view.y, scale: view.scale },
      imgW: 200,
      imgH: 100,
      crop: { box: [400, 300, 600, 400] as [number, number, number, number] }
    };
    // the crop's top-left and bottom-right pixels are the box corners
    assert.deepEqual(cropScreenToMap(0, 0, rec), pngToMap(400, 300, view));
    assert.deepEqual(cropScreenToMap(200, 100, rec), pngToMap(600, 400, view));
    assert.deepEqual(cropScreenToMap(100, 50, rec), pngToMap(500, 350, view));
    // downscaled crop (image 100x50 for the same box): same map point for the same fraction
    const small = { ...rec, imgW: 100, imgH: 50 };
    assert.deepEqual(cropScreenToMap(50, 25, small), pngToMap(500, 350, view));
  });

  test("cropScreenToMap: sideBySide, both halves map to the same region; the gap clamps", () => {
    const rec = {
      full: false,
      pngW: 1280,
      pngH: 720,
      cssW: 1280,
      cssH: 720,
      graphWidth: 1680,
      graphHeight: 849,
      view: { x: view.x, y: view.y, scale: view.scale },
      imgW: 410,
      imgH: 100,
      crop: { box: [400, 300, 600, 400] as [number, number, number, number], half: { width: 200, right: 210 } }
    };
    assert.deepEqual(cropScreenToMap(100, 50, rec), pngToMap(500, 350, view));
    assert.deepEqual(cropScreenToMap(210 + 100, 50, rec), pngToMap(500, 350, view), "the right half");
    assert.deepEqual(cropScreenToMap(205, 50, rec), pngToMap(600, 350, view), "in the gap: the edge");
  });

  test("full shots map linearly onto the graph", () => {
    const v = { ...view, full: true, pngW: 3360, pngH: 1698, cssW: 1680, cssH: 849 };
    assert.deepEqual(pngToMap(3360, 1698, v), [1680, 849]);
    assert.equal(pngPerMap(v), 2);
    assert.deepEqual(boxToMap([336, 170, 1680, 849], v), [168, 85, 840, 424.5]);
  });
});

describe("okResult text output (pure)", () => {
  test("WithText-style output has no structuredContent; extras follow as a JSON line", () => {
    const r = okResult({ value: {}, text: "burg: 0 of 0" }, { notes: ["n1"] });
    assert.equal(r.structuredContent, undefined);
    assert.equal(r.content.length, 1);
    assert.equal((r.content[0] as { text: string }).text, 'burg: 0 of 0\n{"notes":["n1"]}');
    const plainOne = okResult({ value: {}, text: "x" });
    assert.equal((plainOne.content[0] as { text: string }).text, "x");
    assert.ok(new WithText("t") instanceof WithText);
  });
  test("a JSON result is unchanged", () => {
    const r = okResult({ value: { a: 1 } });
    assert.deepEqual(r.structuredContent, { a: 1 });
    assert.equal((r.content[0] as { text: string }).text, '{"a":1}');
  });
});

describe("changedBox / padBox (pure, in node:vm)", () => {
  const ctx = vm.createContext({ console });
  ctx.__tupaia = { fns: {}, fail: (code: string, msg: string) => assert.fail(`${code}: ${msg}`) };
  vm.runInContext(fs.readFileSync(path.join(MCP_ROOT, "src", "bridge-ext", "tokens.js"), "utf8"), ctx, {
    filename: "tokens.js"
  });
  const tk = (ctx.__tupaia as { tokens: { changedBox: (...a: unknown[]) => any; padBox: (...a: unknown[]) => any } })
    .tokens;
  const W = 400;
  const H = 300;
  const frame = () => new Uint8ClampedArray(W * H * 4).fill(200);
  const paint = (buf: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number, v = 20) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) buf.fill(v, (y * W + x) * 4, (y * W + x) * 4 + 3);
  };
  const box = (a: Uint8ClampedArray, b: Uint8ClampedArray) => plain(tk.changedBox(a, b, W, H, 32));

  test("identical frames: nothing changed, no box", () => {
    const r = box(frame(), frame());
    assert.deepEqual(r, { changed: 0, significant: 0, speckle: 0, clusters: [], box: null });
  });

  test("a changed rectangle gives exactly its box (x1/y1 exclusive)", () => {
    const b = frame();
    paint(b, 100, 50, 160, 90);
    const r = box(frame(), b);
    assert.deepEqual(r.box, [100, 50, 160, 90]);
    assert.equal(r.changed, 60 * 40);
    assert.equal(r.speckle, 0);
  });

  test("differences under the threshold are not changes", () => {
    const b = frame();
    paint(b, 100, 50, 160, 90, 180); // 20 per channel < 32
    assert.equal(box(frame(), b).box, null);
  });

  test("a handful of lone pixels (render noise) is not a change", () => {
    const b = frame();
    for (const [x, y] of [
      [3, 4],
      [390, 5],
      [200, 290],
      [10, 250]
    ])
      paint(b, x, y, x + 1, y + 1);
    const r = box(frame(), b);
    assert.equal(r.changed, 4);
    assert.equal(r.box, null);
    assert.equal(r.speckle, 4);
  });

  test("a scatter of small clusters over the frame is noise, a real region next to it is not", () => {
    const noisy = frame();
    for (let k = 0; k < 20; k++)
      paint(noisy, 15 + k * 19, 10 + ((k * 37) % 270), 15 + k * 19 + 2, 12 + ((k * 37) % 270)); // 20 clusters of 4 px, spread out
    assert.equal(box(frame(), noisy).box, null, "spread-out speckle alone");
    paint(noisy, 150, 100, 190, 130); // a real 40x30 change
    const r = box(frame(), noisy);
    assert.deepEqual(r.box, [150, 100, 190, 130], "speckle must not stretch the box");
    assert.ok(r.speckle > 0);
  });

  test("two real regions: the box spans both", () => {
    const b = frame();
    paint(b, 20, 20, 50, 40);
    paint(b, 300, 240, 340, 280);
    assert.deepEqual(box(frame(), b).box, [20, 20, 340, 280]);
  });

  test("a dense label-sized change wins over speckle: the box is the blob, not the frame", () => {
    const b = frame();
    paint(b, 120, 150, 130, 160); // 10x10 = 100 px, the real change
    for (let k = 0; k < 24; k++) paint(b, 12 + k * 15, 8 + ((k * 41) % 280), 12 + k * 15 + 4, 10 + ((k * 41) % 280)); // 24 clusters of 8 px
    const r = box(frame(), b);
    assert.deepEqual(r.box, [120, 150, 130, 160]);
    assert.ok(r.speckle >= 24 * 8 - 40, `speckle ${r.speckle}`);
  });

  test("a small solid change is a change: one icon-sized block (6x6) gives its box", () => {
    const b = frame();
    paint(b, 200, 150, 206, 156); // 36 px, below the 48 px floor but solid
    const r = box(frame(), b);
    assert.deepEqual(r.box, [200, 150, 206, 156]);
    assert.equal(r.speckle, 0);
    assert.equal(r.clusters.length, 1);
  });

  test("a sparse smear of the same pixel count is still noise", () => {
    const b = frame();
    for (let k = 0; k < 36; k++) paint(b, 20 + k * 10, 30 + ((k * 7) % 5) * 40, 21 + k * 10, 31 + ((k * 7) % 5) * 40);
    const r = box(frame(), b);
    assert.equal(r.box, null);
    assert.equal(r.speckle, 36);
  });

  test("a smaller second change is in the box, and clusters list both, largest first", () => {
    const b = frame();
    paint(b, 20, 20, 140, 120); // 12000 px
    paint(b, 300, 250, 330, 262); // 360 px, 3% of the first
    const r = box(frame(), b);
    assert.deepEqual(r.box, [20, 20, 330, 262]);
    assert.deepEqual(
      r.clusters.map((c: { px: number }) => c.px),
      [12000, 360]
    );
    assert.deepEqual(r.clusters[1].box, [300, 250, 330, 262]);
    assert.equal(r.speckle, 0);
  });

  test("padBox: default pad, minimum size, clamped to the frame", () => {
    assert.deepEqual(plain(tk.padBox([100, 100, 300, 260], W, H)), [80, 80, 320, 280]); // pad = max(12, 10% of 200)
    assert.deepEqual(plain(tk.padBox([100, 100, 300, 260], W, H, 0)), [100, 100, 300, 260]);
    assert.deepEqual(plain(tk.padBox([100, 100, 200, 160], W, H, 0)), [86, 66, 214, 194], "grown to 128 px each way");
    const tiny = plain(tk.padBox([200, 150, 203, 152], W, H, 0)) as number[];
    assert.ok(tiny[2] - tiny[0] >= 128 && tiny[3] - tiny[1] >= 128, `${tiny}`);
    const edge = plain(tk.padBox([0, 0, 10, 10], W, H, 20)) as number[];
    assert.ok(edge[0] === 0 && edge[1] === 0 && edge[2] >= 128 && edge[3] >= 128);
    const corner = plain(tk.padBox([395, 295, 400, 300], W, H, 0)) as number[];
    assert.ok(corner[2] === W && corner[3] === H && corner[2] - corner[0] >= 128 && corner[3] - corner[1] >= 128);
  });
});

describe("token savers over the server (demo.map)", () => {
  let h: Harness;

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await h.call(name, args);
    assert.ok(!r.isError, `${name} failed: ${textOf(r)}`);
    return r;
  };
  const json = async (name: string, args: Record<string, unknown>) => JSON.parse(textOf(await call(name, args)));
  const images = (r: { content: Array<{ type: string; data?: string }> }) => r.content.filter(c => c.type === "image");

  before(async () => {
    h = await startServer();
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
  });
  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("map_info right after load_map: the default diff is empty, not the old map against the new one", async () => {
    const info = await h.ok("map_info", {});
    assert.equal(info.changed, false);
    assert.deepEqual(info.changes, {});
    assert.match(String(info.since), /^load_map /);
    // the explicit way to compare with the map that was in the page before
    const counts = await h.ok("map_info", { since: "none", diff: "counts" });
    assert.equal(counts.changes, undefined);
  });

  test("find format:compact: plain text, same rows, far fewer chars", async () => {
    const args = { type: "burg", limit: 25 };
    const j = await h.ok("find", args);
    const r = await call("find", { ...args, format: "compact" });
    assert.equal(r.structuredContent, undefined, "compact has no structuredContent");
    const text = textOf(r);
    assert.throws(() => JSON.parse(text));
    const lines = text.split("\n");
    assert.equal(lines[0], `burg: 25 of ${j.total}`);
    const rows = j.rows as Array<{ i: number; name: string; population: number; state: number }>;
    const rowLines = lines.filter(l => l.startsWith("burg "));
    assert.equal(rowLines.length, 25);
    rows.forEach((row, k) => {
      assert.ok(rowLines[k].startsWith(`burg ${row.i} ${row.name} `), rowLines[k]);
      assert.ok(rowLines[k].includes(`pop=${row.population}`));
      assert.ok(rowLines[k].includes(`state=${row.state}`));
    });
    assert.match(lines.find(l => l.startsWith("names:")) ?? "", /state 1=\w+/);
    assert.equal(lines.at(-1), `+${(j.total as number) - 25} more (offset=25)`);
    const jsonChars = JSON.stringify(j).length;
    assert.ok(text.length < jsonChars * 0.6, `compact ${text.length} vs json ${jsonChars}`);
  });

  test("find compact with fields, sort and near", async () => {
    const t = textOf(
      await call("find", { type: "state", fields: ["culture", "burgs"], sort: "-burgs", limit: 3, format: "compact" })
    );
    const lines = t.split("\n");
    assert.equal(lines[0], "state: 3 of 20");
    assert.match(lines[1], /^state \d+ \S+ culture=\d+ burgs=\d+ at=\(\d+,\d+\)$/);
    const burgs = lines.filter(l => l.startsWith("state ")).map(l => Number(/burgs=(\d+)/.exec(l)?.[1]));
    assert.deepEqual(
      burgs,
      [...burgs].sort((a, b) => b - a)
    );
    const near = textOf(await call("find", { type: "burg", near: { x: 217, y: 585 }, radius: 30, format: "compact" }));
    assert.match(near.split("\n")[0], /^burg: \d+ of \d+ near=\(217,585\)$/);
    assert.match(near.split("\n")[1], /^burg 1 Longong .*dist=\d/);
    const none = textOf(await call("find", { type: "burg", limit: 0, format: "compact" }));
    assert.match(none, /^burg: 0 of \d+\n\+\d+ more \(offset=0\)$/);
  });

  test("find compact keeps errors as errors", async () => {
    const r = await h.call("find", { type: "burg", name: "Zzzqqq-nothing", format: "compact" });
    assert.equal(r.isError, true);
    assert.equal(errorBody(r).error.code, "NOT_FOUND");
  });

  test("find default output is unchanged JSON", async () => {
    const r = await call("find", { type: "state", limit: 1 });
    assert.ok(r.structuredContent);
    assert.equal(JSON.parse(textOf(r)).rows.length, 1);
  });

  test("inspect format:compact for an entity and a place", async () => {
    const j = await h.ok("inspect", { entity: { type: "burg", ref: 1 } });
    const r = await call("inspect", { entity: { type: "burg", ref: 1 }, format: "compact" });
    assert.equal(r.structuredContent, undefined);
    const t = textOf(r);
    assert.ok(t.startsWith("burg 1 Longong at="), t.slice(0, 80));
    assert.ok(t.includes("[entity]") && t.includes("[relations]"));
    assert.ok(t.includes("state=1 (Lohia)"));
    assert.ok(/^pop=\d+$/m.test(t), "relations.people is pop, as in find");
    assert.ok(!/^population=/m.test(t), "no second, thousands-based population");
    assert.ok(/^production=\[\d+ items\]$/m.test(t));
    assert.ok(!t.includes('{"'), "no nested JSON");
    assert.ok(t.length < JSON.stringify(j).length * 0.35, `${t.length} vs ${JSON.stringify(j).length}`);

    const place = textOf(await call("inspect", { at: { x: 216.9, y: 585.1 }, format: "compact" }));
    assert.match(place, /^place at=\(216\.9,585\.1\) cell=\d+/);
    assert.match(place, /^burg=1 \(Longong\)$/m);
    assert.match(place, /^state=1 \(Lohia\)$/m);
    assert.match(place, /^land$/m);
  });

  test("inspect fields narrows both formats", async () => {
    const t = textOf(
      await call("inspect", { entity: { type: "burg", ref: 1 }, format: "compact", fields: ["population", "people"] })
    );
    assert.deepEqual(t.split("\n").slice(1), ["[entity]", "population=15.067", "[relations]", "pop=15067"]);
    const j = await json("inspect", { entity: { type: "burg", ref: 1 }, fields: ["population", "people"] });
    assert.deepEqual(Object.keys(j.entity), ["population"]);
    assert.deepEqual(Object.keys(j.relations), ["people"]);
    assert.equal(j.name, "Longong");
  });

  test("map_info diff:'counts' matches the list diff and is much smaller", async () => {
    await h.ok("map_info", { since: "none" });
    const list = await h.ok("find", { type: "burg", limit: 30 });
    const ops = (list.rows as Array<{ i: number; population: number }>).map(r => ({
      ref: r.i,
      set: { population: r.population + 100 }
    }));
    await h.ok("edit", { type: "burg", ops });
    const full = await h.ok("map_info", { since: "snapshot" });
    const counts = await h.ok("map_info", { since: "snapshot", diff: "counts" });
    assert.equal(counts.changed, true);
    assert.deepEqual(counts.changes, { burg: { added: 0, removed: 0, changed: 30 } });
    // diff:'counts' is the diff only, not the overview around it
    assert.deepEqual(Object.keys(counts).sort(), ["changed", "changes", "opsSince", "since"]);
    assert.ok(JSON.stringify(counts).length < 400, `${JSON.stringify(counts).length} chars`);
    const withOverview = await h.ok("map_info", { since: "snapshot", diff: "counts", overview: true });
    assert.ok(withOverview.counts && withOverview.name !== undefined, "overview:true brings the overview back");
    const burg = (full.changes as { burg: { counts: { modified: number } } }).burg;
    assert.equal(burg.counts.modified, 30);
    assert.equal(counts.changesTruncated, undefined);
    assert.ok(JSON.stringify(counts).length < JSON.stringify(full).length * 0.6);
    // an unchanged baseline: counts mode reports changed:false and no types
    await h.ok("map_info", { since: "none" });
    const none = await h.ok("map_info", { since: "checkpoint", diff: "counts" });
    assert.equal(none.changed, false);
    assert.deepEqual(none.changes, {});
    // no baseline at all keeps the explanatory object
    const off = await h.ok("map_info", { since: "none", diff: "counts" });
    assert.equal(off.changes, undefined);
  });

  test("rows:'ids' answers with ids only and still applies the whole call", async () => {
    const ops = [10, 11, 12, 13].map(i => ({ ref: i, set: { population: 4000 + i } }));
    const lean = await h.ok("edit", { type: "burg", ops, rows: "ids" });
    assert.equal(lean.applied, undefined);
    assert.deepEqual(lean.appliedIds, [10, 11, 12, 13]);
    const full = await h.ok("edit", { type: "burg", ops: ops.map(o => ({ ...o, set: { population: 5000 } })) });
    assert.equal((full.applied as unknown[]).length, 4, "rows defaults to the full rows");
    assert.ok(JSON.stringify(lean).length < JSON.stringify(full).length * 0.8);
    const added = await h.ok("add", {
      type: "marker",
      items: [{ at: { x: 230, y: 570 } }, { at: { x: 190, y: 600 } }],
      rows: "ids"
    });
    assert.equal(added.created, undefined);
    assert.equal((added.createdIds as number[]).length, 2);
    await h.ok("snapshot", { action: "undo" });
    await h.ok("snapshot", { action: "undo" });
    await h.ok("snapshot", { action: "undo" });
  });

  test("diff counts include cells; mutating tools: large changes compact, small ones whole", async () => {
    const before = await h.ok("map_info", { since: "none" });
    assert.ok(before);
    // small: three distinct renames list in full (no `more`)
    const small = await h.ok("edit", {
      type: "burg",
      ops: [2, 3, 4].map(i => ({ ref: i, set: { name: `Smallname${i}` } }))
    });
    const sc = small.changes as { burg: { counts: { modified: number }; modified: unknown[]; more?: unknown } };
    assert.equal(sc.burg.counts.modified, 3);
    assert.equal(sc.burg.modified.length, 3);
    assert.equal(sc.burg.more, undefined);
    // large: 30 renames: exact counts, three entries, the rest counted
    const ops = Array.from({ length: 30 }, (_, k) => ({ ref: k + 10, set: { name: `Bulkname${k}` } }));
    const big = await h.ok("edit", { type: "burg", ops });
    const bc = big.changes as {
      burg: { counts: { modified: number }; modified: Array<{ i: number; name: string }>; more?: { modified: number } };
    };
    assert.equal(bc.burg.counts.modified, 30);
    assert.equal(bc.burg.modified.length, CHANGES_SAMPLE);
    assert.deepEqual(bc.burg.more, { modified: 30 - CHANGES_SAMPLE });
    assert.equal(bc.burg.modified[0].name, "Bulkname0");
    assert.equal((big.applied as unknown[]).length, 30, "applied rows are not touched");
    // the same diff in full is one map_info away, same baseline
    const full = await h.ok("map_info", { detail: "full" });
    assert.equal((full.changes as { burg: { modified: unknown[] } }).burg.modified.length, 30);
    // undo still works
    const u = await h.ok("snapshot", { action: "undo" });
    assert.ok(u);
  });

  test("a paint_cells call reports cell counts alongside the compact entity changes", async () => {
    const r = await h.ok("paint_cells", {
      select: { circle: { at: { x: 217, y: 585 }, radius: 25 }, where: { land: true, hMax: 90 } },
      set: { height: { delta: 5 } }
    });
    assert.ok(((r.set as { height: { changed: number } }).height.changed ?? 0) > 0);
    const ch = r.changes as Record<string, unknown>;
    assert.ok(ch.cells, JSON.stringify(ch).slice(0, 300));
  });

  describe("screenshot crop:'changed'", () => {
    let base = "";
    // burg 96 sits at about (207, 576); this box frames it with its neighbours
    const frame = [180, 540, 300, 640];

    before(async () => {
      // demo.map draws no burg labels until something redraws them: do that first so the
      // baseline shot already has them
      await h.ok("edit", { type: "burg", ops: [{ ref: 1, set: { name: "Longong" } }] });
      // let the redrawn labels and icons finish any transition before the baseline shot
      await h.ok("eval", { code: "await new Promise(r => setTimeout(r, 1200)); return 1", readOnly: true });
      base = (await h.ok("screenshot", { target: { bbox: frame } })).shotId as string;
    });

    test("needs compare; pad and sideBySide need crop", async () => {
      for (const args of [{ crop: "changed" }, { pad: 4 }, { sideBySide: true }]) {
        const r = await h.call("screenshot", { target: { bbox: frame }, ...args });
        assert.equal(r.isError, true, JSON.stringify(args));
        assert.equal(errorBody(r).error.code, "BAD_ARGS");
      }
      const r = await h.call("screenshot", { compare: base, pad: 4 });
      assert.equal(errorBody(r).error.code, "BAD_ARGS");
    });

    test("nothing changed: no image, a one-line note, a shot id to compare against later", async () => {
      const r = await call("screenshot", { compare: base, crop: "changed" });
      assert.equal(images(r).length, 0);
      const body = JSON.parse(textOf(r));
      assert.match(body.shotId, /^s\d+$/);
      // the trade animation is hidden and the view is the rounded one, so the diff is empty, give
      // or take a stray pixel on a loaded machine (a note either way, never an image)
      assert.match(body.note, /^(nothing changed|no significant change) vs s\d+: /);
      assert.ok(body.compare.changedPixels < 20, `${body.compare.changedPixels} px differ`);
      assert.ok(!body.note.includes("\n"));
      assert.equal(body.compare.with, base);
      // (a shot is captured at the rounded view that view:/compare: replay, so the replay is exact)
      assert.match(body.note, new RegExp(`^(nothing changed|no significant change) vs ${base}: `));
      assert.ok(textOf(r).length < 300, `${textOf(r).length} chars`);
      // the shot was stored: it works as a baseline
      const again = await call("screenshot", { compare: body.shotId, crop: "changed" });
      assert.equal(images(again).length, 0);
    });

    test("a renamed burg: the crop is the changed region, with its bbox in map px", async () => {
      await h.ok("edit", { type: "burg", ops: [{ ref: 96, set: { name: "Zhongshan Renamed" } }] });
      const r = await call("screenshot", { compare: base, crop: "changed", format: "png" });
      const imgs = images(r);
      assert.equal(imgs.length, 1);
      const body = JSON.parse(textOf(r));
      const c = body.compare as {
        with: string;
        changedPct: number;
        bbox: number[];
        shown: number[];
        changedPixels: number;
      };
      assert.equal(c.with, base);
      assert.ok(c.changedPct > 0.05 && c.changedPixels > 300, JSON.stringify(c));
      // the box holds the renamed burg and sits inside the framed view
      const [bx0, by0, bx1, by1] = c.bbox;
      const [sx0, sy0, sx1, sy1] = c.shown;
      // (the label sits just above the burg at about (207, 576); nothing else changed)
      assert.ok(Math.abs((bx0 + bx1) / 2 - 207) < 20 && Math.abs((by0 + by1) / 2 - 576) < 15, `bbox ${c.bbox}`);
      assert.ok(bx1 - bx0 < 60 && by1 - by0 < 20, `bbox ${c.bbox} is the label, not the frame`);
      assert.ok(sx0 <= bx0 && sy0 <= by0 && sx1 >= bx1 && sy1 >= by1, "shown contains bbox");
      assert.ok(bx1 - bx0 > 5 && by1 - by0 > 2);
      // the returned image is the crop: same aspect as `shown`, not the whole frame
      const dim = imageSize(Buffer.from(imgs[0].data ?? "", "base64"));
      assert.equal(dim.type, "png");
      assert.equal(body.width, dim.width);
      assert.ok(
        Math.abs(dim.width / dim.height - (sx1 - sx0) / (sy1 - sy0)) < 0.05,
        `${dim.width}x${dim.height} vs ${c.shown}`
      );
      // lean result: no view metadata repeated
      for (const k of ["png", "view", "mapBboxShown", "pixelHint"]) assert.ok(!(k in body), k);
    });

    test("sideBySide returns before | after in one image, about twice as wide", async () => {
      const single = await call("screenshot", { compare: base, crop: "changed", pad: 6, maxSide: 2048 });
      const both = await call("screenshot", {
        compare: base,
        crop: "changed",
        pad: 6,
        maxSide: 2048,
        sideBySide: true
      });
      const a = imageSize(Buffer.from(images(single)[0].data ?? "", "base64"));
      const b = imageSize(Buffer.from(images(both)[0].data ?? "", "base64"));
      assert.equal(a.height, b.height);
      assert.ok(b.width > a.width * 2 - 2 && b.width < a.width * 2 + a.width * 0.1, `${a.width} vs ${b.width}`);
      const body = JSON.parse(textOf(both));
      assert.match(body.compare.sideBySide, /before/);
      assert.deepEqual(body.compare.bbox, JSON.parse(textOf(single)).compare.bbox);
    });

    test("pad widens the shown box in map px", async () => {
      const tight = JSON.parse(textOf(await call("screenshot", { compare: base, crop: "changed", pad: 0 }))).compare;
      const wide = JSON.parse(textOf(await call("screenshot", { compare: base, crop: "changed", pad: 20 }))).compare;
      // two captures of the same change: the box is the same up to a stray anti-aliased pixel or two
      // at its edge (render speckle on a loaded machine), far less than the 20 px pad
      for (let k = 0; k < 4; k++)
        assert.ok(Math.abs(tight.bbox[k] - wide.bbox[k]) <= 3, `bbox ${tight.bbox} vs ${wide.bbox}`);
      const grow = wide.shown[2] - wide.shown[0] - (tight.shown[2] - tight.shown[0]);
      assert.ok(grow > 10, `grew by ${grow}`);
    });

    test("full-map shots: the box comes back in graph (map) px", async () => {
      // remove river 4 (Nelbaz, a long one) and compare two whole-map shots
      const f1 = (await h.ok("screenshot", { full: true })).shotId as string;
      const ext = (
        await h.ok("eval", {
          code: "const r = pack.rivers.find(x => x.i === 4); const pts = r.cells.map(c => pack.cells.p[c]).filter(Boolean); return {x0: Math.min(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), x1: Math.max(...pts.map(p => p[0])), y1: Math.max(...pts.map(p => p[1]))}",
          readOnly: true
        })
      ).value as { x0: number; y0: number; x1: number; y1: number };
      const e = await h.ok("edit", { type: "river", ops: [{ ref: 4, remove: true }] });
      // a large diff: the mutating tool's changes are counts plus the first few
      const rc = (
        e.changes as { river: { counts: { removed: number }; removed: unknown[]; more?: { removed: number } } }
      ).river;
      assert.ok(rc.counts.removed > CHANGES_FULL_MAX, "the river and its tributaries");
      assert.equal(rc.removed.length, CHANGES_SAMPLE);
      assert.equal(rc.more?.removed, rc.counts.removed - CHANGES_SAMPLE);
      const r = await call("screenshot", { compare: f1, crop: "changed", pad: 10 });
      assert.equal(images(r).length, 1, textOf(r).slice(0, 300));
      const c = JSON.parse(textOf(r)).compare as { bbox: number[]; shown: number[] };
      const [x0, y0, x1, y1] = c.bbox;
      // the changed region is the river's own extent (rivers drawn on the whole-map raster), in graph px
      assert.ok(
        Math.abs(x0 - ext.x0) < 12 && Math.abs(y0 - ext.y0) < 12 && Math.abs(y1 - ext.y1) < 12,
        `bbox ${c.bbox} vs river ${JSON.stringify(ext)}`
      );
      assert.ok(x1 > ext.x1 - 12 && x1 < ext.x1 + 60, `bbox ${c.bbox} right edge vs ${ext.x1}`);
      const [sx0, sy0, sx1, sy1] = c.shown;
      assert.ok(sx0 <= x0 && sy0 <= y0 && sx1 >= x1 && sy1 >= y1);
      assert.ok(Math.abs(x0 - sx0 - 10) < 2, `pad 10 map px on the left: ${c.shown} vs ${c.bbox}`);
      await h.ok("snapshot", { action: "undo" });
    });

    test("a framed shot still reports what it framed", async () => {
      const r = await h.ok("screenshot", { target: { entity: { type: "burg", ref: 96 } } });
      assert.match(String(r.target), /^burg 96/);
      const b = await h.ok("screenshot", { target: { bbox: frame } });
      assert.equal(b.target, "bbox");
    });

    test("a differently framed shot cannot be compared; the refusal burns no shot id", async () => {
      const shotNo = async () =>
        Number(String((await h.ok("screenshot", { compare: base, crop: "changed" })).shotId).slice(1));
      const n1 = await shotNo();
      for (const extra of [{ target: { bbox: [400, 300, 600, 400] } }, { zoom: 3 }, { full: true }]) {
        const r = await h.call("screenshot", { compare: base, crop: "changed", ...extra });
        assert.equal(r.isError, true, JSON.stringify(extra));
        assert.equal(errorBody(r).error.code, "BAD_ARGS", JSON.stringify(extra));
        assert.match(errorBody(r).error.message, /framed differently|full-map|viewport/);
      }
      assert.equal(await shotNo(), n1 + 1, "three refusals, no ids used");
      // the same frame asked for again by target is the same view: fine
      const same = await h.call("screenshot", { compare: base, target: { bbox: frame } });
      assert.ok(!same.isError, textOf(same));
    });

    test("inspect {at:{screen, shot}} on a crop shot lands inside the shown region, for both layouts", async () => {
      await h.ok("edit", { type: "burg", ops: [{ ref: 96, set: { name: "Zhongshan Cropped" } }] });
      for (const sideBySide of [false, true]) {
        const r = JSON.parse(textOf(await call("screenshot", { compare: base, crop: "changed", pad: 6, sideBySide })));
        const [sx0, sy0, sx1, sy1] = r.compare.shown as number[];
        // the middle of the after image (the right half with sideBySide) is the middle of `shown`
        const px = Math.round(sideBySide ? r.width * 0.75 : r.width / 2);
        const at = await h.ok("inspect", { at: { screen: [px, Math.round(r.height / 2)], shot: r.shotId } });
        assert.ok(
          Math.abs((at.x as number) - (sx0 + sx1) / 2) < (sx1 - sx0) / 20 + 1 &&
            Math.abs((at.y as number) - (sy0 + sy1) / 2) < (sy1 - sy0) / 20 + 1,
          `${sideBySide ? "sideBySide " : ""}(${at.x}, ${at.y}) vs centre of ${r.compare.shown}`
        );
        // and the top-left pixel is the top-left corner of the shown region
        const tl = await h.ok("inspect", { at: { screen: [0, 0], shot: r.shotId } });
        assert.ok(Math.abs((tl.x as number) - sx0) < 1.5 && Math.abs((tl.y as number) - sy0) < 1.5, `${tl.x},${tl.y}`);
      }
    });

    test("two separate edits: one box over both, and the clusters say where each is", async () => {
      await h.ok("edit", { type: "burg", ops: [{ ref: 1, set: { name: "Longong Far" } }] });
      const r = JSON.parse(textOf(await call("screenshot", { compare: base, crop: "changed" })));
      const c = r.compare as { bbox: number[]; clusters?: Array<{ bbox: number[]; pixels: number }> };
      assert.ok(c.clusters && c.clusters.length >= 2, JSON.stringify(c));
      const [bx0, by0, bx1, by1] = c.bbox;
      for (const k of c.clusters ?? []) {
        assert.ok(k.bbox[0] >= bx0 - 0.2 && k.bbox[1] >= by0 - 0.2 && k.bbox[2] <= bx1 + 0.2 && k.bbox[3] <= by1 + 0.2);
        assert.ok(k.pixels >= 9);
      }
      const px = (c.clusters ?? []).map(k => k.pixels);
      assert.deepEqual(
        px,
        [...px].sort((a, b) => b - a),
        "largest first"
      );
      await h.ok("edit", { type: "burg", ops: [{ ref: 1, set: { name: "Longong" } }] });
    });

    test("after redraw:[] a compare that finds nothing says the mutation was not drawn", async () => {
      await h.ok("display", { on: ["markers"] });
      const b2 = (await h.ok("screenshot", { target: { bbox: frame } })).shotId as string;
      // the markers layer is drawn by the redraw that redraw:[] leaves out
      await h.ok("add", { type: "marker", items: [{ at: { x: 230, y: 570 } }], redraw: [] });
      const r = JSON.parse(textOf(await call("screenshot", { compare: b2, crop: "changed" })));
      assert.equal(r.compare.bbox, undefined, "nothing was drawn, so nothing changed on screen");
      assert.match(r.note, /^(nothing changed|no significant change) vs s\d+: /);
      assert.match(r.note, /last mutation \(add marker\) ran with redraw:\[\]/);
      const plain2 = JSON.parse(textOf(await call("screenshot", { compare: b2 })));
      assert.match(plain2.compare.hint, /redraw:\[\]/);
      // drawn this time: the hint is gone and the change shows
      await h.ok("add", { type: "marker", items: [{ at: { x: 190, y: 600 } }] });
      const shown = JSON.parse(textOf(await call("screenshot", { compare: b2, crop: "changed" })));
      assert.ok(shown.compare.bbox, JSON.stringify(shown).slice(0, 300));
      assert.equal(shown.note, undefined);
      for (let k = 0; k < 3; k++) await h.ok("snapshot", { action: "undo" });
    });

    test("the redraw hint belongs to the newest mutation: an undo or a later edit retires it", async () => {
      const b4 = (await h.ok("screenshot", { target: { bbox: frame } })).shotId as string;
      await h.ok("edit", { type: "burg", ops: [{ ref: 2, set: { population: 777 } }], redraw: [] });
      const a = JSON.parse(textOf(await call("screenshot", { compare: b4, crop: "changed" })));
      assert.match(a.note, /ran with redraw:\[\]/);
      await h.ok("edit", { type: "burg", ops: [{ ref: 3, set: { population: 778 } }] });
      const later = JSON.parse(textOf(await call("screenshot", { compare: b4, crop: "changed" })));
      assert.ok(!String(later.note ?? "").includes("redraw:[]"), "a newer drawn edit replaces it");
      await h.ok("edit", { type: "burg", ops: [{ ref: 2, set: { population: 779 } }], redraw: [] });
      await h.ok("snapshot", { action: "undo" });
      const undone = JSON.parse(textOf(await call("screenshot", { compare: b4, crop: "changed" })));
      assert.ok(!String(undone.note ?? "").includes("redraw:[]"), "undone: not blamed");
      for (let k = 0; k < 2; k++) await h.ok("snapshot", { action: "undo" });
    });

    test("a mutation that only touched a hidden layer is named in the note", async () => {
      await h.ok("display", { off: ["markers"] });
      const b3 = (await h.ok("screenshot", { target: { bbox: frame } })).shotId as string;
      await h.ok("add", { type: "marker", items: [{ at: { x: 230, y: 570 } }] });
      const r = JSON.parse(textOf(await call("screenshot", { compare: b3, crop: "changed" })));
      assert.match(r.note, /only touched hidden layers \(markers\)/);
      for (let k = 0; k < 2; k++) await h.ok("snapshot", { action: "undo" });
    });

    test("a change that fills the frame says the crop saves little; a bbox on the frame edge says so", async () => {
      const wide = (await h.ok("screenshot", { full: true })).shotId as string;
      await h.ok("display", { only: ["heightmap"] });
      const r = JSON.parse(textOf(await call("screenshot", { compare: wide, crop: "changed", full: true })));
      await h.ok("snapshot", { action: "undo" });
      assert.match(String(r.compare.spread), /^the shown region is \d+% of the frame, so the crop saves little/);
      assert.ok(Array.isArray(r.compare.touchesEdge) && r.compare.touchesEdge.length > 0, JSON.stringify(r.compare));
    });

    test("plain compare is unchanged (diff image, diffFile, pixelHint)", async () => {
      const r = await call("screenshot", { compare: base });
      const body = JSON.parse(textOf(r));
      assert.equal(images(r).length, 1);
      assert.ok(fs.existsSync(body.compare.diffFile));
      assert.ok(body.pixelHint && body.png && body.mapBboxShown);
      assert.equal(body.compare.bbox, undefined);
    });
  });

  test("token savings on demo.map (informational)", async () => {
    const pairs: Array<[string, number, number]> = [];
    const size = async (name: string, a: Record<string, unknown>, b: Record<string, unknown>) => {
      const x = textOf(await call(name, a)).length;
      const y = textOf(await call(name, b)).length;
      pairs.push([`${name} ${JSON.stringify(b).slice(0, 60)}`, x, y]);
      assert.ok(y < x, `${name}: ${y} vs ${x}`);
    };
    await size("find", { type: "burg", limit: 25 }, { type: "burg", limit: 25, format: "compact" });
    await size(
      "find",
      { type: "state", sort: "-population", limit: 10 },
      { type: "state", sort: "-population", limit: 10, format: "compact" }
    );
    await size(
      "inspect",
      { entity: { type: "burg", ref: 1 } },
      { entity: { type: "burg", ref: 1 }, format: "compact" }
    );
    await size("inspect", { at: { x: 216.9, y: 585.1 } }, { at: { x: 216.9, y: 585.1 }, format: "compact" });
    if (process.env.TUPAIA_TEST_VERBOSE) for (const [k, x, y] of pairs) console.log(`${k}: ${x} -> ${y}`);
  });
});
