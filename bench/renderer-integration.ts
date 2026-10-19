// Editor integration + save/export roundtrip for the EXPERIMENTAL GPU click routing (?renderer=gpu&gpu-select).
// Real clicks (Playwright mouse) on the live app open, edit and close the burg, label, route, marker and relief editors;
// each click asserts the canonical element identity the editor received (d3.event.target, elSelected), exactly one
// editor call, the routing outcome (gpuClickTelemetry) and the suspended/unavailable pick status while a dialog is
// open. Then prepareMapData + the full-map SVG export are compared byte-for-byte across a load of the saved text, and
// the edits are checked to persist. Stale-camera cohorts: a resynced (unready kind) cohort on the shared world and a
// routed marker cohort on the generated 100k world. The oracle is document.elementFromPoint on the canonical SVG (the
// SVG side only). Isolated local browser: local GET + fonts.gstatic GET only, service workers blocked, autosave 0,
// nothing downloaded. Results are immutable.
//
// INTERFACE FOR CHILD E (editor-dispatch / GPU click routing). Globals this harness relies on, all installed by
// src/gpu/renderer.ts under ?gpu-select (detached again on teardown):
//   window.gpuClickRoute(event)  -> null | false | {target,...}; wrapped per page to record each call's result
//   window.gpuClickTelemetry     -> {byKind, recovered, unrecovered, disagreements, lastMs}; byKind[kind] holds
//                                   routed, resynced, dropped, legacy, agree, disagree, unavailable
//   window.gpuSelect(x, y, tol)  -> {kind, branch, via, unavailable?}; SVG-local CSS px
//   window.gpuRenderer           -> canonicalCameraStale(), syncCanonicalCamera(), and the status fields below
// Also used: window.rendererStatus().gpu.{canvasVisible,sourceCurrent,windows.coverage,pending,refinementPending,moving,
// state,suspendedReason}, window.d3 (zoom on #map), editors (editBurg, editLabel, editRoute, editMarker, editReliefIcon,
// editRiver), window.pack, window.pickBurg, window.peekRelief, window.lazy.save/exportMap.
// Telemetry fields ASSERTED: per cohort, exactly one of routed/resynced/dropped/legacy moves by one per click;
// agree/disagree deltas are reported; recovered/unrecovered move at most once per click; unavailable is only read
// while a dialog is open (suspended pick). Verdicts per cohort: PASS, FAIL, UNTESTED (no eligible sample), UNDERCOVERED.
// Cohort size: INTEGRATION_COHORT=short (default, 10 eligible per cohort) or full (50; the final run).
import { chromium, type CDPSession, type Page } from "playwright";
import { cpuVsWait, diffMetrics, pickMetrics, summarizeCpuProfile } from "./route-state-probe.ts";
import {
  FIXTURE_KINDS,
  FIXTURE_MIN,
  attemptBudget,
  cohortMode,
  cohortSize,
  cohortVerdict,
  compareIds,
  coverage,
  strideSample,
  type CohortVerdict
} from "./integration-fixture.ts";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";

const dpr = Number(process.env.INTEGRATION_DPR || 2);
const zoom = Number(process.env.INTEGRATION_ZOOM || 2);
const name = process.env.INTEGRATION_NAME || "integration";
const output = process.env.INTEGRATION_OUTPUT || "/tmp/tupaia-renderer-integration.json";
const mapPath = process.env.INTEGRATION_MAP || "/tmp/tupaia-navigation-shared-v8.map";
if (![1, 2].includes(dpr)) throw new Error("INTEGRATION_DPR must be 1 or 2");
if (![1, 2, 4, 8].includes(zoom)) throw new Error("INTEGRATION_ZOOM must be 1, 2, 4 or 8");
if (existsSync(output)) throw new Error("INTEGRATION_OUTPUT exists; results are immutable: " + output);
const diagnosticsPath = output.replace(/\.json$/, "") + ".diagnostics.json";
if (existsSync(diagnosticsPath)) throw new Error("diagnostics exist; results are immutable: " + diagnosticsPath);

const VIEW = { width: 1280, height: 720 };
const cohort = cohortMode(process.env.INTEGRATION_COHORT);
const COHORT = cohortSize(cohort);
const MARKER_ELIGIBLE = COHORT;
const MARKER_ATTEMPTS = attemptBudget(COHORT);
const MARKER_MINUTES = cohort === "full" ? 11 : 4;
const RESYNC_PER_KIND = COHORT;
const ROUTE_ATTEMPTS = attemptBudget(COHORT);
// route cohort camera zooms, tried in order until a route has a ±2 px robust click point (max zoom 20 leaves room for
// the +100 wheel step)
const ROUTE_ZOOMS = [8, 16];
// focus "route": the 100k route-click flow alone with phase telemetry (a diagnostic, never a full-suite pass)
const nativeProbe = process.env.INTEGRATION_NATIVE_PROBE === "1";
const forceEmblems = process.env.INTEGRATION_EMBLEMS === "1";
const focus = process.env.INTEGRATION_FOCUS === "route" ? "route" : "all";
const FOCUS_ROUTES = 3;
const FOCUS_LIMIT = 180000; // resume is measured up to this long; the full suite fails past 30 s (__ix.settled)
const FOCUS_DWELL = [0, 3000]; // ms the route editor stays open before close: the cohort's immediate close, a user's dwell
// INTEGRATION_PREAMBLE (route focus only): the full suite's earlier stages, run in suite order on the same page before the
// same route focus, to find the smallest prefix that reproduces the full-suite slowdown (diagnostic, never a pass).
//   none      route focus alone on a fresh page (the existing baseline)
//   editors   + World A (shared fixture): editor open/edit/close per kind, then the stale fallback click
//   roundtrip + save/load/export roundtrip (reload of the saved text), the undo probe and the resync cohort
//   fixture   + world replacement by the 100k world, the synthetic labels and the tile harvest; the route focus then runs
//             on that world without regenerating it, as the route cohort does
const PREAMBLES = ["none", "editors", "roundtrip", "fixture"] as const;
type Preamble = (typeof PREAMBLES)[number];
const preamble = (process.env.INTEGRATION_PREAMBLE || "none") as Preamble;
if (!PREAMBLES.includes(preamble)) throw new Error("INTEGRATION_PREAMBLE must be one of " + PREAMBLES.join(", "));
if (preamble !== "none" && focus !== "route") throw new Error("INTEGRATION_PREAMBLE needs INTEGRATION_FOCUS=route (the full suite runs every stage)");
const stage = (name: Exclude<Preamble, "none">) => focus === "all" || PREAMBLES.indexOf(preamble) >= PREAMBLES.indexOf(name);

