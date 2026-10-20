// Ported from the Codex host harness (control/overnight-palette-check-20261019.ts). Run it through bench/gate/gate.ts, which holds the
// host lock and sets GATE_OUT_DIR (evidence directory) and GATE_MAP (shared-v8 fixture). See docs/performance/webgl-rewrite/GATE.md.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, resolve } from "node:path";

// Standalone diagnostic. Primary owns execution under the shared host lock; no e2e runner.
const root = resolve(import.meta.dirname, "../.."); // repo root: bench/host -> ../..
const dist = resolve(root, "dist");
const output = resolve(process.env.GATE_OUT_DIR || process.cwd(), process.env.PALETTE_OUTPUT || `palette-${Date.now()}`);
const fixture = process.env.PALETTE_FIXTURE || process.env.GATE_MAP || "/tmp/tupaia-navigation-shared-v8.map";
let fixtureText = "";
const report: any = {
  startedUtc: new Date().toISOString(), output, fixture,
  fixtureSha256: null,
  failure: null, errors: [], warnings: [], blockedRequests: [], stages: [], arms: {}, parity: null,
  limitations: "Injected browser keyboard/input diagnostic, not a physical-input latency benchmark. Synthetic world identity/lifecycle cases are labelled. Paint capture invokes the existing GPU draw method synchronously because preserveDrawingBuffer is false."
};
writeFileSync(output + ".attempts.jsonl", "", { flag: "wx" });
function record(value: unknown): void { appendFileSync(output + ".attempts.jsonl", JSON.stringify(value) + "\n"); }
function check(condition: unknown, message: string): asserts condition { if (!condition) throw Error(message); }
async function stage<T>(arm: string, name: string, work: () => Promise<T>): Promise<T> {
  const attempt: any = { arm, name, startedUtc: new Date().toISOString() };
  record({ ...attempt, event: "start" });
  let timer: ReturnType<typeof setTimeout>;
  try {
    const result = await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error(`Stage exceeded 90 seconds: ${arm}/${name}`)), 90000);
    })]);
    attempt.result = result; attempt.pass = true;
    return result;
  } catch (error) { attempt.pass = false; attempt.error = String(error); throw error; }
  finally {
    clearTimeout(timer!); attempt.finishedUtc = new Date().toISOString();
    report.stages.push(attempt); record(attempt);
  }
}
const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
const server = createServer((request, response) => {
  if (request.method !== "GET") return void response.writeHead(405).end();
  const path = resolve(dist, "." + new URL(request.url || "/", "http://localhost").pathname);
  if (!path.startsWith(dist + "/") && path !== dist) return void response.writeHead(403).end();
  try {
    const file = path === dist ? resolve(dist, "index.html") : path;
    response.setHeader("content-type", mime[extname(file)] || "application/octet-stream");
    response.end(readFileSync(file));
  } catch { response.writeHead(404).end(); }
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  fixtureText = readFileSync(fixture, "utf8");
  report.fixtureSha256 = createHash("sha256").update(fixtureText).digest("hex");
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  check(address && typeof address !== "string", "Local server unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, channel: "chromium", timeout: 60000, args: ["--use-angle=metal", "--enable-gpu"] });
  const bridgeNames = ["bridge.js", "bridge-mutations.js", ...readdirSync(resolve(root, "mcp/src/bridge-ext")).filter(name => name.endsWith(".js")).sort().map(name => "bridge-ext/" + name)];
  const bridge = bridgeNames.map(name => readFileSync(resolve(root, "mcp/src", name), "utf8")).join("\n");

  for (const arm of ["svg", "gpu", "gpu-select"]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, serviceWorkers: "block" });
    await context.addInitScript(({ origin }) => {
      if (location.origin !== origin) return;
      localStorage.setItem("autosaveInterval", "0");
      localStorage.setItem("azgaarAssistant", "hide");
    }, { origin });
    await context.addInitScript(`if (location.origin === ${JSON.stringify(origin)}) {\n${bridge}\n}`);
    await context.route("**/*", route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() === "GET" && (url.origin === origin || (url.protocol === "https:" && url.hostname === "fonts.gstatic.com"))) return route.continue();
      if (report.blockedRequests.length < 100) report.blockedRequests.push({ arm, method: request.method(), url: request.url() });
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(60000);
    page.on("pageerror", error => report.errors.push({ arm, error: error.message }));
    page.on("console", message => {
      if (["warning", "error"].includes(message.type()) && report.warnings.length < 100) report.warnings.push({ arm, type: message.type(), text: message.text().slice(0, 1200) });
    });
    page.on("dialog", dialog => dialog.dismiss());
    const data: any = report.arms[arm] = {};
    const openPalette = async (modifier = "Control") => {
      await page.locator("#openCommandPalette").focus();
      await page.keyboard.down(modifier); await page.keyboard.down("k");
      await page.locator("#commandPalette").waitFor({ state: "visible" });
      await page.keyboard.up("k"); await page.keyboard.up(modifier);
    };
    const closePalette = async () => {
      await page.keyboard.press("Escape");
      await page.locator("#commandPalette").waitFor({ state: "detached" });
    };
    const cameraCalls = () => page.evaluate(() => (globalThis as any).__paletteProbe.calls.length);
    const modelDigest = () => page.evaluate(async () => {
      const pack = (0, eval)("pack");
      const fields = ["cells", "burgs", "states", "routes", "rivers", "features", "markers", "cultures", "religions", "provinces", "zones", "goods", "markets", "deals", "ice"];
      const bytes = new TextEncoder().encode(JSON.stringify(Object.fromEntries(fields.map(field => [field, pack[field]]))));
      return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))).map(value => value.toString(16).padStart(2, "0")).join("");
    });
    try {
      await stage(arm, "boot", async () => {
        await page.goto(`${origin}/?local&seed=7319&width=1280&height=720&renderer=${arm === "svg" ? "svg" : "gpu"}${arm === "gpu-select" ? "&gpu-select" : ""}`);
        await page.waitForFunction(() => !!(globalThis as any).__tupaia?.call);
        const ready = await page.evaluate(() => (globalThis as any).__tupaia.call("ready", { timeoutMs: 60000 }));
        check(ready.ok, `Bridge ready failed: ${JSON.stringify(ready)}`);
        return { url: page.url(), ready };
      });
      data.fixture = await stage(arm, "load shared fixture and freeze trade through UI", async () => {
        await page.evaluate(async text => {
          const w = globalThis as any;
          await w.__tupaia.fns.loadMap({ text, timeoutMs: 60000 });
          if (w.layerIsOn("toggleTrade")) document.getElementById("toggleTrade")!.click();
          w.closeDialogs(); w.hideOptions();
          w.zoomTo((0, eval)("graphWidth") / 2, (0, eval)("graphHeight") / 2, 1, 0);
          await w.__tupaia.settle();
        }, fixtureText);
        await page.waitForFunction(() => getComputedStyle(document.getElementById("loading")!).display === "none");
        if (arm !== "svg") await page.waitForFunction(() => {
          const s = (globalThis as any).rendererStatus?.();
          return s?.active === "gpu" && s.gpu?.canvasVisible && s.gpu.sourceCurrent && !s.gpu.pending && !s.gpu.refinementPending && !s.gpu.moving;
        }, {}, { timeout: 60000 });
        const info = await page.evaluate(() => {
          const w = globalThis as any, pack = (0, eval)("pack");
          return { cells: pack.cells.i.length, burgs: pack.burgs.length, tradeOn: w.layerIsOn("toggleTrade"), caravans: document.querySelectorAll("#tradeAnimation > g").length, autosave: localStorage.getItem("autosaveInterval"), renderer: w.rendererStatus?.() };
        });
        check(!info.tradeOn && !info.caravans && info.autosave === "0", "Trade or autosave not disabled for diagnostic");
        check(info.cells > 0 && info.burgs > 1, "Shared fixture lacks searchable geography");
        return info;
      });
      if (arm !== "svg") data.paint = await stage(arm, "settled paint and direct selection", async () => {
        const samples = [];
        for (let sample = 0; sample < 2; sample++) {
          samples.push(await page.evaluate(async () => {
            const w = globalThis as any, renderer = w.gpuRenderer;
            const canvas = document.querySelector<HTMLCanvasElement>("canvas[data-gpu-renderer]")!;
            if (!canvas || typeof renderer?.draw !== "function") throw Error("GPU draw/readback hook unavailable");
            renderer.draw(); // Read in the same task: default WebGL backbuffer is not preserved.
            const gl = canvas.getContext("webgl2")!;
            const rgba = new Uint8Array(canvas.width * canvas.height * 4);
            const previousRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
            gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousRead);
            const glError = gl.getError();
            const png = canvas.toDataURL();
            const hash = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))).map(value => value.toString(16).padStart(2, "0")).join("");
            const before = w.rendererStatus().gpu.pickProfile.queries;
            const selection = w.gpuSelect(640, 360, 0);
            const gpu = w.rendererStatus().gpu;
            let opaque = 0; for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) opaque++;
            return {
              rgbaSha256: await hash(rgba), pngSha256: await hash(new TextEncoder().encode(png)), bytes: rgba.length, nontransparentPixels: opaque, glError,
              width: canvas.width, height: canvas.height, cpuMemory: gpu.memory.cpu, current: gpu.sourceCurrent,
              camera: [(0, eval)("viewX"), (0, eval)("viewY"), (0, eval)("scale")],
              fontStatus: document.fonts.status, tradeOn: w.layerIsOn("toggleTrade"), caravans: document.querySelectorAll("#tradeAnimation > g").length,
              animations: document.getElementById("map")!.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length,
              selection: { kind: selection.kind, id: selection.id, branch: selection.branch, reason: selection.unavailable ?? null, queriesBefore: before, queriesAfter: gpu.pickProfile.queries }
            };
          }));
          await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
        }
        data.paintAttempt = { samples };
        record({ arm, event: "paint-samples", samples });
        for (const sample of samples) {
          check(sample.nontransparentPixels > 100 && sample.glError === 0 && sample.current, "GPU paint readback invalid");
          if (arm === "gpu-select") check(sample.selection.reason === null && sample.selection.queriesAfter > sample.selection.queriesBefore, "Opt-in GPU selection was disabled or unavailable");
          else check(/selection disabled/.test(sample.selection.reason || "") && sample.selection.queriesAfter === sample.selection.queriesBefore, "Rendering-only selection was not safely disabled");
        }
        return { samples, stable: samples[0].rgbaSha256 === samples[1].rgbaSha256, worldDigest: await modelDigest() };
      });
      if (arm === "gpu-select") {
        await stage(arm, "palette smoke preserves opt-in selection", async () => {
          await page.evaluate(() => { const w = globalThis as any; w.showOptions(); document.getElementById("toolsTab")!.click(); });
          await openPalette();
          await page.screenshot({ path: `${output}.${arm}-palette.png`, timeout: 15000 });
          await closePalette();
          await page.evaluate(() => (globalThis as any).hideOptions());
          await page.waitForFunction(() => (globalThis as any).gpuRenderer.pickStatus() === null, {}, { timeout: 60000 });
          const result = await page.evaluate(() => { const s = (globalThis as any).gpuSelect(640, 360, 0); return { branch: s.branch, reason: s.unavailable ?? null }; });
          check(result.reason === null, "Palette disabled the opt-in selector"); return result;
        });
        continue;
      }
      data.subject = await stage(arm, "install forwarding probes and choose unique settlement", async () => {
        const subject = await page.evaluate(() => {
          const w = globalThis as any, pack = (0, eval)("pack");
          const normalize = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
          const valid = pack.burgs.filter((burg: any) => burg?.i && !burg.removed && burg.name && Number.isFinite(burg.x) && Number.isFinite(burg.y));
          const burg = valid.find((candidate: any) => valid.filter((other: any) => normalize(other.name) === normalize(candidate.name)).length === 1);
          if (!burg) throw Error("Fixture lacks a uniquely named settlement");
          w.__paletteProbe = { calls: [], resets: 0, labelClicks: 0, routeClicks: 0, originalZoom: w.zoomTo, originalReset: w.resetZoom };
          const probe = w.__paletteProbe;
          w.zoomTo = (...args: number[]) => { probe.calls.push(args); return probe.originalZoom(...args); };
          w.resetZoom = (...args: number[]) => { probe.resets++; return probe.originalReset(...args); };
          document.addEventListener("click", event => {
            const id = (event.target as Element)?.id;
            if (id === "addLabel") probe.labelClicks++;
            if (id === "addRoute") probe.routeClicks++;
          }, true);
          w.showOptions(); document.getElementById("toolsTab")!.click();
          return { id: burg.i, name: burg.name, x: burg.x, y: burg.y };
        });
        return subject;
      });
      const beforeSearch = await modelDigest();
      data.keyboard = await stage(arm, "both shortcuts, empty Enter, IME and exact canonical navigation", async () => {
        const markersBefore = await page.evaluate(() => (globalThis as any).layerIsOn("toggleMarkers"));
        for (const modifier of ["Control", "Meta"]) {
          await openPalette(modifier);
          await page.keyboard.press("Enter");
          check(await page.locator("#commandPalette").isVisible(), "Empty Enter closed or activated palette");
          check(await cameraCalls() === 0, "Empty Enter navigated");
          await closePalette();
          check(await page.evaluate(() => document.activeElement?.id) === "openCommandPalette", "Shortcut close did not restore launcher focus");
        }
        check(await page.evaluate(() => (globalThis as any).layerIsOn("toggleMarkers")) === markersBefore, "Cmd/Ctrl-K keyup toggled markers");
        await openPalette();
        await page.locator("#commandPaletteInput").fill(data.subject.name);
        await page.screenshot({ path: `${output}.${arm}-palette.png`, timeout: 15000 });
        const options = await page.locator("#commandPaletteResults [role=option]").allTextContents();
        check(options.length > 0 && options[0].includes(data.subject.name), "Unique settlement was not the first search result");
        await page.locator("#commandPaletteInput").dispatchEvent("compositionstart", { data: data.subject.name });
        await page.keyboard.press("Enter");
        check(await cameraCalls() === 0 && await page.locator("#commandPalette").isVisible(), "IME Enter activated a result");
        await page.locator("#commandPaletteInput").dispatchEvent("compositionend", { data: data.subject.name });
        const beforeArrow = await page.evaluate(() => [(0, eval)("viewX"), (0, eval)("viewY"), (0, eval)("scale")]);
        await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowUp");
        const afterArrow = await page.evaluate(() => [(0, eval)("viewX"), (0, eval)("viewY"), (0, eval)("scale")]);
        check(JSON.stringify(beforeArrow) === JSON.stringify(afterArrow), "Palette arrow keyup panned the map");
        // Refill establishes the exact uniquely named settlement as active after the navigation exercise.
        await page.locator("#commandPaletteInput").fill("");
        await page.locator("#commandPaletteInput").fill(data.subject.name);
        await page.keyboard.press("Enter");
        await page.locator("#commandPalette").waitFor({ state: "detached" });
        const calls = await page.evaluate(() => (globalThis as any).__paletteProbe.calls);
        check(calls.length === 1 && calls[0][0] === data.subject.x && calls[0][1] === data.subject.y, `Wrong canonical zoom call: ${JSON.stringify(calls)}`);
        await page.waitForFunction(({ x, y, scale }) => {
          const k = (0, eval)("scale"), vx = (0, eval)("viewX"), vy = (0, eval)("viewY");
          return Math.abs(k - scale) < 0.0001 && Math.abs(((0, eval)("svgWidth") / 2 - vx) / k - x) < 0.01 && Math.abs(((0, eval)("svgHeight") / 2 - vy) / k - y) < 0.01;
        }, { x: data.subject.x, y: data.subject.y, scale: calls[0][2] });
        return { markersBefore, markersAfter: await page.evaluate(() => (globalThis as any).layerIsOn("toggleMarkers")), options, calls, beforeArrow, afterArrow };
      });
      data.model = await stage(arm, "search and navigation do not mutate model", async () => {
        const after = await modelDigest();
        data.modelAttempt = { before: beforeSearch, after };
        check(beforeSearch === after, "Search/navigation mutated world data");
        return { before: beforeSearch, after, exact: true };
      });
      data.editor = await stage(arm, "existing editor, guarded actions and Escape focus", async () => {
        await page.locator("#openMinimapButton").click();
        await page.locator("#minimap").waitFor({ state: "visible" });
        await openPalette();
        for (const title of ["Add a label", "Draw a route"]) {
          await page.locator("#commandPaletteInput").fill(title);
          const option = page.locator("#commandPaletteResults [role=option]").first();
          check(await option.getAttribute("aria-disabled") === "true", "Creation enabled over an open editor");
          await page.keyboard.press("Enter");
          // A disabled best match must not let Enter fall through to a weaker result
          // ("Draw a route" also substring-matches route names like "...withdrawal...").
          const calls = await cameraCalls();
          check(await page.locator("#commandPalette").isVisible(), `Enter on disabled "${title}" closed the palette`);
          check(await cameraCalls() === calls && await page.evaluate(() => (globalThis as any).__paletteProbe.resets) === 0, `Enter on disabled "${title}" navigated`);
          check(/unavailable/.test(await page.locator("#commandPalette .palette-status").textContent() || ""), `Enter on disabled "${title}" gave no reason`);
          await option.click({ force: true }); // Intentionally exercise the disabled row's own click guard.
          check(await page.locator("#commandPalette").isVisible(), "Guarded creation closed palette");
        }
        await closePalette();
        const state = await page.evaluate(() => ({ focus: document.activeElement?.id, label: (globalThis as any).__paletteProbe.labelClicks, route: (globalThis as any).__paletteProbe.routeClicks }));
        check(await page.locator("#minimap").isVisible(), "Escape leaked into closeAllDialogs");
        check(state.focus === "openCommandPalette" && state.label === 0 && state.route === 0, "Guarded action/focus contract failed");
        await page.evaluate(() => (globalThis as any).$("#minimap").dialog("close"));
        return state;
      });
      data.editable = await stage(arm, "existing editable input exclusion", async () => {
        await page.locator("#optionsTab").click();
        const input = page.locator("#mapName"); await input.focus();
        const before = await input.inputValue();
        for (const modifier of ["Control", "Meta"]) {
          await page.keyboard.down(modifier); await page.keyboard.press("k"); await page.keyboard.up(modifier);
          check(await page.locator("#commandPalette").count() === 0, "Palette intercepted editor text shortcut");
        }
        check(await input.inputValue() === before, "Shortcut changed map name text");
        await page.keyboard.press("Escape");
        await page.locator("#toolsTab").click();
        return { input: "mapName", before, after: await input.inputValue() };
      });
      data.invalidation = await stage(arm, "synthetic replacement and lifecycle invalidation", async () => {
        const callsBefore = await cameraCalls();
        await openPalette(); await page.locator("#commandPaletteInput").fill(data.subject.name);
        await page.evaluate(() => { const w = globalThis as any; w.__paletteProbe.originalPack = (0, eval)("pack"); (0, eval)("pack = {...pack}"); });
        try {
          await page.keyboard.press("Enter");
          await page.locator("#commandPalette").waitFor({ state: "detached" });
          check(await cameraCalls() === callsBefore, "Stale world result navigated");
        } finally {
          await page.evaluate(() => { (0, eval)("pack = window.__paletteProbe.originalPack"); delete (globalThis as any).__paletteProbe.originalPack; });
        }
        const events = ["map:loading", "map:loaded", "map:generated", "map:resampled"];
        for (const event of events) {
          await openPalette();
          await page.evaluate(name => window.dispatchEvent(new CustomEvent(name)), event);
          await page.locator("#commandPalette").waitFor({ state: "detached" });
        }
        return { synthetic: true, events, callsBefore, callsAfter: await cameraCalls() };
      });
      data.actions = await stage(arm, "customization guard and existing label/route controllers", async () => {
        const originalCustomization = await page.evaluate(() => (0, eval)("customization"));
        await page.evaluate(() => (0, eval)("customization = 1"));
        try {
          await openPalette(); await page.locator("#commandPaletteInput").fill("Add a label");
          check(await page.locator("#commandPaletteResults [role=option]").first().getAttribute("aria-disabled") === "true", "Customization guard missing");
          await closePalette();
        } finally { await page.evaluate(value => { (globalThis as any).__paletteCustomization = value; (0, eval)("customization = window.__paletteCustomization"); delete (globalThis as any).__paletteCustomization; }, originalCustomization); }
        await openPalette(); await page.locator("#commandPaletteInput").fill("Add a label"); await page.keyboard.press("Enter");
        await page.locator("#commandPalette").waitFor({ state: "detached" });
        check(await page.locator("#addLabel").evaluate(element => element.classList.contains("pressed")), "Label controller was not activated");
        await page.evaluate(() => (globalThis as any).unpressClickToAddButton());
        await openPalette(); await page.locator("#commandPaletteInput").fill("Draw a route"); await page.keyboard.press("Enter");
        await page.locator("#routeCreator").waitFor({ state: "visible" });
        const state = await page.evaluate(() => ({ labelClicks: (globalThis as any).__paletteProbe.labelClicks, routeClicks: (globalThis as any).__paletteProbe.routeClicks, controlPoints: !!document.getElementById("controlPoints") }));
        check(state.labelClicks === 1 && state.routeClicks === 1 && state.controlPoints, "Creation bypassed or duplicated existing controllers");
        await page.locator("#routeCreatorCancel").click();
        return state;
      });
      data.final = { modelDigest: await modelDigest(), cameraCalls: await cameraCalls() };
    } catch (error) {
      data.failure = String(error); report.failure ??= `${arm}: ${error}`;
      try { await page.screenshot({ path: `${output}.${arm}-failure.png`, timeout: 10000 }); } catch (screenshotError) { data.screenshotError = String(screenshotError); }
    } finally { await context.close(); }
  }
  const render = report.arms.gpu?.paint, select = report.arms["gpu-select"]?.paint;
  if (render && select) {
    const a = render.samples[0], b = select.samples[0];
    report.parity = {
      equal: a.rgbaSha256 === b.rgbaSha256, stableWithinArms: render.stable && select.stable,
      worldEqual: render.worldDigest === select.worldDigest, cameraEqual: JSON.stringify(a.camera) === JSON.stringify(b.camera),
      rgba: { renderingOnly: a.rgbaSha256, gpuSelect: b.rgbaSha256 }, cpuMemory: { renderingOnly: a.cpuMemory, gpuSelect: b.cpuMemory },
      animationEvidence: { renderingOnly: { tradeOn: a.tradeOn, caravans: a.caravans, animations: a.animations, fonts: a.fontStatus }, gpuSelect: { tradeOn: b.tradeOn, caravans: b.caravans, animations: b.animations, fonts: b.fontStatus } },
      classification: a.rgbaSha256 === b.rgbaSha256 ? "exact settled paint parity" : "unresolved diagnostic difference; inspect timing/font/animation evidence before attributing a product regression"
    };
    if (!report.parity.equal || !report.parity.stableWithinArms || !report.parity.worldEqual || !report.parity.cameraEqual) report.failure ??= "GPU paint parity is unresolved; raw hashes and stability evidence retained";
  } else report.failure ??= "GPU paint parity could not be established";
  if (report.errors.length) report.failure ??= "Uncaught page errors; see errors";
  if (report.warnings.some((warning: any) => /GL_INVALID_|Feedback loop/.test(warning.text))) report.failure ??= "WebGL validation warning";
} catch (error) { report.failure ??= String(error); }
finally {
  report.finishedUtc = new Date().toISOString();
  writeFileSync(output + ".json", JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ output, failure: report.failure, errors: report.errors, parity: report.parity }, null, 2));
  try { await browser?.close(); } finally { await new Promise<void>(done => server.close(() => done())); }
  if (report.failure || report.errors.length) process.exitCode = 1;
}
