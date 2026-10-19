// Ported from the Codex host harness (control/paired-summary-v3.ts). Summarises five paired SVG/GPU blocks
// written by `gate paired` into one A/B analysis. Run through bench/gate/gate.ts (`gate paired-summary`).
// PAIRED_DIRS: comma-separated block directories (each holds report.json, host-receipt.json, slot-*.json).
// PAIRED_OUTPUT: summary JSON path. PAIRED_DPR: 1 or 2.
import { readFileSync, writeFileSync } from "node:fs";
import { analyzeAb } from "../renderer-ab.ts";

const d = Number(process.env.PAIRED_DPR);
if (![1, 2].includes(d)) throw Error("Invalid DPR");
const dirs = (process.env.PAIRED_DIRS || "").split(",").filter(Boolean);
if (dirs.length !== 5) throw Error("PAIRED_DIRS must name five block directories");
const output = process.env.PAIRED_OUTPUT;
if (!output) throw Error("PAIRED_OUTPUT required");
const slots: any[] = [];
let fingerprint: string | null = null;
dirs.forEach((dir, index) => {
  const b = index + 1;
  const report = JSON.parse(readFileSync(dir + "/report.json", "utf8"));
  const receipt = JSON.parse(readFileSync(dir + "/host-receipt.json", "utf8"));
  if (receipt.exit_code !== 0 || !receipt.dist_unchanged) throw Error("Invalid block " + b + ": " + dir);
  if (receipt.dpr !== d) throw Error("Block " + b + " has dpr " + receipt.dpr + ", expected " + d);
  if (fingerprint !== null && fingerprint !== receipt.dist_before) throw Error("Build differs between blocks");
  fingerprint = receipt.dist_before;
  for (const s of report.schedule) {
    const renderer = s.arm === "A" ? "svg" : "gpu";
    const data = JSON.parse(readFileSync(dir + "/slot-" + s.slot + "-" + s.arm + "-" + renderer + ".json", "utf8"));
    slots.push({
      slot: slots.length,
      arm: s.arm,
      requested: data.renderer,
      active: data.rendererStatus?.end?.active ?? null,
      fallbackReason: data.rendererStatus?.end?.fallbackReason || undefined,
      inputMethod: data.inputMethod,
      fixtures: data.fixtures || {},
      runs: data.runs
    });
  }
});
const result = {
  schema: 1,
  dpr: d,
  distFingerprint: fingerprint,
  blocks: dirs,
  slotCount: slots.length,
  analyses: ["frame", "callback", "inputDispatch", "idleFrame"].map(m => analyzeAb(slots, m as any, 7319)),
  limitations:
    "Synthetic DOM input, offscreen headful Chromium Metal. Timing comparison only; no physical input-to-photon or complete fidelity acceptance. One measured iteration per slot and workload."
};
writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
