import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import type { Rgba } from "./fidelity-metrics.ts";
import { type CellMetrics, censusDrift, D1, heatmap, judgeCell, measureCell, MIN_INK_PIXELS } from "./golden-metrics.ts";
import { decodePng, encodePng } from "./png.ts";

function image(width: number, height: number, f: (x: number, y: number) => [number, number, number]): Rgba {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      [data[i], data[i + 1], data[i + 2]] = f(x, y);
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

const W = 100;
const H = 100; // 10 000 px: 1 % = 100 px, 0.5 % = 50 px
const white = image(W, H, () => [255, 255, 255]);
// A layer: a dark diagonal band plus some texture, on the white background.
const layer = (x: number, y: number): [number, number, number] =>
  Math.abs(x - y) < 12 ? [40 + ((x * 7) % 30), 60, 90 + ((y * 5) % 40)] : [255, 255, 255];

// Copy of `base` with the first `count` ink pixels (in scan order) shifted by `by` in the red channel.
function perturb(base: Rgba, count: number, by: number): Rgba {
  const data = new Uint8Array(base.data as Uint8Array);
  let done = 0;
  for (let i = 0; i < data.length && done < count; i += 4) {
    if (data[i] === 255 && data[i + 1] === 255) continue;
    data[i] = Math.min(255, data[i] + by);
    done++;
  }
  assert.equal(done, count, "not enough ink pixels to perturb");
  return { width: base.width, height: base.height, data };
}

const svg = image(W, H, layer);
const counts = { native: 3, compat: 1, skipped: 0 };
const judge = (gpu: Rgba, extra: Partial<Parameters<typeof judgeCell>[0]> = {}, reading?: "over44" | "conservative") =>
  judgeCell({ metrics: measureCell(svg, gpu, white), census: counts, domDrawables: 4, ...extra }, reading);

test("identical arms: SSIM 1, no differing pixels, ink counted against the blank, pass", () => {
  const m = measureCell(svg, svg, white);
  assert.equal(m.ssim, 1);
  assert.equal(m.changedFraction, 0);
  assert.equal(m.over16Fraction, 0);
  assert.equal(m.over44Fraction, 0);
  assert.equal(m.maxDelta, 0);
  const ink = (svg.data as Uint8Array).reduce((n: number, v: number, i: number) => (i % 4 === 0 && v !== 255 ? n + 1 : n), 0);
  assert.equal(m.inkSvg, ink);
  assert.equal(m.inkGpu, ink);
  assert.equal(m.inkUnion, ink);
  assert.deepEqual(judge(svg).failures, []);
});

test("over16 is Δ > 16 over the whole frame and gates at ≤ 1 %", () => {
  assert.equal(measureCell(svg, perturb(svg, 100, 16), white).over16Fraction, 0, "Δ = 16 is not over 16");
  const at = judge(perturb(svg, 100, 17));
  assert.equal(at.gates.over16, true, "exactly 1 % passes");
  const over = judge(perturb(svg, 101, 17));
  assert.equal(over.gates.over16, false);
  assert.match(over.failures.join(), /over16 1\.010%/);
});

test("over44 reading: at most 0.5 % of pixels beyond Δ 44", () => {
  assert.equal(measureCell(svg, perturb(svg, 60, 44), white).over44Fraction, 0, "Δ = 44 is within");
  assert.equal(judge(perturb(svg, 50, 45)).gates.over44, true);
  const over = judge(perturb(svg, 51, 45));
  assert.equal(over.pass, false);
  assert.match(over.failures.join(), /over44 0\.510%/);
});

test("conservative reading: changed ≤ 0.5 % and max Δ ≤ 44, only gating when chosen", () => {
  const few = perturb(svg, 50, 44);
  assert.equal(judge(few, {}, "conservative").pass, true);
  const many = perturb(svg, 51, 1); // tiny deltas, but more than 0.5 % changed
  assert.equal(judge(many, {}, "conservative").gates.conservative, false);
  assert.equal(judge(many, {}, "conservative").pass, false);
  assert.equal(judge(many).pass, true, "the over44 reading ignores sub-16 deltas");
  const spike = perturb(svg, 1, 100);
  assert.equal(judge(spike, {}, "conservative").gates.conservative, false, "one pixel over Δ44 fails it");
});

test("SSIM catches a structural change that stays under the pixel-count gates' radar", () => {
  const shifted = image(W, H, (x, y) => layer(x + 3, y));
  const v = judge(shifted);
  assert.equal(v.gates.ssim, false, `ssim ${measureCell(svg, shifted, white).ssim}`);
  assert.equal(v.pass, false);
});

test("an empty layer fails in either arm", () => {
  const dropped = judge(white); // GPU painted nothing: a dropped path
  assert.equal(dropped.gates.populated, false);
  assert.match(dropped.failures.join(), /empty in GPU arm/);
  const neither = judgeCell({ metrics: measureCell(white, white, white), census: null, domDrawables: 0 });
  assert.equal(neither.pass, false, "two blank arms agree perfectly and still fail");
  assert.match(neither.failures.join(), /empty in SVG arm/);
  assert.match(neither.failures.join(), /empty in GPU arm/);
  const unrouted = judge(svg, { census: { native: 0, compat: 0, skipped: 5 } });
  assert.match(unrouted.failures.join(), /0 routed/);
  const tiny = image(W, H, (x, y) => (x === 0 && y < MIN_INK_PIXELS - 1 ? [0, 0, 0] : [255, 255, 255]));
  assert.equal(judgeCell({ metrics: measureCell(tiny, tiny, white), census: counts, domDrawables: 1 }).gates.populated, false);
});

test("each arm's ink is measured against its own blank", () => {
  // page chrome that blends one code value differently over the canvas than over the SVG
  const chrome = (img: Rgba, shift: number) => {
    const data = new Uint8Array(img.data as Uint8Array);
    for (let p = 0; p < 40; p++) data[p * 4] = 200 + shift;
    return { width: img.width, height: img.height, data };
  };
  const svgBlank = chrome(white, 0);
  const gpuBlank = chrome(white, 1);
  const shared = measureCell(chrome(white, 0), chrome(white, 1), svgBlank);
  assert.equal(shared.inkGpu, 40, "against the SVG blank the chrome looks like 40 px of GPU ink");
  const own = measureCell(chrome(white, 0), chrome(white, 1), svgBlank, gpuBlank);
  assert.equal(own.inkSvg, 0);
  assert.equal(own.inkGpu, 0);
  assert.equal(judgeCell({ metrics: own, census: counts, domDrawables: 1 }).gates.populated, false);
});

test("census expectations catch a silent routing change", () => {
  assert.deepEqual(censusDrift(counts, counts), []);
  assert.deepEqual(censusDrift(counts, { native: 2, compat: 2, skipped: 0 }), ["native 3→2", "compat 1→2"]);
  assert.deepEqual(censusDrift(counts, null), ["native 3→0", "compat 1→0"]);
  const v = judge(svg, { expected: { native: 4, compat: 1, skipped: 0 } });
  assert.equal(v.gates.census, false);
  assert.match(v.failures.join(), /census changed: native 4→3/);
});

test("judgeCell rejects non-finite metrics", () => {
  const m = { ...measureCell(svg, svg, white), ssim: Number.NaN } as CellMetrics;
  assert.throws(() => judgeCell({ metrics: m, census: counts, domDrawables: 1 }), /non-finite/);
});

test("D1 thresholds are the PROOF-PLAN §4 numbers", () => {
  assert.deepEqual({ ...D1 }, { ssimMin: 0.95, over16Max: 0.01, over44Max: 0.005, conservativeChangedMax: 0.005, conservativeMaxDelta: 44 });
});

test("heatmap colours each band and fades unchanged pixels", () => {
  const gpu = perturb(perturb(perturb(svg, 1, 10), 2, 30), 3, 100);
  const h = heatmap(svg, gpu);
  const colours = new Map<string, number>();
  for (let i = 0; i < h.data.length; i += 4) {
    const key = `${h.data[i]},${h.data[i + 1]},${h.data[i + 2]}`;
    colours.set(key, (colours.get(key) ?? 0) + 1);
  }
  // perturb() always starts from the first ink pixels, so pixel 0..2 overlap: 3 red, the rest unchanged.
  assert.equal(colours.get("220,20,20"), 3);
  assert.equal(h.data[3], 255);
  const white0 = heatmap(white, white);
  assert.equal(white0.data[0], 255, "white stays white when faded");
});

test("PNG codec round-trips RGBA and decodes every filter type in an RGB file", () => {
  const rgba = image(17, 9, (x, y) => [(x * 13) & 255, (y * 29) & 255, (x * y * 7) & 255]);
  assert.deepEqual(decodePng(encodePng(rgba)), { width: 17, height: 9, data: rgba.data });

  // Hand-built RGB PNG with rows filtered by types 0..4 in turn.
  const width = 6;
  const height = 5;
  const src = image(width, height, (x, y) => [(x * 40 + y * 3) & 255, (y * 50 + x) & 255, (x * y * 11 + 5) & 255]);
  const rgb = new Uint8Array(width * height * 3);
  for (let p = 0; p < width * height; p++) for (let c = 0; c < 3; c++) rgb[p * 3 + c] = src.data[p * 4 + c];
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = y % 5;
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const v = rgb[y * stride + x];
      const a = x >= 3 ? rgb[y * stride + x - 3] : 0;
      const b = y ? rgb[(y - 1) * stride + x] : 0;
      const c = x >= 3 && y ? rgb[(y - 1) * stride + x - 3] : 0;
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
      raw[y * (stride + 1) + 1 + x] = (v - predictor) & 255;
    }
  }
  const encoded = encodePng(src);
  // Swap the IDAT of a valid file for the hand-filtered RGB stream and patch IHDR's colour type to 2.
  const ihdrEnd = 8 + 8 + 13 + 4;
  const header = Buffer.from(encoded.subarray(0, ihdrEnd));
  header[8 + 8 + 9] = 2;
  header.writeUInt32BE(crc32(header.subarray(12, 8 + 8 + 13)) >>> 0, 8 + 8 + 13);
  const body = deflateSync(raw);
  const idat = Buffer.alloc(12 + body.length);
  idat.writeUInt32BE(body.length, 0);
  idat.write("IDAT", 4, "latin1");
  body.copy(idat, 8);
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  const decoded = decodePng(Buffer.concat([header, idat, iend]));
  assert.deepEqual(decoded.data, src.data);
});

test("PNG decoder fails closed on unsupported input", () => {
  assert.throws(() => decodePng(Buffer.from("not a png")), /not a PNG/);
  const png = Buffer.from(encodePng(image(2, 2, () => [1, 2, 3])));
  png[8 + 8 + 8] = 16; // bit depth 16
  assert.throws(() => decodePng(png), /bit depth 16/);
});
