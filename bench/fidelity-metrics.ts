// Pure fidelity math for the G-C pixel gates (PROOF-PLAN §4). No I/O, no DOM.
//
// SSIM follows the local-window definition in Wang, Bovik, Sheikh, Simoncelli, "Image Quality Assessment:
// From Error Visibility to Structural Similarity", IEEE TIP 13(4), 2004 (https://www.cns.nyu.edu/pub/eero/wang03-reprint.pdf):
// §III gives the local SSIM index, §IV the 11x11 circular-symmetric Gaussian window (σ = 1.5, normalised to unit sum)
// with weighted local statistics, mean pooling over windows, and K1 = 0.01, K2 = 0.03. The author page
// (https://ece.uwaterloo.ca/~z70wang/research/ssim/) describes full-reference use on grayscale. Implemented
// independently from those definitions; no reference code was copied.
//
// Pinned profile (our choice, not a claim of bit equality with any published implementation):
// - native device pixels: no resize, downsample, alignment search, mask, ROI or blur preprocessing;
// - grayscale intensity Y = 0.299 R + 0.587 G + 0.114 B on 8-bit sRGB code values, kept in float64 (no rounding);
// - L = 255, C1 = (0.01 L)^2, C2 = (0.03 L)^2;
// - weighted population moments: μ = Σ w x, σ² = Σ w x² − μ², σxy = Σ w x y − μx μy;
// - window centres only where the full 11x11 window fits (a 5 px border is excluded); mean over those centres.
// Every pixel must have alpha 255, or the image is rejected.

export const SSIM_WINDOW = 11;
export const SSIM_SIGMA = 1.5;
export const SSIM_RADIUS = (SSIM_WINDOW - 1) / 2;
export const SSIM_L = 255;
export const SSIM_K1 = 0.01;
export const SSIM_K2 = 0.03;
export const SSIM_C1 = (SSIM_K1 * SSIM_L) ** 2;
export const SSIM_C2 = (SSIM_K2 * SSIM_L) ** 2;
export const LUMA = [0.299, 0.587, 0.114] as const;

// E[x²] − μ² can come out a few ulps below zero on flat windows. Values in [−VARIANCE_ROUNDOFF, 0) are left as they
// are (C2 = 58.5 dominates them, so they cannot move SSIM measurably); anything more negative means a bug and throws.
// SSIM itself is never clamped.
export const VARIANCE_ROUNDOFF = 1e-6;

export const GATES = {
  ssimMin: 0.95,
  over16Max: 0.01,
  // Conservative reading of "whole-frame diff ≤0.5% of pixels at delta ≤44" (labelled interpretation, see report).
  referenceChangedMax: 0.005,
  referenceMaxDelta: 44,
} as const;

export interface Rgba {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

export function validateRgba(img: Rgba, label = "image"): void {
  const { width, height, data } = img;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`${label}: invalid dimensions ${width}x${height}`);
  }
  if (!data || data.length !== width * height * 4) {
    throw new Error(`${label}: data length ${data?.length} does not match ${width}x${height}x4`);
  }
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error(`${label}: non-8-bit value at ${i}`);
    if ((i & 3) === 3 && v !== 255) throw new Error(`${label}: alpha ${v} at pixel ${i >> 2}, expected 255`);
  }
}

function assertSameSize(a: Rgba, b: Rgba): void {
  validateRgba(a, "reference");
  validateRgba(b, "candidate");
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
}

/** 1D Gaussian taps normalised to unit sum. The outer product is the normalised 2D Gaussian exactly. */
export function gaussianKernel1D(size = SSIM_WINDOW, sigma = SSIM_SIGMA): Float64Array {
  if (!Number.isInteger(size) || size < 1 || size % 2 === 0) throw new Error(`kernel size must be odd, got ${size}`);
  if (!(sigma > 0) || !Number.isFinite(sigma)) throw new Error(`invalid sigma ${sigma}`);
  const r = (size - 1) / 2;
  const k = new Float64Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    k[i] = Math.exp(-((i - r) ** 2) / (2 * sigma * sigma));
    sum += k[i];
  }
  for (let i = 0; i < size; i++) k[i] /= sum;
  return k;
}

export function toGray(img: Rgba): Float64Array {
  const n = img.width * img.height;
  const out = new Float64Array(n);
  const d = img.data;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    out[p] = LUMA[0] * d[i] + LUMA[1] * d[i + 1] + LUMA[2] * d[i + 2];
  }
  return out;
}

/** SSIM from weighted local statistics (Wang et al. 2004, eq. 13 with weighted moments). */
export function ssimFromMoments(mx: number, my: number, vx: number, vy: number, cov: number): number {
  return ((2 * mx * my + SSIM_C1) * (2 * cov + SSIM_C2)) / ((mx * mx + my * my + SSIM_C1) * (vx + vy + SSIM_C2));
}

export interface SsimResult {
  ssim: number;
  windows: number;
  border: number;
  minSsim: number;
  minVariance: number;
}

/**
 * Mean local SSIM over valid window centres, computed with a separable Gaussian. Horizontal sums are kept in a
 * ring of 11 rows, so memory is O(width) beyond the two grayscale planes.
 */
