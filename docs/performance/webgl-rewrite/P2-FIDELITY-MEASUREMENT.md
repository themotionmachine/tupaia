# P2 fidelity measurement: SSIM and raw RGB gates on the 8 fixed smoke pairs

Measurement only. The renderer and `dist` are frozen (fingerprint `f99596d6…0b00911`). There are no new captures, no navigation or smoke reruns, no deploy, no default flip and no production change. **The rewrite is not done.**

## 1. Result

| DPR | zoom | artifact (`p1-delegated-…`) | size | SSIM | SSIM ≥ 0.95 | changed (Δ>0) | over16 | over16 ≤ 1% | over44 | max Δ | conservative ref. (changed ≤ 0.5% AND max ≤ 44) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 1792147325190851000 | 1280×720 | 0.991810 | pass | 13.876% | 1.3214% | **fail** | 0.1179% | 137 | fail |
| 1 | 2 | 1792147369331737000 | 1280×720 | 0.993286 | pass | 13.608% | 0.7592% | pass | 0.0418% | 113 | fail |
| 1 | 4 | 1792147378036339000 | 1280×720 | 0.989899 | pass | 13.163% | 1.1817% | **fail** | 0.0292% | 125 | fail |
| 1 | 8 | 1792147386754457000 | 1280×720 | 0.996960 | pass | 10.663% | 0.2746% | pass | 0.0492% | 158 | fail |
| 2 | 1 | 1792147288671115000 | 2560×1440 | 0.983268 | pass | 17.603% | 1.8311% | **fail** | 0.6292% | 255 | fail |
| 2 | 2 | 1792147298488577000 | 2560×1440 | 0.991264 | pass | 16.556% | 0.9939% | pass | 0.2863% | 255 | fail |
| 2 | 4 | 1792147307465443000 | 2560×1440 | 0.990823 | pass | 15.410% | 0.7908% | pass | 0.2326% | 237 | fail |
| 2 | 8 | 1792147316213558000 | 2560×1440 | 0.996040 | pass | 12.963% | 0.2084% | pass | 0.0867% | 158 | fail |

**Summary: SSIM 8/8 pass, over16 5/8 pass, conservative reference interpretation 0/8 pass.** The three pass/fail columns are separate gates and are not combined. An SSIM pass does **not** close G-C.

Minimum local SSIM per image is 0.117 to 0.403 at DPR 1 and −0.844 to −0.329 at DPR 2. The means are high, but there are small regions of strong local disagreement; the over16 and max Δ columns show the same thing.

Every value is finite. On all 8 pairs the recomputed RGB metrics agree **exactly** with the original capture JSON (`diff` block) on dimensions, over16 count, maxDelta, changedFraction and meanMaxChannelDelta. This independently confirms the PNG decode and the delta definition. Every pixel of all 16 images has alpha 255. Every PNG SHA-256 matched the manifest.

### Ambiguous reference gate

PROOF-PLAN §4 reads "a whole-frame diff of ≤0.5% of pixels at delta ≤44", citing the relief-tile reference of 0.486% with max 44. This job reports it as a **labelled conservative interpretation**: changedFraction (Δ > 0, no tolerance, no mask) ≤ 0.005 **and** maxDelta ≤ 44. Under that reading every cell fails by a wide margin (changed 10.7–17.6%, max 113–255), so it would fail even if both clauses were relaxed separately. The over44 fraction is reported as a raw number but is **not** used as a substitute gate. No threshold was retuned and no mask was applied. Deciding the intended reading is a plan-owner decision.

## 2. Pinned profile

Primary sources (opened for this job):
- Z. Wang, A. C. Bovik, H. R. Sheikh, E. P. Simoncelli, "Image Quality Assessment: From Error Visibility to Structural Similarity", IEEE TIP 13(4), 2004. https://www.cns.nyu.edu/pub/eero/wang03-reprint.pdf. §III defines local SSIM; §IV specifies the 11×11 circular-symmetric Gaussian window (σ = 1.5, normalised to unit sum), weighted local statistics and mean pooling; the Fig. 8 caption gives K1 = 0.01 and K2 = 0.03.
- Z. Wang, SSIM author page. https://ece.uwaterloo.ca/~z70wang/research/ssim/. It describes full-reference use on grayscale images. Its viewing-distance downsampling option is **not** used here.

