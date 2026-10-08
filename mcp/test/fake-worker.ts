// In-process fake of the shared-map Worker (cloudflare/worker/src/index.ts) for tests.
// Same routes and semantics, for any map id: GET /api/maps, meta, versions, GET/PUT map with the
// X-Map-Version stale guard (409 {error:'conflict', version, updated_by, updated_at}), restore?v=N,
// claim/release, GET/PUT /api/map/:id/ops (JSON, 2 MB, 404 when absent) and DELETE /api/map/:id
// (403 for 'shared'; removes the blob, the versions, ops.json and the row). Also serves
// /versioning.js (configurable VERSION) and / (an index.html with an entry chunk) for the build
// check, or, with `assetsDir`, the built app itself (like the real Worker's ASSETS binding), so a
// browser can boot it same-origin. Records every request with its headers. Binds 127.0.0.1 only.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

export interface FakeRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  bytes: number;
  status: number;
}

interface Row {
  id: string;
  name: string;
  version: number;
  updated_at: string;
  updated_by: string;
  editing_by: string | null;
  lock_expires: string | null;
}

interface MapEntry {
  row: Row;
  current: Buffer;
  retained: Map<number, { bytes: Buffer; saved_at: string }>;
  ops: Buffer | null;
}

export interface FakeWorkerOptions {
  /** .map file to seed the 'shared' map with. */
  seedFile: string;
  /** Current version (older versions 1..version-1 are retained as copies of the seed). */
  version?: number;
  name?: string;
  updatedBy?: string;
  /** VERSION served in /versioning.js. */
  appVersion?: string;
  /** index-*.js entry served in /. */
  entry?: string;
  /** Serve this built app (dist/) for every non-/api path, like the Worker's ASSETS binding. */
  assetsDir?: string;
}

const KEEP_VERSIONS = 20;
const MAX_OPS_BYTES = 2 * 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json"
};

export class FakeWorker {
  readonly requests: FakeRequest[] = [];
  readonly maps = new Map<string, MapEntry>();
  appVersion: string;
  entry: string;
  readonly assetsDir: string | null;
  /** false = behave like the Worker before the sketch routes (ops and DELETE answer the generic 404). */
  sketchRoutes = true;
  /** When set, /versioning.js answers with this status (build check cannot compare). */
  versioningStatus: number | null = null;
  #fail409 = 0;
  #server: http.Server | null = null;
  origin = "";

  constructor(opts: FakeWorkerOptions) {
    const seed = fs.readFileSync(opts.seedFile);
    const v = opts.version ?? 1;
    const now = new Date().toISOString();
    const shared: MapEntry = {
      row: {
        id: "shared",
        name: opts.name ?? "Chanland",
        version: v,
        updated_at: now,
        updated_by: opts.updatedBy ?? "seed@example.test",
        editing_by: null,
        lock_expires: null
      },
      current: seed,
      retained: new Map(),
      ops: null
    };
    for (let k = 1; k < v; k++) shared.retained.set(k, { bytes: Buffer.from(seed), saved_at: now });
    this.maps.set("shared", shared);
    this.appVersion = opts.appVersion ?? "1.130.1";
    this.entry = opts.entry ?? "index-FAKE.js";
    this.assetsDir = opts.assetsDir ? path.resolve(opts.assetsDir) : null;
  }

