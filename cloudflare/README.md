# Tupaia on Cloudflare (Worker `fmg-map`)

Tupaia is the project name; the Cloudflare resources still carry their original
`fmg-*` names (Worker `fmg-map`, R2 `fmg-maps`, D1 `fmg-meta`). A single Worker serves the built FMG SPA and a small `/api/*` control plane for one
shared, version-historied map. Full design: [`PRD-tier-a.md`](./PRD-tier-a.md).

```
browser ─ https://map.activationlayer.org ─▶ fmg-map Worker
   run_worker_first: /api/*
   ├─ static assets (../dist)          FMG SPA + SPA fallback
   ├─ GET  /api/maps                   list maps + metadata
   ├─ GET  /api/map/:id                load current blob   (R2)
   ├─ PUT  /api/map/:id                save + snapshot      (R2 + D1, 409 on stale)
   ├─ GET  /api/map/:id/meta           "last saved by" + lock status
   ├─ GET  /api/map/:id/versions       retained snapshots (≤20)
   ├─ POST /api/map/:id/restore?v=n    roll back to a version
   └─ POST /api/map/:id/{claim,release} soft advisory edit lock
```

Storage: blobs in **R2** (`maps/<id>.map`, `maps/<id>/v<n>.map`); one metadata row
per map in **D1**. The blob is opaque — the Worker never parses it.

## Layout

| Path | What |
|---|---|
| `cloudflare/wrangler.jsonc` | Committed config (source of truth). Deploy with `-c`. |
| `cloudflare/worker/src/index.ts` | The Worker (no framework deps). |
| `cloudflare/worker/schema.sql` | D1 schema. |
| `cloudflare/deploy.sh` | Build (`CF_BUILD=1`) + `wrangler deploy`. |
| `src/io/cloud-cloudflare.ts` | Client provider + shared-map save/load/history UX. |

Client fork surface is just that one file, two buttons in `src/index.html`
(Save/Load menus), one `lazy-loaders.ts` entry, and the `base` flag in
`vite.config.ts` — keeps upstream rebases cheap (NFR-3).

## Local smoke test (no Cloudflare account needed)

`wrangler dev --local` runs the Worker against an in-memory R2 + D1 (miniflare):

```bash
CF_BUILD=1 npm run build                                   # produces dist/
npx wrangler d1 execute fmg-meta --local \
  --file=cloudflare/worker/schema.sql -c cloudflare/wrangler.jsonc
npx wrangler dev -c cloudflare/wrangler.jsonc --local      # serves on :8787

# round-trip the demo map:
curl -X PUT  --data-binary @tests/fixtures/demo.map http://localhost:8787/api/map/shared
curl -s http://localhost:8787/api/map/shared -o /tmp/out.map -D - | grep -i x-map   # headers
curl -s http://localhost:8787/api/maps                                              # list
```

To point a `vite dev` SPA at the local Worker, set `window.FMG_API_BASE =
"http://localhost:8787"` in the console (prod is same-origin, so no override).

## One-time provisioning (remote)

The env `CLOUDFLARE_API_TOKEN` can `wrangler deploy` and `wrangler secret put`, but
**cannot create D1/R2** — create those via the Cloudflare MCP, then commit the ids.

1. **R2 bucket** `fmg-maps` — MCP `r2_bucket_create` (or `wrangler r2 bucket create fmg-maps`).
2. **D1 database** `fmg-meta` — MCP `d1_database_create`; paste the returned
   `database_id` into `cloudflare/wrangler.jsonc`.
3. **Schema** — `npx wrangler d1 execute fmg-meta --remote --file=cloudflare/worker/schema.sql -c cloudflare/wrangler.jsonc`
4. **Deploy** — `./cloudflare/deploy.sh` (builds + `wrangler deploy`). The
   `custom_domain` route attaches `map.activationlayer.org` under the existing zone.

## Access gating (deferred — "no password initially")

Per the current decision the app ships **without** the Cloudflare Access gate; the
Worker reads `Cf-Access-Authenticated-User-Email` when present and falls back to
`anonymous`. To turn the gate on later (PRD FR-9), add a Zero-Trust self-hosted
application over `map.activationlayer.org` with a policy allowing the 4 emails
(one-time-PIN or SSO). No Worker change is needed — `updated_by` starts attributing
real emails automatically once Access injects the header.
