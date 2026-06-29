# PRD — Collaborative Fantasy Map on Cloudflare (Tier A)

**Status:** Draft · **Owner:** Ryan Williams · **Last updated:** 2026-06-29
**Scope:** Tier A only (async shared state). Tier B (presence + single-writer
lock) and Tier C (real-time co-edit) are explicitly **out of scope** here — see
[§12](#12-out-of-scope--future-tiers).

---

## 1. Context & vision

We are self-hosting a fork of [Azgaar's Fantasy Map
Generator](https://github.com/Azgaar/Fantasy-Map-Generator) (FMG) so that **Ryan
+ 3 collaborators (4 total)** can work on **one shared map**, hosted on Ryan's
existing Cloudflare account, keyed to a saved map state that lives in the cloud
rather than on any one person's laptop.

FMG is a static, client-side SPA with **no server**. It is **MIT-licensed** with
an explicit grant to produce derivative works and host them — so forking and
self-hosting a modified build is unambiguously permitted (the only obligation is
to preserve the copyright/permission notice).

This maps cleanly onto the architecture pattern Ryan already runs for
`adjacency-matrix` and `activation-layer`: a single Worker serving a built SPA as
**static assets**, with `run_worker_first` carving out an `/api/*` control plane,
durable state in **R2 + D1**, a **committed `wrangler.jsonc`** as the source of
truth (no dashboard-only config — the "anna trap"), and a **custom-domain** route
under the `activationlayer.org` zone.

## 2. Goal & non-goals

**Goal.** A private web app at **`map.activationlayer.org`** where the 4 users
log in (gated to their emails), open the shared map, edit it with FMG's full
toolset, and save back to a single cloud-stored map state — with enough
guardrails that a careless save doesn't silently destroy someone else's work.

**Non-goals (Tier A).**
- **Not** real-time collaborative editing (simultaneous cursors / live co-edit).
  FMG's state model makes this impractical — see
  [§12](#12-out-of-scope--future-tiers).
- **Not** a hard edit lock or live presence (that's Tier B).
- **Not** public/multi-tenant. One small trusted group, one (or a few) maps.
- **Not** an upstream contribution. Our changes stay in an **isolated fork
  surface** so rebasing on Azgaar's releases stays cheap.

## 3. Users

Four named people, identified by email, all trusted, mostly editing at
**different times** (the async assumption that makes Tier A adequate). No roles or
permissions beyond "is one of the 4." No anonymous access.

## 4. The decided architecture (Tier A)

A single new Worker, `fmg-map`, cloned from the `adjacency-matrix` wrangler
pattern:

```
                       Cloudflare Access (Zero Trust)
                       policy: allow 4 specific emails  ─────┐
                                                             ▼
 browser ── https://map.activationlayer.org ───────▶  fmg-map Worker
                                                             │
         run_worker_first: ["/api/*"]                        │
         ┌──────────────────────────┬──────────────┬─────────┴──────────┐
         ▼                          ▼              ▼                     ▼
   static assets (dist/)     GET /api/maps   GET /api/map/:id    PUT /api/map/:id
   FMG SPA, SPA fallback     (list+meta)     (load blob)         (save blob)
                                   │              │                     │
                                   ▼              ▼                     ▼
                              D1: fmg-meta   R2: fmg-maps         R2 + D1
                              (index rows)   maps/<id>.map        write blob +
                                             + maps/<id>/v<n>.map upsert meta row
```

**Read path.** A user loads `map.activationlayer.org`, passes Access (SSO/OTP to
their email), and gets the FMG SPA. On boot the app loads the shared map via the
existing `?maplink=` seam pointed at `GET /api/map/<id>`; the Worker streams the
`.map` blob from R2 and FMG's `uploadMap()` rehydrates the `grid`/`pack` world
state.

**Write path.** A new **Cloudflare cloud provider** in the fork (mirroring the
existing Dropbox provider) calls `PUT /api/map/<id>` with the serialized blob from
`prepareMapData()`. The Worker writes the blob to R2 (`maps/<id>.map`), snapshots
the prior version (`maps/<id>/v<n>.map`), and upserts a metadata row in D1
(`updated_at`, `updated_by`, incremented `version`). The authenticated email comes
from the `Cf-Access-Authenticated-User-Email` request header.

## 5. `wrangler.jsonc` bindings (committed — the source of truth)

```jsonc
{
  "name": "fmg-map",
  "compatibility_date": "2026-06-01",
  "main": "cloudflare/worker/src/index.ts",
  "assets": {
    "directory": "./dist",                    // FMG `npm run build` output
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "r2_buckets": [
    { "binding": "MAPS", "bucket_name": "fmg-maps" }
  ],
  "d1_databases": [
    { "binding": "DB", "database_name": "fmg-meta", "database_id": "<created-via-API>" }
  ],
  "routes": [{ "pattern": "map.activationlayer.org", "custom_domain": true }],
  "observability": { "enabled": true }
}
```

Created via the Cloudflare API (per Ryan's MCP-create habit), never the dashboard.
Access is configured as a separate Zero Trust application over the same hostname.

## 6. Data model

**R2 bucket `fmg-maps`:**
| Key | Contents |
|---|---|
| `maps/<id>.map` | Current map blob (the `prepareMapData()` output, ~4.3 MB / ~1 MB gzipped). |
| `maps/<id>/v<n>.map` | Immutable snapshot of version `n` — version history / rollback. |

**D1 `fmg-meta` — one row per map:**
```sql
CREATE TABLE IF NOT EXISTS map (
  id          TEXT PRIMARY KEY,           -- short slug, e.g. "shared"
  name        TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 0, -- monotonically incremented per save
  updated_at  TEXT NOT NULL,              -- ISO timestamp
  updated_by  TEXT NOT NULL,              -- Cf-Access-Authenticated-User-Email
  -- soft advisory lock (Tier A guardrail, honored by convention, not enforced):
  editing_by    TEXT,
  lock_expires  TEXT
);
```
Blobs live in R2, **never** in D1 (keep the multi-MB blob out of the relational
store).

## 7. Functional requirements

- **FR-1 — Host FMG.** The FMG SPA builds (`npm run build` → `dist/`) and is
  served as static assets by the `fmg-map` Worker, with SPA fallback. Generating a
  brand-new map in-browser works unchanged from upstream.
- **FR-2 — Custom domain.** The app is reachable at `map.activationlayer.org`
  (custom-domain route, committed in `wrangler.jsonc`).
- **FR-3 — Load shared map.** On boot (or via a "Load shared map" action), the app
  fetches the cloud map via `GET /api/map/:id` and rehydrates it through FMG's
  existing `loadMapFromURL`/`uploadMap` path.
- **FR-4 — Save shared map.** A "Save to shared map" action serializes via
  `prepareMapData()` and `PUT`s the blob to `/api/map/:id`. The Worker persists it
  to R2 and updates D1 metadata.
- **FR-5 — Version history.** Every save snapshots the prior blob to
  `maps/<id>/v<n>.map`; the Worker retains at least the last **N = 20** versions
  and exposes them for listing/rollback via `GET /api/map/:id/versions` and
  `POST /api/map/:id/restore?v=<n>`.
- **FR-6 — Metadata / "last saved by."** `GET /api/maps` returns the map list with
  `name`, `version`, `updated_at`, `updated_by`. On load, the UI shows
  *"Shared map · v{N} · last saved by {email} at {time}"*.
- **FR-7 — Stale-write guard.** The client sends the `version` it loaded with its
  `PUT`. If it is **not** the current version, the Worker returns **409 Conflict**
  with the current `version`/`updated_by`; the client must surface *"This map was
  saved by {email} since you opened it"* and require an explicit **overwrite**
  confirm (or reload) before retrying. **No silent last-writer-wins.**
- **FR-8 — Soft advisory lock (optional within Tier A).** A user may "claim
  editing," writing `editing_by`/`lock_expires` (short TTL, e.g. 15 min) to D1.
  Other clients display *"{email} is editing"* as a courtesy. It is **advisory
  only** — not enforced — and never blocks a save; it just reduces accidental
  collisions.
- **FR-9 — Access gating.** Only the 4 configured emails can reach the app and the
  `/api/*` routes; everyone else is blocked by Cloudflare Access. The Worker reads
  the authenticated email from the Access header for `updated_by`.

## 8. Non-functional requirements

- **NFR-1 — Committed config.** All infra (`wrangler.jsonc`, D1 schema, bucket
  names) lives in the repo. No dashboard-only configuration.
- **NFR-2 — Free-tier fit.** Stays within Cloudflare free limits: R2 (10 GB-month
  storage, egress free), D1 (5 GB, 5M reads/day, 100k writes/day), Workers static
  assets (≤20,000 files / ≤25 MiB each — FMG's `public/` is ~613 files), Access
  (≤50 users; we have 4).
- **NFR-3 — Isolated fork surface.** Cloudflare-specific code lives under
  `cloudflare/` and in **one new** `src/io/cloud-cloudflare.ts` provider plus a
  couple of button bindings. **Do not** make structural edits to the ~831 KB,
  9,000-line `src/index.html` (per FMG's own `CONTEXT.md`) — keep upstream rebases
  clean.
- **NFR-4 — Build base path.** Build with `base: '/'` (root-domain deploy), not
  the upstream default `/Fantasy-Map-Generator/`. See
  [§9](#9-fork-surface-what-we-change) and [§11](#11-risks--open-questions).
- **NFR-5 — Blob integrity.** The Worker treats the `.map` blob as opaque bytes;
  it never parses or rewrites it. Validate only size (reject absurdly large/empty
  bodies).

## 9. Fork surface (what we change)

Keep it minimal and isolated so `git rebase upstream/master` stays cheap:

1. **`vite.config.ts`** — set `base: '/'` for the Cloudflare build (or build with
   `NETLIFY=true`, which upstream already maps to `/`). *(1-line change / build
   flag — the single highest-risk gotcha; see §11.)*
2. **`src/io/cloud-cloudflare.ts`** *(new)* — implement FMG's existing cloud
   provider interface (`auth` / `save(filename, contents)` / `load(path)` /
   `list` / `getLink`) against `/api/map/:id`. Mirror `src/io/cloud.ts`'s Dropbox
   provider; register it alongside.
3. **Minimal UI hooks** — a "Save to shared map" button bound to the provider's
   `save`, and shared-map load on boot via `?maplink=/api/map/<id>` (reusing the
   existing `loadMapFromURL` seam in `src/io/load.ts`). Prefer wiring over new
   markup.
4. **`cloudflare/`** *(new dir)* — `wrangler.jsonc`, the Worker (`worker/src/`),
   D1 schema, this PRD, and a deploy README. Nothing here is touched by upstream.

Everything else in FMG is used as-is.

## 10. Lost-edits handling (the core Tier A risk)

Tier A is last-writer-wins **by storage**, so the design must make conflicts
**visible and consensual**, never silent:

- **On load:** show current `version` + `updated_by` + time (FR-6).
- **On save:** send the loaded `version`; the Worker rejects a stale write with
  **409** (FR-7). The user sees who saved since and must consciously choose
  *overwrite* or *reload-and-redo*.
- **Always recoverable:** every prior version is snapshotted in R2 (FR-5), so even
  an intentional overwrite is reversible via restore.
- **Courtesy signal:** the optional soft lock (FR-8) reduces collisions for a
  group that coordinates out-of-band ("I'm jumping in now").

This is the pre-real-time Google-Docs model and is adequate for 4 known people. If
the friction is felt in practice, the resolution is **Tier B**, not more Tier A
patching.

## 11. Risks & open questions

| Risk | Mitigation |
|---|---|
| **Base-path trap** — wrong Vite `base` 404s every asset on a root-domain deploy. | Build with `base: '/'` (NFR-4); verify in the Phase 0 spike before anything else. |
| **Lost edits** (Tier A's defining limitation). | Stale-write 409 + version history + advisory lock (§10). Escalate to Tier B if it bites. |
| **Fork-maintenance drift** — FMG is actively developed (v1.130, mid JS→TS migration). | Keep the fork surface tiny and isolated (NFR-3); rebase on tagged releases, not `master` tip. |
| **Map blob growth** — bigger maps grow the ~4.3 MB blob. | R2 handles it trivially; keep blobs in R2 only (NFR-5). Revisit if a single blob approaches request-body limits. |
| **No storage-level CAS** — R2 PUT is atomic per object but has no compare-and-swap. | Enforce version check in the Worker against D1 (FR-7), not in storage. |
| **Open Q — one map or many?** | Schema/keys are already multi-map (`:id`). MVP can ship a single `id = "shared"`; multi-map is a small additive step. |
| **Open Q — Access identity provider.** | Decide between one-time-PIN email vs. Google SSO for the 4 emails during Phase 3. |

## 12. Out of scope / future tiers

- **Tier B — presence + single active editor.** One Durable Object per map (`MapRoom`),
  WebSocket Hibernation API: an explicit edit lock ("one pen") + live presence
  ("{email} is editing"), broadcasting "new version, reload" on save-and-release.
  Converts the soft lock into a real one and eliminates silent lost edits.
  **Additive** to this design (a DO binding + the same `/api/map` storage), not a
  rewrite. Estimated +1–2 days. **Recommended fast-follow** if lost-edit friction
  is felt.
- **Tier C — true real-time co-editing.** Collaborative cursors / simultaneous
  edits. **Impractical** for this app: FMG state is a monolithic `grid`+`pack`
  object graph serialized to one ~4.3 MB blob, with no granular edit operations
  and no CRDT/OT layer, and regeneration steps rewrite essentially the whole graph
  and SVG. Real-time co-edit would require building an OT/CRDT model over the
  `pack` graph that survives full regenerations — months of fragile work against a
  globals-heavy, 9,000-line-HTML app. **Do not attempt for this use case.**

## 13. Build & deploy phases

- **Phase 0 — Build & serve spike (½ day).** Set `base: '/'`, `npm run build`,
  deploy `dist/` behind a throwaway Worker on a temp subdomain. Confirm the SPA
  loads and generates a map on Cloudflare static assets. *De-risks NFR-4 / the
  base-path trap before any backend work.*
- **Phase 1 — Persistence backend (½ day).** Create R2 `fmg-maps` + D1 `fmg-meta`
  (via API). Build the Worker: `GET/PUT /api/map/:id`, `GET /api/maps`, versions +
  restore. Commit `cloudflare/wrangler.jsonc` and the D1 schema.
- **Phase 2 — Cloudflare cloud provider (½ day).** Add `src/io/cloud-cloudflare.ts`
  + the save button + boot-load via `?maplink`. The only real fork surface.
- **Phase 3 — Access + custom domain (½ day, mostly DNS/SSO wait).** Add the
  `map.activationlayer.org` route; create the Access self-hosted app + a policy
  for the 4 emails; verify a non-listed email is blocked and the Worker sees the
  authenticated-email header.

**MVP total: ~2 days** for a private, version-historied, 4-person shared map.

## 14. Success criteria

1. The 4 emails (and only those) can reach `map.activationlayer.org` and edit a
   map; a 5th email is blocked.
2. Any of the 4 can open the shared map, make an edit, save, and another sees the
   change on next load — with "last saved by {email} · v{N}".
3. A stale save is rejected with a clear conflict prompt (FR-7), never silently
   overwriting.
4. Any prior version is restorable (FR-5).
5. All infra is reproducible from the committed repo (no dashboard-only config).

## 15. References

**FMG seams (in this fork, v1.130.0):**
- `src/io/save.ts` — `prepareMapData()`, the `.map` blob format.
- `src/io/load.ts` — `loadMapFromURL()`, the `?maplink=` load seam.
- `src/io/cloud.ts` — the cloud-provider interface to mirror (Dropbox today).
- `src/services/autosave.ts` — autosave timer (IndexedDB).
- `vite.config.ts:5` — the `base` trap (`/Fantasy-Map-Generator/` vs `/`).
- `LICENSE` — MIT, explicit derivative/hosting grant.
- `tests/fixtures/demo.map` — ~4.3 MB size reference.

**Pattern to clone:** `Adjacency-Matrix/wrangler.jsonc` (committed assets +
`run_worker_first` + custom_domain + observability; D1 + KV bindings).

**Cloudflare docs:** Workers static-asset limits · R2 pricing · D1 pricing ·
Durable Objects WebSockets (Tier B) · Zero Trust free plan (≤50 users).
