import { readFileSync } from "node:fs";
interface Row {
  cells: number;
  operation: string;
  medianMs: number;
}
interface Result {
  schema: number;
  node?: string;
  layers?: string[];
  samples: number;
  platform: string;
  arch: string;
  cpu: string;
  chromium: string;
  viewport: number[];
  seed: string;
  measurements: Row[];
}
const [baseFile, currentFile] = process.argv.slice(2);
if (!baseFile || !currentFile) throw new Error("Usage: node bench/compare.ts BASE CURRENT");
const base: Result = JSON.parse(readFileSync(baseFile, "utf8"));
const current: Result = JSON.parse(readFileSync(currentFile, "utf8"));
for (const field of [
  "schema",
  "node",
  "layers",
  "samples",
  "platform",
  "arch",
  "cpu",
  "chromium",
  "viewport",
  "seed"
] as const) {
  if (JSON.stringify(base[field]) !== JSON.stringify(current[field]))
    throw new Error(`Incompatible baseline: ${field}`);
}
if (base.samples < 3) throw new Error("Regression gates require at least 3 samples");
if (base.schema !== 2) throw new Error("Unsupported benchmark schema");
const expected = new Set([10000, 50000, 100000].flatMap(cells =>
  ["generate", "save", "load", "redraw", "regrid"].map(operation => `${cells}/${operation}`)
));
for (const [label, result] of [["baseline", base], ["current", current]] as const) {
  const seen = new Set<string>();
  for (const row of result.measurements) {
    const key = `${row.cells}/${row.operation}`;
    if (!expected.has(key) || seen.has(key) || !Number.isFinite(row.medianMs) || row.medianMs <= 0)
      throw new Error(`Invalid ${label} measurement ${key}`);
    seen.add(key);
  }
  if (seen.size !== expected.size) throw new Error(`Missing ${label} measurements`);
}
const keys = new Set<string>();
let failed = false;
for (const row of current.measurements) {
  const key = `${row.cells}/${row.operation}`;
  if (keys.has(key)) throw new Error(`Duplicate measurement ${key}`);
  keys.add(key);
  const reference = base.measurements.find(value => value.cells === row.cells && value.operation === row.operation);
  if (
    !reference ||
    !Number.isFinite(row.medianMs) ||
    row.medianMs <= 0 ||
    !Number.isFinite(reference.medianMs) ||
    reference.medianMs <= 0
  )
    throw new Error(`Invalid baseline ${key}`);
  const delta = row.medianMs - reference.medianMs;
  const regression = delta > 100 && row.medianMs > reference.medianMs * 1.25;
  console.log(
    `${regression ? "FAIL" : "PASS"} ${key}: ${reference.medianMs.toFixed(1)} -> ${row.medianMs.toFixed(1)} ms (${((delta / reference.medianMs) * 100).toFixed(1)}%)`
  );
  failed ||= regression;
}
for (const cells of [10000, 50000, 100000])
  for (const operation of ["generate", "save", "load", "redraw", "regrid"]) {
    if (!keys.has(`${cells}/${operation}`)) throw new Error(`Missing measurement ${cells}/${operation}`);
  }
if (failed) process.exitCode = 1;
