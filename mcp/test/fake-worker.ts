// In-process fake of the shared-map Worker (cloudflare/worker/src/index.ts) for tests.
// Same routes and semantics: meta, versions, GET/PUT map with the X-Map-Version stale guard
// (409 {error:'conflict', version, updated_by, updated_at}), restore?v=N, claim/release.
// Also serves /versioning.js (configurable VERSION) and / (an index.html with an entry chunk)
// for the build check. Records every request with its headers. Binds 127.0.0.1 only.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

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

export interface FakeWorkerOptions {
  /** .map file to seed with. */
  seedFile: string;
  /** Current version (older versions 1..version-1 are retained as copies of the seed). */
  version?: number;
  name?: string;
  updatedBy?: string;
  /** VERSION served in /versioning.js. */
  appVersion?: string;
  /** index-*.js entry served in /. */
  entry?: string;
}

const KEEP_VERSIONS = 20;

export class FakeWorker {
  readonly requests: FakeRequest[] = [];
  row: Row;
  current: Buffer;
  readonly retained = new Map<number, { bytes: Buffer; saved_at: string }>();
  appVersion: string;
  entry: string;
  #fail409 = 0;
  #server: http.Server | null = null;
  origin = "";

  constructor(opts: FakeWorkerOptions) {
    const seed = fs.readFileSync(opts.seedFile);
    const v = opts.version ?? 1;
    const now = new Date().toISOString();
    this.row = {
      id: "shared",
      name: opts.name ?? "Chanland",
      version: v,
      updated_at: now,
      updated_by: opts.updatedBy ?? "seed@example.test",
      editing_by: null,
      lock_expires: null
    };
    this.current = seed;
    for (let k = 1; k < v; k++) this.retained.set(k, { bytes: Buffer.from(seed), saved_at: now });
    this.appVersion = opts.appVersion ?? "1.130.1";
    this.entry = opts.entry ?? "index-FAKE.js";
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

  /** Someone else saves: bumps the version like a real PUT would (snapshotting the old blob). */
  externalSave(by = "someone@example.test", bytes?: Buffer): number {
    this.#snapshot(this.row.version);
    if (bytes) this.current = bytes;
    this.row = {
      ...this.row,
      version: this.row.version + 1,
      updated_at: new Date().toISOString(),
      updated_by: by,
      editing_by: null,
      lock_expires: null
    };
    return this.row.version;
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

  #meta() {
    const r = this.row;
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

  #snapshot(version: number): void {
    this.retained.set(version, { bytes: Buffer.from(this.current), saved_at: new Date().toISOString() });
    const vs = [...this.retained.keys()].sort((a, b) => b - a);
    for (const v of vs.slice(KEEP_VERSIONS)) this.retained.delete(v);
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

    if (p === "/versioning.js" && method === "GET") {
      return send(200, `"use strict";\nconst VERSION = "${this.appVersion}";\n`, { "content-type": "text/javascript" });
    }
    if (p === "/" && method === "GET") {
      return send(
        200,
        `<!doctype html><html><head><script type="module" src="/${this.entry}"></script></head></html>`,
        {
          "content-type": "text/html"
        }
      );
    }
    const m = p.match(/^\/api\/map\/([^/]+)(\/(meta|versions|restore|claim|release))?$/);
    if (!m || decodeURIComponent(m[1]) !== "shared") return send(404, { error: "not_found" });
    const sub = m[3];
    const r = this.row;

    if (!sub && method === "GET") {
      return send(200, this.current, {
        "X-Map-Id": r.id,
        "X-Map-Name": encodeURIComponent(r.name),
        "X-Map-Version": String(r.version),
        "X-Map-Updated-At": r.updated_at,
        "X-Map-Updated-By": r.updated_by
      });
    }
    if (sub === "meta" && method === "GET") return send(200, this.#meta());
    if (sub === "versions" && method === "GET") {
      const snapshots = [...this.retained.entries()]
        .map(([version, s]) => ({ version, size: s.bytes.length, saved_at: s.saved_at }))
        .sort((a, b) => b.version - a.version);
      return send(200, { current: r.version, snapshots });
    }
    if (!sub && method === "PUT") {
      if (body.length === 0) return send(400, { error: "empty_body" });
      const overwrite = headers["x-map-overwrite"] === "true";
      const hdr = headers["x-map-version"];
      const clientVersion = hdr === undefined ? null : Number(hdr);
      if (this.#fail409 > 0 || (!overwrite && (clientVersion === null || clientVersion !== r.version))) {
        if (this.#fail409 > 0) this.#fail409--;
        return send(409, { error: "conflict", version: r.version, updated_by: r.updated_by, updated_at: r.updated_at });
      }
      this.#snapshot(r.version);
      this.current = body;
      const now = new Date().toISOString();
      const name = headers["x-map-name"] ? decodeURIComponent(headers["x-map-name"]) : r.name;
      this.row = {
        ...r,
        name,
        version: r.version + 1,
        updated_at: now,
        updated_by: caller,
        editing_by: null,
        lock_expires: null
      };
      return send(200, { id: r.id, version: this.row.version, updated_at: now, updated_by: caller });
    }
    if (sub === "restore" && method === "POST") {
      const v = Number(url.searchParams.get("v"));
      if (!Number.isInteger(v) || v < 1) return send(400, { error: "bad_version" });
      const snap = this.retained.get(v);
      if (!snap) return send(404, { error: "version_not_found", id: r.id, version: v });
      this.#snapshot(r.version);
      this.current = Buffer.from(snap.bytes);
      const now = new Date().toISOString();
      this.row = {
        ...r,
        version: r.version + 1,
        updated_at: now,
        updated_by: `${caller} (restored v${v})`,
        editing_by: null,
        lock_expires: null
      };
      return send(200, { id: r.id, version: this.row.version, restored_from: v, updated_at: now, updated_by: caller });
    }
    if (sub === "claim" && method === "POST") {
      this.setLock(caller);
      return send(200, this.#meta());
    }
    if (sub === "release" && method === "POST") {
      this.setLock(null);
      return send(200, this.#meta());
    }
    return send(404, { error: "not_found" });
  }
}
