// Node-side client for the shared-map Worker API. This layer only READS (load_map
// {source:'shared'}). Builder 3 adds meta/versions/putMap/restore with the live-write gate
// (one-time token, lineage, build-version block) INSIDE this module, not only in tools.
// Every request is logged through BrowserManager.logOutward (method, url, status).
import type { BrowserManager } from "./browser.ts";
import type { Config } from "./config.ts";
import { ToolError } from "./result.ts";

export interface SharedMapBlob {
  bytes: Buffer;
  version: number | null;
  updatedBy: string | null;
  updatedAt: string | null;
  url: string;
}

export class SharedApi {
  readonly config: Config;
  readonly browser: BrowserManager;

  constructor(config: Config, browser: BrowserManager) {
    this.config = config;
    this.browser = browser;
  }

  /** The origin reads hit, or a MODE error when TUPAIA_LIVE_ORIGIN=none. */
  origin(): string {
    const o = this.config.liveOrigin;
    if (!o) {
      throw new ToolError("MODE", "TUPAIA_LIVE_ORIGIN=none: shared-map reads are disabled in this server process");
    }
    return o;
  }

  async get(pathname: string, timeoutMs = 30_000): Promise<Response> {
    const url = `${this.origin()}${pathname}`;
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    } catch (e) {
      this.browser.logOutward("GET", url, `error: ${(e as Error).message}`, "node");
      throw new ToolError("NETWORK", `GET ${url} failed: ${(e as Error).message}`);
    }
    this.browser.logOutward("GET", url, res.status, "node");
    return res;
  }

  async getMap(): Promise<SharedMapBlob> {
    const res = await this.get("/api/map/shared", 60_000);
    if (res.status === 404) throw new ToolError("NOT_FOUND", "the shared map does not exist yet (404)");
    if (!res.ok) throw new ToolError("NETWORK", `GET /api/map/shared returned ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const v = res.headers.get("x-map-version");
    return {
      bytes,
      version: v && /^\d+$/.test(v) ? Number(v) : null,
      updatedBy: res.headers.get("x-map-updated-by"),
      updatedAt: res.headers.get("x-map-updated-at"),
      url: res.url
    };
  }
}