The implementation was written independently from those definitions; no reference code was copied. It makes no claim of bit equality with the published MATLAB code.

| Item | Choice |
|---|---|
| Pixels | Native device pixels. No resize, downsample, alignment search, mask, ROI or blur preprocessing |
| Reference / candidate | SVG / GPU |
| Gray | Y = 0.299 R + 0.587 G + 0.114 B on 8-bit sRGB code values, float64, not rounded. This is our explicit profile choice |
| Window | 11×11 Gaussian, σ = 1.5, applied as a separable 1D kernel normalised to unit sum. Its outer product is the normalised 2D kernel exactly |
| Moments | Weighted population moments: μ = Σwx, σ² = Σwx² − μ², σxy = Σwxy − μxμy |
| Constants | L = 255, C1 = (0.01 L)² = 6.5025, C2 = (0.03 L)² = 58.5225 |
| Local index | SSIM = ((2μxμy + C1)(2σxy + C2)) / ((μx² + μy² + C1)(σx² + σy² + C2)) |
| Pooling | Mean over every centre whose full window fits. A 5 px border is excluded: (w−10)(h−10) windows, i.e. 901,700 at 1280×720 and 3,646,500 at 2560×1440 |
| Roundoff | σ² from E[x²] − μ² can be a few ulps below zero on flat windows. Values in [−1e−6, 0) are used unchanged (C2 dominates them). Anything more negative throws. Observed minimum: −2.9e−11. **SSIM is never clamped** |
| Alpha | Must be 255 at every pixel, otherwise the run fails closed |
| Raw RGB | Per pixel Δ = max(\|ΔR\|, \|ΔG\|, \|ΔB\|) over **all** pixels, border included. changed: Δ > 0; over16: Δ > 16; over44: Δ > 44 |
| Global SSIM | Not used; only mean local SSIM counts |

## 3. Tooling and artifacts

- `bench/fidelity-metrics.ts`: pure math with no I/O (kernel, grayscale, separable SSIM with an 11-row ring buffer, RGB diff, gates).
- `bench/fidelity-metrics.test.ts`: 11 `node:test` cases covering:
  - kernel normalisation, symmetry and σ ratio;
  - identity gives exactly 1;
  - constant images against the analytical formula (2pq + C1)/(p² + q² + C1);
  - grayscale weights;
  - a 1 px structural shift scores below 1, and SSIM is symmetric;
  - separable SSIM against an **independent slow direct 2D reference** that uses a 2D-built kernel and central-moment variance/covariance, on 23×19 and single-window 11×11 images, within 1e−10;
  - the 5 px border: a corner change touches exactly one window, and the RGB metrics still count it;
  - negative covariance;
  - rejection of malformed, non-finite, translucent, size-mismatched and too-small (< 11 px) input;
  - strict `>` thresholds;
  - separate gate evaluation, including exact boundary values.
- `bench/fidelity-metrics-run.ts` (fixed check `metrics`):
  - It reads only the manifest and the files it names. It checks the dist fingerprint, the exact DPR×zoom set and every SHA-256, and requires `failure: null` in each capture JSON.
  - No fixed check runs bench tests outside the fixed list, so the runner first runs `fidelity-metrics.test.ts` through `node:test`'s `run()` and aborts on any failure.
  - It decodes each PNG serially in Playwright Chromium on `about:blank`: every route is aborted, service workers are blocked, and there is no app, server or network. Decoding uses `createImageBitmap` (colorSpaceConversion none, premultiplyAlpha none), OffscreenCanvas and `getImageData` in 128-row chunks.
  - The math runs in Node. One pair is held in memory at a time. No pixels are logged.
  - Before decoding, it rejects any PNG that is not 8-bit RGB/RGBA or that carries gAMA, cHRM or iCCP chunks, so the canvas cannot silently colour-convert. It also asserts the length of every pixel chunk.
  - It fails on a material mismatch with the capture JSON in any of the five cross-checked fields: dimensions, over16 count, maxDelta, changedFraction or meanMaxChannelDelta. over44 is not in the capture JSON, so it cannot be cross-checked.
  - Exit 0 means a valid, cross-checked measurement. Gate pass/fail is in the JSON (`rows[].gates`, `summary`) and is **not** reflected in the exit code.
