// Compat reuse fidelity (COST, W3): a raster reused across an edit is compared with the SVG. Run it through
// bench/gate/gate.ts (`gate reuse-fidelity`), which takes a shared host-lock slot and sets GATE_OUT_DIR.
//
// Compat reuse (src/gpu/compat-reuse.ts, prepare.ts adoptRuns) keeps a compat run's raster when nothing that can reach
// its pixels changed since it was cut. Its failure is a stale raster. For each edit and layer family:
//   1. the camera and the DOM are put back to the base state, the family is isolated (golden isolation) and the GPU
//      frame becomes current: the family's rasters are cut, or reused from the frame before;
//   2. the edit is applied and the frame becomes current again: the prepare reuses every run it finds clean;
//   3. GPU against SVG for the isolated family, from the same DOM state (captureArms): the reused cell;
//   4. a forced full re-prepare with no reuse (the renderer's forced invalidate dirties every run), then GPU against SVG
//      again: the fresh cell;
//   5. judged (reuse-fidelity-core.ts): the reused cell must look like the fresh one (the toggle census on-state
//      margins), within D1 when the fresh one is. Never GPU against GPU. A cell where the prepare of step 2 reused no
//      raster of the family is reported (INFO), and an edit that no family reused across fails as vacuous.
// The page runs with ?gpu-compat-reuse=1 whatever the build default, so the check holds for the reuse path itself.
//
// Edits (REUSE_EDITS, default zoom,move,toggle):
//   zoom    the camera from k 1.5 to 1.9 (the same raster bucket at dpr 2): zoom-end label font-size writes on
//           #labels > g (the subtree rule) plus every camera-dependent attribute the app writes;
//   move    every marker's x/y by (25, 15) (the markers run must be re-cut; with any other family isolated it is hidden);
//   toggle  rulers off (run boundaries change around a removed layer).
// REUSE_BREAK=stale (self-test, the run must FAIL): ?gpu-compat-reuse-break=stale makes the tracker ignore every edit,
// so stale rasters are reused; the move edit leaves the markers family showing its old position.
//
// Environment: REUSE_DPR (2), REUSE_LAUNCHER (metal), REUSE_FAMILIES (comma list of golden family names, default the
// families with compat runs on the parity fixture), REUSE_EDITS, REUSE_BREAK, REUSE_MAP (parity .map), GATE_OUT_DIR.
// Output: reuse-fidelity.json (`failure` null on a pass) and the PNGs of failing cells.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { heatmap, measureCell } from "../golden-metrics.ts";
import { encodePng } from "../png.ts";
import { captureArms, decode, isolateLayers, launch, loadParity, openPage, parityFixture, serveDist, settleApp, type Sink, waitCurrent, zoomTo } from "./census-lib.ts";
import { type Check, failureSummary, fail, info, judged, pass } from "./census-core.ts";
import { FAMILIES } from "./golden-families.ts";
import { judgeExercised, judgeReuse, type ReuseVerdict } from "./reuse-fidelity-core.ts";

const env = process.env;
const outDir = env.GATE_OUT_DIR || process.cwd();
const dpr = Number(env.REUSE_DPR || 2);
const breakMode = env.REUSE_BREAK || "none";
if (!["none", "stale"].includes(breakMode)) throw Error("REUSE_BREAK must be none|stale");
const DEFAULT_FAMILIES = "markers,emblems,military,labels,goods,markets,precipitation,population,burgs,lakes,coastline,states,provinces,ocean,texture,cells,coordinates,compass,ice,fog,rulers";
const families = (env.REUSE_FAMILIES || DEFAULT_FAMILIES).split(",").map(s => s.trim()).filter(Boolean).map(name => {
  const family = FAMILIES.find(f => f.name === name);
  if (!family) throw Error(`REUSE_FAMILIES: unknown family ${name}`);
  return family;
});
const EDITS = ["zoom", "move", "toggle"] as const;
type Edit = (typeof EDITS)[number];
const edits = (env.REUSE_EDITS || EDITS.join(",")).split(",").map(s => s.trim()).filter(Boolean) as Edit[];
for (const edit of edits) if (!EDITS.includes(edit)) throw Error(`REUSE_EDITS: unknown edit ${edit}`);
const BASE_K = 1.5;
const EDIT_K = 1.9; // k·dpr 3 → 3.8: the same power-of-two raster bucket (4), so world raster keys stay valid