const dist = resolve("dist");
const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json"
};
const blocked: string[] = [];
const server = createServer((request, response) => {
  if (request.method !== "GET") return void response.writeHead(405).end();
  const path = resolve(dist, "." + new URL(request.url || "/", "http://localhost").pathname);
  if (!path.startsWith(dist + "/") && path !== dist) return void response.writeHead(403).end();
  try {
    const file = path === dist ? resolve(dist, "index.html") : path;
    response.setHeader("content-type", mime[extname(file)] || "application/octet-stream");
    response.end(readFileSync(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing local server");
const origin = "http://127.0.0.1:" + address.port;
const sharedText = readFileSync(mapPath, "utf8");

const failures: string[] = [];
const fail = (message: string) => failures.push(message);
const check = (ok: unknown, message: string) => {
  if (!ok) fail(message);
  return !!ok;
};
const diagnostics: Record<string, unknown> = {};
const report: any = {
  schema: 1,
  name,
  config: {
    dpr,
    zoom,
    map: mapPath,
    mapSha256: createHash("sha256").update(sharedText).digest("hex"),
    generated: { cells: 100000, seed: "7319", template: "continents", width: 1280, height: 720 },
    viewport: VIEW,
    url: "/?local&seed=7319&width=1280&height=720&renderer=gpu&gpu-select",
    markerCohort: { eligible: MARKER_ELIGIBLE, attempts: MARKER_ATTEMPTS, minutes: MARKER_MINUTES },
    resyncPerKind: RESYNC_PER_KIND,
    cohort: { mode: cohort, size: COHORT, attemptBudget: MARKER_ATTEMPTS, fixtureMinimum: FIXTURE_MIN },
    nativeProbe, forceEmblems,
    focus,
    preamble,
    scope: focus === "route" ? "route-focus diagnostic only: never a full-suite pass" : "full suite",
    oracle:
      "document.elementFromPoint on the canonical SVG after the click returns (post camera sync); independent of the " +
      "routed path, the same computation as resolve() on the resynced path (not independent there)",
    network: "local GET + fonts.gstatic.com GET only; service workers blocked; autosave 0; no downloads"
  },
  editors: [],
  staleFallback: null,
  roundtrip: null,
  resyncCohort: null,
  markerCohort: null,
  telemetry: null,
  pageErrors: [] as string[],
  blockedRequests: blocked,
  failures,
  failure: null as string | null
};

// Page-side harness state (window.__ix): editor wrappers, the click-route recorder and the oracle helpers. Installed
// once per page; wrappers are re-armed before every click because a world load may replace the hooked globals.
function installHelpers() {
  const w = globalThis as any;
  const EDITORS = ["editBurg", "editLabel", "editRoute", "editMarker", "editReliefIcon", "editRiver"];
  const DIALOGS: Record<string, string> = {
    editBurg: "#burgEditor",
    editLabel: "#labelEditor",
    editRoute: "#routeEditor",
    editMarker: "#markerEditor",
    editReliefIcon: "#reliefEditor",
    editRiver: "#riverEditor"
  };
  // clicked()'s fixed-depth branches (editors.js), the replica pinned by editor-dispatch.test.ts
  const branchOf = (el: Element | null) => {
    const parent = el?.parentElement;
    const grand = parent?.parentElement;
    const great = grand?.parentElement;
    const ancestor = great?.parentElement;
    if (!el || !parent || !grand || !great || !ancestor) return "ignored";
    if (grand.id === "emblems") return "emblems";
    if (parent.id === "rivers") return "rivers";
    if (grand.id === "routes") return "routes";
    if (ancestor.id === "labels" && el.tagName === "tspan") return "labels";
    if (grand.id === "burgLabels") return "burgLabels";
    if (grand.id === "burgIcons") return "burgIcons";
    if (parent.id === "ice") return "ice";
    if (parent.id === "terrain") return "terrain";
    if (grand.id === "markers" || great.id === "markers") return "markers";
    if (grand.id === "markets" && el.tagName !== "path") return "markets";
    if (grand.id === "goodsIcons") return "goodsIcons";
    if (parent.id === "goodsCells") return "goodsCells";
    if (grand.id === "goodsBurgs") return "goodsBurgs";
    if (grand.id === "coastline") return "coastline";
    if (grand.id === "lakes") return "lakes";
    if (great.id === "armies") return "armies";
    return "fallback";
  };
  const subject = (el: Element | null) => {
    if (!el) return null;
    const branch = branchOf(el);
    if (branch === "labels") return el.closest("text");
    if (branch === "markers") return el.closest("svg");
    return el;
  };
  const EDITOR_OF: Record<string, string> = {
    routes: "editRoute",
    labels: "editLabel",
    burgLabels: "editBurg",
    burgIcons: "editBurg",
    terrain: "editReliefIcon",
    markers: "editMarker",
    rivers: "editRiver"
  };
  const describe = (el: Element | null) => (el ? el.tagName + "#" + (el.id || "") : null);
  const ix: any = {
    branchOf,
    subject,
    describe,
    EDITOR_OF,
    calls: [] as { editor: string; target: Element | null; args: unknown[] }[],
    routes: [] as any[],
    current: null as any,
    sleep: (ms: number) => new Promise(done => setTimeout(done, ms)),
    frames: () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))),
    selected: () => {
      const sel = (0, eval)("typeof elSelected === 'undefined' ? null : elSelected");
      return sel?.node?.() ?? null;
    },
    hit: (x: number, y: number) => {
      const el = document.elementFromPoint(x, y);
      return el && document.getElementById("viewbox")?.contains(el) ? el : null;
    },
    toWorld: (x: number, y: number) => {
      const p = new DOMPoint(x, y).matrixTransform((document.getElementById("viewbox") as any).getScreenCTM().inverse());
      return [p.x, p.y];
    },
    toScreen: (wx: number, wy: number) => {
      const p = new DOMPoint(wx, wy).matrixTransform((document.getElementById("viewbox") as any).getScreenCTM());
      return [p.x, p.y];
    },
    // where a world point sits under the d3 zoom transform (the GPU camera), not the possibly stale SVG
    toScreenLive: (wx: number, wy: number) => {
      const map = document.getElementById("map")!;
      const t = w.d3.zoomTransform(map);
      const rect = map.getBoundingClientRect();
      return [rect.left + t.x + wx * t.k, rect.top + t.y + wy * t.k];
    },
    telemetry: () => {
      const sum: Record<string, number> = {};
      for (const counts of Object.values(w.gpuClickTelemetry?.byKind ?? {}) as Record<string, number>[])
        for (const [key, value] of Object.entries(counts)) sum[key] = (sum[key] ?? 0) + value;
      sum.recovered = w.gpuClickTelemetry?.recovered ?? 0;
      sum.unrecovered = w.gpuClickTelemetry?.unrecovered ?? 0;
      return {
        sum,
        byKind: JSON.parse(JSON.stringify(w.gpuClickTelemetry?.byKind ?? {})),
        unavailableReasons: [...(w.gpuClickTelemetry?.unavailableReasons ?? [])],
        dropReasons: { ...(w.gpuClickTelemetry?.dropReasons ?? {}) }
      };
    },
    openDialogs: () =>
      Object.values(DIALOGS).filter(id => w.$(id).hasClass("ui-dialog-content") && w.$(id).dialog("isOpen")),
    // closes the editors, then any other open jQuery UI dialog (an editor can open a secondary one); returns the
    // ids of the others so the report shows them
    closeAll: () => {
      for (const id of Object.values(DIALOGS))
        if (w.$(id).hasClass("ui-dialog-content") && w.$(id).dialog("isOpen")) w.$(id).dialog("close");
      const others: string[] = [];
      for (const el of document.querySelectorAll(".ui-dialog-content"))
        if (w.$(el).dialog("isOpen")) {
          others.push(el.id || el.className);
          w.$(el).dialog("close");
        }
      return others;
    },
    // jQuery UI dialog wrappers still displayed (what the renderer's editor suspension sees), for diagnosis
    shownDialogs: () =>
      [...document.querySelectorAll<HTMLElement>(".ui-dialog")]
        .filter(el => getComputedStyle(el).display !== "none")
        .map(el => {
          const content = el.querySelector(".ui-dialog-content");
          return (content?.id || "?") + ":" + (el.querySelector(".ui-dialog-title")?.textContent ?? "");
        }),
    DIALOGS,
    arm() {
      ix.calls = [];
      ix.routes = [];
      ix.clicks = [];
      // every click event as the window capture phase sees it (before #map's recovery listener)
      if (!w.__ixClicks) {
        w.__ixClicks = true;
        window.addEventListener("click", event => {
          w.__ix.clicks.push({ trusted: event.isTrusted, target: event.target, stale: w.gpuRenderer?.canonicalCameraStale() });
        }, true);
      }
      for (const editor of EDITORS) {
        const fn = w[editor];
        if (typeof fn !== "function") throw new Error("missing editor global " + editor);
        if (fn.__ix) continue;
        const wrapped = function (this: unknown, ...args: unknown[]) {
          w.__ix.calls.push({ editor, target: w.d3.event?.target ?? null, args });
          return fn.apply(this, args);
        };
        (wrapped as any).__ix = true;
        w[editor] = wrapped;
      }
      const route = w.gpuClickRoute;
      if (typeof route !== "function") throw new Error("gpuClickRoute missing: ?gpu-select not active");
      if (!route.__ix) {
        const wrapped = (event: MouseEvent) => {
          const record: any = {
            stale: w.gpuRenderer.canonicalCameraStale(),
            native: event.target,
            point: [event.clientX, event.clientY]
          };
          w.__ix.routes.push(record);
          const result = route(event);
          record.result = result === null ? "legacy" : result === false ? "dropped" : "event";
          record.target = result ? result.target : null;
          record.oracle = w.__ix.hit(event.clientX, event.clientY); // after the route returned: camera synced
          return result;
        };
        (wrapped as any).__ix = true;
        w.gpuClickRoute = wrapped;
      }
    },
    async settled(limit = 30000) {
      const start = performance.now();
      while (true) {
        const status = w.rendererStatus?.();
        const gpu = status?.gpu;
        if (status?.active !== "gpu") throw new Error("GPU fell back: " + status?.fallbackReason);
        if (
          gpu?.canvasVisible &&
          gpu.sourceCurrent &&
          gpu.windows?.coverage === "covered" &&
          !gpu.pending &&
          !gpu.refinementPending &&
          !gpu.moving
        )
          return;
        if (performance.now() - start > limit)
          throw new Error(
            "GPU did not settle: " +
              JSON.stringify({
                // newest background jobs first (ms null = still running), ages relative to now: names the stuck job
                jobs: (gpu?.trace?.jobs ?? [])
                  .slice(-6)
                  .reverse()
                  .map((job: any) => [job.kind, job.detail, Math.round(gpu.trace.now - job.at), job.ms && Math.round(job.ms)]),
                state: gpu?.state,
                suspended: gpu?.suspendedReason,
                coverage: gpu?.windows?.coverage,
                canvasVisible: gpu?.canvasVisible,
                sourceCurrent: gpu?.sourceCurrent,
                pending: gpu?.pending,
                refinementPending: gpu?.refinementPending,
                moving: gpu?.moving,
                revision: gpu?.revision,
                lastRevision: gpu?.invalidations?.last,
                lastPrepare: gpu?.lastPrepare,
                markers: gpu?.markers,
                frames: gpu?.frames
              })
          );
        await ix.sleep(25);
      }
    },
    async quiet(ms = 400, limit = 10000) {
      let last = performance.now();
      const observer = new MutationObserver(() => (last = performance.now()));
      observer.observe(document.getElementById("map")!, {
        childList: true,
        attributes: true,
        characterData: true,
        subtree: true
      });
      const begin = performance.now();
      try {
        while (performance.now() - last < ms && performance.now() - begin < limit) await ix.sleep(50);
      } finally {
        observer.disconnect();
      }
      return performance.now() - last >= ms;
    },
    async prepare() {
      w.TradeAnimation?.stop?.();
      await ix.settled();
      const quiet = await ix.quiet();
      await ix.settled();
      await ix.frames();
      return quiet;
    },
    async camera(k: number, wx: number, wy: number, sx = 640, sy = 360) {
      w.d3
        .select("#map")
        .call((0, eval)("zoom").transform, w.d3.zoomIdentity.translate(sx - wx * k, sy - wy * k).scale(k));
      await ix.sleep(350);
      if (w.waitDenseZoomReady) await w.waitDenseZoomReady(15000);
      await w.reliefRenderReady;
    },
    // GPU selection at a client point, SVG-local CSS px, tolerance 0
    gpuAt(x: number, y: number) {
      const rect = document.getElementById("map")!.getBoundingClientRect();
      const s = w.gpuSelect(x - rect.left, y - rect.top, 0);
      return { kind: s.kind, branch: s.branch, via: s.via, unavailable: s.unavailable ?? null };
    }
  };
  // wrappers installed by an earlier install record into the current w.__ix (they read it at call time)
  w.__ix = ix;
}

// Target search at the current camera: an integer client point whose canonical SVG hit lies in the candidate and takes
// the expected clicked() branch (a label must be hit on a tspan). Relief targets are compact-raster icons whose center
// falls through to the fallback leg with no burg nearby and a matching read-only peekRelief key.
function installLocate() {
  const w = globalThis as any;
  const ix = w.__ix;
  const SPECS: Record<string, { selector: string; branch: string }> = {
    route: { selector: "#routes > g > path", branch: "routes" },
    label: { selector: "#labels > g > text", branch: "labels" },
    burg: { selector: "#burgLabels > g > text", branch: "burgLabels" },
    river: { selector: "#rivers > path", branch: "rivers" },
    marker: { selector: "#markers > svg", branch: "markers" }
  };
  const inView = (x: number, y: number) => x >= 20 && x <= 1260 && y >= 20 && y <= 700;
  const candidates = (kind: string) => {
    const list = [...document.querySelectorAll(SPECS[kind].selector)];
    // labels: ordinary labels first (a stateLabel edit only raises a tip, but keep it the last resort)
    if (kind === "label") list.sort((a, b) => +a.id.startsWith("stateLabel") - +b.id.startsWith("stateLabel"));
    return list;
  };
  const points = (el: Element) => {
    const out: [number, number][] = [];
    const geometry = el as SVGGeometryElement;
    if (el.tagName === "path" && typeof geometry.getTotalLength === "function") {
      const length = geometry.getTotalLength();
      const ctm = geometry.getScreenCTM();
      if (ctm && length > 0)
        for (let f = 0.05; f < 1; f += 0.05) {
          const p = geometry.getPointAtLength(length * f).matrixTransform(ctm);
          out.push([p.x, p.y]);
        }
    }
    const r = el.getBoundingClientRect();
    for (let i = 1; i <= 9; i++) for (let j = 1; j <= 9; j++) out.push([r.left + (r.width * i) / 10, r.top + (r.height * j) / 10]);
    return out;
  };
  const accepts = (kind: string, el: Element, hit: Element | null) =>
    !!hit && el.contains(hit) && ix.branchOf(hit) === SPECS[kind].branch && (kind !== "label" || hit.tagName === "tspan");
  // one element's accepted click point at the current camera; robust: the 2 px neighbours hit it too (stale clicks
  // re-project the world point)
  const probe = (kind: string, el: Element, robust: boolean) => {
    const r = el.getBoundingClientRect();
    if (r.right < 20 || r.left > 1260 || r.bottom < 20 || r.top > 700 || !r.width || !r.height) return null;
    for (const [fx, fy] of points(el)) {
      const x = Math.round(fx),
        y = Math.round(fy);
      if (!inView(x, y)) continue;
      const hit = ix.hit(x, y);
      if (!accepts(kind, el, hit)) continue;
      if (robust && ![[2, 0], [-2, 0], [0, 2], [0, -2]].every(([dx, dy]) => accepts(kind, el, ix.hit(x + dx, y + dy))))
        continue;
      return { kind, element: el, hit, x, y, world: ix.toWorld(x, y) };
    }
    return null;
  };
  ix.locate = (kind: string, robust = false) => {
    if (kind === "relief") return ix.locateRelief();
    let checked = 0;
    for (const el of candidates(kind)) {
      if (++checked > 400) break;
      const found = probe(kind, el, robust);
      if (!found) continue;
      ix.current = found;
      return { kind, id: el.id, dataId: el.getAttribute("data-id"), x: found.x, y: found.y, hit: ix.describe(found.hit), world: found.world };
    }
    return null;
  };
  // fixture keys: the element id, else its data-id, else its position in the kind's candidate list (stable per world)
  const keyed = (kind: string) => candidates(kind).map((el, index) => ({ el, key: el.id || el.getAttribute("data-id") || "#" + index }));
  // census of one kind: every distinct key in the world, and the keys with a clickable point at the current camera
  // (no aiming: the natural coverage). Page-side only; the node side chooses which keys form the fixture.
  ix.census = (kind: string) => {
    const seen = new Map<string, Element>();
    for (const { el, key } of keyed(kind)) if (!seen.has(key)) seen.set(key, el);
    const natural = [...seen].filter(([, el]) => probe(kind, el, false)).map(([key]) => key);
    return { keys: [...seen.keys()], natural };
  };
  // the fixture object's click point at the current camera, or null when it is not visible from here
  ix.probeKey = (kind: string, key: string, robust = false) => {
    const hit = keyed(kind).find(entry => entry.key === key);
    const found = hit ? probe(kind, hit.el, robust) : null;
    if (found) ix.current = found;
    return found ? { x: found.x, y: found.y, hit: ix.describe(found.hit), world: found.world } : null;
  };
  // keys of one kind with a click point at the current camera, skipping those already verified (one pass per tile camera)
  ix.harvest = (kind: string, skip: string[]) => {
    const done = new Set(skip);
    const keys: string[] = [];
    let onScreen = 0;
    for (const { el, key } of keyed(kind)) {
      if (done.has(key)) continue;
      done.add(key);
      const r = el.getBoundingClientRect();
      if (r.right >= 20 && r.left <= 1260 && r.bottom >= 20 && r.top <= 700 && r.width && r.height) onScreen++;
      if (probe(kind, el, false)) keys.push(key);
    }
    return { keys, onScreen };
  };
  // the canonical camera at a tile: whether the SVG transform lags the GPU camera, and the transform itself
  ix.cameraState = () => ({
    stale: !!w.gpuRenderer?.canonicalCameraStale?.(),
    transform: document.getElementById("viewbox")?.getAttribute("transform") ?? null,
    zoom: (({ k, x, y }) => ({ k, x, y }))(w.d3.zoomTransform(document.getElementById("map")))
  });
  // world center of a fixture object: the camera is aimed here so that its click point becomes visible. A path aims at
  // its mid-length point (a route's bbox center is usually off the stroke)
  ix.aimKey = (kind: string, key: string) => {
    const hit = keyed(kind).find(entry => entry.key === key);
    if (!hit) return null;
    const geometry = hit.el as SVGGeometryElement;
    if (hit.el.tagName === "path" && typeof geometry.getTotalLength === "function") {
      const length = geometry.getTotalLength();
      const ctm = geometry.getScreenCTM();
      if (ctm && length > 0) {
        const p = geometry.getPointAtLength(length / 2).matrixTransform(ctm);
        return ix.toWorld(p.x, p.y);
      }
    }
    const r = hit.el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? ix.toWorld(r.left + r.width / 2, r.top + r.height / 2) : null;
  };
  // the document-level undo/redo controls: #undo and #redo belong to the heightmap editor (index.html), not to the map
  ix.undoState = () => {
    const undo = document.getElementById("undo") as HTMLButtonElement | null;
    const redo = document.getElementById("redo") as HTMLButtonElement | null;
    return { undo: !!undo, undoDisabled: !!undo?.disabled, redo: !!redo, redoDisabled: !!redo?.disabled };
  };
  ix.routeName = (id: number) => (globalThis as any).pack.routes.find((r: any) => r.i === id)?.name ?? null;
  ix.locateRelief = () => {
    const raster = document.querySelector("#terrain > image[data-relief]");
    if (!raster) return null;
    const sprites = JSON.parse(raster.getAttribute("data-relief") || "[]") as { i: string; x: number; y: number; s: number }[];
    const ranked = sprites
      .map(sprite => {
        const [sx, sy] = ix.toScreen(sprite.x + sprite.s / 2, sprite.y + sprite.s / 2);
        return { sprite, x: Math.round(sx), y: Math.round(sy), d: (sx - 640) ** 2 + (sy - 360) ** 2 };
      })
      .filter(c => inView(c.x, c.y))
      .sort((a, b) => a.d - b.d)
      .slice(0, 400);
    for (const { sprite, x, y } of ranked) {
      const hit = ix.hit(x, y);
      if (ix.branchOf(hit) !== "fallback") continue;
      const [qx, qy] = ix.toWorld(x, y);
      if (w.pickBurg?.(qx, qy) != null) continue;
      const key = "|" + sprite.i + "@" + sprite.x + "," + sprite.y;
      const peek = w.peekRelief?.(qx, qy);
      if (peek?.key !== key) continue;
      ix.current = { kind: "relief", element: null, hit, x, y, world: [qx, qy], key, sprite };
      return { kind: "relief", id: key, x, y, hit: ix.describe(hit), world: [qx, qy], sprite };
    }
    return null;
  };
  // world center of the attempt-th candidate (any position), for re-aiming the camera when none is on screen
  ix.aim = (kind: string, attempt: number) => {
    if (kind === "relief") return null;
    const list = candidates(kind).filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const el = list[Math.floor((attempt * list.length) / 5)];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return ix.toWorld(r.left + r.width / 2, r.top + r.height / 2);
  };
}

// After a real click on ix.current at the current (exact) camera: legacy dispatch of the native canonical target, one
// editor call, elSelected identity, the dialog open and the pick index unavailable (suspended), then a real edit
// through the editor's own input and close. Returns the problems found (each a failure) and the observations.
function installEditorChecks() {
  const w = globalThis as any;
  const ix = w.__ix;
  const EDITOR: Record<string, string> = {
    burg: "editBurg",
    label: "editLabel",
    route: "editRoute",
    marker: "editMarker",
    relief: "editReliefIcon"
  };
  const input = (id: string, value: string | number) => {
    const el = document.getElementById(id) as HTMLInputElement;
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const close = (id: string) => {
    w.$(id).dialog("close");
    return !(w.$(id).hasClass("ui-dialog-content") && w.$(id).dialog("isOpen"));
  };
  const reliefKey = (use: Element) =>
    "|" + (use.getAttribute("href") || use.getAttribute("xlink:href")) + "@" + +use.getAttribute("x")! + "," + +use.getAttribute("y")!;
  ix.edits ??= {};
  ix.verifyEditor = (kind: string, before: any) => {
    const problems: string[] = [];
    const expect = (ok: unknown, message: string) => ok || problems.push(kind + ": " + message);
    const cur = ix.current;
    const editor = EDITOR[kind];
    const dialog = ix.DIALOGS[editor];
    const route = ix.routes[0];
    expect(ix.routes.length === 1, "gpuClickRoute calls " + ix.routes.length);
    expect(route?.stale === false, "camera stale at an exact-camera click");
    expect(route?.result === "legacy", "route result " + route?.result);
    const after = ix.telemetry().sum;
    const delta = (key: string) => (after[key] ?? 0) - (before[key] ?? 0);
    expect(delta("legacy") === 1 && delta("routed") === 0 && delta("resynced") === 0 && delta("dropped") === 0,
      "telemetry delta " + JSON.stringify(after));
    expect(ix.calls.length === 1 && ix.calls[0].editor === editor,
      "editor calls " + JSON.stringify(ix.calls.map((c: any) => c.editor)));
    const call = ix.calls[0];
    expect(call?.target === cur.hit, "d3.event.target " + ix.describe(call?.target) + " != native " + ix.describe(cur.hit));
    expect(route?.native === cur.hit, "native target moved: " + ix.describe(route?.native));
    const selected = ix.selected();
    if (kind === "relief")
      expect(selected?.tagName === "use" && selected.parentElement?.id === "terrain" && reliefKey(selected) === cur.key,
        "elSelected " + ix.describe(selected) + " key " + (selected && reliefKey(selected)) + " != " + cur.key);
    else expect(selected === cur.element, "elSelected " + ix.describe(selected) + " != " + ix.describe(cur.element));
    expect(ix.openDialogs().includes(dialog), "dialog not open: " + dialog);
    // fail-closed while editing: the pick is unavailable (never an empty hit), reported as the editor suspension
    const pick = ix.gpuAt(cur.x, cur.y);
    expect(pick.branch === "unavailable" && pick.kind === "none" && String(pick.unavailable).startsWith("suspended"),
      "pick while editing " + JSON.stringify(pick));
    const observed: any = { kind, editor, agree: { agree: delta("agree"), disagree: delta("disagree") }, pickWhileOpen: pick };
    try {
      if (kind === "burg") {
        const id = +cur.element.getAttribute("data-id");
        const name = "Ixburg" + id;
        input("burgName", name);
        expect(w.pack.burgs[id].name === name && cur.element.textContent === name, "burg name not applied");
        ix.edits.burg = { id, name };
      } else if (kind === "label") {
        input("labelText", "Ixlabel");
        expect(cur.element.textContent === "Ixlabel", "label text " + cur.element.textContent);
        ix.edits.label = { id: cur.element.id, text: "Ixlabel" };
      } else if (kind === "route") {
        const id = +cur.element.id.slice(5);
        const name = "Ixroute" + id;
        input("routeName", name);
        expect(w.pack.routes.find((r: any) => r.i === id)?.name === name, "route name not applied");
        ix.edits.route = { id, name };
      } else if (kind === "marker") {
        const i = +cur.element.id.slice(6);
        const size = +(document.getElementById("markerSize") as HTMLInputElement).value + 3;
        input("markerSize", size);
        const rescale = +document.getElementById("markers")!.getAttribute("rescale")!;
        const scale = (0, eval)("scale");
        const zoomed = rescale ? Math.max(w.rn(size / 5 + 24 / scale, 2), 1) : size;
        expect(w.pack.markers.find((m: any) => m.i === i)?.size === size, "marker size not applied");
        expect(+cur.element.getAttribute("width") === zoomed, "marker width " + cur.element.getAttribute("width") + " != " + zoomed);
        ix.edits.marker = { i, size };
      } else if (kind === "relief") {
        expect(document.getElementById("reliefIndividual")?.classList.contains("pressed"), "relief individual mode off");
        const x0 = +selected.getAttribute("x"),
          y0 = +selected.getAttribute("y"),
          s0 = +selected.getAttribute("width");
        input("reliefSizeNumber", s0 + 4);
        const x = +selected.getAttribute("x"),
          y = +selected.getAttribute("y"),
          s = +selected.getAttribute("width");
        expect(s === s0 + 4 && Math.abs(x - (x0 - 2)) < 1e-6 && Math.abs(y - (y0 - 2)) < 1e-6,
          "relief resize " + JSON.stringify({ x0, y0, s0, x, y, s }));
        ix.edits.relief = { href: selected.getAttribute("href") || selected.getAttribute("xlink:href"), x, y, s, center: [x + s / 2, y + s / 2] };
      }
    } catch (error) {
      problems.push(kind + ": edit threw " + String(error));
    }
    expect(close(dialog), "dialog did not close");
    observed.edit = ix.edits[kind] ?? null;
    return { problems, observed };
  };
}

// After a click taken right after a wheel step: the outcome (routed / resynced / dropped / legacy), its invariants
// (one route call, at most one editor call, the editor the dispatched branch opens, d3.event.target = the dispatched
// target, elSelected = its subject, and a routed target never contradicting the post-sync SVG oracle).
function installStaleChecks() {
  const w = globalThis as any;
  const ix = w.__ix;
  const ELEMENT_EDITORS = new Set(["routes", "labels", "burgLabels", "burgIcons", "markers", "rivers"]);
  ix.verifyStale = (before: any) => {
    const problems: string[] = [];
    const expect = (ok: unknown, message: string) => ok || problems.push(message);
    const rec = ix.routes[0];
    const after = ix.telemetry().sum;
    const delta = (key: string) => (after[key] ?? 0) - (before[key] ?? 0);
    const outcome = ["routed", "resynced", "dropped", "legacy"].filter(key => delta(key) === 1);
    // an HTML element over the map (e.g. the notes box) took the click: neither path sees it; reported, not routed
    const firstTarget = ix.clicks.find((c: any) => c.trusted)?.target ?? null;
    const intercepted = !!firstTarget && !document.getElementById("map")?.contains(firstTarget);
    expect(ix.routes.length === (intercepted ? 0 : 1), "gpuClickRoute calls " + ix.routes.length + (intercepted ? " (intercepted)" : ""));
    if (!intercepted) expect(outcome.length === 1, "telemetry outcome " + JSON.stringify(outcome));
    expect(ix.calls.length <= 1, "editor calls " + JSON.stringify(ix.calls.map((c: any) => c.editor)));
    // recovered: the stale-view hit was the bare #map; recoverClick synced and re-dispatched to the re-run hit, so
    // clicked() saw a current camera (legacy) with that hit as the native target
    const recovered = delta("recovered") === 1;
    const first = ix.clicks.find((c: any) => c.trusted) ?? null;
    expect(delta("recovered") + delta("unrecovered") <= 1, "recovery ran " + (delta("recovered") + delta("unrecovered")) + " times");
    if (recovered) expect(first?.target?.id === "map" && first?.stale === true, "recovered a click that was not a stale #map hit");
    const target = rec?.result === "legacy" ? rec.native : (rec?.target ?? null);
    const branch = ix.branchOf(target);
    const call = ix.calls[0];
    const dispatched = rec?.result === "event" || rec?.result === "legacy";
    if (dispatched && ix.EDITOR_OF[branch])
      expect(ix.calls.length === 1 && call.editor === ix.EDITOR_OF[branch],
        "branch " + branch + " opened " + JSON.stringify(ix.calls.map((c: any) => c.editor)));
    if (call && dispatched) expect(call.target === target, "d3.event.target != dispatched target");
    if (rec?.result === "dropped") expect(ix.calls.length === 0, "dropped click opened an editor");
    const selected = ix.selected();
    if (call && ELEMENT_EDITORS.has(branch)) {
      const want = branch === "burgLabels" || branch === "burgIcons" ? null : ix.subject(target);
      if (want) expect(selected === want, "elSelected " + ix.describe(selected) + " != " + ix.describe(want));
    }
    const routedWrong = outcome[0] === "routed" && ix.subject(target) !== ix.subject(rec?.oracle ?? null);
    expect(!routedWrong, "ROUTED WRONG TARGET " + ix.describe(target) + " oracle " + ix.describe(rec?.oracle));
    const expected = ix.current?.element ?? null;
    return {
      problems,
      stale: recovered || (rec?.stale ?? null),
      recovered,
      intercepted,
      unrecovered: delta("unrecovered") === 1,
      firstClick: first ? { target: ix.describe(first.target), stale: first.stale } : null,
      result: rec?.result ?? null,
      outcome: outcome[0] ?? null,
      target: ix.describe(target),
      native: ix.describe(rec?.native ?? null),
      oracle: ix.describe(rec?.oracle ?? null),
      nativeIsExpected: !!expected && ix.subject(rec?.native ?? null) === expected,
      oracleIsExpected: !!expected && ix.subject(rec?.oracle ?? null) === expected,
      targetIsExpected: !!expected && ix.subject(target) === expected,
      editors: ix.calls.map((c: any) => c.editor),
      selectedIsExpected: !!expected && selected === expected,
      ms: w.gpuClickTelemetry?.lastMs ?? null
    };
  };
}

// The exact save text and full-map export at the identity camera (prepareMapData twice: determinism).
async function snapshot() {
  const w = globalThis as any;
  const ix = w.__ix;
  w.d3.select("#map").call((0, eval)("zoom").transform, w.d3.zoomIdentity);
  await ix.sleep(350);
  if (w.waitDenseZoomReady) await w.waitDenseZoomReady(15000);
  await Promise.all([w.reliefRenderReady, w.burgRenderReady]);
  await ix.prepare();
  const save = await w.lazy.save();
  const text = save.prepareMapData();
  const again = save.prepareMapData();
  const exporter = await w.lazy.exportMap();
  const clone = await exporter.prepareMapClone("svg", { fullMap: true });
  const svg = new XMLSerializer().serializeToString(clone);
  const sha = async (value: string) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  // the header's last field is the save time (Date.now()): compared with that one field masked, and reported raw
  const header = (value: string) => value.slice(0, value.indexOf("\r\n"));
  const masked = (value: string) => {
    const head = header(value);
    return head.slice(0, head.lastIndexOf("|") + 1) + "<saved-at>" + value.slice(head.length);
  };
  const stamp = (value: string) => header(value).slice(header(value).lastIndexOf("|") + 1);
  return {
    text,
    comparable: masked(text),
    savedAt: stamp(text),
    deterministic: masked(text) === masked(again),
    svg,
    textSha: await sha(text),
    comparableSha: await sha(masked(text)),
    svgSha: await sha(svg)
  };
}

// first difference between two texts: the "\r\n"-separated save section (or line) and an excerpt on each side
function firstDifference(a: string, b: string) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return null;
  const section = a.slice(0, i).split("\r\n").length - 1;
  return { offset: i, section, a: a.slice(Math.max(0, i - 80), i + 160), b: b.slice(Math.max(0, i - 80), i + 160), lengths: [a.length, b.length] };
}

const install = async (page: Page) => {
  await page.evaluate(installHelpers);
  await page.evaluate(installLocate);
  await page.evaluate(installEditorChecks);
  await page.evaluate(installStaleChecks);
};
const telemetrySum = (page: Page) => page.evaluate(() => (globalThis as any).__ix.telemetry().sum);
const prepare = (page: Page) => page.evaluate(() => (globalThis as any).__ix.prepare());
const camera = (page: Page, k: number, wx: number, wy: number) =>
  page.evaluate(async ({ k, wx, wy }) => {
    const ix = (globalThis as any).__ix;
    await ix.camera(k, wx, wy);
    return ix.prepare();
  }, { k, wx, wy });
// the center camera of the picking matrix: k = zoom on the burg nearest the map center
const centerCamera = (page: Page, k: number) =>
  page.evaluate(async k => {
    const w = globalThis as any;
    const cx = w.graphWidth / 2,
      cy = w.graphHeight / 2;
    let x = cx,
      y = cy,
      best = Infinity;
    if (k > 1)
      for (const burg of w.pack.burgs)
        if (burg?.i && !burg.removed) {
          const d = (burg.x - cx) ** 2 + (burg.y - cy) ** 2;
          if (d < best) [best, x, y] = [d, burg.x, burg.y];
        }
    await w.__ix.camera(k, x, y);
    return { k, x, y, quiet: await w.__ix.prepare() };
  }, k);

// one wheel step at the view center, then a real click where the world point now sits under the GPU camera
async function staleClick(page: Page, world: [number, number], step: number, dwell = 0) {
  await page.mouse.move(640, 360);
  // the move is wheel-position setup, but its hover can mutate the world (the tooltip handler raise()s emblems), so
  // settle again before the measured stale step
  await prepare(page);
  const before = await telemetrySum(page);
  // static revisions across the wheel step: a revision here leaves the pick index stale at click time (diagnosis only)
  const revisions = () => (globalThis as any).rendererStatus?.()?.gpu?.invalidations?.count ?? null;
  const revisionsBefore = await page.evaluate(revisions);
  await page.mouse.wheel(0, step);
  const point = await page.evaluate(async world => {
    const ix = (globalThis as any).__ix;
    await ix.frames();
    const [x, y] = ix.toScreenLive(world[0], world[1]);
    ix.arm();
    const invalidations = (globalThis as any).rendererStatus?.()?.gpu?.invalidations;
    return {
      x: Math.round(x),
      y: Math.round(y),
      staleBefore: (globalThis as any).gpuRenderer.canonicalCameraStale(),
      revisions: invalidations?.count ?? null,
      lastRevision: invalidations?.last ?? null
    };
  }, world);
  (point as any).revisionsBefore = revisionsBefore;
  const inView = point.x >= 2 && point.x <= 1278 && point.y >= 2 && point.y <= 718;
  if (inView) await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(60 + dwell);
  const result = inView ? await page.evaluate(before => (globalThis as any).__ix.verifyStale(before), before) : null;
  const otherDialogs: string[] = await page.evaluate(() => (globalThis as any).__ix.closeAll());
  await page.waitForTimeout(160);
  // an editor can open (or reopen) a dialog after the first close; close again for up to 2 s and record what stayed
  const lateDialogs: string[][] = [];
  for (let n = 0; n < 10; n++) {
    const shown: string[] = await page.evaluate(() => (globalThis as any).__ix.shownDialogs());
    if (!shown.length) break;
    lateDialogs.push(shown);
    await page.evaluate(() => (globalThis as any).__ix.closeAll());
    await page.waitForTimeout(200);
  }
  return { point, inView, result, otherDialogs, lateDialogs };
}

// route-state diagnosis (route focus only, INTEGRATION_PREAMBLE): counting wrappers installed before any app script.
// They only count (scheduling, order and arguments are unchanged), so a fresh and a preamble page differ only in state.
function pageCounters() {
  const w = globalThis as any;
  if (w.__counters) return;
  const c: Record<string, number> = { intervals: 0, timeouts: 0, timeoutsFired: 0, rafs: 0, rafsFired: 0, posts: 0, channels: 0,
    observe: 0, disconnect: 0, listenersAdded: 0, listenersRemoved: 0, workers: 0, glContexts: 0 };
  const live = new Set<unknown>();
  const gl: WeakRef<HTMLCanvasElement>[] = [];
  const { setInterval: si, clearInterval: ci, setTimeout: st, requestAnimationFrame: raf } = w;
  w.setInterval = (...a: any[]) => { const id = si.apply(w, a); live.add(id); c.intervals++; return id; };
  w.clearInterval = (id: unknown) => { live.delete(id); return ci.call(w, id); };
  w.setTimeout = (fn: any, ...a: any[]) => {
    c.timeouts++;
    return st.call(w, typeof fn === "function" ? (...b: any[]) => (c.timeoutsFired++, fn(...b)) : fn, ...a);
  };
  w.requestAnimationFrame = (fn: FrameRequestCallback) => { c.rafs++; return raf.call(w, (t: number) => (c.rafsFired++, fn(t))); };
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (this: MessagePort, ...a: any[]) { c.posts++; return (post as any).apply(this, a); };
  const MC = w.MessageChannel;
  w.MessageChannel = class extends MC { constructor() { super(); c.channels++; } };
  const observe = MutationObserver.prototype.observe, disconnect = MutationObserver.prototype.disconnect;
  MutationObserver.prototype.observe = function (this: MutationObserver, ...a: any[]) { c.observe++; return (observe as any).apply(this, a); };
  MutationObserver.prototype.disconnect = function (this: MutationObserver) { c.disconnect++; return disconnect.call(this); };
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, ...a: any[]) { c.listenersAdded++; return (add as any).apply(this, a); };
  EventTarget.prototype.removeEventListener = function (this: EventTarget, ...a: any[]) { c.listenersRemoved++; return (remove as any).apply(this, a); };
  if (w.Worker) w.Worker = class extends w.Worker { constructor(...a: any[]) { super(...a); c.workers++; } };
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...a: any[]) {
    const ctx = (getContext as any).call(this, type, ...a);
    if (ctx && /webgl/.test(type) && !gl.some(r => r.deref() === this)) (c.glContexts++, gl.push(new WeakRef(this)));
    return ctx;
  };
  w.__counters = {
    snapshot: () => {
      const alive = gl.map(r => r.deref()).filter(Boolean) as HTMLCanvasElement[];
      return { ...c, liveIntervals: live.size, glCanvasesAlive: alive.length, glCanvasesConnected: alive.filter(e => e.isConnected).length };
    }
  };
}

