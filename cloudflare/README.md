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
   ├─ POST /api/map/:id/{claim,release} soft advisory edit lock
   ├─ GET  /api/map/:id/ops            a sketch's ops.json  (R2)          [not deployed yet]
   ├─ PUT  /api/map/:id/ops            replace ops.json (sketch-*, ≤ 2 MB) [not deployed yet]
   └─ DELETE /api/map/:id              remove a sketch (403 otherwise)   [not deployed yet]
```

Storage: blobs in **R2** (`maps/<id>.map`, `maps/<id>/v<n>.map`, and for sketches
`maps/<id>/ops.json`); one metadata row per map in **D1**. The blob is opaque — the Worker
never parses it.

### Sketch routes (added for the MCP server's sketches; NOT deployed)

The MCP server (`mcp/`) stores a provisional sketch of the shared map as its own map id,
`sketch-<slug>`, plus an operation log beside it. Two routes were added for that; **they are
in `worker/src/index.ts` but are not deployed. Deploying them is Ryan's call** (`./cloudflare/deploy.sh`
after review). The live site answers them with its generic 404 until then, and the MCP server
refuses to save a sketch against such a Worker.

- `GET /api/map/:id/ops`: the JSON at `maps/<id>/ops.json`. 404 `{error:'not_found', id}` when
  the map or its ops.json does not exist.
- `PUT /api/map/:id/ops`: replace it. Only for `sketch-<slug>` ids (403 `{error:'forbidden'}`
  for `shared` and every other id, so this adds no write path to the shared map). The body must
  be a JSON object, at most 2 MB (413 `too_large`, 400 `bad_json`/`empty_body`); no version
  guard; the map must exist (404), so PUT the blob first. Returns `{id, bytes, updated_at}`.
- `DELETE /api/map/:id`: delete the current blob, every `maps/<id>/v<n>.map`, `ops.json` and
  the D1 row (R2 deletes in batches of 1000 keys); returns `{id, deleted:true, objects}`. Only
  for `sketch-<slug>` ids: `shared` and every other map are refused with 403
  `{error:'forbidden'}` (a delete drops the version history a PUT keeps); an unknown sketch is
  404.

Nothing else changed: existing handlers are untouched, `snapshotAndPrune` and `listVersions`
only look at `maps/<id>/v*`, so `ops.json` never counts as a version. Tested locally with
`wrangler dev --local` against a scratch config and `--persist-to` a scratch directory (never
`cloudflare/.wrangler`): PUT `sketch-x`, GET/PUT its ops (404 before, 200 after, 400 for non-JSON
and arrays, 413 over 2 MB, 404 for a missing map), `GET /api/maps`, `DELETE sketch-x` (3 objects,
then 404 for the blob and ops), `DELETE shared` → 403 with the shared map untouched; and after
the sketch-only restriction: `PUT shared/ops`, `PUT other/ops`, `PUT sketch-/ops`,
`DELETE other` and `DELETE %73hared` → 403, `GET shared/ops` → 404.

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

The MCP server lives in `mcp/` with its own `package.json` and `node_modules`; nothing
in it is imported by the app or shipped in `dist/`. Its other repo-level files are
`.mcp.json` (registers the local-mode `tupaia` server), `.claude/skills/tupaia-dexterity/`
and `docs/architecture/runtime_api.md` (its §10 lists the runtime additions). Inside the app it
adds the hooks below, each marked `// tupaia-mcp:` (`grep -rn "tupaia-mcp" src public` lists
them all). First, two small export hooks and one client guard:
`src/controllers/states-editor.ts` puts the module-private `adjustProvinces` and
`stateRemove` on `window.__tupaiaInternals` when the states editor module loads, and
`public/modules/ui/heightmap-editor.js` returns its rebuild closures (`restoreKeptData`,
`restoreRiskedData`, `regenerateErasedData`) from `editHeightmap({tupaiaExport: true})`
without opening the editor; `restoreRiskedData(opts)` also takes an optional
`{erosion, regenerateRivers, redefineBiomes, afterRivers}` (MCP `set_heights`: regenerate the
rivers without erosion, recompute every biome, restore heights right after the rivers), and
without it behaves exactly as before. The guard: `src/io/load.ts` fires a `map:loading` event when a load
starts (before the loader's callback) and a `map:loaded` event after a successful load (one line
each), and `src/io/cloud-cloudflare.ts` uses them (with the existing `map:generated`) so a shared
load that never completes cannot lend its version to the next load, and so `loadedVersion` only holds while the page still has the map it loaded from
`shared`; when it does not (a `?maplink` sketch, a file, a new map), `saveSharedMap` shows
"Replace the shared map v<N>?" and, on Replace, PUTs with `X-Map-Version: N` instead of the old
versionless PUT whose 409 dialog offered an `X-Map-Overwrite` button. One save-format fix,
also marked `// tupaia-mcp:`: upstream saves only `color|habitability|name` per biome, so every
reload reset biome icon density, relief icons and movement cost to the defaults (custom biomes
to 0, none and 50). `src/io/save.ts` appends a 4th `|` field to the biome line (JSON
`{iconsDensity, icons, cost}`, from `src/io/biome-extras.ts`) and `src/io/load.ts` applies it when
present; files without it load as before, and older clients read only the first three fields (a
re-save by an older client drops the 4th). `biome-extras.ts` applies the stored `icons` list only
when every name is a plain symbol id (letters, digits, `_`, `-`), so a crafted file cannot put markup
into the relief `<use>` elements; a list with any other name keeps the default icons. One more
save/load pair: upstream's load turns the Trade button on whenever `#tradeAnimation` exists and
is not hidden (every map a current client saved), so each save switched Trade on for everyone;
`prepareMapData` in `src/io/save.ts` now marks the saved group `data-layer-off="1"` when Trade is
off and `src/io/load.ts` leaves the button off for it (files without the attribute, and older
clients, behave as before). Re-check all of these after an upstream rebase.