export function ssimGray(x: Float64Array, y: Float64Array, width: number, height: number): SsimResult {
  if (x.length !== width * height || y.length !== width * height) throw new Error("gray plane size mismatch");
  if (width < SSIM_WINDOW || height < SSIM_WINDOW) {
    throw new Error(`image ${width}x${height} smaller than the ${SSIM_WINDOW}x${SSIM_WINDOW} window`);
  }
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) throw new Error(`non-finite gray value at ${i}`);
  }
  const k = gaussianKernel1D();
  const W = SSIM_WINDOW;
  const ow = width - W + 1;
  const oh = height - W + 1;
  // ring[row % W][q] holds horizontal sums of x, y, x², y², xy for one input row.
  const ring = Array.from({ length: W }, () => Array.from({ length: 5 }, () => new Float64Array(ow)));
  const fillRow = (row: number) => {
    const [sx, sy, sxx, syy, sxy] = ring[row % W];
    const base = row * width;
    for (let c = 0; c < ow; c++) {
      let a = 0, b = 0, aa = 0, bb = 0, ab = 0;
      for (let t = 0; t < W; t++) {
        const w = k[t];
        const xv = x[base + c + t];
        const yv = y[base + c + t];
        a += w * xv;
        b += w * yv;
        aa += w * xv * xv;
        bb += w * yv * yv;
        ab += w * xv * yv;
      }
      sx[c] = a; sy[c] = b; sxx[c] = aa; syy[c] = bb; sxy[c] = ab;
    }
  };
  for (let r = 0; r < W - 1; r++) fillRow(r);
  let sum = 0;
  let minSsim = Infinity;
  let minVariance = Infinity;
  for (let orow = 0; orow < oh; orow++) {
    fillRow(orow + W - 1);
    for (let c = 0; c < ow; c++) {
      let mx = 0, my = 0, ex2 = 0, ey2 = 0, exy = 0;
      for (let t = 0; t < W; t++) {
        const w = k[t];
        const q = ring[(orow + t) % W];
        mx += w * q[0][c];
        my += w * q[1][c];
        ex2 += w * q[2][c];
        ey2 += w * q[3][c];
        exy += w * q[4][c];
      }
      const vx = ex2 - mx * mx;
      const vy = ey2 - my * my;
      const cov = exy - mx * my;
      const v = Math.min(vx, vy);
      if (v < minVariance) minVariance = v;
      if (v < -VARIANCE_ROUNDOFF) throw new Error(`negative variance ${v} beyond roundoff at (${c}, ${orow})`);
      const s = ssimFromMoments(mx, my, vx, vy, cov);
      if (!Number.isFinite(s)) throw new Error(`non-finite SSIM at (${c}, ${orow})`);
      if (s < minSsim) minSsim = s;
      sum += s;
    }
  }
  const windows = ow * oh;
  return { ssim: sum / windows, windows, border: SSIM_RADIUS, minSsim, minVariance };
}

export function ssim(a: Rgba, b: Rgba): SsimResult {
  assertSameSize(a, b);
  return ssimGray(toGray(a), toGray(b), a.width, a.height);
}

export interface RgbDiff {
  width: number;
  height: number;
  pixels: number;
  changed: number;
  over16: number;
  over44: number;
  changedFraction: number;
  over16Fraction: number;
  over44Fraction: number;
  maxDelta: number;
  meanMaxChannelDelta: number;
}

/** Per-pixel delta is max(|ΔR|, |ΔG|, |ΔB|) over every pixel, border included. */
export function rgbDiff(a: Rgba, b: Rgba): RgbDiff {
  assertSameSize(a, b);
  const pixels = a.width * a.height;
  let changed = 0, over16 = 0, over44 = 0, maxDelta = 0, total = 0;
  for (let p = 0; p < pixels; p++) {
    const i = p * 4;
    const d = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
    );
    if (d > 0) changed++;
    if (d > 16) over16++;
    if (d > 44) over44++;
    if (d > maxDelta) maxDelta = d;
    total += d;
  }
  return {
    width: a.width,
    height: a.height,
    pixels,
    changed,
    over16,
    over44,
    changedFraction: changed / pixels,
    over16Fraction: over16 / pixels,
    over44Fraction: over44 / pixels,
    maxDelta,
    meanMaxChannelDelta: total / pixels,
  };
}

export interface GateResult {
  ssimPass: boolean;
  over16Pass: boolean;
  /** Labelled interpretation: changedFraction ≤ 0.5% AND maxDelta ≤ 44. */
  conservativeReferencePass: boolean;
}

export function evaluateGates(s: number, d: RgbDiff): GateResult {
  if (!Number.isFinite(s) || !Number.isFinite(d.changedFraction) || !Number.isFinite(d.over16Fraction)) {
    throw new Error("non-finite metric");
  }
  return {
    ssimPass: s >= GATES.ssimMin,
    over16Pass: d.over16Fraction <= GATES.over16Max,
    conservativeReferencePass: d.changedFraction <= GATES.referenceChangedMax && d.maxDelta <= GATES.referenceMaxDelta,
  };
}
