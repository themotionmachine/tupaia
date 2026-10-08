/**
 * fmg-map — Tier-A control plane (Cloudflare Worker).
 *
 * A single Worker serves the built FMG SPA as static assets (ASSETS binding) and
 * carves out an `/api/*` control plane (run_worker_first in wrangler.jsonc) for a
 * single shared, version-historied map. See cloudflare/PRD-tier-a.md.
 *
 * Storage (PRD §6):
 *   R2 `MAPS`:  maps/<id>.map            — current opaque .map blob
 *               maps/<id>/v<n>.map       — immutable snapshot of version n
 *               maps/<id>/ops.json       — optional JSON sidecar (a sketch's ops log)
 *   D1 `DB`:    one `map` row per id     — name, version, updated_at, updated_by, soft lock
 *
 * The blob is opaque bytes — the Worker never parses or rewrites it (NFR-5).
 * Concurrency safety is a version check against D1 (FR-7), not storage-level CAS.
 *
 * No framework dependency on purpose: keeps the fork surface dependency-free.
 */

export interface Env {
  /** R2 bucket holding the .map blobs + version snapshots. */
  MAPS: R2Bucket;
  /** D1 database holding one metadata row per map. */
  DB: D1Database;
  /** Static-assets binding (the built FMG SPA). Absent in unit tests. */
  ASSETS?: Fetcher;
}

interface MapRow {
  id: string;
  name: string;
  version: number;
  updated_at: string;
  updated_by: string;
  editing_by: string | null;
  lock_expires: string | null;
}

/** Keep at least the last N version snapshots in R2 (FR-5). */
const KEEP_VERSIONS = 20;
/** Reject empty or absurdly large bodies (NFR-5). Maps are ~4.3 MB; 64 MB is generous headroom. */
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
/** The ops.json sidecar is small JSON (a sketch's operation log). */
const MAX_OPS_BYTES = 2 * 1024 * 1024;
/** ops.json writes and DELETE are for sketches only (`sketch-<slug>`); never `shared`. */
const SKETCH_PREFIX = "sketch-";
const isSketchId = (id: string) => id.startsWith(SKETCH_PREFIX) && id.length > SKETCH_PREFIX.length;
/** R2 bulk delete takes at most 1000 keys per call. */
const R2_DELETE_BATCH = 1000;
/** Advisory edit-lock TTL (FR-8). */
const LOCK_TTL_MS = 15 * 60 * 1000;
/** Slugs must be filesystem/key-safe. */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const currentKey = (id: string) => `maps/${id}.map`;
const versionKey = (id: string, v: number) => `maps/${id}/v${v}.map`;
const opsKey = (id: string) => `maps/${id}/ops.json`;

/** Identity from Cloudflare Access; falls back when Access is not (yet) enforced. */
const callerEmail = (req: Request) =>
  req.headers.get("Cf-Access-Authenticated-User-Email") || "anonymous";

async function getRow(env: Env, id: string): Promise<MapRow | null> {
  return env.DB.prepare("SELECT * FROM map WHERE id = ?").bind(id).first<MapRow>();
}

/** Metadata as the client/UI consume it (also emitted as response headers on load). */
function metaPayload(row: MapRow) {
  const locked = !!(row.editing_by && row.lock_expires && Date.parse(row.lock_expires) > Date.now());
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    editing_by: locked ? row.editing_by : null,
    lock_expires: locked ? row.lock_expires : null,
  };
}

function metaHeaders(row: MapRow): Record<string, string> {
  return {
    "X-Map-Id": row.id,
    "X-Map-Name": encodeURIComponent(row.name),
    "X-Map-Version": String(row.version),
    "X-Map-Updated-At": row.updated_at,
    "X-Map-Updated-By": row.updated_by,
    // let the browser read these from fetch() on the same origin
    "Access-Control-Expose-Headers":
      "X-Map-Id, X-Map-Name, X-Map-Version, X-Map-Updated-At, X-Map-Updated-By",
  };
}

/** Snapshot the current blob under its version number, then prune to KEEP_VERSIONS. */
async function snapshotAndPrune(env: Env, id: string, version: number): Promise<void> {
  const current = await env.MAPS.get(currentKey(id));
  if (current) {
    const bytes = await current.arrayBuffer();
    await env.MAPS.put(versionKey(id, version), bytes);
  }
  const listed = await env.MAPS.list({ prefix: `maps/${id}/v` });
  const versions = listed.objects
    .map((o) => {
      const m = o.key.match(/\/v(\d+)\.map$/);
      return m ? Number(m[1]) : NaN;
    })
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);
  for (const v of versions.slice(KEEP_VERSIONS)) {
    await env.MAPS.delete(versionKey(id, v));
  }
}

// --- route handlers -------------------------------------------------------

/** GET /api/maps — list maps with metadata (FR-6). */
async function listMaps(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM map ORDER BY updated_at DESC",
  ).all<MapRow>();
  return json((results ?? []).map(metaPayload));
}

