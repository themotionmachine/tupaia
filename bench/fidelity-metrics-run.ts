// G-C fidelity metrics over the fixed 8-pair smoke manifest. Reads only BENCH_METRICS_MANIFEST and the files it names,
// writes only BENCH_METRICS_OUTPUT. PNGs are decoded by the existing Playwright Chromium on about:blank (every network
// request aborted, service workers blocked); the math runs in Node (fidelity-metrics.ts). One image pair is held at a
// time, and no pixel data is logged. Exit 0 means a valid measurement; gate pass/fail is reported in the JSON, not
// through the exit code.
import { chromium, type Page } from "playwright";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { run } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateGates, GATES, LUMA, type Rgba, rgbDiff, SSIM_C1, SSIM_C2, SSIM_SIGMA, SSIM_WINDOW, ssim } from "./fidelity-metrics.ts";

// The pin is the P2 capture build. bench/gate/gate.ts sets BENCH_METRICS_EXPECTED_FINGERPRINT when it measures
// pairs it has just captured from the current dist (`gate metrics`), so the same runner gates fresh builds.
const EXPECTED_FINGERPRINT =
  process.env.BENCH_METRICS_EXPECTED_FINGERPRINT || "f99596d60eaf0b0ab818d14b2d9564559fb42ba7ad7037deec0af734e0b00911";
const EXPECTED_CELLS = ["1x1", "1x2", "1x4", "1x8", "2x1", "2x2", "2x4", "2x8"];
const ROW_CHUNK = 128;

interface Pair {
  dpr: number;
  zoom: number;
  gpu: string;
  svg: string;
  report: string;
  gpu_sha256: string;
  svg_sha256: string;
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

// No fixed check runs bench/fidelity-metrics.test.ts, so the runner gates itself on it before touching any image.
async function selfTest() {
  const passed: string[] = [];
  const failed: string[] = [];
  const file = fileURLToPath(new URL("./fidelity-metrics.test.ts", import.meta.url));
  for await (const event of run({ files: [file], concurrency: 1 })) {
    if (event.type === "test:pass" && event.data.nesting === 0) passed.push(event.data.name);
    if (event.type === "test:fail" && event.data.nesting === 0) {
      const cause = (event.data.details.error as Error & { cause?: Error }).cause;
      failed.push(`${event.data.name}: ${String(cause?.message ?? event.data.details.error.message).slice(0, 300)}`);
    }
  }
  console.log(`self-test pass=${passed.length} fail=${failed.length}${failed.length ? ` ${JSON.stringify(failed)}` : ""}`);
  if (failed.length || !passed.length) throw new Error("fidelity-metrics unit tests failed");
  return { file, passed, failed };
}

// Fail closed on anything the canvas might colour-convert: require 8-bit RGB/RGBA and no gAMA/cHRM/iCCP chunks.
function assertPlainPng(bytes: Buffer, label: string): void {
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(`${label}: not a PNG`);
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    if (type === "IHDR" && (bytes[at + 16] !== 8 || (bytes[at + 17] !== 2 && bytes[at + 17] !== 6))) {
      throw new Error(`${label}: bit depth ${bytes[at + 16]} colour type ${bytes[at + 17]} unsupported`);
    }
    if (type === "gAMA" || type === "cHRM" || type === "iCCP") throw new Error(`${label}: colour chunk ${type}`);
    if (type === "IEND") return;
    at += 12 + length;
  }
  throw new Error(`${label}: truncated PNG`);
}

async function decodePng(page: Page, bytes: Buffer): Promise<Rgba> {
  const dims = await page.evaluate(async (b64: string) => {
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([raw], { type: "image/png" }), {
      colorSpaceConversion: "none",
      premultiplyAlpha: "none",
    });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { colorSpace: "srgb", willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    (globalThis as any).__fidelityCtx = ctx;
    return { width: bitmap.width, height: bitmap.height };
  }, bytes.toString("base64"));
  const data = new Uint8Array(dims.width * dims.height * 4);
  for (let y = 0; y < dims.height; y += ROW_CHUNK) {
    const rows = Math.min(ROW_CHUNK, dims.height - y);
    const chunk = await page.evaluate(
      ({ y, rows, width }) => {
        const d = (globalThis as any).__fidelityCtx.getImageData(0, y, width, rows, { colorSpace: "srgb" }).data;
        let s = "";
        for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
        return btoa(s);
      },
      { y, rows, width: dims.width },
    );
    const bytes = Buffer.from(chunk, "base64");
    if (bytes.length !== rows * dims.width * 4) throw new Error(`short pixel chunk at row ${y}`);
    data.set(bytes, y * dims.width * 4);
  }
  await page.evaluate(() => { delete (globalThis as any).__fidelityCtx; });
  return { width: dims.width, height: dims.height, data };
}

