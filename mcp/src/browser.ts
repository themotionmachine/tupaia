// Headless Chromium ownership: lazy launch, one context + one page at /?local, the route
// firewall, the console ring, the call mutex and the bridge caller with hang/timeout recovery.
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type Browser, type BrowserContext, chromium, type Page, type Route } from "playwright";
import { type Config, type ModeState, readDistEntry, readDistVersion } from "./config.ts";
import { type Envelope, ToolError } from "./result.ts";
import { TIMEOUT_CAP_MS } from "./schemas.ts";
import { checkDist, type StaticServer, startStaticServer } from "./static-server.ts";

export type BrowserState = "not-launched" | "ready" | "closed";

export interface ConsoleEntry {
  seq: number;
  at: string;
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
}

export interface RequestLogEntry {
  at: string;
  method: string;
  url: string;
  status: number | string;
  via: "node" | "page-proxy";
}

export interface BlockedEntry {
  at: string;
  method: string;
  url: string;
  action: "aborted" | "403" | "stubbed";
}

export interface CallOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Mutating calls get an op token; a timeout marks the page dirty (relaunch + restore). */
  mutating?: boolean;
  json?: Record<string, unknown>;
  noAlerts?: boolean;
}

/** Restores the newest snapshot after a relaunch; returns a note for the caller. */
export type Restorer = (reason: string) => Promise<string>;

export const HIDE_UI_CSS =
  "#optionsContainer,#optionsTrigger,#tooltip,#tourPromptButton,#loading,.ui-dialog,#chat-widget-container{display:none!important}";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const STUB_HOSTS = /(^|\.)(googletagmanager\.com|google-analytics\.com|openwidget\.com)$/;
const FONT_HOSTS = /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com)$/;
const RING_MAX = 300;
const LOG_MAX = 200;

/** Init script #1. Serialised by Playwright, so it must be self-contained. */
function initSeed(seed: { version: string | null; w: number; h: number }) {
  try {
    const kv: Record<string, string> = {
      azgaarAssistant: "hide",
      noReminder: "true",
      "fmg-tour-prompt-count": "3",
      mapWidth: String(seed.w),
      mapHeight: String(seed.h),
      autosaveInterval: "0"
    };
    if (seed.version) kv.version = seed.version;
    for (const k of Object.keys(kv)) if (localStorage.getItem(k) === null) localStorage.setItem(k, kv[k]);
  } catch {}
  const w = window as unknown as { __mcpBoot?: Promise<unknown> };
  w.__mcpBoot = new Promise(res =>
    addEventListener("map:generated", e => res((e as CustomEvent).detail), { once: true })
  );
  const addCss = () => {
    const s = document.createElement("style");
    s.id = "tupaia-mcp-css";
    s.textContent = "#loading{display:none!important}";
    (document.head || document.documentElement).appendChild(s);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addCss, { once: true });
  else addCss();
}

export class BrowserManager {
  readonly config: Config;
  readonly modeState: ModeState;
  readonly bridgePath: string;
  readonly appVersion: string | null;
  readonly distEntry: string | null;

  state: BrowserState = "not-launched";
  launches = 0;
  lastRelaunch: { reason: string; at: string } | null = null;
  /** Reason the page must be relaunched (and the newest snapshot restored) before the next call. */
  dirty: string | null = null;
  /** Notes for the next tool result (relaunch notices). */
  pendingNotes: string[] = [];
  readonly outward: RequestLogEntry[] = [];
  readonly blocked: BlockedEntry[] = [];
  readonly consoleRing: ConsoleEntry[] = [];
  #seq = 0;
  #opSeq = 0;
  #browser: Browser | null = null;
  #context: BrowserContext | null = null;
  #page: Page | null = null;
  #server: StaticServer | null = null;
  #launching: Promise<Page> | null = null;
  #crashed: string | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  #restorer: Restorer | null = null;
  #launchHooks: Array<() => Promise<void>> = [];
  #closing = false;

  constructor(config: Config, modeState: ModeState) {
    this.config = config;
    this.modeState = modeState;
    this.bridgePath = path.join(config.mcpRoot, "src", "bridge.js");
    this.appVersion = readDistVersion(config.distDir);
    this.distEntry = readDistEntry(config.distDir);
  }

  setRestorer(fn: Restorer): void {
    this.#restorer = fn;
  }

  /** Runs after every fresh page boot (inside the caller's exclusive section). */
  onLaunch(fn: () => Promise<void>): void {
    this.#launchHooks.push(fn);
  }

  get url(): string | null {
    return this.#page && !this.#page.isClosed() ? this.#page.url() : null;
  }

  get origin(): string | null {
    return this.#server?.origin ?? null;
  }