/** GET /api/map/:id — stream the current blob (FR-3). */
async function loadMap(env: Env, id: string): Promise<Response> {
  const row = await getRow(env, id);
  if (!row) return json({ error: "not_found", id }, 404);
  const obj = await env.MAPS.get(currentKey(id));
  if (!obj) return json({ error: "blob_missing", id }, 404);
  return new Response(obj.body, {
    headers: { "content-type": "text/plain; charset=utf-8", ...metaHeaders(row) },
  });
}

/** GET /api/map/:id/meta — metadata only (for "last saved by" + lock status). */
async function getMeta(env: Env, id: string): Promise<Response> {
  const row = await getRow(env, id);
  if (!row) return json({ error: "not_found", id }, 404);
  return json(metaPayload(row));
}

/** PUT /api/map/:id — save (FR-4) with stale-write guard (FR-7) + version snapshot (FR-5). */
async function saveMap(req: Request, env: Env, id: string): Promise<Response> {
  const body = await req.arrayBuffer();
  if (body.byteLength === 0) return json({ error: "empty_body" }, 400);
  if (body.byteLength > MAX_BLOB_BYTES) return json({ error: "too_large" }, 413);

  const email = callerEmail(req);
  const overwrite = req.headers.get("X-Map-Overwrite") === "true";
  const clientVersionHdr = req.headers.get("X-Map-Version");
  const name = req.headers.get("X-Map-Name")
    ? decodeURIComponent(req.headers.get("X-Map-Name")!)
    : null;

  const row = await getRow(env, id);

  // Stale-write guard: the client must echo the version it loaded. A mismatch on
  // an existing map is a conflict unless it explicitly chose to overwrite (FR-7).
  if (row && !overwrite) {
    const clientVersion = clientVersionHdr === null ? null : Number(clientVersionHdr);
    if (clientVersion === null || clientVersion !== row.version) {
      return json(
        {
          error: "conflict",
          version: row.version,
          updated_by: row.updated_by,
          updated_at: row.updated_at,
        },
        409,
      );
    }
  }

  const prevVersion = row?.version ?? 0;
  const newVersion = prevVersion + 1;
  const now = new Date().toISOString();

  // Snapshot the prior blob before we overwrite it (history / rollback).
  if (row) await snapshotAndPrune(env, id, prevVersion);

  await env.MAPS.put(currentKey(id), body);

  await env.DB.prepare(
    `INSERT INTO map (id, name, version, updated_at, updated_by, editing_by, lock_expires)
     VALUES (?, ?, ?, ?, ?, NULL, NULL)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, version=excluded.version,
       updated_at=excluded.updated_at, updated_by=excluded.updated_by,
       editing_by=NULL, lock_expires=NULL`,
  )
    .bind(id, name ?? row?.name ?? id, newVersion, now, email)
    .run();

  return json({ id, version: newVersion, updated_at: now, updated_by: email });
}

/** GET /api/map/:id/versions — list retained snapshots (FR-5). */
async function listVersions(env: Env, id: string): Promise<Response> {
  const row = await getRow(env, id);
  if (!row) return json({ error: "not_found", id }, 404);
  const listed = await env.MAPS.list({ prefix: `maps/${id}/v` });
  const snapshots = listed.objects
    .map((o) => {
      const m = o.key.match(/\/v(\d+)\.map$/);
      return m ? { version: Number(m[1]), size: o.size, saved_at: o.uploaded.toISOString() } : null;
    })
    .filter((v): v is { version: number; size: number; saved_at: string } => v !== null)
    .sort((a, b) => b.version - a.version);
  return json({ current: row.version, snapshots });
}

/** POST /api/map/:id/restore?v=<n> — roll back to a snapshot (FR-5). The restore is
 *  itself a new save, so it too is reversible. */
async function restoreVersion(req: Request, env: Env, id: string, v: number): Promise<Response> {
  const row = await getRow(env, id);
  if (!row) return json({ error: "not_found", id }, 404);
  const snap = await env.MAPS.get(versionKey(id, v));
  if (!snap) return json({ error: "version_not_found", id, version: v }, 404);

  const bytes = await snap.arrayBuffer();
  await snapshotAndPrune(env, id, row.version); // preserve the pre-restore state too
  await env.MAPS.put(currentKey(id), bytes);

  const newVersion = row.version + 1;
  const now = new Date().toISOString();
  const email = callerEmail(req);
  await env.DB.prepare(
    "UPDATE map SET version=?, updated_at=?, updated_by=?, editing_by=NULL, lock_expires=NULL WHERE id=?",
  )
    .bind(newVersion, now, `${email} (restored v${v})`, id)
    .run();

  return json({ id, version: newVersion, restored_from: v, updated_at: now, updated_by: email });
}