Relief icons (MCP `regenerate {parts:['relief']}` and `edit map {set:{reliefOnLoad}}`) add one
new file and five marked hooks. `src/renderers/relief-settings.ts` reads map-level settings from
attributes of `#terrain` (`data-seed`, `data-scale`, `data-biomes`, `data-min-height`,
`data-exclude`, `data-near-burgs`, `data-regenerate`) and exposes its helpers as the page global
`ReliefSettings` (the MCP bridge uses them; its reader clamps each value to a sane range: scale and
per-biome multipliers 0 to 2, min height 0 to 100, near-burg distance 0 to 10000, so a crafted file
cannot make a draw hang); `src/renderers/draw-relief-icons.ts` applies them
(with none set it draws as upstream; a seeded draw swaps `Math.random` per cell and
`drawReliefIcons` puts it back; below a multiplier of 1 a cell keeps its icons with odds that keep
the count going with the square of the multiplier, instead of always keeping one). With
`data-regenerate` set, `prepareMapData` (`src/io/save.ts`) empties `#terrain` in the saved SVG, so
every save path (File > Save, browser storage, autosave, the shared map, MCP saves and snapshots)
drops the icons, and `src/io/load.ts` calls `restoreReliefOnLoad()` after a load to draw the same
icons again and turn the Relief button on. `generate()` in `public/main.js` clears the settings,
so a new map starts as upstream. `public/modules/ui/relief-editor.js` warns that manual relief
edits are not saved on such a map. In the app the switch is a Style > Relief checkbox, "Redraw
relief icons on load (smaller file)" (one row in `src/index.html`, its handler in
`public/modules/ui/style.js`, calling `ReliefSettings.setOnLoad`). Old files load unchanged. A client without these hooks (an
older deploy) loading such a file shows no relief and the Relief button off; turning Relief on
draws unseeded icons at the style density, and its next save stores them again. So MCP
`shared_save` and `sketch_promote` refuse (BUILD) a `data-regenerate` map unless the deployed
build is the local one or its entry chunk contains the hook. Deploy the app before saving such a
map to `shared` by hand. In-app edits that change what relief is drawn from redraw the icons on a
`data-regenerate` map, so the page shows what its next load draws: `ReliefSettings.sync()` is
called after the biomes editor's Apply and Restore defaults (`public/modules/ui/biomes-editor.js`)
and after the heightmap editor's finalize (`public/modules/ui/heightmap-editor.js`); Tools >
Regenerate > Relief and the Style relief controls already redraw with the stored settings. On
other maps `sync()` does nothing. MCP calls redraw through the bridge. Re-check after an upstream rebase (upstream has a `relief-webgl-renderer` branch).

Resampling (for the MCP `regrid` tool and the app's Transform tool): `src/generators/resample.ts`
`process()` takes a `keepId` option; with it (scale 1) it keeps the map id and fires `map:resampled` instead of
`showStatistics()` (a new id and `map:generated`), so a density-only change of the shared map
still saves with its loaded version. Only the MCP `regrid` and a Transform with no shift,
rotation, zoom, mirror or canvas change pass it; any other Transform and every Submap stay a new
map ("Replace the shared map?"). `public/modules/ui/transform-tool.js` computes that and keeps
`notes` across its `undraw()` so Resample carries them over (it dropped them). Re-check all of these
after an upstream rebase.

Two load-time data integrity repairs in `src/io/load.ts` (marked `// tupaia-mcp:`) now call
`src/io/load-repairs.ts`, each with an upstream bug fixed: cells of an invalid or removed culture
are reset to culture 0 (upstream reset their province instead, leaving the bad culture and
wiping valid provinces), and the state capital checks set `state.capital` to the burg they promote
for a capital-less state, or keep, of several capitals the one `state.capital` names (upstream
promoted a burg without updating `state.capital`, and always kept the first). Only maps with those
inconsistencies load differently; old clients load every file as before. Re-check both after an
upstream rebase (the blocks moved out of `load.ts`).

One more one-line guard: `focusOn` in `public/main.js` ignores a `?burg=` id whose record
is a stub left by the MCP `compact` tool (`{i, removed:true}`, no coordinates) instead of
zooming to NaN; re-check it after a rebase too.

One more hook, in `public/main.js` `invokeActiveZooming` (two `// tupaia-mcp:` blocks, labels
and emblems): a label or emblem group may carry `data-min-size` (replaces the lower bound of the
automatic hiding, 6 for labels and 25 for emblems), `data-max-size` (replaces the upper bound, 60
and 300) and `data-always-show` (`1` skips both bounds). The MCP `display {labels}` writes them on
the SVG groups, so they ride in the `.map` file; a group without them behaves exactly as upstream,
and an older client ignores them. A matching small filter in `src/renderers/draw-burg-labels.ts`
`createLabelGroups` keeps a new burg group, which copies the `town` style, from inheriting them.
Re-check both after an upstream rebase.

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
