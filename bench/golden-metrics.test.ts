import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import type { Rgba } from "./fidelity-metrics.ts";
import { type CellMetrics, COVERAGE, censusDrift, coverageOf, D1, DEFAULT_READING, FAINT, heatmap, isFaint, judgeCell, measureCell, MIN_INK_PIXELS } from "./golden-metrics.ts";
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

test("over44 reading (the D11 default): at most 0.5 % of pixels beyond Δ 44", () => {
  assert.equal(DEFAULT_READING, "over44");
  assert.equal(measureCell(svg, perturb(svg, 60, 44), white).over44Fraction, 0, "Δ = 44 is within");
  assert.equal(judge(perturb(svg, 50, 45)).gates.over44, true);
  const over = judge(perturb(svg, 51, 45));
  assert.equal(over.pass, false, "the default gates on over44");
  assert.match(over.failures.join(), /over44 0\.510%/);
});

test("conservative is the strict reading: changed ≤ 0.5 % and max Δ ≤ 44, opt-in, always reported", () => {
  const few = perturb(svg, 50, 44);
  assert.equal(judge(few, {}, "conservative").pass, true);
  const many = perturb(svg, 51, 1); // tiny deltas, but more than 0.5 % changed: invisible rounding
  assert.equal(judge(many, {}, "conservative").gates.conservative, false);
  assert.equal(judge(many, {}, "conservative").pass, false);
  assert.match(judge(many, {}, "conservative").failures.join(), /conservative: changed 0\.510%/);
  const relaxed = judge(many);
  assert.equal(relaxed.pass, true, "over44 ignores rounding");
  assert.equal(relaxed.gates.conservative, false, "the strict verdict is still in the report");
  assert.match(relaxed.notes.join(), /strict reading fails/);
  const spike = perturb(svg, 1, 100);
  assert.equal(judge(spike, {}, "conservative").gates.conservative, false, "one pixel over Δ44 fails it");
  assert.equal(judge(spike, {}, "conservative").pass, false);
});

// A sparse layer on a big frame: whole-frame fractions are diluted, so only the coverage gate sees a loss.
const BW = 800;
const BH = 400; // 320 000 px: 1 % = 3200 px, 0.5 % = 1600 px
const bigWhite = image(BW, BH, () => [255, 255, 255]);
// vertical strokes `width` px wide every 200 px (rivers, borders), and 6×6 icons every 50 px (burgs, markers)
const strokes = (width: number) => (x: number, _y: number): [number, number, number] => (x % 200 < width ? [40, 70, 120] : [255, 255, 255]);
const icons = (keep: (i: number) => boolean) => (x: number, y: number): [number, number, number] =>
  x % 50 < 6 && y % 50 < 6 && keep(Math.floor(x / 50) + 16 * Math.floor(y / 50)) ? [120, 30, 30] : [255, 255, 255];
const judgeBig = (s: Rgba, g: Rgba, reading?: "over44" | "conservative") =>
  judgeCell({ metrics: measureCell(s, g, bigWhite), census: counts, domDrawables: 4 }, reading);
const wholeFrame = (v: ReturnType<typeof judgeCell>) => v.gates.ssim && v.gates.over16 && v.gates.over44;

