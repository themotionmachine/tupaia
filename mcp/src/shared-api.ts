// Node-side client for the shared-map Worker API (cloudflare/worker/src/index.ts).
//
// Reads (meta, versions, map, live build) work in both modes. The two writes (putMap,
// restore) re-check the live-write gate HERE, not only in the tool layer:
// - the server must have been spawned with TUPAIA_MODE=live and still be in live mode, and
//   the caller passes the mode it believes it is in;
// - the caller passes a one-time token issued by a preview of exactly this write (same live
//   version, same body hash or target, same flags); it is valid for 10 minutes, once.
// putMap sends X-Map-Version and never X-Map-Overwrite. Every request is logged through
// BrowserManager.logOutward (method, url, status) into the session's outward request log.
//
// Sketch writes (putSketchBlob, putSketchOps, deleteSketch) never touch `shared`: they refuse
// any id that does not start with `sketch-` and need the same spawn-time live mode, re-checked
// here. They take no token (the shared map is not involved) and never send X-Map-Overwrite.
import crypto from "node:crypto";
import type { BrowserManager } from "./browser.ts";
import type { Config, Mode } from "./config.ts";
import { ToolError } from "./result.ts";

export const MAP_ID = "shared";
/** Ids sketch writes may touch: `sketch-<slug>`, slug as in the sketch tool. */
export const SKETCH_ID_RE = /^sketch-[a-z0-9][a-z0-9-]{0,47}$/;
export const TOKEN_TTL_MS = 10 * 60 * 1000;

export interface SharedMapBlob {
  bytes: Buffer;
  version: number | null;
  updatedBy: string | null;
  updatedAt: string | null;
  url: string;
}

/** Worker metaPayload. */
export interface SharedMeta {
  id: string;
  name: string;
  version: number;
  updated_at: string;
  updated_by: string;
  editing_by: string | null;
  lock_expires: string | null;
}

export interface SharedVersions {
  current: number;
  snapshots: Array<{ version: number; size: number; saved_at: string }>;
}

export interface LiveBuild {
  version: string | null;
  entry: string | null;
  fetchedAt: string;
  error?: string;
}

/** What a token is bound to. Every field must match again at confirm time. */
export interface GateFields {
  kind: "save" | "restore";
  /** Live meta.version seen by the preview. */
  liveVersion: number;
  /** save: sha256 of the outgoing body. restore: `v<target>`. */
  subject: string;
  target: string;
  mode: Mode;
  /** Overrides the preview was made with (force, replaceWithUnrelated, expect...). */
  flags: string;
}

interface TokenEntry {
  fields: GateFields;
  issuedAt: number;
  used: boolean;
}

function fieldsKey(f: GateFields): string {
  return JSON.stringify([f.kind, f.liveVersion, f.subject, f.target, f.mode, f.flags]);
}