  get isLaunched(): boolean {
    return !!(this.#page && !this.#page.isClosed() && this.#browser?.isConnected());
  }

  /** Serialise work on the single page. Tools wrap their whole handler in this. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => {});
    return run;
  }

  // ------------------------------------------------------------------ logs

  get consoleSeq(): number {
    return this.#seq;
  }

  consoleSince(seq: number): string[] {
    return this.consoleRing.filter(e => e.seq > seq).map(e => (e.kind === "console" ? e.text : `${e.kind}: ${e.text}`));
  }

  clearConsole(): void {
    this.consoleRing.length = 0;
  }

  #pushConsole(kind: ConsoleEntry["kind"], text: string): void {
    const entry = { seq: ++this.#seq, at: new Date().toISOString(), kind, text: text.slice(0, 2000) };
    this.consoleRing.push(entry);
    if (this.consoleRing.length > RING_MAX) this.consoleRing.shift();
    process.stderr.write(`[tupaia-mcp] page ${kind}: ${entry.text.slice(0, 300)}\n`);
  }

  logOutward(method: string, url: string, status: number | string, via: RequestLogEntry["via"]): void {
    this.outward.push({ at: new Date().toISOString(), method, url, status, via });
    if (this.outward.length > LOG_MAX) this.outward.shift();
    process.stderr.write(`[tupaia-mcp] outward ${method} ${url} -> ${status}\n`);
  }

  #logBlocked(method: string, url: string, action: BlockedEntry["action"]): void {
    this.blocked.push({ at: new Date().toISOString(), method, url: url.slice(0, 300), action });
    if (this.blocked.length > LOG_MAX) this.blocked.shift();
  }

  // ------------------------------------------------------------------ lifecycle

  /** The page, launching (or relaunching after a crash) as needed. Callers hold exclusive(). */
  async getPage(): Promise<Page> {
    if (this.#page && !this.#page.isClosed() && this.#browser?.isConnected() && !this.#crashed) return this.#page;
    if (this.#crashed) {
      const reason = this.#crashed;
      this.#crashed = null;
      await this.#teardownContext();
      this.lastRelaunch = { reason, at: new Date().toISOString() };
      this.pendingNotes.push(
        `browser relaunched after: ${reason}. The map in the page was lost and the page now holds a fresh random map; restore with session {action:'restart', restore:'latest'} or snapshot {action:'restore'}.`
      );
    }
    this.#launching ??= this.#launch().finally(() => {
      this.#launching = null;
    });
    return this.#launching;
  }

