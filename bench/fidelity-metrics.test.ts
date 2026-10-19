import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateGates,
  gaussianKernel1D,
  type Rgba,
  rgbDiff,
  SSIM_C1,
  SSIM_C2,
  ssim,
  ssimGray,
  toGray,
  validateRgba,
} from "./fidelity-metrics.ts";

function image(width: number, height: number, f: (x: number, y: number) => [number, number, number]): Rgba {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = f(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

const gray = (v: number): [number, number, number] => [v, v, v];
// Deterministic structured texture with a broad value range.
const texture = (x: number, y: number) => gray((x * 37 + y * 91 + ((x * y) % 13) * 11) % 256);

// Independent slow reference: explicit 2D Gaussian built from the 2D formula, direct weighted moments per window.
function slowSsim(a: Rgba, b: Rgba): number {
  const size = 11, r = 5, sigma = 1.5;
  const w2 = new Float64Array(size * size);
  let total = 0;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      w2[j * size + i] = Math.exp(-((i - r) ** 2 + (j - r) ** 2) / (2 * sigma * sigma));
      total += w2[j * size + i];
    }
  }
  for (let i = 0; i < w2.length; i++) w2[i] /= total;
  const gx = toGray(a), gy = toGray(b);
  let sum = 0, n = 0;
  for (let cy = r; cy < a.height - r; cy++) {
    for (let cx = r; cx < a.width - r; cx++) {
      let mx = 0, my = 0;
      for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
        const p = (cy - r + j) * a.width + (cx - r + i);
        mx += w2[j * size + i] * gx[p];
        my += w2[j * size + i] * gy[p];
      }
      // Central-moment form, so the reference does not share the E[x²] − μ² path.
      let vx = 0, vy = 0, cov = 0;
      for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
        const p = (cy - r + j) * a.width + (cx - r + i);
        const w = w2[j * size + i];
        vx += w * (gx[p] - mx) ** 2;
        vy += w * (gy[p] - my) ** 2;
        cov += w * (gx[p] - mx) * (gy[p] - my);
      }
      sum += ((2 * mx * my + SSIM_C1) * (2 * cov + SSIM_C2)) / ((mx * mx + my * my + SSIM_C1) * (vx + vy + SSIM_C2));
      n++;
    }
  }
  return sum / n;
}

test("kernel is 11 taps, symmetric, unit sum, peak at centre with σ = 1.5 ratio", () => {
  const k = gaussianKernel1D();
  assert.equal(k.length, 11);
  assert.ok(Math.abs(k.reduce((s, v) => s + v, 0) - 1) < 1e-15);
  for (let i = 0; i < 5; i++) assert.equal(k[i], k[10 - i]);
  assert.ok(Math.abs(k[6] / k[5] - Math.exp(-1 / 4.5)) < 1e-14);
  assert.throws(() => gaussianKernel1D(10, 1.5));
  assert.throws(() => gaussianKernel1D(11, 0));
});

test("identical images give SSIM exactly 1 and zero diff", () => {
  const a = image(32, 24, texture);
  const s = ssim(a, a);
  assert.equal(s.ssim, 1);
  assert.equal(s.windows, 22 * 14);
  assert.equal(s.border, 5);
  const d = rgbDiff(a, a);
  assert.equal(d.changed, 0);
  assert.equal(d.maxDelta, 0);
});

test("constant images match the analytical luminance-only formula", () => {
  for (const [p, q] of [[100, 120], [0, 255], [30, 31], [200, 10]]) {
    const s = ssim(image(16, 16, () => gray(p)), image(16, 16, () => gray(q))).ssim;
    const expected = (2 * p * q + SSIM_C1) / (p * p + q * q + SSIM_C1);
    assert.ok(Math.abs(s - expected) < 1e-12, `${p}/${q}: ${s} vs ${expected}`);
  }
});

test("grayscale uses 0.299/0.587/0.114 without rounding", () => {
  const g = toGray(image(1, 1, () => [10, 20, 30]));
  assert.ok(Math.abs(g[0] - (2.99 + 11.74 + 3.42)) < 1e-12);
});

test("a 1 px structural shift scores below 1, and SSIM is symmetric", () => {
  const a = image(40, 30, texture);
  const b = image(40, 30, (x, y) => texture(x + 1, y));
  const ab = ssim(a, b).ssim;
  const ba = ssim(b, a).ssim;
  assert.ok(ab < 0.99 && ab > -1, `ssim ${ab}`);
  assert.ok(Math.abs(ab - ba) < 1e-12);
});