export function sha256(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Numeric semver compare: -1, 0, 1 (missing parts count as 0). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(n => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map(n => Number.parseInt(n, 10) || 0);
  for (let k = 0; k < Math.max(pa.length, pb.length); k++) {
    const d = (pa[k] ?? 0) - (pb[k] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export class SharedApi {
  readonly config: Config;
  readonly browser: BrowserManager;
  #tokens = new Map<string, TokenEntry>();
  #build: { at: number; value: LiveBuild } | null = null;
  #sketchRoutes = false;

  constructor(config: Config, browser: BrowserManager) {
    this.config = config;
    this.browser = browser;
  }

  get target(): string {
    return `${this.config.liveOrigin ?? "none"}/api/map/${MAP_ID}`;
  }

  /** The origin reads hit, or a MODE error when TUPAIA_LIVE_ORIGIN=none. */
  origin(): string {
    const o = this.config.liveOrigin;
    if (!o) {
      throw new ToolError("MODE", "TUPAIA_LIVE_ORIGIN=none: shared-map reads are disabled in this server process");
    }
    return o;
  }

  async #request(
    method: "GET" | "PUT" | "POST" | "DELETE",
    pathname: string,
    init: { headers?: Record<string, string>; body?: Buffer | string; timeoutMs?: number } = {}
  ): Promise<Response> {
    const url = `${this.origin()}${pathname}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: init.headers,
        body: init.body as BodyInit | undefined,
        signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
        redirect: "error"
      });
    } catch (e) {
      this.browser.logOutward(method, url, `error: ${(e as Error).message}`, "node");
      throw new ToolError("NETWORK", `${method} ${url} failed: ${(e as Error).message}`);
    }
    this.browser.logOutward(method, url, res.status, "node");
    return res;
  }

  get(pathname: string, timeoutMs = 30_000): Promise<Response> {
    return this.#request("GET", pathname, { timeoutMs });
  }

  async #json<T>(res: Response, what: string): Promise<T> {
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ToolError("NETWORK", `${what}: expected JSON, got ${res.status} ${text.slice(0, 120)}`);
    }
  }

  /** GET /api/map/<id>/meta (default shared); null when the map does not exist (404). */
  async meta(id: string = MAP_ID): Promise<SharedMeta | null> {
    const res = await this.get(`/api/map/${encodeURIComponent(id)}/meta`);
    if (res.status === 404) return null;
    if (!res.ok) throw new ToolError("NETWORK", `GET meta returned ${res.status}`);
    return this.#json<SharedMeta>(res, "meta");
  }

  async versions(): Promise<SharedVersions | null> {
    const res = await this.get(`/api/map/${MAP_ID}/versions`);
    if (res.status === 404) return null;
    if (!res.ok) throw new ToolError("NETWORK", `GET versions returned ${res.status}`);
    return this.#json<SharedVersions>(res, "versions");
  }

  async getMap(id: string = MAP_ID): Promise<SharedMapBlob> {
    const res = await this.get(`/api/map/${encodeURIComponent(id)}`, 60_000);
    if (res.status === 404)
      throw new ToolError(
        "NOT_FOUND",
        id === MAP_ID ? "the shared map does not exist yet (404)" : `map '${id}' not found (404)`
      );
    if (!res.ok) throw new ToolError("NETWORK", `GET /api/map/${id} returned ${res.status}`);
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

  /** GET /api/maps: every map's metadata (the shared map and the sketches). */
  async listMaps(): Promise<SharedMeta[]> {
    const res = await this.get("/api/maps");
    if (!res.ok) throw new ToolError("NETWORK", `GET /api/maps returned ${res.status}`);
    return this.#json<SharedMeta[]>(res, "maps");
  }

  /** GET /api/map/:id/ops: a sketch's ops.json, or null when it has none (404). */
  async getOps(id: string): Promise<Record<string, unknown> | null> {
    const res = await this.get(`/api/map/${encodeURIComponent(id)}/ops`);
    if (res.status === 404) return null;
    if (!res.ok) throw new ToolError("NETWORK", `GET /api/map/${id}/ops returned ${res.status}`);
    return this.#json<Record<string, unknown>>(res, "ops");
  }

  /** The deployed build: VERSION from /versioning.js and the entry chunk from /. Cached. */
  async liveBuild(): Promise<LiveBuild> {
    const now = Date.now();
    if (this.#build && now - this.#build.at < this.config.buildCacheMs) return this.#build.value;
    const value: LiveBuild = { version: null, entry: null, fetchedAt: new Date(now).toISOString() };
    const errors: string[] = [];
    try {
      const res = await this.get("/versioning.js");
      if (res.ok) value.version = /const VERSION = "([^"]+)"/.exec(await res.text())?.[1] ?? null;
      else errors.push(`versioning.js ${res.status}`);
    } catch (e) {
      errors.push((e as Error).message);
    }
    try {
      const res = await this.get("/");
      if (res.ok) value.entry = /src="\/(index-[^"]+\.js)"/.exec(await res.text())?.[1] ?? null;
      else errors.push(`/ ${res.status}`);
    } catch (e) {
      errors.push((e as Error).message);
    }
    if (errors.length) value.error = errors.join("; ");
    this.#build = { at: now, value };
    return value;
  }

  // ------------------------------------------------------------------ the gate

  /** Issue a one-time token bound to these fields (10 minutes, single use). */
  issueToken(fields: GateFields): { token: string; expiresAt: string } {
    const now = Date.now();
    for (const [k, e] of this.#tokens) if (e.used || now - e.issuedAt > TOKEN_TTL_MS) this.#tokens.delete(k);
    const nonce = crypto.randomBytes(8).toString("hex");
    const token = sha256(`${fieldsKey(fields)}|${nonce}`).slice(0, 16);
    this.#tokens.set(token, { fields, issuedAt: now, used: false });
    return { token, expiresAt: new Date(now + TOKEN_TTL_MS).toISOString() };
  }

  /** Throws unless the token is live, unused and bound to exactly these fields. consume marks it used. */
  checkToken(token: string | undefined, fields: GateFields, consume: boolean): void {
    if (!token) {
      throw new ToolError(
        "REFUSED",
        "a confirmed write needs the token from a preview: call without confirm first, show the preview to the human, then confirm with that token"
      );
    }
    const e = this.#tokens.get(token);
    if (!e) throw new ToolError("REFUSED", "unknown token: preview again and use the token it returns");
    if (e.used) throw new ToolError("REFUSED", "this token was already used; a token allows exactly one write");
    if (Date.now() - e.issuedAt > TOKEN_TTL_MS) {
      this.#tokens.delete(token);
      throw new ToolError("REFUSED", "the token expired (10 minutes); preview again");
    }
    if (e.fields.kind !== fields.kind)
      throw new ToolError("REFUSED", `this token was issued for shared_${e.fields.kind}`);
    if (fieldsKey(e.fields) !== fieldsKey(fields)) {
      const what: string[] = [];
      if (e.fields.liveVersion !== fields.liveVersion)
        what.push(`the live version moved from ${e.fields.liveVersion} to ${fields.liveVersion}`);
      if (e.fields.subject !== fields.subject)
        what.push(fields.kind === "save" ? "the map in the page changed" : "the restore target changed");
      if (e.fields.flags !== fields.flags)
        what.push(`the flags differ (preview ${e.fields.flags}, now ${fields.flags})`);
      if (e.fields.mode !== fields.mode || e.fields.target !== fields.target) what.push("the mode or target changed");
      throw new ToolError("REFUSED", `the token does not match this write (${what.join("; ")}); preview again`);
    }
    if (consume) e.used = true;
  }

  #assertLive(mode: Mode): void {
    if (this.config.envMode !== "live" || this.browser.modeState.mode !== "live" || mode !== "live") {
      throw new ToolError(
        "MODE",
        "shared-map writes need a server spawned with TUPAIA_MODE=live (and not dropped to local); this one is local"
      );
    }
  }

  /** PUT the map. Sends X-Map-Version (never X-Map-Overwrite). 409 becomes a CONFLICT error with the Worker body. */
  async putMap(req: {
    mode: Mode;
    token: string;
    fields: GateFields;
    body: Buffer;
    version: number;
    name: string | null;
  }): Promise<{ id: string; version: number; updated_at: string; updated_by: string }> {
    this.#assertLive(req.mode);
    if (req.fields.kind !== "save" || req.fields.liveVersion !== req.version || req.fields.subject !== sha256(req.body))
      throw new ToolError("REFUSED", "putMap: the body or version does not match the gate fields");
    this.checkToken(req.token, req.fields, true);
    const headers: Record<string, string> = {
      "content-type": "text/plain; charset=utf-8",
      "X-Map-Version": String(req.version)
    };
    if (req.name) headers["X-Map-Name"] = encodeURIComponent(req.name);
    const res = await this.#request("PUT", `/api/map/${MAP_ID}`, { headers, body: req.body, timeoutMs: 120_000 });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    if (res.status === 409) {
      throw new ToolError("CONFLICT", `the Worker refused the save as stale (409): ${text.slice(0, 300)}`, {
        details: { status: 409, body }
      });
    }
    if (!res.ok)
      throw new ToolError("NETWORK", `PUT returned ${res.status}: ${text.slice(0, 300)}`, { details: { body } });
    return body as { id: string; version: number; updated_at: string; updated_by: string };
  }

  // ------------------------------------------------------------------ sketch writes

  #assertSketchId(id: string): void {
    if (id === MAP_ID || !SKETCH_ID_RE.test(id))
      throw new ToolError("REFUSED", `sketch writes only touch ids 'sketch-<slug>'; refused '${id}'`);
  }

  /**
   * Does the Worker have the sketch routes (GET|PUT /api/map/:id/ops, DELETE /api/map/:id)? One
   * read-only GET of /api/map/shared/ops: a Worker with them answers 200 or its own 404
   * {error, id}; one without them answers the generic 404 {error:'not_found'} (no id). Only a
   * positive answer is cached.
   */
  async sketchRoutesAvailable(): Promise<boolean> {
    if (this.#sketchRoutes) return true;
    const res = await this.get(`/api/map/${MAP_ID}/ops`);
    const text = await res.text();
    let ok = res.ok;
    if (res.status === 404) {
      try {
        ok = typeof (JSON.parse(text) as { id?: unknown }).id === "string";
      } catch {
        ok = false;
      }
    }
    this.#sketchRoutes = ok;
    return ok;
  }

  async #answer(res: Response, what: string): Promise<Record<string, unknown>> {
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    if (res.status === 409)
      throw new ToolError("CONFLICT", `${what}: the Worker answered 409: ${text.slice(0, 300)}`, {
        details: { status: 409, body }
      });
    if (res.status === 404) throw new ToolError("NOT_FOUND", `${what}: 404 ${text.slice(0, 200)}`);
    if (!res.ok)
      throw new ToolError("NETWORK", `${what} returned ${res.status}: ${text.slice(0, 300)}`, { details: { body } });
    return (body && typeof body === "object" ? body : { body }) as Record<string, unknown>;
  }

  /**
   * PUT a sketch blob. `version` is the sketch's own current version (X-Map-Version), null on
   * the first save; the Worker answers 409 (CONFLICT) when the id exists at another version.
   */
  async putSketchBlob(req: {
    mode: Mode;
    id: string;
    body: Buffer;
    version: number | null;
    name: string | null;
  }): Promise<{ id: string; version: number; updated_at: string; updated_by: string }> {
    this.#assertSketchId(req.id);
    this.#assertLive(req.mode);
    if (!(await this.sketchRoutesAvailable()))
      throw new ToolError(
        "REFUSED",
        `the Worker at ${this.origin()} does not have the sketch routes yet (GET|PUT /api/map/:id/ops, DELETE /api/map/:id), so a sketch could be written but not its ops log or deleted again; nothing was written. Deploying cloudflare/worker is Ryan's call.`
      );
    const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8" };
    if (req.version !== null) headers["X-Map-Version"] = String(req.version);
    if (req.name) headers["X-Map-Name"] = encodeURIComponent(req.name);
    const res = await this.#request("PUT", `/api/map/${req.id}`, { headers, body: req.body, timeoutMs: 120_000 });
    return (await this.#answer(res, `PUT /api/map/${req.id}`)) as {
      id: string;
      version: number;
      updated_at: string;
      updated_by: string;
    };
  }

  /** PUT a sketch's ops.json (the Worker keeps no versions of it). */
  async putSketchOps(req: { mode: Mode; id: string; json: unknown }): Promise<Record<string, unknown>> {
    this.#assertSketchId(req.id);
    this.#assertLive(req.mode);
    const body = JSON.stringify(req.json);
    const res = await this.#request("PUT", `/api/map/${req.id}/ops`, {
      headers: { "content-type": "application/json; charset=utf-8" },
      body,
      timeoutMs: 60_000
    });
    return this.#answer(res, `PUT /api/map/${req.id}/ops`);
  }

  /** DELETE a sketch (blob, versions, ops.json, row). Never `shared`. */
  async deleteSketch(req: { mode: Mode; id: string }): Promise<Record<string, unknown>> {
    this.#assertSketchId(req.id);
    this.#assertLive(req.mode);
    const res = await this.#request("DELETE", `/api/map/${req.id}`, { timeoutMs: 60_000 });
    return this.#answer(res, `DELETE /api/map/${req.id}`);
  }

  /** POST restore?v=N. The Worker has no version guard here; the token's liveVersion is the only one. */
  async restore(req: {
    mode: Mode;
    token: string;
    fields: GateFields;
    version: number;
  }): Promise<{ id: string; version: number; restored_from: number; updated_at: string; updated_by: string }> {
    this.#assertLive(req.mode);
    if (req.fields.kind !== "restore" || req.fields.subject !== `v${req.version}`)
      throw new ToolError("REFUSED", "restore: the target does not match the gate fields");
    this.checkToken(req.token, req.fields, true);
    const res = await this.#request("POST", `/api/map/${MAP_ID}/restore?v=${req.version}`, { timeoutMs: 60_000 });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    if (!res.ok)
      throw new ToolError("NETWORK", `restore returned ${res.status}: ${text.slice(0, 300)}`, { details: { body } });
    return body as { id: string; version: number; restored_from: number; updated_at: string; updated_by: string };
  }
}