const started = Date.now();
const log = (message: string) => process.stderr.write(`[reuse ${Math.round((Date.now() - started) / 1000)}s] ${message}\n`);
const sink: Sink = { errors: [], warnings: [] };
const checks: Check[] = [];
const report: any = { schema: 1, check: "reuse-fidelity", config: { dpr, break: breakMode, edits, families: families.map(f => f.name) }, cells: [] as any[], checks, errors: sink.errors, warnings: sink.warnings, failure: null as string | null };
const write = () => writeFileSync(join(outDir, "reuse-fidelity.json"), `${JSON.stringify(report, null, 2)}\n`);
const add = (c: Check) => {
  checks.push(c);
  log(`${c.status} ${c.id}${c.status === "PASS" ? "" : ` :: ${c.detail.slice(0, 240)}`}`);
};

const served = await serveDist();
const { browser, launcher } = await launch(env.REUSE_LAUNCHER);
report.config.launcher = launcher;
try {
  mkdirSync(join(outDir, "cells"), { recursive: true });
  const fixture = parityFixture(env.REUSE_MAP);
  report.config.fixture = { path: fixture.path, sha256: fixture.sha256 };
  const opened = await openPage(browser, served.origin, { dpr, renderer: "gpu", launcher, sink, label: "gpu" });
  const { page } = opened;
  report.adapter = opened.adapter;
  // the reuse path whatever the build default (and the self-test's blind tracker): the renderer reads both at boot.
  // First details off (RES, prepare.ts firstDetails): they re-cut sharp runs (markers, emblems) at the view before the
  // frame commits, which hides a reused base raster in the captured view though a pan within the bucket shows it.
  const params = `&gpu-compat-reuse=1&gpu-first-detail=0${breakMode === "stale" ? "&gpu-compat-reuse-break=stale" : ""}`;
  await page.goto(`${page.url()}${params}`);
  await page.evaluate(async () => {
    const ready = await (globalThis as any).__tupaia.call("ready", { timeoutMs: 120000 });
    if (!ready.ok) throw Error(JSON.stringify(ready));
  });
  for (const p of await loadParity(page, fixture)) sink.warnings.push(`load: ${p}`);
  await page.evaluate(zoomTo, { k: BASE_K });
  const loaded = await waitCurrent(page, 180000);
  if (loaded.active !== "gpu" || loaded.timedOut) throw Error(`GPU not current after the fixture load (${JSON.stringify(loaded)})`);

  const probe = () =>
    page.evaluate(() => {
      const g = (globalThis as any).rendererStatus?.()?.gpu;
      const reuse = g?.lastPrepare?.reuse;
      return {
        enabled: !!reuse?.enabled,
        worldKept: reuse?.worldKept ?? 0,
        world: reuse?.world ?? 0,
        keptLayers: (reuse?.keptLayers ?? []) as string[],
        reasons: reuse?.reasons ?? {},
        prepares: g?.prepares ?? 0,
        lastPrepareMs: g?.lastPrepareMs ?? null,
        // the compat runs of the drawn frame (evidence: which runs an edit restructured)
        runs: (((globalThis as any).gpuRenderer?.prepared?.runs ?? []) as any[]).map(
          run => `${run.screen ? "screen" : "world"} <${run.elements[0]?.tagName}${run.elements[0]?.id ? `#${run.elements[0].id}` : ""}> in #${run.elements[0]?.closest?.("#viewbox > *, svg#map > *")?.id ?? "?"} x${run.elements.length}`
        )
      };
    });
  const settle = async () => {
    await settleApp(page);
    return waitCurrent(page, 120000);
  };
  // apply / undo an edit (page side; each returns once the app has settled)
  const apply = async (edit: Edit, on: boolean) => {
    if (edit === "zoom") await page.evaluate(zoomTo, { k: on ? EDIT_K : BASE_K });
    else if (edit === "move")
      await page.evaluate(set => {
        // every marker's own position: the run keeps its elements (a transform on #markers would regroup it into one
        // run), and a stale raster shows every marker where it was
        const page = globalThis as any;
        for (const marker of document.querySelectorAll("#markers > svg[x]")) {
          const [x, y] = [Number(marker.getAttribute("x")), Number(marker.getAttribute("y"))];
          const d = set ? 1 : -1;
          marker.setAttribute("x", String(x + 25 * d));
          marker.setAttribute("y", String(y + 15 * d));
        }
        page.__reuseMoved = set;
      }, on);
    else await page.evaluate(set => (globalThis as any).__tupaia.call("display", set ? { off: ["rulers"] } : { on: ["rulers"] }), on);
  };

  type Metrics = ReturnType<typeof measureCell>;
  interface Cell {
    shots: { gpu: Buffer; svg: Buffer };
    metrics: Metrics;
    raced: boolean; // the canvas redrew while its screenshot was taken (a refinement landing): not judged
    gpu: { active: string | null; timedOut?: boolean; fallbackReason?: string };
    ms: number;
  }
  const frames = () => page.evaluate(() => (globalThis as any).rendererStatus?.()?.gpu?.frames ?? 0);
  const cell = async (refined: boolean): Promise<Cell> => {
    await settleApp(page);
    const wait = await waitCurrent(page, 120000, refined);
    const before = await frames();
    const shots = await captureArms(page);
    const raced = (await frames()) !== before;
    return { shots, metrics: measureCell(decode(shots.svg), decode(shots.gpu), blankSvg, blankGpu), raced, gpu: wait, ms: wait.ms };
  };
  // Holds the settle refinement (page side, on the renderer instance): the current frame shows the base rasters, reused
  // or cut, only until the settle details replace them over the whole view. A settle that would prepare still runs.
  const hold = (on: boolean) =>
    page.evaluate(on => {
      const r = (globalThis as any).gpuRenderer;
      if (on) {
        if (Object.hasOwn(r, "settle")) return;
        const original = r.settle;
        r.settle = function (this: any) {
          const p = this.prepared;
          const refine = p && !this.preparing && !this.moving && !this.prepareWanted && p.revision === this.revision && p.bucket === this.bucket();
          if (!refine) return original.call(this);
          this.__refineHeld = true;
        };
      } else if (Object.hasOwn(r, "settle")) {
        delete r.settle;
        if (r.__refineHeld) {
          delete r.__refineHeld;
          r.scheduleSettle();
        }
      }
    }, on);
  // the current frame first (the base rasters, the settle refinement held), then the refined frame
  const cells = async (change: () => Promise<unknown>) => {
    await hold(true);
    try {
      await change();
      const current = await cell(false);
      await hold(false);
      const refined = await cell(true);
      return { current, refined };
    } finally {
      await hold(false);
    }
  };

  // the blank in both arms: every layer hidden (and the backdrop set once, for the whole run)
  await page.evaluate(isolateLayers, { ids: [], bg: "#ffffff" });
  await settle();
  const blanks = await captureArms(page);
  const blankSvg = decode(blanks.svg);
  const blankGpu = decode(blanks.gpu);

  for (const edit of edits) {
    const verdicts: ReuseVerdict[] = [];
    for (const family of families) {
      const id = `reuse.${edit}.${family.name}`;
      // 1. base state, family isolated, current (its rasters cut or reused from the frame before)
      await page.evaluate(isolateLayers, { ids: [family.id], bg: "#ffffff" });
      await settle();
      const baseProbe = await probe();
      // 2. the edit: the prepare reuses every run it finds clean
      // 3. reused cells: the current frame (base rasters, D12) and the refined one (settle details, carried or re-cut)
      const probed: { value?: Awaited<ReturnType<typeof probe>> } = {};
      const reusedCells = await cells(async () => {
        await apply(edit, true);
        await page.evaluate(isolateLayers, { ids: [family.id], bg: "#ffffff" });
        await settle();
        probed.value = await probe();
      });
      const kept = probed.value!;
      // 4. fresh control: forced re-prepare, every run dirty
      const freshCells = await cells(() => page.evaluate(() => (globalThis as any).gpuRenderer.invalidate(true)));
      const freshProbe = await probe();
      // 5. judged, the current and the refined frame each
      const pick = (m: Metrics) => ({ ssim: m.ssim, over16Fraction: m.over16Fraction, over16OfInk: m.over16OfInk, inkRatio: m.inkRatio });
      const judge = (stage: "current" | "refined") =>
        judgeReuse({
          edit: `${edit}@${stage}`,
          family: family.name,
          layerId: family.id,
          kept: { worldKept: kept.worldKept, keptLayers: kept.keptLayers },
          freshKept: freshProbe.enabled ? freshProbe.worldKept : null,
          reused: pick(reusedCells[stage].metrics),
          fresh: pick(freshCells[stage].metrics),
          gpu: reusedCells[stage].gpu
        });
      const stages = (["current", "refined"] as const).filter(stage => !reusedCells[stage].raced && !freshCells[stage].raced);
      const byStage = stages.map(stage => ({ stage, verdict: judge(stage) }));
      const verdict: ReuseVerdict = {
        status: byStage.some(v => v.verdict.status === "FAIL") ? "FAIL" : byStage.some(v => v.verdict.status === "PASS") ? "PASS" : "INFO",
        problems: byStage.flatMap(v => v.verdict.problems),
        exercised: byStage.some(v => v.verdict.exercised)
      };
      if (!stages.length) verdict.problems.push(`${edit}/${family.name}: every capture raced a redraw`);
      verdicts.push(verdict);
      let evidence: string | undefined;
      if (verdict.status === "FAIL") {
        for (const { stage, verdict: v } of byStage) {
          if (v.status !== "FAIL") continue;
          const base = join(outDir, "cells", `${edit}-${family.name}-${stage}`);
          writeFileSync(`${base}-reused-gpu.png`, reusedCells[stage].shots.gpu);
          writeFileSync(`${base}-reused-svg.png`, reusedCells[stage].shots.svg);
          writeFileSync(`${base}-fresh-gpu.png`, freshCells[stage].shots.gpu);
          writeFileSync(`${base}-reused-diff.png`, encodePng(heatmap(decode(reusedCells[stage].shots.svg), decode(reusedCells[stage].shots.gpu))));
          evidence ??= `cells/${edit}-${family.name}-${stage}-reused-diff.png`;
        }
      }
      const row = (stage: "current" | "refined") => ({ reused: pick(reusedCells[stage].metrics), fresh: pick(freshCells[stage].metrics), raced: reusedCells[stage].raced || freshCells[stage].raced, ms: reusedCells[stage].ms });
      report.cells.push({ edit, family: family.name, status: verdict.status, exercised: verdict.exercised, kept, baseRuns: baseProbe.runs, freshKept: freshProbe.worldKept, current: row("current"), refined: row("refined"), problems: verdict.problems });
      const m = (stage: "current" | "refined") => {
        const [f, r] = [freshCells[stage].metrics, reusedCells[stage].metrics];
        return `${stage}: ssim ${f.ssim.toFixed(4)}/${r.ssim.toFixed(4)}, over16 ${(f.over16Fraction * 100).toFixed(3)}%/${(r.over16Fraction * 100).toFixed(3)}%, ink ratio ${f.inkRatio.toFixed(3)}/${r.inkRatio.toFixed(3)}`;
      };
      const metrics = `fresh/reused ${stages.map(m).join("; ")}; kept ${kept.worldKept}/${kept.world} world runs`;
      if (verdict.status === "PASS") add(pass(id, "P2", `reused across the edit, as close to the SVG as a fresh prepare: ${metrics}`));
      else if (verdict.status === "INFO") add(info(id, "P2", `${verdict.problems.join("; ")} (${Object.entries(kept.reasons).map(([k, v]) => `${k}: ${v}`).join(", ") || "no reasons"})`));
      else add(fail(id, "P2", `${verdict.problems.join("; ")} (${metrics})`, evidence));
      // back to the base state for the next family
      await apply(edit, false);
      write();
    }
    add(judged(`reuse.${edit}.exercised`, "P2", judgeExercised(edit, verdicts), `${verdicts.filter(v => v.exercised).length}/${verdicts.length} families reused a raster across the edit`));
  }
  await page.evaluate(isolateLayers, { ids: [], restore: true });
  add(sink.errors.length ? fail("run.page-errors", "P2", sink.errors.slice(0, 3).join(" | ")) : pass("run.page-errors", "P2", "no page errors"));
} catch (error) {
  add(fail("run.harness", "P2", `harness: ${(error as Error).stack?.slice(0, 600) ?? error}`));
} finally {
  report.failure = failureSummary(checks);
  report.summary = { checks: checks.length, pass: checks.filter(c => c.status === "PASS").length, fail: checks.filter(c => c.status === "FAIL").length, info: checks.filter(c => c.status === "INFO").length, seconds: Math.round((Date.now() - started) / 1000) };
  write();
  await browser.close();
  await served.close();
}
process.exit(report.failure ? 1 : 0);
