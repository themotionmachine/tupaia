import { readFileSync } from "node:fs";
const [basePath, headPath] = process.argv.slice(2);
if (!basePath || !headPath) throw new Error("Usage: node bench/navigation-compare.ts BASE HEAD");
const base = JSON.parse(readFileSync(basePath, "utf8")),
  head = JSON.parse(readFileSync(headPath, "utf8"));
for (const field of [
  "schema",
  "fixtureHash",
  "fixtureMetadata",
  "budgetToleranceFraction",
  "tracing",
  "gpu",
  "launchConfig",
  "node",
  "platform",
  "arch",
  "cpu",
  "chromium",
  "viewport",
  "deviceScaleFactor",
  "samples",
  "frames",
  "seed",
  "layers"
])
  if (JSON.stringify(base[field]) !== JSON.stringify(head[field]))
    throw new Error("Incompatible navigation runs: " + field);
if (base.samples < 3) throw new Error("Use at least three gesture samples");
const key = (run: any) => run.world + "/" + run.gesture + "/" + run.iteration;
for (const data of [base, head]) {
  const keys = new Set<string>();
  for (const run of data.runs) {
    if (
      keys.has(key(run)) ||
      !run.modelUnchanged ||
      run.frames !== data.frames ||
      run.intervalsMs.length !== data.frames - 1 ||
      !Number.isFinite(run.frame.p95) ||
      run.frame.p95 <= 0 ||
      !Number.isFinite(run.callback.p95) ||
      run.callback.p95 < 0
    )
      throw new Error("Invalid gesture: " + key(run));
    if (
      data.schema >= 2 &&
      (run.idleIntervalsMs?.length !== data.frames - 1 ||
        !Number.isFinite(run.idleFrame?.p95) ||
        run.idleFrame.p95 <= 0 ||
        !Number.isFinite(run.inputDispatch?.p95) ||
        run.inputDispatch.p95 < 0 ||
        run.inputDispatchMs?.length !== (run.gesture === "wheel-zoom" ? data.frames : data.frames + 2))
    )
      throw new Error("Invalid idle/input measurements: " + key(run));
    keys.add(key(run));
  }
}
if (base.runs.length !== head.runs.length) throw new Error("Missing navigation gesture samples");
for (const run of head.runs) {
  const previous = base.runs.find((item: any) => key(item) === key(run));
  if (!previous || previous.cells !== run.cells || !run.settledExact)
    throw new Error("Mismatched world or unsettled gesture: " + key(run));
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const world of [...new Set(base.runs.map((r: any) => r.world))])
  for (const gesture of ["pan-near", "pan-wide", "wheel-zoom"]) {
    const b = base.runs.filter((r: any) => r.world === world && r.gesture === gesture);
    const h = head.runs.filter((r: any) => r.world === world && r.gesture === gesture);
    if (b.length !== base.samples || h.length !== head.samples) throw new Error("Missing gesture repetitions");
    const value = (rows: any[], field: string) =>
      median(rows.map(r => (field === "glyphAdds" ? r[field] : r[field].p95)));
    console.log(
      JSON.stringify({
        world,
        gesture,
        cells: b[0].cells,
        frameP95Ms: [value(b, "frame"), value(h, "frame")],
        callbackP95Ms: [value(b, "callback"), value(h, "callback")],
        ...(base.schema >= 2
          ? {
              idleFrameP95Ms: [value(b, "idleFrame"), value(h, "idleFrame")],
              inputDispatchP95Ms: [value(b, "inputDispatch"), value(h, "inputDispatch")],
              missedBudgets16_7: [
                median(b.map((r: any) => r.frameBudgets["16.7"].missedBudgets)),
                median(h.map((r: any) => r.frameBudgets["16.7"].missedBudgets))
              ],
              missedBudgets8_3: [
                median(b.map((r: any) => r.frameBudgets["8.3"].missedBudgets)),
                median(h.map((r: any) => r.frameBudgets["8.3"].missedBudgets))
              ],
              idleMissedBudgets16_7: [
                median(b.map((r: any) => r.idleFrameBudgets["16.7"].missedBudgets)),
                median(h.map((r: any) => r.idleFrameBudgets["16.7"].missedBudgets))
              ],
              idleMissedBudgets8_3: [
                median(b.map((r: any) => r.idleFrameBudgets["8.3"].missedBudgets)),
                median(h.map((r: any) => r.idleFrameBudgets["8.3"].missedBudgets))
              ]
            }
          : {}),
        glyphAdds: [value(b, "glyphAdds"), value(h, "glyphAdds")]
      })
    );
  }