test("coverage: a thinner stroke passes every whole-frame gate and fails on the layer's own ink", () => {
  const v = judgeBig(image(BW, BH, strokes(3)), image(BW, BH, strokes(2))); // a third of the ink gone (W1 rivers k 1: 0.66)
  assert.equal(wholeFrame(v), true, "0.5 % of the frame: invisible to SSIM, over16 and over44");
  assert.equal(v.gates.coverageInk, false);
  assert.equal(v.gates.coverageOver16, false);
  assert.equal(v.pass, false);
  assert.match(v.failures.join(), /coverage: ink 3200 GPU vs 4800 SVG px \(ratio 0\.667 < 0\.9\)/);
  assert.match(v.failures.join(), /coverage: over16 is 33\.333% of the layer's ink \(max 20\.000%\)/);
  assert.equal(judgeBig(image(BW, BH, strokes(3)), image(BW, BH, strokes(2)), "conservative").gates.coverage, false, "gated under the strict reading too");
});

test("coverage: dropped icons pass the whole-frame gates and fail the ink rule", () => {
  const v = judgeBig(image(BW, BH, icons(() => true)), image(BW, BH, icons(i => i % 8 !== 0))); // 1 in 8 dropped
  assert.equal(wholeFrame(v), true, "0.18 % of the frame");
  assert.equal(v.gates.coverageInk, false);
  assert.equal(v.gates.coverageOver16, true, "12.5 % of the layer's ink differs: under the 20 % cap");
  assert.equal(v.pass, false);
  assert.match(v.failures.join(), /coverage: ink 4032 GPU vs 4608 SVG px \(ratio 0\.875 < 0\.9\)/);
});

test("coverage: extra GPU ink (a heavier stroke) fails the symmetric ink rule", () => {
  const v = judgeBig(image(BW, BH, strokes(2)), image(BW, BH, strokes(3)));
  assert.equal(wholeFrame(v), true);
  assert.equal(v.gates.coverageInk, false, "GPU 1.5× the SVG's ink");
  assert.equal(v.pass, false);
});

test("coverage: a colour shift on half the layer fails over16-of-ink, not the ink rule", () => {
  const tinted = image(BW, BH, (x, y) => (x % 200 < 3 && y < BH / 2 ? [80, 100, 140] : strokes(3)(x, y)));
  const v = judgeBig(image(BW, BH, strokes(3)), tinted);
  assert.equal(wholeFrame(v), true, "Δ 40: over16 0.75 % of the frame, nothing over 44");
  assert.equal(v.gates.coverageInk, true, "same footprint");
  assert.equal(v.gates.coverageOver16, false, "half the layer's ink differs by more than 16");
  assert.equal(v.pass, false);
});

test("coverage: anti-aliased edges alone pass", () => {
  // 6-px strokes; the GPU adds a light edge pixel on every other row (an AA fringe the SVG lacks)
  const fringe = image(BW, BH, (x, y) => (x % 200 === 6 && y % 2 === 0 ? [200, 210, 225] : strokes(6)(x, y)));
  const m = measureCell(image(BW, BH, strokes(6)), fringe, bigWhite);
  assert.ok(m.inkRatio < 1 && m.inkRatio >= COVERAGE.inkRatioMin, `ratio ${m.inkRatio}`);
  assert.ok(m.over16OfInk > 0.05 && m.over16OfInk < COVERAGE.over16OfInkMax, `over16 of ink ${m.over16OfInk}`);
  assert.equal(judgeBig(image(BW, BH, strokes(6)), fringe).pass, true);
});

test("coverage: tiny layers get a 16 px slack, so a 30-pixel layer is judged on whole pixels, not ratios", () => {
  const dot = (n: number) => image(W, H, (x, y) => (y * W + x < n ? [0, 0, 0] : [255, 255, 255]));
  const thirty = dot(30);
  // 30 px vs 27 px: ratio 0.9 → passes; 30 vs 20: ratio 0.67 but within the slack (20 ≥ 27 − 16) → passes
  assert.equal(judgeCell({ metrics: measureCell(thirty, dot(20), white), census: counts, domDrawables: 1 }).gates.coverage, true);
  // 30 vs 10: beyond the slack → fails
  const ten = judgeCell({ metrics: measureCell(thirty, dot(10), white), census: counts, domDrawables: 1 });
  assert.equal(ten.gates.coverageInk, false);
  assert.equal(ten.pass, false);
  // the slack is absolute (16 px): on a 10 000-px layer it moves the bounds by 0.16 % and nothing more
  assert.deepEqual(coverageOf({ inkSvg: 10000, inkGpu: 8984, inkUnion: 10000, over16Px: 0 }), { ink: true, over16: true });
  assert.deepEqual(coverageOf({ inkSvg: 10000, inkGpu: 8983, inkUnion: 10000, over16Px: 0 }), { ink: false, over16: true });
  assert.deepEqual(coverageOf({ inkSvg: 10000, inkGpu: 9000, inkUnion: 10000, over16Px: 2016 }), { ink: true, over16: true });
  assert.deepEqual(coverageOf({ inkSvg: 10000, inkGpu: 9000, inkUnion: 10000, over16Px: 2017 }), { ink: true, over16: false });
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

// FAINT layers. A layer at 0.008 opacity is 0.18 of a code value at its strongest, so each renderer's rounding decides
// which of its pixels reach a whole value: the same footprint, a different ink count (legacy-v1.99 ice, 3164 vs 3618).
// `faintShot(w, eighths)` is the strokes(w) footprint with `eighths` of every 8 pixels rounded to 254 (what the arm's
// rounding happens to produce) and the rest left at 255.
const faintShot = (width: number, eighths: number) => (x: number, y: number): [number, number, number] =>
  x % 200 < width && (x * 7 + y * 3) % 8 < eighths ? [254, 254, 254] : [255, 255, 255];
const judgeFaint = (s: Rgba, g: Rgba, lifted: Rgba[] | null) =>
  judgeCell({
    metrics: measureCell(s, g, bigWhite),
    census: counts,
    domDrawables: 4,
    lifted: lifted && measureCell(lifted[0], lifted[1], bigWhite)
  });

test("faint: the contrast is the layer's strongest pixel over both arms, and a normal layer is not faint", () => {
  assert.equal(FAINT.maxContrast, 3, "changing this is a gate change (golden-metrics.ts FAINT says why)");
  const faintSvg = image(BW, BH, faintShot(6, 5));
  assert.equal(measureCell(faintSvg, faintSvg, bigWhite).contrast, 1);
  assert.equal(isFaint(measureCell(faintSvg, faintSvg, bigWhite)), true);
  assert.equal(isFaint(measureCell(image(BW, BH, strokes(3)), image(BW, BH, strokes(3)), bigWhite)), false, "Δ 215 is a normal layer");
  // either arm's contrast counts: a GPU that paints a faint layer at full strength is not faint
  const loud = measureCell(faintSvg, image(BW, BH, strokes(6)), bigWhite);
  assert.equal(loud.contrast, 215);
  assert.equal(isFaint(loud), false);
  assert.equal(measureCell(white, white, white).contrast, 0);
});

test("faint: rounding alone moves the plain ink ratio below the floor and the lifted capture judges the layer", () => {
  const svgFaint = image(BW, BH, faintShot(6, 5));
  const gpuFaint = image(BW, BH, faintShot(6, 6)); // same footprint, rounded to a different set of whole values
  const plain = judgeFaint(svgFaint, gpuFaint, null);
  assert.equal(plain.gates.coverageInk, false, `plain ink ratio ${measureCell(svgFaint, gpuFaint, bigWhite).inkRatio}`);
  assert.deepEqual(plain.faint, { contrast: 1, lifted: false });
  assert.match(plain.notes.join(), /the lift was not captured/);
  const v = judgeFaint(svgFaint, gpuFaint, [image(BW, BH, strokes(6)), image(BW, BH, strokes(6))]);
  assert.equal(v.pass, true, v.failures.join());
  assert.deepEqual(v.faint, { contrast: 1, lifted: true });
  assert.match(v.notes.join(), /faint layer \(contrast 1 code value\): coverage judged at full opacity/);
});

test("faint: a real gap on a faint layer still fails, on the lifted capture", () => {
  const svgFaint = image(BW, BH, faintShot(6, 5));
  const gpuFaint = image(BW, BH, faintShot(6, 6));
  // thinner strokes, a third of the ink gone
  const thin = judgeFaint(svgFaint, gpuFaint, [image(BW, BH, strokes(6)), image(BW, BH, strokes(4))]);
  assert.equal(thin.pass, false);
  assert.match(thin.failures.join(), /coverage at full opacity: ink 6400 GPU vs 9600 SVG px \(ratio 0\.667 < 0\.9\)/);
  // dropped icons
  const dropped = judgeFaint(svgFaint, gpuFaint, [image(BW, BH, icons(() => true)), image(BW, BH, icons(i => i % 3 !== 0))]);
  assert.equal(dropped.gates.coverageInk, false);
  // a colour shift on the lifted layer
  const tinted = image(BW, BH, (x, y) => (x % 200 < 3 && y < BH / 2 ? [80, 100, 140] : strokes(3)(x, y)));
  assert.equal(judgeFaint(svgFaint, gpuFaint, [image(BW, BH, strokes(3)), tinted]).gates.coverageOver16, false);
  // the layer missing from the GPU arm altogether
  const gone = judgeFaint(svgFaint, image(BW, BH, () => [255, 255, 255]), [image(BW, BH, strokes(6)), bigWhite]);
  assert.equal(gone.pass, false);
  assert.match(gone.failures.join(), /empty in GPU arm \(ink 0 px/);
});

test("faint: a layer too faint to show even lifted is judged on the plain capture, exactly as before", () => {
  const svgFaint = image(BW, BH, faintShot(6, 5));
  const gpuFaint = image(BW, BH, faintShot(6, 6));
  // the lift changed nothing (white on white; the opacity sits on children): contrast still ≤ 3
  const still = judgeFaint(svgFaint, gpuFaint, [svgFaint, gpuFaint]);
  assert.deepEqual(still.faint, { contrast: 1, lifted: false });
  assert.equal(still.gates.coverageInk, false);
  assert.match(still.notes.join(), /revealed nothing/);
});

test("faint: a lifted capture never rescues a normal layer", () => {
  const thin = judgeBig(image(BW, BH, strokes(3)), image(BW, BH, strokes(2)));
  assert.equal(thin.pass, false);
  const withLift = judgeCell({
    metrics: measureCell(image(BW, BH, strokes(3)), image(BW, BH, strokes(2)), bigWhite),
    census: counts,
    domDrawables: 4,
    lifted: measureCell(image(BW, BH, strokes(3)), image(BW, BH, strokes(3)), bigWhite)
  });
  assert.equal(withLift.pass, false, "contrast 215 > 3: the plain capture decides");
  assert.deepEqual(withLift.failures, thin.failures);
  assert.equal(withLift.faint, null);
});

test("faint: an opacity-0.008 layer that paints nothing in 8 bits is judged populated by its lifted capture", () => {
  const lifted = [image(BW, BH, strokes(6)), image(BW, BH, strokes(6))];
  const v = judgeFaint(bigWhite, bigWhite, lifted); // no plain ink at all
  assert.equal(v.pass, true, v.failures.join());
  assert.equal(judgeFaint(bigWhite, bigWhite, null).pass, false, "without a lift the same cell is empty");
  // no DOM drawables: nothing to lift, empty stands
  assert.match(judgeCell({ metrics: measureCell(bigWhite, bigWhite, bigWhite), census: counts, domDrawables: 0 }).failures.join(), /empty in SVG arm/);
});

test("D1 thresholds are the PROOF-PLAN §4 numbers; the D11 coverage numbers are pinned", () => {
  assert.deepEqual({ ...D1 }, { ssimMin: 0.95, over16Max: 0.01, over44Max: 0.005, conservativeChangedMax: 0.005, conservativeMaxDelta: 44 });
  // changing these is a gate change (golden-metrics.ts COVERAGE says why they are what they are)
  assert.deepEqual({ ...COVERAGE }, { inkRatioMin: 0.9, over16OfInkMax: 0.2, slackPx: 16 });
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