  // The 'shared' map, as the older tests address it.
  get #shared(): MapEntry {
    return this.maps.get("shared") as MapEntry;
  }
  get row(): Row {
    return this.#shared.row;
  }
  set row(r: Row) {
    this.#shared.row = r;
  }
  get current(): Buffer {
    return this.#shared.current;
  }
  set current(b: Buffer) {
    this.#shared.current = b;
  }
  get retained(): Map<number, { bytes: Buffer; saved_at: string }> {
    return this.#shared.retained;
  }

  async start(): Promise<string> {
    this.#server = http.createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>(r => this.#server?.listen(0, "127.0.0.1", () => r()));
    const { port } = this.#server.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${port}`;
    return this.origin;
  }

  async stop(): Promise<void> {
    const s = this.#server;
    this.#server = null;
    if (s) {
      s.closeAllConnections();
      await new Promise<void>(r => s.close(() => r()));
    }
  }

  // ------------------------------------------------------------------ test controls

  /** Answer the next n PUTs with 409 regardless of the version header. */
  fail409Once(n = 1): void {
    this.#fail409 = n;
  }

  /** Someone else saves 'shared': bumps the version like a real PUT would (snapshotting the old blob). */
  externalSave(by = "someone@example.test", bytes?: Buffer): number {
    const e = this.#shared;
    this.#snapshot(e, e.row.version);
    if (bytes) e.current = bytes;
    e.row = {
      ...e.row,
      version: e.row.version + 1,
      updated_at: new Date().toISOString(),
      updated_by: by,
      editing_by: null,
      lock_expires: null
    };
    return e.row.version;
  }

  setLock(by: string | null, ms = 15 * 60 * 1000): void {
    this.row.editing_by = by;
    this.row.lock_expires = by ? new Date(Date.now() + ms).toISOString() : null;
  }

  clearLog(): void {
    this.requests.length = 0;
  }

  /** Requests other than the read-only GETs. */
  writes(): FakeRequest[] {
    return this.requests.filter(r => r.method !== "GET" && r.method !== "HEAD");
  }

  // ------------------------------------------------------------------ worker semantics

  #meta(r: Row) {
    const locked = !!(r.editing_by && r.lock_expires && Date.parse(r.lock_expires) > Date.now());
    return {
      id: r.id,
      name: r.name,
      version: r.version,
      updated_at: r.updated_at,
      updated_by: r.updated_by,
      editing_by: locked ? r.editing_by : null,
      lock_expires: locked ? r.lock_expires : null
    };
  }

  #snapshot(e: MapEntry, version: number): void {
    e.retained.set(version, { bytes: Buffer.from(e.current), saved_at: new Date().toISOString() });
    const vs = [...e.retained.keys()].sort((a, b) => b - a);
    for (const v of vs.slice(KEEP_VERSIONS)) e.retained.delete(v);
  }

  #asset(pathname: string): { body: Buffer; type: string } | null {
    if (!this.assetsDir) return null;
    const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
    const file = path.resolve(this.assetsDir, rel);
    if (!file.startsWith(this.assetsDir + path.sep)) return null;
    try {
      if (!fs.statSync(file).isFile()) return null;
      return {
        body: fs.readFileSync(file),
        type: TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream"
      };
    } catch {
      return null;
    }
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://fake");
    const method = (req.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers))
      headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : String(v);
    const entry: FakeRequest = { method, path: url.pathname + url.search, headers, bytes: body.length, status: 0 };
    this.requests.push(entry);
    const send = (status: number, data: unknown, extra: Record<string, string> = {}) => {
      entry.status = status;
      const isBuf = Buffer.isBuffer(data);
      const isText = typeof data === "string";
      res.writeHead(status, {
        "content-type":
          isBuf || isText ? (extra["content-type"] ?? "text/plain; charset=utf-8") : "application/json; charset=utf-8",
        ...extra
      });
      res.end(isBuf || isText ? data : JSON.stringify(data));
    };
    const p = url.pathname;
    const caller = headers["cf-access-authenticated-user-email"] || "anonymous";

    if (!p.startsWith("/api/")) {
      if (this.assetsDir) {
        const a = this.#asset(p);
        return a ? send(200, a.body, { "content-type": a.type }) : send(404, "Not found");
      }
      if (p === "/versioning.js" && method === "GET") {
        if (this.versioningStatus) return send(this.versioningStatus, "unavailable");
        return send(200, `"use strict";\nconst VERSION = "${this.appVersion}";\n`, {
          "content-type": "text/javascript"
        });
      }
      if (p === "/" && method === "GET") {
        return send(
          200,
          `<!doctype html><html><head><script type="module" src="/${this.entry}"></script></head></html>`,
          { "content-type": "text/html" }
        );
      }
      return send(404, "Not found");
    }

    if (p === "/api/maps" && method === "GET") {
      const rows = [...this.maps.values()].map(e => e.row).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return send(
        200,
        rows.map(r => this.#meta(r))
      );
    }
    const m = p.match(/^\/api\/map\/([^/]+)(\/(meta|versions|restore|claim|release|ops))?$/);
    if (!m) return send(404, { error: "not_found" });
    if (!this.sketchRoutes && (m[3] === "ops" || (!m[3] && method === "DELETE")))
      return send(404, { error: "not_found" });
    const id = decodeURIComponent(m[1]);
    if (!ID_RE.test(id)) return send(400, { error: "bad_id", id });
    const sub = m[3];
    const e = this.maps.get(id);

    if (!sub && method === "PUT") {
      if (body.length === 0) return send(400, { error: "empty_body" });
      const overwrite = headers["x-map-overwrite"] === "true";
      const hdr = headers["x-map-version"];
      const clientVersion = hdr === undefined ? null : Number(hdr);
      if (this.#fail409 > 0 || (e && !overwrite && (clientVersion === null || clientVersion !== e.row.version))) {
        if (this.#fail409 > 0) this.#fail409--;
        const r = e?.row;
        return send(409, {
          error: "conflict",
          version: r?.version,
          updated_by: r?.updated_by,
          updated_at: r?.updated_at
        });
      }
      const now = new Date().toISOString();
      const name = headers["x-map-name"] ? decodeURIComponent(headers["x-map-name"]) : (e?.row.name ?? id);
      if (e) this.#snapshot(e, e.row.version);
      const prev = e?.row.version ?? 0;
      const row: Row = {
        id,
        name,
        version: prev + 1,
        updated_at: now,
        updated_by: caller,
        editing_by: null,
        lock_expires: null
      };
      if (e) {
        e.row = row;
        e.current = body;
      } else this.maps.set(id, { row, current: body, retained: new Map(), ops: null });
      return send(200, { id, version: row.version, updated_at: now, updated_by: caller });
    }
    if (!e) return send(404, { error: "not_found", id });
    const r = e.row;

    if (!sub && method === "GET") {
      return send(200, e.current, {
        "X-Map-Id": r.id,
        "X-Map-Name": encodeURIComponent(r.name),
        "X-Map-Version": String(r.version),
        "X-Map-Updated-At": r.updated_at,
        "X-Map-Updated-By": r.updated_by
      });
    }
    if (!sub && method === "DELETE") {
      if (id === "shared") return send(403, { error: "forbidden", id });
      const objects = 1 + e.retained.size + (e.ops ? 1 : 0);
      this.maps.delete(id);
      return send(200, { id, deleted: true, objects });
    }
    if (sub === "meta" && method === "GET") return send(200, this.#meta(r));
    if (sub === "versions" && method === "GET") {
      const snapshots = [...e.retained.entries()]
        .map(([version, s]) => ({ version, size: s.bytes.length, saved_at: s.saved_at }))
        .sort((a, b) => b.version - a.version);
      return send(200, { current: r.version, snapshots });
    }
    if (sub === "ops" && method === "GET") {
      if (!e.ops) return send(404, { error: "not_found", id });
      return send(200, e.ops.toString("utf8"), { "content-type": "application/json; charset=utf-8" });
    }
    if (sub === "ops" && method === "PUT") {
      if (body.length === 0) return send(400, { error: "empty_body" });
      if (body.length > MAX_OPS_BYTES) return send(413, { error: "too_large" });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        return send(400, { error: "bad_json" });
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return send(400, { error: "bad_json" });
      e.ops = Buffer.from(body);
      return send(200, { id, bytes: body.length, updated_at: new Date().toISOString() });
    }
    if (sub === "restore" && method === "POST") {
      const v = Number(url.searchParams.get("v"));
      if (!Number.isInteger(v) || v < 1) return send(400, { error: "bad_version" });
      const snap = e.retained.get(v);
      if (!snap) return send(404, { error: "version_not_found", id: r.id, version: v });
      this.#snapshot(e, r.version);
      e.current = Buffer.from(snap.bytes);
      const now = new Date().toISOString();
      e.row = {
        ...r,
        version: r.version + 1,
        updated_at: now,
        updated_by: `${caller} (restored v${v})`,
        editing_by: null,
        lock_expires: null
      };
      return send(200, { id: r.id, version: e.row.version, restored_from: v, updated_at: now, updated_by: caller });
    }
    if (sub === "claim" && method === "POST") {
      r.editing_by = caller;
      r.lock_expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      return send(200, this.#meta(r));
    }
    if (sub === "release" && method === "POST") {
      r.editing_by = null;
      r.lock_expires = null;
      return send(200, this.#meta(r));
    }
    return send(404, { error: "not_found" });
  }
}