let cdp: CDPSession | null = null;
const session = async (page: Page) => {
  if (!cdp) {
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
  }
  return cdp;
};
const metrics = async (page: Page) => pickMetrics(((await (await session(page)).send("Performance.getMetrics")) as any).metrics);

// page/world/DOM/renderer/loop state at a stage boundary, plus an idle second of loop activity and a MessageChannel ping
// (50 round trips: queue latency a sliced prepare pays per 12 ms yield)
const stageState = (page: Page) =>
  page.evaluate(async () => {
    const w = globalThis as any;
    const count = (sel: string) => document.querySelectorAll(sel).length;
    const children = (id: string) => document.getElementById(id)?.childElementCount ?? null;
    const r = w.gpuRenderer;
    if (r) r.__ixId ??= w.__ixRendererSeq = (w.__ixRendererSeq ?? 0) + 1;
    const g = w.rendererStatus?.()?.gpu;
    const device = r?.device ?? r?.gpu?.device;
    const zoom = w.d3?.zoomTransform?.(document.getElementById("map"));
    const before = w.__counters?.snapshot();
    const t0 = performance.now();
    await new Promise(resolve => setTimeout(resolve, 1000));
    const after = w.__counters?.snapshot();
    const idleWindowMs = performance.now() - t0;
    const ping = await new Promise<{ meanMs: number; maxMs: number }>(resolve => {
      const ch = new MessageChannel();
      let n = 0, max = 0;
      const start = performance.now();
      let last = start;
      ch.port1.onmessage = () => {
        const t = performance.now();
        max = Math.max(max, t - last);
        last = t;
        if (++n < 50) ch.port2.postMessage(0);
        else {
          ch.port1.close();
          resolve({ meanMs: Math.round(((t - start) / 50) * 1000) / 1000, maxMs: Math.round(max * 10) / 10 });
        }
      };
      ch.port2.postMessage(0);
    });
    const idle: Record<string, number> = {};
    if (before && after) for (const k of Object.keys(after)) if (after[k] !== before[k]) idle[k] = after[k] - before[k];
    return {
      dom: {
        elements: count("*"), map: document.getElementById("map")?.getElementsByTagName("*").length ?? null,
        viewbox: document.getElementById("viewbox")?.getElementsByTagName("*").length ?? null,
        mapHtmlKB: Math.round((document.getElementById("map")?.outerHTML.length ?? 0) / 1024),
        canvases: count("canvas"), svgs: count("svg"), styles: count("style"), dialogs: count(".ui-dialog"),
        dialogsShown: w.__ix?.shownDialogs?.().length ?? null, defs: children("defs") ?? count("defs *"),
        coas: children("coas"), coasKB: Math.round((document.getElementById("coas")?.outerHTML.length ?? 0) / 1024),
        labels: count("#labels text"), routes: count("#routes path"), markers: count("#markers > svg"),
        tradeAnimation: document.getElementById("tradeAnimation")?.childElementCount ?? null, debug: children("debug")
      },
      renderer: r ? { canonicalEmblems: r.emblemCulling?.status?.() ?? null, id: r.__ixId, seq: w.__ixRendererSeq, prepares: g?.prepares, revision: g?.revision, invalidations: g?.invalidations?.count,
        state: g?.state, pending: g?.pending, lastPrepareMs: g?.lastPrepareMs, lastPrepare: g?.lastPrepare,
        deviceMemory: device?.memory?.() ?? null } : null,
      camera: zoom ? { k: zoom.k, x: zoom.x, y: zoom.y } : null,
      layersOn: [...document.querySelectorAll("#mapLayers li[id]")].filter(li => !li.classList.contains("buttonoff")).map(li => li.id),
      heapMB: Math.round(((performance as any).memory?.usedJSHeapSize ?? 0) / 104857.6) / 10,
      counters: after ?? null,
      idleSecond: { windowMs: Math.round(idleWindowMs), deltas: idle },
      ping
    };
  });