async function main() {
  const manifestPath = process.env.BENCH_METRICS_MANIFEST;
  const outputPath = process.env.BENCH_METRICS_OUTPUT;
  if (!manifestPath || !outputPath) throw new Error("BENCH_METRICS_MANIFEST and BENCH_METRICS_OUTPUT are required");
  const unit = await selfTest();
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.render_dist_fingerprint !== EXPECTED_FINGERPRINT) throw new Error("render dist fingerprint mismatch");
  const pairs: Pair[] = manifest.pairs;
  const cells = pairs.map((p) => `${p.dpr}x${p.zoom}`).sort();
  if (pairs.length !== 8 || cells.join() !== EXPECTED_CELLS.join()) throw new Error(`unexpected pair set ${cells.join()}`);

  const browser = await chromium.launch({ headless: true });
  const rows = [];
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.goto("about:blank");
    for (const pair of pairs) {
      const svgBytes = readFileSync(pair.svg);
      const gpuBytes = readFileSync(pair.gpu);
      const svgSha = sha256(svgBytes);
      const gpuSha = sha256(gpuBytes);
      if (svgSha !== pair.svg_sha256 || gpuSha !== pair.gpu_sha256) throw new Error(`SHA mismatch dpr${pair.dpr} z${pair.zoom}`);
      const capture = JSON.parse(readFileSync(pair.report, "utf8"));
      const original = capture.diff;
      if (capture.failure !== null || !original) throw new Error(`capture report not clean: ${pair.report}`);

      assertPlainPng(svgBytes, "svg");
      assertPlainPng(gpuBytes, "gpu");
      // SVG is the reference, GPU the candidate. alpha255 below is enforced by validateRgba inside rgbDiff/ssim.
      const svg = await decodePng(page, svgBytes);
      const gpu = await decodePng(page, gpuBytes);
      const diff = rgbDiff(svg, gpu);
      const s = ssim(svg, gpu);
      const gates = evaluateGates(s.ssim, diff);

      const crossCheck = {
        dimensions: diff.width === original.width && diff.height === original.height,
        over16Count: diff.over16 === Math.round(original.over16Fraction * diff.pixels),
        maxDelta: diff.maxDelta === original.maxDelta,
        changedFraction: Math.abs(diff.changedFraction - original.changedFraction) < 0.5 / diff.pixels,
        meanMaxChannelDelta: Math.abs(diff.meanMaxChannelDelta - original.meanMaxChannelDelta) < 1e-9,
      };
      if (!Object.values(crossCheck).every(Boolean)) {
        throw new Error(`material mismatch vs capture JSON dpr${pair.dpr} z${pair.zoom}: ${JSON.stringify(crossCheck)}`);
      }
      const row = {
        dpr: pair.dpr,
        zoom: pair.zoom,
        artifact: pair.report.replace(/^.*\//, "").replace(/\.json$/, ""),
        svg: { path: pair.svg, sha256: svgSha, width: svg.width, height: svg.height, alpha255: true },
        gpu: { path: pair.gpu, sha256: gpuSha, width: gpu.width, height: gpu.height, alpha255: true },
        ssim: s,
        rgb: diff,
        original: { report: pair.report, ...original },
        crossCheck,
        gates,
      };
      rows.push(row);
      console.log(
        `dpr${pair.dpr} z${pair.zoom} ${svg.width}x${svg.height} ssim=${s.ssim.toFixed(6)} min=${s.minSsim.toFixed(4)} ` +
          `changed=${diff.changedFraction.toFixed(6)} over16=${diff.over16Fraction.toFixed(6)} over44=${diff.over44Fraction.toFixed(6)} ` +
          `max=${diff.maxDelta} cross=${JSON.stringify(crossCheck)} gates=${JSON.stringify(gates)}`,
      );
    }
    await context.close();
  } finally {
    await browser.close();
  }

  const report = {
    schema: 1,
    generatedUtc: new Date().toISOString(),
    unitTests: unit,
    manifest: { path: manifestPath, sha256: sha256(manifestBytes), renderDistFingerprint: manifest.render_dist_fingerprint },
    profile: {
      reference: "svg",
      candidate: "gpu",
      pixels: "native device pixels; no resize/downsample/alignment/mask/ROI/blur",
      gray: `Y = ${LUMA[0]} R + ${LUMA[1]} G + ${LUMA[2]} B on 8-bit sRGB code values (float64)`,
      window: `${SSIM_WINDOW}x${SSIM_WINDOW} Gaussian sigma ${SSIM_SIGMA}, normalised, weighted population moments`,
      constants: { L: 255, K1: 0.01, K2: 0.03, C1: SSIM_C1, C2: SSIM_C2 },
      pooling: "mean of local SSIM over centres with a full window (5 px border excluded)",
      rgbDelta: "max(|dR|,|dG|,|dB|) per pixel, all pixels including border",
      citations: [
        "https://www.cns.nyu.edu/pub/eero/wang03-reprint.pdf (Wang et al. 2004, §III, §IV, Fig. 8 constants)",
        "https://ece.uwaterloo.ca/~z70wang/research/ssim/",
      ],
    },
    gates: {
      ...GATES,
      note: "conservativeReferencePass is a labelled interpretation of PROOF-PLAN §4: changedFraction <= 0.005 AND maxDelta <= 44",
    },
    rows,
    summary: {
      pairs: rows.length,
      ssimPass: rows.filter((r) => r.gates.ssimPass).length,
      over16Pass: rows.filter((r) => r.gates.over16Pass).length,
      conservativeReferencePass: rows.filter((r) => r.gates.conservativeReferencePass).length,
      allFinite: rows.every((r) => Number.isFinite(r.ssim.ssim) && Number.isFinite(r.ssim.minSsim)),
    },
  };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`summary ${JSON.stringify(report.summary)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