- Checks run (in order): `unit` `p1-delegated-1792150133419248000` (vitest 579/579 pass; the vitest root is `src`, so it does not include bench tests), `bench` `…150155591932000` (fixed 20/20 pass; it does not include the new test file), `build` `…150194508084000` (exit 0), first `metrics` `fidelity-metrics-1792150200445803000` (exit 0, self-test 11/11), then after the audit fixes **authoritative `metrics` `fidelity-metrics-1792150282727161000`** (exit 0, self-test 11/11, 8/8 pairs with all five cross-checks true; values identical to the first run). Output is `host-checks/fidelity-metrics-1792150282727161000.json` and the log is `.log`.
- Manifest `host-checks/fidelity-measurement-manifest.json` sha256 `9455b294…40365e3` was not modified.

## 4. Math audit

There was one mandatory native Haiku 5.5 read-only audit, run after the code was written. It made no edits, ran no checks and used no network.

**Verdict: no math bugs found.** It confirmed the kernel, the weighted moments, the SSIM formula, the constants, the border and window count, the grayscale weights, the RGB delta, the strict thresholds and the separation of the gates. No math changed, so the unit numbers and the metric values are the same as before the audit.

| Finding | Severity | Disposition |
|---|---|---|
| changedFraction and meanMaxChannelDelta were computed in the cross-check but did not fail the run | medium | **Fixed.** All five cross-check fields are now fatal |
| Exit code is 0 even when gates fail | medium | Kept on purpose. Exit 0 means a valid measurement; gates are reported in the JSON. Documented in §3 and in the runner header |
| PNG gAMA/cHRM/iCCP or 16-bit/palette input could be colour-converted during decode | low | **Fixed.** `assertPlainPng` fails closed. The exact RGB cross-check against the original captures would also have caught it |
| Pixel chunk length was not asserted | low | **Fixed.** A short chunk now throws |
| `alpha255: true` is written as a literal in the report rows | low | Correct as written: `validateRgba` throws on any alpha ≠ 255 before the row exists. A comment was added |
| `Math.round(over16Fraction × pixels)` depends on float precision | low | Left as is. It can only cause a false *fail* (a mismatch), never a false pass |
| No test for the negative-variance throw; no test for the runner itself | gap | Known gap. The throw is unreachable on 8-bit input (the observed minimum is −2.9e−11 against a 1e−6 limit). The runner is covered end to end by the exact cross-check against the capture JSON |
| over44 cannot be cross-checked | gap | Known gap. It is not in the capture JSON and is reported as a raw value only |

## 5. Scope limits: what this does NOT show

- It covers only **8 full-scene smoke images** (DPR 1/2 × zoom 1/2/4/8) of one fixture. PROOF-PLAN §4 also requires the following, all of which remain unmeasured:
  - per-layer-family goldens;
  - all built-in style presets;
  - the coastline k-switch points 1.5 and 2.6;
  - dynamic zoomMin;
  - font switching;
  - hit parity;
  - label, hatch and stroke sub-gates beyond the existing hatch check;
  - group-opacity fixtures;
  - the compat lane;
  - editor parity (G-E).
- Grayscale SSIM can hide chroma-only differences. The raw RGB max-channel gates partly cover this, because they see each channel.
- Goldens are per GPU family. These numbers are for this host's GPU only.

## 6. Remaining gates

- G-C over16 fails at DPR 2 z1 (1.831%), DPR 1 z1 (1.321%) and DPR 1 z4 (1.182%). These are the same three pre-existing failures.
- The reference gate fails 8/8 under the conservative interpretation, and its intended reading needs a decision.
- Context restore takes about 600 ms against a 500 ms target. Heap is 38.7 MB. Windows is untested. SceneDoc, editor and picking parity are incomplete.
- No full rewrite has been done.

## 7. Next bounded correctness recommendation

1. Have the plan owner pin the reference-gate reading (changed-fraction tolerance vs Δ > 0, and whether max ≤ 44 is a hard cap). Do this before any further fidelity spend, and do not retune silently.
2. Then run one bounded diagnosis of the three over16 failures using existing per-layer fidelity isolation, attributing over16 and min-local-SSIM hotspots to layers (text/markers vs fills). Fix only an attributable renderer defect, under a separate authorised job that re-captures.
3. Add the bench test file to the fixed `bench` check list (a harness owner change, out of scope here) so the math tests also run outside `metrics`.