const stageSnapshot = async (page: Page, name: string, operations: string[]) => {
  if (focus !== "route") return;
  const state = await stageState(page);
  const row = { stage: name, operations, at: Math.round(performance.now()), metrics: await metrics(page), ...state };
  list("stages").push(row);
  if(nativeProbe)writeFileSync(output.replace(/\.json$/,"")+".stages.jsonl",JSON.stringify(row)+"\n",{flag:"a"});
  (report.preambleStages ??= []).push({ stage: name, operations, camera: row.camera, layersOn: row.layersOn, dom: row.dom,
    renderer: row.renderer && { id: row.renderer.id, seq: row.renderer.seq, prepares: row.renderer.prepares, revision: row.renderer.revision,
      deviceCount: row.renderer.deviceMemory?.count ?? null }, ping: row.ping, idleSecond: row.idleSecond, nodes: row.metrics.Nodes,
    listeners: row.metrics.JSEventListeners, heapMB: row.heapMB });
};
const list = (key: string) => ((diagnostics[key] ??= []) as any[]);

// CPU profile + CDP task metrics around one measured window: busy (script/GC/native) vs idle wait, top callsites. The
// raw profile is written next to the report (immutable, wx).
// Diagnostic only: timings delegate to the exact browser methods and never alter scene or readiness.
function installNativeProbe() {
  const w=globalThis as any;
  if(w.__nativeProbe)return;
  let stats:Record<string,{calls:number,ms:number,maxMs:number}>={},images:any[]=[];
  const add=(key:string,ms:number)=>{const r=stats[key]??={calls:0,ms:0,maxMs:0};r.calls++;r.ms+=ms;r.maxMs=Math.max(r.maxMs,ms);};
  const wrap=(owner:any,key:string,detail=false)=>{
    const original=owner[key];if(typeof original!=="function")return;
    owner[key]=function(...args:any[]){
      const start=performance.now();
      try{return original.apply(this,args);}finally{
        const target=detail?(args[0] instanceof Element?args[0]:this):null;
        const layer=target instanceof Element?target.closest("#viewbox > g")?.id??target.tagName:"";
        add(key+(layer?":"+layer:""),performance.now()-start);
      }
    };
  };
  wrap(w,"getComputedStyle",true);
  for(const key of["getBBox","getScreenCTM","getCTM"])wrap(SVGGraphicsElement.prototype,key,true);
  wrap(XMLSerializer.prototype,"serializeToString");
  for(const key of["drawImage","getImageData"])wrap(CanvasRenderingContext2D.prototype,key);
  const urls=new Map<string,{bytes:number,type:string}>();
  const create=URL.createObjectURL;URL.createObjectURL=function(blob:Blob){const url=create.call(URL,blob);urls.set(url,{bytes:blob.size,type:blob.type});return url;};
  const revoke=URL.revokeObjectURL;URL.revokeObjectURL=function(url:string){urls.delete(url);return revoke.call(URL,url);};
  const src=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,"src")!;
  Object.defineProperty(HTMLImageElement.prototype,"src",{...src,set(value:string){
    const metadata=urls.get(value);const start=performance.now();const image=this;
    if(metadata){const done=()=>{image.removeEventListener("load",done,true);image.removeEventListener("error",done,true);if(images.length<200)images.push({...metadata,ms:performance.now()-start,width:image.naturalWidth,height:image.naturalHeight});};
      image.addEventListener("load",done,{once:true,capture:true});image.addEventListener("error",done,{once:true,capture:true});}
    return src.set!.call(this,value);
  }});
  w.__nativeProbe={reset(){stats={};images=[];},snapshot(){return {stats,images};}};
}
const profiled = async <T>(page: Page, label: string, run: () => Promise<T>) => {
  const s = await session(page);
  const m0 = await metrics(page);
  const t0 = performance.now();
  if(nativeProbe)await page.evaluate(()=>{(globalThis as any).__nativeProbe?.reset();});
  let traceComplete:Promise<any>|null=null;
  if(nativeProbe && (label==="reprepare"||label==="opacity-reprepare"||label.startsWith("paint-"))){
    traceComplete=new Promise(resolve=>s.once("Tracing.tracingComplete",resolve));
    await s.send("Tracing.start",{transferMode:"ReturnAsStream",traceConfig:{recordMode:"recordUntilFull",includedCategories:["devtools.timeline","blink","toplevel","disabled-by-default-devtools.timeline"]}});
  }
  await s.send("Profiler.start");
  let profile: any = null;
  try {
    return await run();
  } finally {
    profile = ((await s.send("Profiler.stop")) as any).profile;
    const wallMs = performance.now() - t0;
    const delta = diffMetrics(m0, await metrics(page));
    const file = output.replace(/\.json$/, "") + "." + label + ".cpuprofile";
    writeFileSync(file, JSON.stringify(profile), { flag: "wx" });
    const nativeTimings=nativeProbe?await page.evaluate(()=>(globalThis as any).__nativeProbe?.snapshot()):null;
    let traceFile:string|null=null;
    if(traceComplete){
      await s.send("Tracing.end");
      const complete=await traceComplete;traceFile=output.replace(/\.json$/,"")+"."+label+".trace.json";
      let first=true;
      while(true){const part=await s.send("IO.read",{handle:complete.stream});writeFileSync(traceFile,part.base64Encoded?Buffer.from(part.data,"base64"):part.data,{flag:first?"wx":"a"});first=false;if(part.eof)break;}
      await s.send("IO.close",{handle:complete.stream});
    }
    const row = { label, file, nativeTimings, traceFile, metricsDelta: delta, cpuVsWait: cpuVsWait(wallMs, delta), profile: summarizeCpuProfile(profile) };
    if(nativeProbe)writeFileSync(output.replace(/\.json$/,"")+"."+label+".native.json",JSON.stringify(row,null,2),{flag:"wx"});
    list("profiles").push(row);
    (report.profiles ??= []).push({ label, file, nativeTimings, traceFile, cpuVsWait: row.cpuVsWait, busyMs: row.profile.busyMs, idleMs: row.profile.idleMs,
      top: row.profile.top.slice(0, 8) });
  }
};