  async #launch(): Promise<Page> {
    if (this.#closing) throw new ToolError("BROWSER", "server is shutting down");
    checkDist(this.config.distDir, this.config.repoRoot);
    this.#server ??= await startStaticServer(this.config.distDir);
    if (!this.#browser?.isConnected()) {
      this.#browser = await chromium.launch({
        headless: !this.config.headed,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false
      });
      const b = this.#browser;
      b.on("disconnected", () => {
        if (this.#browser === b) {
          this.#browser = null;
          this.#page = null;
          this.#context = null;
          if (!this.#closing && this.state === "ready") this.#crashed = "browser disconnected";
        }
      });
    }
    const { width, height } = this.config.viewport;
    const ctx = await this.#browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      serviceWorkers: "block",
      acceptDownloads: true
    });
    await ctx.addInitScript(initSeed, { version: this.appVersion, w: width, h: height });
    await ctx.addInitScript({ path: this.bridgePath });
    await this.#installRoutes(ctx);
    const page = await ctx.newPage();
    page.on("console", msg => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (/net::ERR_BLOCKED_BY_CLIENT|net::ERR_FAILED/.test(text) && /Failed to load resource/.test(text)) return;
      this.#pushConsole("console", text);
    });
    page.on("pageerror", err => this.#pushConsole("pageerror", err.message));
    page.on("requestfailed", req => {
      const u = req.url();
      const err = req.failure()?.errorText ?? "";
      if (/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(err)) return;
      this.#pushConsole("requestfailed", `${req.method()} ${u.slice(0, 200)} ${err}`);
    });
    page.on("crash", () => {
      if (this.#page === page) this.#crashed = "page crashed";
    });
    if (process.env.TUPAIA_DEBUG) {
      const dbg = (m: string) => process.stderr.write(`[tupaia-mcp] debug ${Date.now() % 100000} ${m}\n`);
      page.on("load", () => dbg("load"));
      page.on("domcontentloaded", () => dbg("domcontentloaded"));
      page.on("frameattached", f => dbg(`frameattached ${f.url()}`));
      page.on("framedetached", f => dbg(`framedetached ${f.url()}`));
      page.on("close", () => dbg("close"));
      page.on("console", m => dbg(`console ${m.type()} ${m.text().slice(0, 120)}`));
    }
    page.on("framenavigated", frame => {
      if (frame === page.mainFrame())
        process.stderr.write(`[tupaia-mcp] page navigated: ${frame.url().slice(0, 200)}\n`);
    });
    page.on("dialog", d => {
      d.dismiss().catch(() => {});
    });
    this.#context = ctx;
    this.#page = page;
    try {
      await page.goto(`${this.#server.origin}/?local`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const env = (await page.evaluate(
        ([n, a]) =>
          (globalThis as unknown as { __tupaia: { call: (n: string, a: unknown) => unknown } }).__tupaia.call(n, a),
        ["ready", { timeoutMs: 60_000 }] as const
      )) as Envelope;
      if (!env.ok) throw new ToolError("BROWSER", `app did not boot: ${env.error?.message ?? "unknown"}`);
    } catch (e) {
      await this.#teardownContext();
      throw e instanceof ToolError ? e : new ToolError("BROWSER", `browser launch failed: ${(e as Error).message}`);
    }
    this.launches++;
    this.state = "ready";
    for (const hook of this.#launchHooks) await hook();
    return page;
  }

  async #installRoutes(ctx: BrowserContext): Promise<void> {
    // Playwright runs the LAST registered matching route first, so the catch-all goes first.
    await ctx.route(
      url => (url.protocol === "http:" || url.protocol === "https:") && !LOOPBACK.has(url.hostname),
      route => {
        const req = route.request();
        this.#logBlocked(req.method(), req.url(), "aborted");
        return route.abort("blockedbyclient");
      }
    );
    await ctx.route(
      url => STUB_HOSTS.test(url.hostname),
      route => {
        this.#logBlocked(route.request().method(), route.request().url(), "stubbed");
        return route.fulfill({ status: 200, body: "", contentType: "text/plain" });
      }
    );
    await ctx.route(
      url => FONT_HOSTS.test(url.hostname),
      route => {
        if (this.config.offline) {
          this.#logBlocked(route.request().method(), route.request().url(), "stubbed");
          const css = /\.css|fonts\.googleapis/.test(route.request().url());
          return route.fulfill({ status: 200, body: "", contentType: css ? "text/css" : "font/woff2" });
        }
        return route.continue();
      }
    );
    // The write firewall: every page-originated non-GET to any /api/ path is refused in all modes.
    await ctx.route("**/api/**", route => this.#apiRoute(route));
  }

  async #apiRoute(route: Route): Promise<void> {
    const req = route.request();
    const method = req.method();
    if (method !== "GET" && method !== "HEAD") {
      this.#logBlocked(method, req.url(), "403");
      return route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "blocked by tupaia-mcp" })
      });
    }
    const origin = this.config.liveOrigin;
    if (this.modeState.mode !== "live" || !origin) {
      return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not_found"}' });
    }
    const u = new URL(req.url());
    const target = `${origin}${u.pathname}${u.search}`;
    try {
      const resp = await route.fetch({ url: target, method: "GET" });
      this.logOutward("GET", target, resp.status(), "page-proxy");
      return route.fulfill({ response: resp });
    } catch (e) {
      this.logOutward("GET", target, `error: ${(e as Error).message}`, "page-proxy");
      return route.fulfill({ status: 502, contentType: "application/json", body: '{"error":"proxy_failed"}' });
    }
  }

  async #teardownContext(): Promise<void> {
    const ctx = this.#context;
    this.#context = null;
    this.#page = null;
    if (ctx) await ctx.close().catch(() => {});
  }

  /** Close everything; the next getPage() starts fresh. */
  async relaunch(reason: string): Promise<Page> {
    await this.#teardownContext();
    if (this.#browser && !this.#browser.isConnected()) this.#browser = null;
    this.#crashed = null;
    this.lastRelaunch = { reason, at: new Date().toISOString() };
    return this.getPage();
  }

  /** If the page was marked dirty (mutating timeout/hang), relaunch and restore the newest snapshot. */
  async ensureHealthy(notes: string[]): Promise<void> {
    if (this.dirty) {
      const reason = this.dirty;
      this.dirty = null;
      await this.relaunch(reason);
      let note = `browser relaunched (${reason}).`;
      if (this.#restorer) {
        try {
          note += ` ${await this.#restorer(reason)}`;
        } catch (e) {
          note += ` Restoring the newest snapshot failed: ${(e as Error).message}`;
        }
      }
      notes.push(note);
    } else {
      await this.getPage();
    }
    if (this.pendingNotes.length) notes.push(...this.pendingNotes.splice(0));
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.state = "closed";
    const b = this.#browser;
    this.#browser = null;
    this.#page = null;
    this.#context = null;
    if (b) await b.close().catch(() => {});
    if (this.#server) await this.#server.close().catch(() => {});
    this.#server = null;
  }

  /** Test hook: crash the renderer. */
  async crashForTest(): Promise<void> {
    const page = await this.getPage();
    await page.goto("chrome://crash", { timeout: 5000 }).catch(() => {});
    for (let k = 0; k < 50 && !this.#crashed; k++) await sleep(100);
    if (!this.#crashed) this.#crashed = "page crashed (test hook)";
  }

  // ------------------------------------------------------------------ bridge

  /** One bridge call with timeout, cancellation and hang detection. Caller holds exclusive(). */
  async callBridge<T = unknown>(name: string, args: unknown, opts: CallOptions): Promise<Envelope<T>> {
    const page = await this.getPage();
    const timeoutMs = Math.max(500, Math.min(opts.timeoutMs, TIMEOUT_CAP_MS));
    const op = opts.mutating ? `op${++this.#opSeq}` : undefined;
    const meta = { op, json: opts.json, noAlerts: opts.noAlerts };
    const evalP = page.evaluate(
      ([n, a, m]) =>
        (globalThis as unknown as { __tupaia: { call: (n: string, a: unknown, m: unknown) => unknown } }).__tupaia.call(
          n,
          a,
          m
        ),
      [name, args, meta] as const
    ) as Promise<Envelope<T>>;
    evalP.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const stop = new Promise<"timeout" | "abort">(resolve => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      if (opts.signal) {
        if (opts.signal.aborted) resolve("abort");
        onAbort = () => resolve("abort");
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      const r = await Promise.race([
        evalP.then(
          v => ({ v }),
          (e: unknown) => ({ e })
        ),
        stop
      ]);
      if (r === "timeout" || r === "abort") {
        const what = r === "timeout" ? `timed out after ${timeoutMs} ms` : "was cancelled";
        const recovery = await this.#afterStall(name, !!opts.mutating, what);
        throw new ToolError(r === "timeout" ? "TIMEOUT" : "CANCELLED", `${name} ${what}. ${recovery}`);
      }
      if ("e" in r) {
        const msg = (r.e as Error)?.message ?? String(r.e);
        if (this.#crashed || page.isClosed()) {
          throw new ToolError("BROWSER", `the page went away during ${name}: ${msg.split("\n")[0]}`);
        }
        throw new ToolError("PAGE_ERROR", `${name}: ${msg.split("\n")[0]}`);
      }
      if (op && r.v && r.v.op !== op) throw new ToolError("STALE_OP", `${name}: op token mismatch`);
      return r.v;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  async #afterStall(name: string, mutating: boolean, what: string): Promise<string> {
    if (mutating) {
      this.dirty = `${name} ${what}`;
      return "The page state is uncertain: it will be relaunched and the newest snapshot restored before the next call.";
    }
    const page = this.#page;
    const alive = page
      ? await Promise.race([
          page.evaluate("1").then(
            () => true,
            () => false
          ),
          sleep(2000).then(() => false)
        ])
      : false;
    if (alive) return "The page still responds; read-only work was abandoned.";
    this.dirty = `${name} ${what} and the page stopped responding`;
    return "The page stopped responding: it will be relaunched and the newest snapshot restored before the next call.";
  }

  // ------------------------------------------------------------------ screenshots

  /** PNG of the #map element at the current view; scale > 1 renders at a higher device scale. */
  async screenshotMap(opts: { hideUi: boolean; scale: number; timeoutMs: number }): Promise<Buffer> {
    const page = await this.getPage();
    const style = opts.hideUi ? HIDE_UI_CSS : undefined;
    const shoot = () =>
      page
        .locator("#map")
        .screenshot({ type: "png", style, scale: "device", timeout: opts.timeoutMs, animations: "disabled" });
    if (opts.scale <= 1) return shoot();
    // Higher-resolution capture: CDP captureScreenshot with a clip scale renders the viewport
    // region at scale x CSS pixels (Playwright's own screenshot ignores device-metric overrides).
    const box = await page.locator("#map").boundingBox({ timeout: opts.timeoutMs });
    if (!box) throw new ToolError("BROWSER", "the #map element is not visible");
    const vp = this.config.viewport;
    const x = Math.max(0, box.x);
    const y = Math.max(0, box.y);
    const width = Math.min(box.width, vp.width - x);
    const height = Math.min(box.height, vp.height - y);
    const tag = style ? await page.addStyleTag({ content: style }) : null;
    const cdp = await page.context().newCDPSession(page);
    try {
      const r = (await cdp.send("Page.captureScreenshot", {
        format: "png",
        clip: { x, y, width, height, scale: opts.scale },
        captureBeyondViewport: false
      })) as { data: string };
      return Buffer.from(r.data, "base64");
    } finally {
      await cdp.detach().catch(() => {});
      if (tag) await tag.evaluate(el => (el as Element).remove()).catch(() => {});
    }
  }
}
