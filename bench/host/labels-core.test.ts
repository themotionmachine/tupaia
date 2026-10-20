// node --test bench/host/labels-core.test.ts (part of `gate bench`)
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeGlyphKey,
  glyphBaseline,
  inkCount,
  labelHidden,
  matchGlyphs,
  probes,
  register,
  scaleBucket,
  strayInk,
  thresholds,
  zones
} from "./labels-core.ts";

test("labelHidden follows updateZoomStyling, overrides included", () => {
  const town = { desired: 4, hideLabels: true };
  // relative*k = rn((4 + 4/k)/2, 2) * k: 4 at k 1 (hidden, < 6), 10 at k 4
  assert.equal(labelHidden(town, 1), true);
  assert.equal(labelHidden(town, 4), false);
  assert.equal(labelHidden({ ...town, hideLabels: false }, 1), false);
  assert.equal(labelHidden({ ...town, always: true }, 1), false);
  assert.equal(labelHidden({ ...town, min: 3 }, 1), false);
  // states (22): 22*(k+1)/2 > 60 above k ≈ 4.45
  assert.equal(labelHidden({ desired: 22, hideLabels: true }, 4.4), false);
  assert.equal(labelHidden({ desired: 22, hideLabels: true }, 4.5), true);
  assert.equal(labelHidden({ desired: 22, hideLabels: true, max: 100 }, 4.5), false);
});

test("thresholds find each flip and probes straddle it", () => {
  const town = { desired: 4, hideLabels: true };
  const found = thresholds(town, 1, 20);
  // min flip near k = 2 (4*(k+1)/2 = 6), max flip near k = 29 is outside the extent
  assert.equal(found.length, 1);
  assert.ok(Math.abs(found[0].k - 2) < 0.01, `k ${found[0].k}`);
  assert.equal(found[0].below, true);
  assert.equal(found[0].above, false);
  const [zone] = zones(found);
  const sides = probes(zone, town, 1, 20);
  assert.deepEqual(
    sides.map(p => [p.side, p.hidden]),
    [
      ["below", true],
      ["above", false]
    ]
  );
  const states = thresholds({ desired: 22, hideLabels: true }, 1, 20);
  assert.equal(states.length, 1);
  assert.equal(states[0].below, false);
  assert.equal(states[0].above, true);
  assert.deepEqual(thresholds({ desired: 22, hideLabels: false }, 1, 20), []);
  assert.deepEqual(thresholds({ desired: 22, hideLabels: true, always: true }, 1, 20), []);
  // a probe outside the zoom extent is dropped
  assert.deepEqual(
    probes({ k0: 1.005, k1: 1.005, flips: 1 }, town, 1, 20).map(p => p.side),
    ["above"]
  );
});

test("zones merge flips closer than the probe span (rn() flicker)", () => {
  // city (5) flips three times within 0.004 around k 1.4; parity's parityLabels (14) likewise near 7.57
  for (const desired of [5, 14]) {
    const rule = { desired, hideLabels: true };
    const found = thresholds(rule, 1, 20);
    assert.ok(found.length >= 3, `${desired}: ${found.length} flips`);
    const merged = zones(found);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].flips, found.length);
    for (const p of probes(merged[0], rule, 1, 20)) assert.equal(labelHidden(rule, p.k), p.hidden);
    // no flip within 0.01 of either probe
    for (const p of probes(merged[0], rule, 1, 20)) assert.ok(found.every(t => Math.abs(t.k - p.k) >= 0.01 - 1e-6));
  }
});

const image = (width: number, height: number, ink: [number, number][]) => {
  const out = new Uint8Array(width * height);
  for (const [x, y] of ink) out[y * width + x] = 200;
  return out;
};