/** POST /api/map/:id/claim — soft advisory edit lock (FR-8). Never blocks a save. */
async function claimLock(req: Request, env: Env, id: string): Promise<Response> {
  const row = await getRow(env, id);
  if (!row) return json({ error: "not_found", id }, 404);
  const email = callerEmail(req);
  const expires = new Date(Date.now() + LOCK_TTL_MS).toISOString();
  await env.DB.prepare("UPDATE map SET editing_by=?, lock_expires=? WHERE id=?")
    .bind(email, expires, id)
    .run();
  return json(metaPayload({ ...row, editing_by: email, lock_expires: expires }));
}

/** POST /api/map/:id/release — drop the advisory lock (FR-8). */
async function releaseLock(env: Env, id: string): Promise<Response> {
  const row = await getRow(env, id);
  if (!row) return json({ error: "not_found", id }, 404);
  await env.DB.prepare("UPDATE map SET editing_by=NULL, lock_expires=NULL WHERE id=?")
    .bind(id)
    .run();
  return json(metaPayload({ ...row, editing_by: null, lock_expires: null }));
}

/** GET /api/map/:id/ops — the map's ops.json sidecar (a sketch's operation log). */
async function getOps(env: Env, id: string): Promise<Response> {
  const row = await getRow(env, id);
  if (!row) return json({ error: "not_found", id }, 404);
  const obj = await env.MAPS.get(opsKey(id));
  if (!obj) return json({ error: "not_found", id }, 404);
  return new Response(obj.body, { headers: { "content-type": "application/json; charset=utf-8" } });
}

/** PUT /api/map/:id/ops — replace the ops.json sidecar. Sketch ids only (403 otherwise, so no
 *  new write path to `shared`). JSON object, ≤ 2 MB, no version guard; the map itself must exist
 *  (PUT the blob first). */
async function putOps(req: Request, env: Env, id: string): Promise<Response> {
  if (!isSketchId(id)) return json({ error: "forbidden", id }, 403);
  const body = await req.arrayBuffer();
  if (body.byteLength === 0) return json({ error: "empty_body" }, 400);
  if (body.byteLength > MAX_OPS_BYTES) return json({ error: "too_large" }, 413);
  const row = await getRow(env, id);
  if (!row) return json({ error: "not_found", id }, 404);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({ error: "bad_json" }, 400);
  await env.MAPS.put(opsKey(id), body, { httpMetadata: { contentType: "application/json" } });
  return json({ id, bytes: body.byteLength, updated_at: new Date().toISOString() });
}

/** DELETE /api/map/:id — remove a sketch: its blob, every version snapshot, ops.json and the D1
 *  row. Sketch ids only: `shared` and every other map are refused (403), since a delete drops
 *  the version history a PUT keeps. */
async function deleteMap(env: Env, id: string): Promise<Response> {
  if (!isSketchId(id)) return json({ error: "forbidden", id }, 403);
  const row = await getRow(env, id);
  if (!row) return json({ error: "not_found", id }, 404);
  const keys = [currentKey(id)];
  let cursor: string | undefined;
  do {
    const listed = await env.MAPS.list({ prefix: `maps/${id}/`, cursor });
    keys.push(...listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  for (let k = 0; k < keys.length; k += R2_DELETE_BATCH) await env.MAPS.delete(keys.slice(k, k + R2_DELETE_BATCH));
  await env.DB.prepare("DELETE FROM map WHERE id = ?").bind(id).run();
  return json({ id, deleted: true, objects: keys.length });
}

// --- entry ----------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // Only /api/* reaches the Worker (run_worker_first). Anything else → assets.
    if (!pathname.startsWith("/api/")) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
    }

    const method = request.method.toUpperCase();
    try {
      if (pathname === "/api/maps" && method === "GET") return await listMaps(env);

      const m = pathname.match(/^\/api\/map\/([^/]+)(\/(meta|versions|restore|claim|release|ops))?$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (!ID_RE.test(id)) return json({ error: "bad_id", id }, 400);
        const sub = m[3];

        if (!sub && method === "GET") return await loadMap(env, id);
        if (!sub && method === "PUT") return await saveMap(request, env, id);
        if (!sub && method === "DELETE") return await deleteMap(env, id);
        if (sub === "ops" && method === "GET") return await getOps(env, id);
        if (sub === "ops" && method === "PUT") return await putOps(request, env, id);
        if (sub === "meta" && method === "GET") return await getMeta(env, id);
        if (sub === "versions" && method === "GET") return await listVersions(env, id);
        if (sub === "restore" && method === "POST") {
          const v = Number(url.searchParams.get("v"));
          if (!Number.isInteger(v) || v < 1) return json({ error: "bad_version" }, 400);
          return await restoreVersion(request, env, id, v);
        }
        if (sub === "claim" && method === "POST") return await claimLock(request, env, id);
        if (sub === "release" && method === "POST") return await releaseLock(env, id);
      }

      return json({ error: "not_found" }, 404);
    } catch (err) {
      return json({ error: "internal", detail: (err as Error).message }, 500);
    }
  },
};