test("separable implementation matches the slow direct 2D reference", () => {
  const a = image(23, 19, texture);
  const b = image(23, 19, (x, y) => {
    const v = texture(x, y);
    return [Math.min(255, v + ((x + y) % 7)), Math.max(0, v - (x % 5) * 3), (v * 3) % 256];
  });
  const fast = ssim(a, b).ssim;
  const slow = slowSsim(a, b);
  assert.ok(Math.abs(fast - slow) < 1e-10, `${fast} vs ${slow}`);
  // Exactly 11x11 is a single window; that window must match too.
  const a1 = image(11, 11, texture), b1 = image(11, 11, (x, y) => texture(y, x));
  const one = ssim(a1, b1);
  assert.equal(one.windows, 1);
  assert.ok(Math.abs(one.ssim - slowSsim(a1, b1)) < 1e-10);
});

test("5 px border: corner change touches one window only, and RGB metrics still count it", () => {
  const a = image(30, 30, texture);
  const b = image(30, 30, (x, y) => (x === 0 && y === 0 ? [0, 255, 0] : texture(x, y)));
  // Corner pixel (0,0) lies only in the window centred at (5,5); the other 399 windows stay exactly 1.
  const s = ssim(a, b);
  assert.equal(s.windows, 400);
  const crop = (img: Rgba) => image(11, 11, (x, y) => {
    const i = (y * 30 + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  });
  const local = slowSsim(crop(a), crop(b));
  assert.ok(local < 1);
  assert.ok(Math.abs(s.ssim * 400 - 399 - local) < 1e-9);
  const d = rgbDiff(a, b);
  assert.equal(d.changed, 1);
  assert.equal(d.pixels, 900);
});

test("negative covariance (inverted structure) gives negative local SSIM", () => {
  const a = image(11, 11, texture);
  const b = image(11, 11, (x, y) => gray(255 - texture(x, y)[0]));
  const s = ssimGray(toGray(a), toGray(b), 11, 11);
  assert.ok(s.ssim < 0, `ssim ${s.ssim}`);
});

test("rejects malformed, non-finite, translucent and too-small input", () => {
  const ok = image(12, 12, texture);
  assert.throws(() => validateRgba({ width: 12, height: 12, data: new Uint8Array(10) }));
  assert.throws(() => validateRgba({ width: 0, height: 12, data: new Uint8Array(0) }));
  assert.throws(() => validateRgba({ width: 1.5, height: 2, data: new Uint8Array(12) }));
  assert.throws(() => validateRgba({ width: 1, height: 1, data: [0, 0, Number.NaN, 255] }));
  const translucent = new Uint8ClampedArray(ok.data as Uint8ClampedArray);
  translucent[7] = 254;
  assert.throws(() => ssim(ok, { width: 12, height: 12, data: translucent }), /alpha/);
  assert.throws(() => ssim(ok, image(12, 11, texture)), /mismatch/);
  assert.throws(() => ssim(image(10, 20, texture), image(10, 20, texture)), /smaller/);
  const nan = toGray(ok);
  nan[3] = Number.NaN;
  assert.throws(() => ssimGray(toGray(ok), nan, 12, 12), /non-finite/);
});

test("RGB diff uses max channel delta and strict > thresholds", () => {
  const a = image(4, 1, () => gray(100));
  const b = image(4, 1, (x) => [[100, 100, 100], [100, 116, 100], [100, 100, 117], [145, 100, 100]][x] as [number, number, number]);
  const d = rgbDiff(a, b);
  assert.deepEqual([d.changed, d.over16, d.over44, d.maxDelta], [3, 2, 1, 45]);
  assert.equal(d.changedFraction, 0.75);
  assert.equal(d.meanMaxChannelDelta, (16 + 17 + 45) / 4);
});

test("gates: SSIM, over16 and the conservative reference interpretation are separate", () => {
  const base = { width: 1, height: 1, pixels: 1000, changed: 5, over16: 10, over44: 0, over44Fraction: 0, meanMaxChannelDelta: 0 };
  const pass = evaluateGates(0.95, { ...base, changedFraction: 0.005, over16Fraction: 0.01, maxDelta: 44 });
  assert.deepEqual(pass, { ssimPass: true, over16Pass: true, conservativeReferencePass: true });
  const fail = evaluateGates(0.9499, { ...base, changedFraction: 0.0051, over16Fraction: 0.0101, maxDelta: 44 });
  assert.deepEqual(fail, { ssimPass: false, over16Pass: false, conservativeReferencePass: false });
  assert.equal(evaluateGates(1, { ...base, changedFraction: 0, over16Fraction: 0, maxDelta: 45 }).conservativeReferencePass, false);
  assert.throws(() => evaluateGates(Number.NaN, { ...base, changedFraction: 0, over16Fraction: 0, maxDelta: 0 }));
});