test("register recovers an integer shift and reports no shift for equal windows", () => {
  const glyph: [number, number][] = [];
  for (let y = 8; y < 14; y++) for (let x = 10; x < 13; x++) glyph.push([x, y]);
  glyph.push([13, 8], [14, 8], [15, 9]); // asymmetric so the score has one minimum
  const svg = image(32, 24, glyph);
  const moved = image(
    32,
    24,
    glyph.map(([x, y]) => [x + 2, y - 1])
  );
  const box = { x0: 8, y0: 6, x1: 18, y1: 16 };
  const same = register(svg, svg, 32, 24, box);
  assert.ok(same);
  assert.equal(same.dx, 0);
  assert.equal(same.dy, 0);
  const shifted = register(svg, moved, 32, 24, box);
  assert.ok(shifted);
  assert.ok(Math.abs(shifted.dx - 2) <= 0.5, `dx ${shifted.dx}`);
  assert.ok(Math.abs(shifted.dy + 1) <= 0.5, `dy ${shifted.dy}`);
  assert.ok(shifted.shift > 1.5);
  assert.equal(shifted.edge, false);
});

test("inkCount and strayInk count only uncovered candidate ink", () => {
  const ref = image(10, 10, [[1, 1]]);
  const cand = image(10, 10, [
    [1, 1],
    [5, 5],
    [8, 8]
  ]);
  assert.equal(inkCount(cand, 10, { x0: 0, y0: 0, x1: 10, y1: 10 }), 3);
  assert.equal(strayInk(cand, ref, 10, 10, []), 2);
  assert.equal(strayInk(cand, ref, 10, 10, [{ x0: 4, y0: 4, x1: 6, y1: 6 }]), 1);
});

test("decodeGlyphKey reads fill and halo keys, including a | character", () => {
  assert.deepEqual(decodeGlyphKey('normal 400 40px "Almendra SC"|0|N'), { font: 'normal 400 40px "Almendra SC"', halo: 0, char: "N" });
  assert.deepEqual(decodeGlyphKey("normal 400 8px Georgia|0||"), { font: "normal 400 8px Georgia", halo: 0, char: "|" });
  assert.deepEqual(decodeGlyphKey("normal 400 8px Georgia|4.4|round|4|a"), { font: "normal 400 8px Georgia", halo: 4.4, char: "a" });
  assert.equal(decodeGlyphKey("bad"), null);
});

test("glyphBaseline undoes text.ts cell placement", () => {
  // scale 2: a 20 px tall cell is 10 world units; top -16 px is -8 world; dy 5 → ly = 5 - 8 = -3
  const flat = glyphBaseline([100, 50, 0, -4, -3, 6, 10], { top: -16, height: 20 });
  assert.ok(flat);
  assert.ok(Math.abs(flat.x - 100) < 1e-9 && Math.abs(flat.y - 55) < 1e-9);
  // rotated 90°: the dy offset points along -x
  const turned = glyphBaseline([100, 50, Math.PI / 2, -4, -3, 6, 10], { top: -16, height: 20 });
  assert.ok(turned);
  assert.ok(Math.abs(turned.x - 95) < 1e-9 && Math.abs(turned.y - 50) < 1e-9);
});

test("matchGlyphs pairs nearest same characters once", () => {
  const svg = [
    { char: "a", x: 0, y: 0 },
    { char: "a", x: 10, y: 0 },
    { char: "b", x: 20, y: 0 }
  ];
  const gpu = [
    { char: "a", x: 10.4, y: 0 },
    { char: "a", x: 0.3, y: 0 },
    { char: "c", x: 20, y: 0 }
  ];
  const pairs = matchGlyphs(svg, gpu, 3);
  assert.deepEqual(
    pairs.map(p => [p.i, p.j]),
    [
      [0, 1],
      [1, 0]
    ]
  );
});

test("scaleBucket matches raster.ts", () => {
  assert.equal(scaleBucket(1), 1);
  assert.equal(scaleBucket(2), 2);
  assert.equal(scaleBucket(2.02), 4);
  assert.equal(scaleBucket(40), 16);
});