// route focus timing, in the page: t0 = probe start; trace jobs and long tasks are re-based to ms since t0, and a 50 ms
// poll logs each change of shown dialogs / suspension / pending / prepares / revision (gaps in it are main-thread stalls)
const focusProbe = (page: Page) =>
  page.evaluate(() => {
    const w = globalThis as any;
    const t0 = performance.now();
    const gpu = w.rendererStatus?.()?.gpu;
    const log: [number, string][] = [];
    let last = "";
    const timer = setInterval(() => {
      const s = w.rendererStatus?.()?.gpu;
      const key = [w.__ix.shownDialogs().join(","), s?.suspendedReason ?? "", s?.pending, s?.canvasVisible, s?.prepares, s?.revision].join("|");
      if (key !== last) log.push([Math.round(performance.now() - t0), (last = key)]);
    }, 50);
    w.__focus = { t0, timer, log, prepares: gpu?.prepares ?? 0, revisions: gpu?.invalidations?.count ?? 0, deferrals: gpu?.suspendDeferrals ?? 0 };
  });
const focusResume = (page: Page, world: [number, number] | null) =>
  page.evaluate(
    async ({ limit, world }) => {
      const w = globalThis as any;
      const ix = w.__ix,
        f = w.__focus;
      const begin = performance.now();
      let error = "";
      try {
        await ix.settled(limit);
      } catch (e) {
        error = String((e as Error)?.message || e).slice(0, 800);
      }
      const end = performance.now();
      clearInterval(f.timer);
      const status = w.rendererStatus?.();
      const g = status?.gpu;
      const since = (at: number) => Math.round(at - f.t0 - (g?.trace?.now ?? end) + end);
      const pick = world && w.gpuSelect ? ix.gpuAt(...ix.toScreenLive(world[0], world[1])) : null;
      return {
        active: status?.active,
        fallbackReason: status?.fallbackReason ?? null,
        closeAt: Math.round(begin - f.t0),
        resumeMs: Math.round(end - begin),
        totalMs: Math.round(end - f.t0),
        error,
        prepares: (g?.prepares ?? 0) - f.prepares,
        revisions: (g?.invalidations?.count ?? 0) - f.revisions,
        suspendDeferrals: g?.suspendDeferrals == null ? null : g.suspendDeferrals - f.deferrals,
        lastPrepareMs: g?.lastPrepareMs,
        lastPrepare: g?.lastPrepare,
        state: g?.state,
        suspendedReason: g?.suspendedReason ?? "",
        canonicalEmblems: w.gpuRenderer?.emblemCulling?.status?.() ?? null,
        cellsOn: w.layerIsOn("toggleCells"),
        controlGroups: ["controlCells", "controlPoints"].filter(id => document.getElementById(id)),
        pick: pick && { branch: pick.branch },
        jobs: (g?.trace?.jobs ?? []).map((j: any) => [j.kind, j.detail, since(j.at), j.ms && Math.round(j.ms)]).filter((j: any) => j[2] >= -500),
        longTasks: (g?.trace?.longTasks ?? []).map((t: any) => [since(t.at), Math.round(t.ms)]).filter((t: any) => t[0] >= -500),
        cellsMesh: performance
          .getEntriesByType("measure")
          .filter(m => m.name.startsWith("cells-mesh:") && m.startTime >= f.t0 - 500)
          .map(m => [m.name.slice(11), Math.round(m.startTime - f.t0), Math.round(m.duration)]),
        log: f.log
      };
    },
    { limit: FOCUS_LIMIT, world }
  );

// route focus: the 100k world, a stride sample of census routes (no tile harvest, no synthetic labels), two controls
// at the first route camera (a plain re-prepare and a cells on/off toggle without an editor), then real route clicks
// through the cohort's staleClick with the editor closed at once or after a dwell, timing resume after close
// reuse: the fixture preamble already replaced the world by the 100k one and installed; the route cohort runs on it as is
async function routeFocus(page: Page, loadWorld: (world: "100k") => Promise<void>, reuse = false) {
  const mark = failures.length;
  if (!reuse) {
    await loadWorld("100k");
    await install(page);
  }
  if(nativeProbe)await page.evaluate(installNativeProbe);
  if(forceEmblems){
    await page.evaluate(async()=>{
      const w=globalThis as any;
      const shown=await w.__tupaia.call("display",{on:["emblems"]});if(!shown.ok)throw Error(JSON.stringify(shown));
      await w.__tupaia.settle();
    });
  }
  await centerCamera(page, zoom);
  const census = await page.evaluate(() => (globalThis as any).__ix.census("route"));
  const keys: string[] = strideSample([...census.keys].sort(compareIds), FIXTURE_MIN);
  const routeZooms = [...new Set([zoom, ...ROUTE_ZOOMS.filter(k => k > zoom)])];
  const controls: any = {};
  const rows: any[] = [];
  // a harness error (e.g. a fallback inside staleClick's settle) still reports the rows measured so far
  try {
  for (let i = 0; i < keys.length && rows.filter(r => !r.skip).length < FOCUS_ROUTES && rows.length < FOCUS_ROUTES * 3; i++) {
    const key = keys[i];
    let target: any = null;
    let routeZoom = 0;
    for (const k of routeZooms) {
      const aim = await page.evaluate(({ key }) => (globalThis as any).__ix.aimKey("route", key), { key });
      if (aim) await camera(page, k, aim[0], aim[1]);
      target = await page.evaluate(({ key }) => (globalThis as any).__ix.probeKey("route", key, true), { key });
      routeZoom = k;
      if (target) break;
    }
    if (!target) {
      rows.push({ key, skip: "no robust point" });
      continue;
    }
    if (!controls.camera) {
      controls.camera = await page.evaluate(() => (globalThis as any).__ix.cameraState());
      await stageSnapshot(page, "route-camera", ["route camera " + key + " k=" + routeZoom]);
      await focusProbe(page);
      controls.reprepare = await profiled(page, "reprepare", async () => {
        await page.evaluate(() => (globalThis as any).gpuRenderer.invalidate());
        return focusResume(page, null);
      });
      if(process.env.INTEGRATION_OPACITY_PAIR==="1"){
        const baseline=await page.screenshot({path:output.replace(/\.json$/,"")+".gpu-original-svg.png",animations:"disabled"});
        controls.opacityProbe=await page.evaluate(()=>{
          const root=document.getElementById("map")!,view=document.getElementById("viewbox")! as unknown as SVGGraphicsElement;
          const hit=document.elementFromPoint(640,360),before={opacity:getComputedStyle(view).opacity,box:view.getBBox(),hit:hit?.id??null};
          const css=document.createElement("style");css.id="direct-canonical-opacity-probe";
          css.textContent='body:has(canvas[data-gpu-renderer][style*="display: block"]) #map {opacity:0!important}';
          document.head.append(css);
          const after={opacity:getComputedStyle(view).opacity,box:view.getBBox(),hit:document.elementFromPoint(640,360)?.id??null};
          return {before,after,rootOpacity:getComputedStyle(root).opacity,scope:"diagnostic canonical paint suppression; no product change"};
        });
        await focusProbe(page);
        controls.opacityReprepare=await profiled(page,"opacity-reprepare",async()=>{
          await page.evaluate(()=>(globalThis as any).gpuRenderer.invalidate());
          return focusResume(page,null);
        });
        const suppressed=await page.screenshot({path:output.replace(/\.json$/,"")+".gpu-suppressed-svg.png",animations:"disabled"});
        controls.opacityPixelParity=await page.evaluate(async([a,b])=>{
          const images=[];
          for(const encoded of[a,b]){const image=new Image();image.src="data:image/png;base64,"+encoded;await image.decode();const canvas=document.createElement("canvas");canvas.width=image.width;canvas.height=image.height;const c=canvas.getContext("2d")!;c.drawImage(image,0,0);images.push(c.getImageData(0,0,canvas.width,canvas.height));}
          const[p,q]=images;let changed=0,over16=0,max=0;
          for(let i=0;i<p.data.length;i+=4){let delta=0;for(let j=0;j<4;j++)delta=Math.max(delta,Math.abs(p.data[i+j]-q.data[i+j]));if(delta)changed++;if(delta>16)over16++;max=Math.max(max,delta);}
          return {changed,over16,max,pixels:p.width*p.height};
        },[baseline.toString("base64"),suppressed.toString("base64")]);
        await page.evaluate(()=>document.getElementById("direct-canonical-opacity-probe")?.remove());
      }
      if(process.env.INTEGRATION_PAINT_VARIANTS==="1"){
        controls.paintVariants=[];
        const beforePixels=await page.screenshot({path:output.replace(/\.json$/,"")+".paint-baseline.png",animations:"disabled"});
        const canonicalBefore=process.env.INTEGRATION_EMBLEM_CULL==="1"?await (async()=>{
          const old=await page.evaluate(async()=>{
            const w=globalThis as any,c=document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement;
            const previousTransform=document.getElementById("viewbox")?.getAttribute("transform");
            w.gpuRenderer.syncCanonicalCamera();
            const old=c.style.visibility;c.style.visibility="hidden";
            await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(done))));
            const rect=document.getElementById("map")!.getBoundingClientRect();
            (w.__canonicalShots??=[]).push({previousTransform,transform:document.getElementById("viewbox")?.getAttribute("transform"),gpuView:w.gpuRenderer.view,mapRect:[rect.x,rect.y,rect.width,rect.height],canvasVisibility:getComputedStyle(c).visibility,canvasDisplay:getComputedStyle(c).display,rootOpacity:getComputedStyle(document.getElementById("map")!).opacity,gpuCanvases:document.querySelectorAll("canvas[data-gpu-renderer]").length,fonts:document.fonts.status,labels:[...document.querySelectorAll("#labels text")].slice(0,5).map(e=>({id:e.id,text:e.textContent,font:getComputedStyle(e).font,fontSize:getComputedStyle(e).fontSize}))});
            return old;
          });
          const bytes=await page.screenshot({path:output.replace(/\.json$/,"")+".canonical-before-cull.png",animations:"disabled"});
          await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
          const repeated=await page.screenshot({path:output.replace(/\.json$/,"")+".canonical-before-cull-repeat.png",animations:"disabled"});
          controls.canonicalBaselineRepeatedPngEqual=bytes.equals(repeated);
          await page.evaluate(old=>{(document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement).style.visibility=old;},old);return bytes;
        })():null;
        const variants=process.env.INTEGRATION_EMBLEM_CULL==="1"?[["emblem-cull",""]]:[
          ["map-layer","#map{will-change:transform!important}"],
          ["defs-layer","#defElements{will-change:transform!important}"],
          ["defs-opacity","#defElements{opacity:0!important}"]
        ];
        for(const[label,css]of variants){
          const before=await page.evaluate(()=>{
            const view=document.getElementById("viewbox")! as unknown as SVGGraphicsElement;
            const b=view.getBBox();return {box:[b.x,b.y,b.width,b.height],hit:document.elementFromPoint(640,360)?.id??null};
          });
          await page.evaluate(css=>{const e=document.createElement("style");e.id="direct-paint-variant";e.textContent=css;document.head.append(e);},css);
          let culling:any=null;
          if(label==="emblem-cull")culling=await page.evaluate(()=>{
            const root=document.getElementById("map")!,viewport=root.getBoundingClientRect();const restored:any[]=[];
            for(const element of document.querySelectorAll("#emblems use")){
              const rect=element.getBoundingClientRect(),pad=160;
              if(rect.right<viewport.left-pad||rect.left>viewport.right+pad||rect.bottom<viewport.top-pad||rect.top>viewport.bottom+pad){
                restored.push([element,element.getAttribute("class")]);element.classList.add("viewport-culled");
              }
            }
            (globalThis as any).__directCullRestore=restored;
            return {uses:document.querySelectorAll("#emblems use").length,culled:restored.length,paddingCssPx:160,scope:"fixed-camera diagnostic only; production bounds/invalidation not implemented"};
          });
          await focusProbe(page);
          const resume=await profiled(page,"paint-"+label,async()=>{
            await page.evaluate(()=>(globalThis as any).gpuRenderer.invalidate());return focusResume(page,null);
          });
          const afterPixels=await page.screenshot({path:output.replace(/\.json$/,"")+".paint-"+label+".png",animations:"disabled"});
          const parity=await page.evaluate(async({a,b})=>{
            const images=[];
            for(const encoded of[a,b]){const image=new Image();image.src="data:image/png;base64,"+encoded;await image.decode();const canvas=document.createElement("canvas");canvas.width=image.width;canvas.height=image.height;const c=canvas.getContext("2d")!;c.drawImage(image,0,0);images.push(c.getImageData(0,0,canvas.width,canvas.height));}
            const[p,q]=images;let changed=0,over16=0,max=0;
            for(let i=0;i<p.data.length;i+=4){let d=0;for(let j=0;j<4;j++)d=Math.max(d,Math.abs(p.data[i+j]-q.data[i+j]));if(d)changed++;if(d>16)over16++;max=Math.max(max,d);}
            const view=document.getElementById("viewbox")! as unknown as SVGGraphicsElement,bbox=view.getBBox();
            return {changed,over16,max,pixels:p.width*p.height,box:[bbox.x,bbox.y,bbox.width,bbox.height],hit:document.elementFromPoint(640,360)?.id??null};
          },{a:beforePixels.toString("base64"),b:afterPixels.toString("base64")});
          let canonicalParity:any=null;
          if(canonicalBefore){
            const old=await page.evaluate(async()=>{
            const w=globalThis as any,c=document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement;
            const previousTransform=document.getElementById("viewbox")?.getAttribute("transform");
            w.gpuRenderer.syncCanonicalCamera();
            const old=c.style.visibility;c.style.visibility="hidden";
            await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(done))));
            const rect=document.getElementById("map")!.getBoundingClientRect();
            (w.__canonicalShots??=[]).push({previousTransform,transform:document.getElementById("viewbox")?.getAttribute("transform"),gpuView:w.gpuRenderer.view,mapRect:[rect.x,rect.y,rect.width,rect.height],canvasVisibility:getComputedStyle(c).visibility,canvasDisplay:getComputedStyle(c).display,rootOpacity:getComputedStyle(document.getElementById("map")!).opacity,gpuCanvases:document.querySelectorAll("canvas[data-gpu-renderer]").length,fonts:document.fonts.status,labels:[...document.querySelectorAll("#labels text")].slice(0,5).map(e=>({id:e.id,text:e.textContent,font:getComputedStyle(e).font,fontSize:getComputedStyle(e).fontSize}))});
            return old;
          });
            const bytes=await page.screenshot({path:output.replace(/\.json$/,"")+".canonical-after-cull.png",animations:"disabled"});
            await page.evaluate(old=>{(document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement).style.visibility=old;},old);
            canonicalParity=await page.evaluate(async([a,b])=>{
              const images=[];for(const encoded of[a,b]){const image=new Image();image.src="data:image/png;base64,"+encoded;await image.decode();const canvas=document.createElement("canvas");canvas.width=image.width;canvas.height=image.height;const c=canvas.getContext("2d")!;c.drawImage(image,0,0);images.push(c.getImageData(0,0,canvas.width,canvas.height));}
              const[p,q]=images;let changed=0,over16=0,max=0;for(let i=0;i<p.data.length;i+=4){let d=0;for(let j=0;j<4;j++)d=Math.max(d,Math.abs(p.data[i+j]-q.data[i+j]));if(d)changed++;if(d>16)over16++;max=Math.max(max,d);}return {changed,over16,max,pixels:p.width*p.height};
            },[canonicalBefore.toString("base64"),bytes.toString("base64")]);
          }
          controls.paintVariants.push({label,css,before,parity,resume,culling,canonicalParity,canonicalShots:await page.evaluate(()=>(globalThis as any).__canonicalShots??[]),canonicalBaselineRepeatedPngEqual:controls.canonicalBaselineRepeatedPngEqual});
          await page.evaluate(()=>{
            document.getElementById("direct-paint-variant")?.remove();
            for(const[element,value]of(globalThis as any).__directCullRestore??[]){if(value===null)element.removeAttribute("class");else element.setAttribute("class",value);}
            delete(globalThis as any).__directCullRestore;
          });
          if(canonicalBefore){
            const old=await page.evaluate(async()=>{const w=globalThis as any;w.gpuRenderer.syncCanonicalCamera();const c=document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement;const old=c.style.visibility;c.style.visibility="hidden";await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(done))));return old;});
            const restored=await page.screenshot({path:output.replace(/\.json$/,"")+".canonical-restored.png",animations:"disabled"});
            controls.paintVariants.at(-1).restoredCanonicalPngEqual=canonicalBefore.equals(restored);
            await page.evaluate(old=>{(document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement).style.visibility=old;},old);
          }
          writeFileSync(output.replace(/\.json$/,"")+".paint-"+label+".result.json",JSON.stringify(controls.paintVariants.at(-1),null,2),{flag:"wx"});
        }
      }
      if(process.env.INTEGRATION_SINGLE_PREPARE==="1"){
        report.diagnosticOnly={scope:"single preparation and optional paired canonical-paint experiment; no route clicks/cohort acceptance",nativeProbe,forceEmblems};
        return;
      }
      for (const step of ["cellsOn", "cellsOff"]) {
        await focusProbe(page);
        await page.evaluate(() => (globalThis as any).toggleCells());
        controls[step] = await focusResume(page, null);
      }
    }
    const dwell = FOCUS_DWELL[rows.filter(r => !r.skip).length % FOCUS_DWELL.length];
    const cellsBefore = await page.evaluate(() => (globalThis as any).layerIsOn("toggleCells"));
    await page.mouse.move(640, 360);
    await prepare(page);
    await focusProbe(page);
    const click = await staleClick(page, target.world, i % 2 ? -100 : 100, dwell);
    const first = !rows.some(r => r.resume);
    const resume = first ? await profiled(page, "click-resume", () => focusResume(page, target.world)) : await focusResume(page, target.world);
    const r = click.result;
    const row: any = { key, routeZoom, dwell, point: click.point, inView: click.inView, otherDialogs: click.otherDialogs, lateDialogs: click.lateDialogs, resume, ...r };
    const tag = "routeFocus " + key + ": ";
    if (r) r.problems.forEach((p: string) => fail(tag + p));
    else fail(tag + "world point left the view");
    if (r && r.oracleIsExpected)
      check(r.targetIsExpected && r.selectedIsExpected && r.editors.length === 1 && r.editors[0] === "editRoute",
        tag + "target/elSelected/editor " + JSON.stringify({ t: r.target, e: r.editors }));
    check(resume.active === "gpu", tag + "GPU fell back: " + resume.fallbackReason);
    check(!resume.error, tag + "resume " + resume.error);
    check(resume.resumeMs <= 30000, tag + "resume " + resume.resumeMs + " ms after close (limit 30000)");
    check(resume.cellsOn === cellsBefore, tag + "cells layer " + cellsBefore + " -> " + resume.cellsOn);
    check(!resume.controlGroups.length, tag + "editor groups left " + resume.controlGroups.join(","));
    check(resume.pick?.branch !== "unavailable", tag + "pick unavailable after resume");
    rows.push(row);
    if (resume.error || resume.active !== "gpu") break;
  }
  } finally {
  const clicked = rows.filter(r => !r.skip && r.resume);
  report.routeFocus = {
    scope: "route-focus diagnostic only: never a full-suite pass",
    preamble,
    reusedWorld: reuse,
    renderer: await page
      .evaluate(() => {
        const s = (globalThis as any).rendererStatus?.();
        return { active: s?.active, fallbackReason: s?.fallbackReason ?? null, lastPrepare: s?.gpu?.lastPrepare ?? null };
      })
      .catch(e => ({ error: String(e?.message || e).slice(0, 300) })),
    censusRoutes: census.keys.length,
    sampled: keys.length,
    routeZooms,
    controls,
    clicks: clicked.length,
    skipped: rows.length - clicked.length,
    resumeMs: clicked.map(r => r.resume.resumeMs),
    totalMs: clicked.map(r => r.resume.totalMs),
    goalMs: 2000,
    underGoal: clicked.length > 0 && clicked.every(r => r.resume.resumeMs < 2000),
    verdict: !clicked.length ? "UNTESTED" : failures.length > mark ? "FAIL" : "PASS"
  };
  diagnostics.routeFocus = rows;
  }
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: dpr, serviceWorkers: "block", acceptDownloads: false });
  await context.addInitScript(() => {
    localStorage.setItem("autosaveInterval", "0");
    localStorage.setItem("azgaarAssistant", "hide");
    (globalThis as any).__name ??= (fn: unknown) => fn; // tsx keepNames helper inside serialized page functions
  });
  const scripts = [
    "bridge.js",
    "bridge-mutations.js",
    ...readdirSync("mcp/src/bridge-ext")
      .filter(file => file.endsWith(".js"))
      .sort()
      .map(file => "bridge-ext/" + file)
  ];
  await context.addInitScript(scripts.map(file => readFileSync("mcp/src/" + file, "utf8")).join("\n"));
  if (focus === "route") await context.addInitScript(pageCounters);
  await context.route("**/*", route => {
    const request = route.request();
    const url = new URL(request.url());
    const fonts = url.origin === "https://fonts.gstatic.com";
    if (request.method() === "GET" && (url.origin === origin || fonts)) return route.continue();
    blocked.push(request.method() + " " + url.origin + url.pathname);
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(300000);
  page.on("pageerror", error => report.pageErrors.push(error.message));
  page.on("dialog", dialog => dialog.dismiss());
  const downloads: string[] = [];
  page.on("download", download => downloads.push(download.suggestedFilename()));
  await page.goto(origin + report.config.url);
  await page.evaluate(async () => {
    const result = await (globalThis as any).__tupaia.call("ready", { timeoutMs: 120000 });
    if (!result.ok) throw new Error(JSON.stringify(result));
  });
  const loadWorld = (world: "shared" | "100k" | "text", text = "") =>
    page.evaluate(
      async ({ world, text }) => {
        const runtime = (globalThis as any).__tupaia;
        const result =
          world === "100k"
            ? await runtime.fns.generateMap({ cells: 100000, seed: "7319", template: "continents", width: 1280, height: 720, timeoutMs: 300000 })
            : await runtime.fns.loadMap({ text, timeoutMs: 300000 });
        if (result?.ok === false) throw new Error(JSON.stringify(result));
        const displayed = await runtime.call("display", { on: ["heightmap", "relief"] });
        if (!displayed.ok) throw new Error(JSON.stringify(displayed));
        await Promise.all([(globalThis as any).reliefRenderReady, (globalThis as any).burgRenderReady]);
        await runtime.settle();
      },
      { world, text }
    );

  await stageSnapshot(page, "start", []);

  // World A: the shared fixture, editor open/edit/close at the exact camera
  if (stage("editors")) {
    await loadWorld("shared", sharedText);
    await install(page);
    diagnostics.cameraA = await centerCamera(page, zoom);
    for (const kind of ["burg", "label", "route", "marker", "relief"]) {
      let target: any = await page.evaluate(kind => (globalThis as any).__ix.locate(kind), kind);
      for (let attempt = 0; !target && attempt < 4; attempt++) {
        const aim = await page.evaluate(({ kind, attempt }) => (globalThis as any).__ix.aim(kind, attempt), { kind, attempt });
        if (!aim) break;
        await camera(page, zoom, aim[0], aim[1]);
        target = await page.evaluate(kind => (globalThis as any).__ix.locate(kind), kind);
      }
      if (!check(target, kind + ": no clickable target found")) continue;
      const before = await telemetrySum(page);
      await page.evaluate(() => (globalThis as any).__ix.arm());
      await page.mouse.click(target.x, target.y);
      await page.waitForTimeout(120);
      const verdict = await page.evaluate(({ kind, before }) => (globalThis as any).__ix.verifyEditor(kind, before), { kind, before });
      verdict.problems.forEach(fail);
      report.editors.push({ target, ...verdict.observed, problems: verdict.problems });
      await prepare(page);
      const resumed = await page.evaluate(({ x, y }) => (globalThis as any).__ix.gpuAt(x, y), target);
      check(resumed.branch !== "unavailable", kind + ": pick still unavailable after close " + JSON.stringify(resumed));
    }
  }

  // unready kind at a stale camera (river, else route, else label): sync, then the legacy path at the current camera
  if (stage("editors")) {
    await centerCamera(page, zoom);
    let unready: any = null;
    for (const kind of ["river", "route", "label"]) {
      unready = await page.evaluate(kind => (globalThis as any).__ix.locate(kind, true), kind);
      if (unready) {
        unready.kind = kind;
        break;
      }
    }
    if (check(unready, "staleFallback: no robust river/route/label target")) {
      const click = await staleClick(page, unready.world, 100);
      report.staleFallback = { target: unready, ...click };
      if (click.result) {
        click.result.problems.forEach((p: string) => fail("staleFallback: " + p));
        const { outcome, recovered } = click.result;
        if (click.result.stale) check(outcome === "resynced" || outcome === "dropped" || (recovered && outcome === "legacy"),
          "staleFallback: unready " + unready.kind + " outcome " + click.result.outcome);
      } else fail("staleFallback: world point left the view");
    }
    await prepare(page);
  }
  if (stage("editors")) await stageSnapshot(page, "editors", ["load shared", "install", "centerCamera", "editor open/edit/close x5", "staleFallback click"]);

  // save/load/export roundtrip: A = save text after the edits, E1 = full-map SVG export; load A; B, E2 must match
  if (stage("roundtrip")) {
    const edits = await page.evaluate(() => (globalThis as any).__ix.edits);
    const first = await page.evaluate(snapshot);
    await loadWorld("text", first.text);
    await install(page);
    const second = await page.evaluate(snapshot);
    const persisted = await page.evaluate(edits => {
      const w = globalThis as any;
      const out: Record<string, unknown> = {};
      if (edits.burg) out.burg = w.pack.burgs[edits.burg.id]?.name === edits.burg.name;
      if (edits.label) out.label = document.getElementById(edits.label.id)?.textContent === edits.label.text;
      if (edits.route) out.route = w.pack.routes.find((r: any) => r.i === edits.route.id)?.name === edits.route.name;
      if (edits.marker) out.marker = w.pack.markers.find((m: any) => m.i === edits.marker.i)?.size === edits.marker.size;
      if (edits.relief) {
        const [cx, cy] = edits.relief.center;
        const icon = w.peekRelief?.(cx, cy)?.icon;
        const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
        out.relief = !!icon && near(icon.s, edits.relief.s) && near(icon.x, edits.relief.x) && near(icon.y, edits.relief.y);
        out.reliefPeek = icon ? { ...icon } : null;
      }
      return out;
    }, edits);
    const textDiff = firstDifference(first.comparable, second.comparable);
    const svgDiff = firstDifference(first.svg, second.svg);
    report.roundtrip = {
      edits,
      persisted,
      saveDeterministic: [first.deterministic, second.deterministic],
      saveComparison: "exact text with only the header save-time field masked",
      savedAt: [first.savedAt, second.savedAt],
      rawSaveEqual: first.text === second.text,
      saveSha256: [first.textSha, second.textSha],
      saveMaskedSha256: [first.comparableSha, second.comparableSha],
      exportSha256: [first.svgSha, second.svgSha],
      saveBytes: [first.text.length, second.text.length],
      exportBytes: [first.svg.length, second.svg.length],
      saveEqual: !textDiff,
      exportEqual: !svgDiff,
      editsInExport: Object.fromEntries(
        // route names are data only (no SVG text): checked through the save above, not the export
        [edits.burg?.name, edits.label?.text].filter(Boolean).map((s: string) => [s, second.svg.includes(s)])
      ),
      exportHasCanvas: second.svg.includes("<canvas") || second.svg.includes("data-gpu-renderer"),
      downloads
    };
    diagnostics.roundtripDiff = { textDiff, svgDiff };
    check(first.deterministic && second.deterministic, "roundtrip: prepareMapData not deterministic");
    check(!textDiff, "roundtrip: save text differs after load at section " + textDiff?.section);
    check(!svgDiff, "roundtrip: export differs after load at offset " + svgDiff?.offset);
    for (const kind of ["burg", "label", "route", "marker", "relief"])
      check(persisted[kind] === true, "roundtrip: " + kind + " edit not persisted");
    for (const [s, ok] of Object.entries(report.roundtrip.editsInExport)) check(ok, "roundtrip: export lacks " + s);
    check(!report.roundtrip.exportHasCanvas, "roundtrip: export contains the GPU canvas");
    check(downloads.length === 0, "roundtrip: downloads " + downloads.join(","));
  }

  // undo/redo after a routed edit: the stock app has no document-level undo for route, label, burg or marker edits
  // (docs/performance/webgl-rewrite/p0-audits/io-format-undo.md:118), so Ctrl+Z / Ctrl+Y (hotkeys.js, heightmap only)
  // are pressed after the route rename and the route name is read back. Undo is PASS only if both directions revert;
  // otherwise the probe is UNTESTED with the evidence, never PASS.
  if (stage("roundtrip")) {
    // the edits made before the roundtrip (the reload re-creates the page helpers, so they are read from the report)
    const edits: any = report.roundtrip?.edits ?? {};
    const routeId: number = edits.route?.id ?? -1;
    const state = await page.evaluate(() => (globalThis as any).__ix.undoState());
    const read = () => page.evaluate(id => (globalThis as any).__ix.routeName(id), routeId);
    const before = await read();
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(200);
    const afterUndo = await read();
    await page.keyboard.press("Control+y");
    await page.waitForTimeout(200);
    const afterRedo = await read();
    const reverted = !!edits.route && afterUndo !== before;
    const restored = !!edits.route && afterRedo === before;
    const verdict: CohortVerdict = reverted && restored ? "PASS" : "UNTESTED";
    report.undoCohort = {
      verdict,
      reason: edits.route
        ? reverted
          ? restored ? "undo and redo reverted the routed edit" : "undo reverted, redo did not restore"
          : "no document-level undo for route edits; #undo/#redo are heightmap-owned"
        : "no route edit was applied",
      state,
      routeEdit: edits.route ?? null,
      names: { before, afterUndo, afterRedo }
    };
  }

  // resynced cohort on the reloaded world: label and route are unready, so stale clicks sync and take the legacy path
  if (stage("roundtrip")) {
    await centerCamera(page, zoom);
    const cohort: any = { label: [], route: [] };
    for (const kind of ["label", "route"]) {
      for (let attempt = 0; cohort[kind].filter(row => row.eligible).length < RESYNC_PER_KIND && attempt < RESYNC_PER_KIND * 2; attempt++) {
        const aim = await page.evaluate(({ kind, attempt }) => (globalThis as any).__ix.aim(kind, attempt % 5), { kind, attempt });
        if (aim) await camera(page, zoom, aim[0], aim[1]);
        const target: any = await page.evaluate(kind => (globalThis as any).__ix.locate(kind, true), kind);
        if (!target) continue;
        const click = await staleClick(page, target.world, attempt % 2 ? -100 : 100);
        const r = click.result;
        const row: any = { target: { id: target.id, x: target.x, y: target.y }, point: click.point, inView: click.inView, ...r };
        row.eligible = !!r && r.stale && r.oracleIsExpected;
        if (r) r.problems.forEach((p: string) => fail("resync " + kind + ": " + p));
        if (row.eligible) {
          check(r.outcome === "resynced" || (r.recovered && r.outcome === "legacy"), "resync " + kind + ": outcome " + r.outcome);
          check(r.targetIsExpected && r.selectedIsExpected && r.editors.length === 1,
            "resync " + kind + ": target/elSelected/editor " + JSON.stringify({ t: r.target, e: r.editors }));
        }
        cohort[kind].push(row);
        await prepare(page);
      }
    }
    const summary = (rows: any[]) => ({
      clicks: rows.length,
      stale: rows.filter(r => r.stale).length,
      eligible: rows.filter(r => r.eligible).length,
      resynced: rows.filter(r => r.outcome === "resynced").length,
      dropped: rows.filter(r => r.outcome === "dropped").length,
      legacy: rows.filter(r => r.outcome === "legacy").length,
      recovered: rows.filter(r => r.recovered).length,
      intercepted: rows.filter(r => r.intercepted).length,
      notInView: rows.filter(r => !r.inView).length
    });
    report.resyncCohort = { label: summary(cohort.label), route: summary(cohort.route) };
    diagnostics.resyncCohort = cohort;
  }
  if (stage("roundtrip")) await stageSnapshot(page, "roundtrip", ["save/export", "load text", "install", "undo probe (Ctrl+Z/Y)", "resync cohort label+route"]);

  // World B: generated 100k world, routed marker cohort (marker is the one ready kind)
  const fixtureKeys: Record<string, string[]> = {};
  if (stage("fixture")) {
    // world replacement mid-session: the element under the last held click must be detached by the new world, and
    // the stale clicks below run against the new world's live #map and canonical SVG
    const held = await page.evaluate(() => {
      const element = (globalThis as any).__ix.current?.element ?? null;
      (globalThis as any).__heldElement = element;
      return !!element;
    });
    await loadWorld("100k");
    await install(page);
    const heldDetached = await page.evaluate(() => {
      const element = (globalThis as any).__heldElement;
      return element ? !element.isConnected : null;
    });
    report.worldReplacement = {
      held,
      heldDetached,
      verdict: !held ? "UNTESTED" : heldDetached ? "PASS" : "FAIL",
      reason: held ? "held element from the previous world" : "no held element to test"
    };
    if (held && !heldDetached) fail("worldReplacement: element from the replaced world is still connected");
    await centerCamera(page, zoom);

    // labeled fixture on this world: a fixed grid of tile cameras covers the map; at each tile every not-yet-verified key
    // of each kind is probed for a click point (one camera move per tile, not per key: per-key aiming timed out on the
    // 100k world). Per kind the fixture is FIXTURE_MIN distinct verified keys, strideSample over the sorted verified ids.
    const fixture: Record<string, unknown> = {};
    const census: Record<string, { keys: string[]; natural: string[] }> = {};
    for (const kind of FIXTURE_KINDS) census[kind] = await page.evaluate(kind => (globalThis as any).__ix.census(kind), kind);
    const size = await page.evaluate(() => [(globalThis as any).graphWidth, (globalThis as any).graphHeight] as [number, number]);
    const grid = Math.max(1, Math.ceil(zoom * 1.5));
    const tiles: [number, number][] = [];
    for (let j = 0; j < grid; j++) for (let i = 0; i < grid; i++) tiles.push([(size[0] * (i + 0.5)) / grid, (size[1] * (j + 0.5)) / grid]);
    // too few natural labels (the 100k world has ~20): add synthetic ones through the app's add-label mutation, a 4×2
    // screen grid per tile camera, in local memory only. The natural census above is kept; the census is re-read so the
    // world total includes them, and they are reported as fixture coverage.
    let syntheticLabels: any = null;
    if (census.label.keys.length < FIXTURE_MIN) {
      // points outside the map fail the whole add batch (OUT_OF_BOUNDS), so they are dropped
      const items = tiles
        .flatMap(([wx, wy], t) =>
          Array.from({ length: 8 }, (_, n) => ({
            at: { x: wx + (160 + 320 * (n % 4) - 640) / zoom, y: wy + (180 + 360 * Math.floor(n / 4) - 360) / zoom },
            text: "Fx" + String(t * 8 + n + 1).padStart(2, "0")
          }))
        )
        .filter(({ at }) => at.x >= 16 && at.x <= size[0] - 16 && at.y >= 16 && at.y <= size[1] - 16);
      syntheticLabels = await page.evaluate(async items => {
        const runtime = (globalThis as any).__tupaia;
        const result = await runtime.call("add", { type: "label", phase: "apply", items });
        const created = result.value?.created ?? [];
        await runtime.settle?.();
        await (globalThis as any).__ix.prepare();
        return { ok: !!result.ok && !result.value?.aborted && !result.value?.errors?.length && created.length === items.length,
          requested: items.length, added: created.length, error: result.ok ? (result.value?.errors ?? null) : result };
      }, items);
      check(syntheticLabels.ok, "fixture label: synthetic add " + JSON.stringify(syntheticLabels).slice(0, 400));
      const natural = census.label.natural;
      census.label = { ...(await page.evaluate(() => (globalThis as any).__ix.census("label"))), natural };
    }
    const verified: Record<string, string[]> = Object.fromEntries(FIXTURE_KINDS.map(kind => [kind, [...census[kind].natural]]));
    const harvestStart = Date.now();
    let tilesVisited = 0;
    const tileRows: any[] = [];
    for (const [wx, wy] of tiles) {
      if (FIXTURE_KINDS.every(kind => verified[kind].length >= FIXTURE_MIN * 2)) break;
      if (Date.now() - harvestStart > 5 * 60000) break;
      await camera(page, zoom, wx, wy);
      tilesVisited++;
      const tile: any = { center: [wx, wy], camera: await page.evaluate(() => (globalThis as any).__ix.cameraState()), kinds: {} };
      for (const kind of FIXTURE_KINDS) {
        if (verified[kind].length >= FIXTURE_MIN * 2) continue;
        const found = await page.evaluate(({ kind, skip }) => (globalThis as any).__ix.harvest(kind, skip), { kind, skip: verified[kind] });
        verified[kind].push(...found.keys);
        tile.kinds[kind] = { found: found.keys.length, onScreen: found.onScreen };
      }
      tileRows.push(tile);
    }
    for (const kind of FIXTURE_KINDS) {
      const picks: string[] = strideSample([...verified[kind]].sort(compareIds), FIXTURE_MIN);
      fixtureKeys[kind] = picks;
      fixture[kind] = { ...coverage(kind, census[kind].natural.length, census[kind].keys.length, picks.length), verifiedAnyTile: verified[kind].length };
      check(picks.length >= FIXTURE_MIN, "fixture " + kind + ": " + picks.length + " of " + FIXTURE_MIN + " distinct objects visible");
    }
    report.fixture = {
      world: "100k",
      zoom,
      minimum: FIXTURE_MIN,
      syntheticLabels,
      tiles: { grid, planned: tiles.length, visited: tilesVisited, seconds: Math.round((Date.now() - harvestStart) / 1000), rows: tileRows },
      kinds: fixture
    };
    await centerCamera(page, zoom);
    await stageSnapshot(page, "fixture", ["load 100k (world replacement)", "install", "centerCamera", "census", "synthetic labels",
      "tile harvest " + tilesVisited + "/" + tiles.length, "centerCamera"]);
  }

  if (focus === "route") await routeFocus(page, loadWorld, preamble === "fixture");

  if (focus === "all") {
    // route camera-stale cohort on the 100k world: fixture routes with a robust click point, one wheel step, real click.
    // Route strokes are ~0.5-1.6 CSS px wide at z2, too thin for the ±2 px robust probe, so the camera aims at the
    // route's mid-length point and steps up through ROUTE_ZOOMS until the probe holds (target selection only; the pass
    // criteria are unchanged). The zoom used is recorded per row.
    {
      const mark = failures.length;
      const rows: any[] = [];
      let eligible = 0;
      const routeZooms = [...new Set([zoom, ...ROUTE_ZOOMS.filter(k => k > zoom)])];
      for (let i = 0; i < fixtureKeys.route.length && eligible < COHORT && rows.length < ROUTE_ATTEMPTS; i++) {
        const key = fixtureKeys.route[i];
        let target: any = null;
        let routeZoom = 0;
        for (const k of routeZooms) {
          const aim = await page.evaluate(({ key }) => (globalThis as any).__ix.aimKey("route", key), { key });
          if (aim) await camera(page, k, aim[0], aim[1]);
          target = await page.evaluate(({ key }) => (globalThis as any).__ix.probeKey("route", key, true), { key });
          routeZoom = k;
          if (target) break;
        }
        if (!target) {
          rows.push({ key, skip: "no robust point", routeZooms });
          continue;
        }
        const click = await staleClick(page, target.world, i % 2 ? -100 : 100);
        const r = click.result;
        const row: any = { key, routeZoom, point: click.point, inView: click.inView, otherDialogs: click.otherDialogs, lateDialogs: click.lateDialogs, ...r };
        row.eligible = !!r && r.stale && r.oracleIsExpected;
        if (r) r.problems.forEach((p: string) => fail("route " + key + ": " + p));
        if (row.eligible) {
          eligible++;
          check(r.outcome === "resynced" || (r.recovered && r.outcome === "legacy"), "route " + key + ": outcome " + r.outcome);
          check(r.targetIsExpected && r.selectedIsExpected && r.editors.length === 1 && r.editors[0] === "editRoute",
            "route " + key + ": target/elSelected/editor " + JSON.stringify({ t: r.target, e: r.editors }));
        }
        rows.push(row);
        try {
          await prepare(page);
        } catch (error) {
          const shown = await page.evaluate(() => (globalThis as any).__ix.shownDialogs()).catch(() => null);
          // still a failure; measure whether the GPU settles late (slow prepare/refine) or never (stuck)
          row.lateSettle = await page.evaluate(async () => {
            const w = globalThis as any;
            const begin = performance.now();
            let error = "";
            try { await w.__ix.settled(120000); } catch (e) { error = String((e as Error)?.message || e).slice(0, 600); }
            const gpu = w.rendererStatus?.()?.gpu;
            return { extraMs: performance.now() - begin, error, prepares: gpu?.prepares, lastPrepareMs: gpu?.lastPrepareMs,
              lastPrepare: gpu?.lastPrepare, revision: gpu?.revision, zoom: w.d3?.zoomTransform?.(document.getElementById("map")) };
          }).catch(e => ({ error: String(e?.message || e).slice(0, 300) }));
          fail("route " + key + ": settle after click: " + String((error as Error)?.message || error).slice(0, 1000) +
            " shown " + JSON.stringify(shown) + " lateSettle " + JSON.stringify(row.lateSettle));
          break;
        }
      }
      const clicked = rows.filter(r => !r.skip);
      report.routeCohort = {
        fixtureKeys: fixtureKeys.route.length,
        routeZooms,
        routeZoomUsed: Object.fromEntries(routeZooms.map(k => [k, rows.filter(r => !r.skip && r.routeZoom === k).length])),
        attempts: rows.length,
        skipped: rows.length - clicked.length,
        clicks: clicked.length,
        stale: clicked.filter(r => r.stale).length,
        eligible,
        resynced: clicked.filter(r => r.outcome === "resynced").length,
        dropped: clicked.filter(r => r.outcome === "dropped").length,
        recovered: clicked.filter(r => r.recovered).length,
        intercepted: clicked.filter(r => r.intercepted).length,
        verdict: cohortVerdict({ eligible, required: COHORT, failures: failures.length - mark })
      };
      diagnostics.routeCohort = rows;
    }
    const ids: string[] = await page.evaluate(() =>
      [...document.querySelectorAll("#markers > svg")].map(el => el.id).sort((a, b) => +a.slice(6) - +b.slice(6))
    );
    const rows: any[] = [];
    const start = Date.now();
    let eligible = 0;
    for (let i = 0; i < ids.length && eligible < MARKER_ELIGIBLE && rows.length < MARKER_ATTEMPTS; i++) {
      if (Date.now() - start > MARKER_MINUTES * 60000) break;
      const sx = Math.round(640 + 180 * Math.cos(i * 2.4)),
        sy = Math.round(360 + 180 * Math.sin(i * 2.4));
      const aimed = await page.evaluate(
        async ({ id, k, sx, sy }) => {
          const ix = (globalThis as any).__ix;
          const svg = document.getElementById(id) as unknown as SVGSVGElement;
          if (!svg) return { skip: "missing" };
          const x = +svg.getAttribute("x")! + +svg.getAttribute("width")! / 2;
          const y = +svg.getAttribute("y")! + +svg.getAttribute("height")! / 2;
          await ix.camera(k, x, y, sx, sy);
          // settled + DOM quiet: a late world mutation after the aim (e.g. #emblems childList) otherwise leaves the pick
          // index one static revision behind at click time, which tests the revision fallback, not the stale camera
          await ix.prepare();
          const r = svg.getBoundingClientRect();
          for (const [fx, fy] of [[0.5, 0.7], [0.5, 0.5], [0.4, 0.7], [0.6, 0.7], [0.5, 0.85]]) {
            const px = Math.round(r.left + r.width * fx),
              py = Math.round(r.top + r.height * fy);
            if (px < 20 || px > 1260 || py < 20 || py > 700) continue;
            const hit = ix.hit(px, py);
            if (!hit || !svg.contains(hit) || ix.branchOf(hit) !== "markers") continue;
            ix.current = { kind: "marker", element: svg, hit, x: px, y: py, world: ix.toWorld(px, py) };
            // re-settle after the probe and record static revisions on both sides of it (diagnosis only)
            const count = () => (globalThis as any).rendererStatus?.()?.gpu?.invalidations?.count ?? null;
            const aimRevisions = [count()];
            await ix.prepare();
            aimRevisions.push(count());
            return { world: ix.current.world, x: px, y: py, aimRevisions };
          }
          return { skip: "no marker hit" };
        },
        { id: ids[i], k: zoom, sx, sy }
      );
      if ((aimed as any).skip) {
        rows.push({ id: ids[i], skip: (aimed as any).skip });
        continue;
      }
      const click = await staleClick(page, (aimed as any).world, i % 2 ? -100 : 100);
      const r = click.result;
      const row: any = { id: ids[i], point: click.point, aimRevisions: (aimed as any).aimRevisions, inView: click.inView, ...r };
      row.eligible = !!r && r.stale && r.oracleIsExpected;
      if (r) r.problems.forEach((p: string) => fail("marker " + ids[i] + ": " + p));
      if (row.eligible) {
        eligible++;
        const ok = (r.outcome === "routed" && r.result === "event") || (r.recovered && r.outcome === "legacy");
        check(ok, "marker " + ids[i] + ": outcome " + r.outcome + (r.recovered ? " (recovered)" : ""));
        check(r.targetIsExpected && r.selectedIsExpected && r.editors.length === 1 && r.editors[0] === "editMarker",
          "marker " + ids[i] + ": target/elSelected/editor " + JSON.stringify({ t: r.target, e: r.editors }));
      }
      rows.push(row);
    }
    const clicked = rows.filter(r => !r.skip);
    const reasons: Record<string, number> = {};
    for (const r of clicked.filter(r => !r.eligible)) {
      const reason = !r.inView ? "left view" : r.intercepted ? "html overlay took the click" : !r.stale ? "not stale" : "oracle subject differs";
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
    report.markerCohort = {
      markers: ids.length,
      attempts: rows.length,
      skipped: rows.length - clicked.length,
      clicks: clicked.length,
      stale: clicked.filter(r => r.stale).length,
      eligible,
      routed: clicked.filter(r => r.outcome === "routed").length,
      routedCorrect: clicked.filter(r => r.outcome === "routed" && r.targetIsExpected).length,
      recovered: clicked.filter(r => r.recovered).length,
      recoveredCorrect: clicked.filter(r => r.recovered && r.targetIsExpected && r.selectedIsExpected).length,
      unrecovered: clicked.filter(r => r.unrecovered).length,
      // clicks with a static revision during the wheel step (pick index necessarily stale at click; diagnosis only)
      revisionDuringWheel: clicked.filter(r => r.point && r.point.revisions !== r.point.revisionsBefore).length,
      ineligible: reasons,
      underCoverage: eligible < MARKER_ELIGIBLE,
      verdict: cohortVerdict({ eligible, required: COHORT, failures: failures.filter(f => f.startsWith("marker ")).length }),
      latencyMs: clicked.map(r => r.ms).filter((v: unknown) => typeof v === "number"),
      seconds: Math.round((Date.now() - start) / 1000)
    };
    diagnostics.markerCohort = rows;
  }
  report.telemetry = await page.evaluate(() => (globalThis as any).__ix.telemetry());
  if (report.pageErrors.length) fail("page errors: " + report.pageErrors.slice(0, 3).join(" | "));
} catch (error) {
  fail("harness: " + ((error as Error)?.stack || String(error)));
} finally {
  await browser.close().catch(() => {});
  await new Promise<void>(done => server.close(() => done()));
}
// verdicts per cohort. UNTESTED (no eligible sample, no undo) and UNDERCOVERED never count as PASS. In full mode they
// are failures too; in short mode only FAIL is.
const verdicts: Record<string, CohortVerdict | string> = focus === "route" ? { routeFocus: report.routeFocus?.verdict ?? "UNTESTED" } : {
  routeCohort: report.routeCohort?.verdict ?? "UNTESTED",
  markerCohort: report.markerCohort?.verdict ?? "UNTESTED",
  resyncLabel: report.resyncCohort
    ? cohortVerdict({ eligible: report.resyncCohort.label.eligible, required: COHORT, failures: failures.filter(f => f.startsWith("resync label")).length })
    : "UNTESTED",
  undo: report.undoCohort?.verdict ?? "UNTESTED",
  worldReplacement: report.worldReplacement?.verdict ?? "UNTESTED",
  fixture: report.fixture
    ? Object.values(report.fixture.kinds as Record<string, { meets: boolean }>).every(c => c.meets) ? "PASS" : "UNDERCOVERED"
    : "UNTESTED"
};
report.verdicts = verdicts;
for (const [name, verdict] of Object.entries(verdicts)) {
  const strictBad = cohort === "full" && (verdict === "UNTESTED" || verdict === "UNDERCOVERED");
  if (verdict === "FAIL" || strictBad) fail("verdict " + name + ": " + verdict);
}
report.failure = failures.length ? failures.join("; ") : null;
writeFileSync(output, JSON.stringify(report, null, 2), { flag: "wx" });
writeFileSync(diagnosticsPath, JSON.stringify(diagnostics, null, 2), { flag: "wx" });
console.log(
  JSON.stringify({
    output,
    failure: report.failure && report.failure.slice(0, 2000),
    editors: report.editors.map((e: any) => [e.kind, e.problems.length]),
    staleFallback: report.staleFallback?.result && { stale: report.staleFallback.result.stale, outcome: report.staleFallback.result.outcome },
    roundtrip: report.roundtrip && { save: report.roundtrip.saveEqual, export: report.roundtrip.exportEqual, persisted: report.roundtrip.persisted },
    resyncCohort: report.resyncCohort,
    markerCohort: report.markerCohort && { ...report.markerCohort, latencyMs: undefined },
    routeCohort: report.routeCohort,
    routeFocus: report.routeFocus && {
      ...report.routeFocus,
      controls: Object.fromEntries(Object.entries(report.routeFocus.controls).map(([k, v]: [string, any]) => [k, v?.resumeMs ?? v]))
    },
    undo: report.undoCohort,
    worldReplacement: report.worldReplacement,
    fixture: report.fixture,
    verdicts,
    pageErrors: report.pageErrors.length,
    blocked: blocked.length
  })
);
if (report.failure) process.exitCode = 1;
