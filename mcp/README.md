# tupaia-mcp

An MCP server that drives the built Tupaia app (this repo's fork of Azgaar's Fantasy Map
Generator) in headless Chromium, so a Claude session can look at and change a map precisely
and check what it did: query entities, edit them in batches, paint cells, import terrain,
apply a declarative spec, lint, generate and regenerate, screenshot and compare, snapshot and
undo, save and export, propose shared-map changes as sketches, and, only when a human set it
up, write the live shared map at map.activationlayer.org.

It is a separate Node package. Nothing here is imported by the app or shipped in `dist/`.

- Every tool, field table, error code and recipe: `resources/cheatsheet.md` (served as
  `tupaia://docs/cheatsheet.md`).
- How an agent should work with it, the CLI, and the eval-to-tool table:
  `.claude/skills/tupaia-dexterity/SKILL.md`.
- The app's runtime globals (for `eval`): `docs/architecture/runtime_api.md`.

## How it works

- `node mcp/src/server.ts` (Node 24+ type stripping; not tsx). On stdio, stdout carries only
  JSON-RPC and logs go to stderr. `--http` serves the same tools from a local daemon instead
  (below).
- Startup registers 28 tools and 3 resources and opens no browser and no network. The first
  tool call starts a loopback static server over `<repo>/dist`, launches Chromium
  (Playwright 1.60.0) and opens one page at `/?local`.
- Page side: `src/bridge.js` and `src/bridge-mutations.js` define `globalThis.__tupaia`; every
  `src/bridge-ext/*.js` is injected after them in name order (apply, biomes, clear, compact,
  labels, lint, regen-replay, regen, regrid, relief, rivers, routes, settings, terrain, tokens).
  Extensions add FIELDS, types and FNS functions, and some wrap core ones (FNS.edit, regenerate,
  display, summary, loadMap). Every tool goes through one `__tupaia.call(name, args)`.
- Node side: `src/tools/*.ts` are imported in name order and register through `defineTools`;
  `context.ts` (CallScope: one mutex, undo, sketch logging), `snapshots.ts` (undo/redo,
  snapshots, provenance), `ops.ts` + `replay.ts` (sketch log and replay; later tools add replay
  support with `registerReplayable`), `browser.ts` (Chromium, relaunch and restore),
  `result.ts`, `paths.ts`, `shared-api.ts` (every request to the live origin), `http.ts` and
  `cli.ts` (the daemon and `bin/tupaia`).
- A route firewall answers every page-originated non-GET `/api` request with 403 in all
  modes and aborts every non-loopback host (analytics are stubbed, fonts are allowed unless
  `TUPAIA_OFFLINE=1`). So `eval` cannot write the live map; only `shared_save`,
  `shared_restore`, `sketch_promote` and sketch save/discard can, from Node.
- Arguments are checked centrally (`context.ts`): every tool except `apply` (whose lists go under
  any key) refuses an unknown top-level key with BAD_ARGS naming the allowed keys
  (`details {unknown, allowed}`), schema errors are BAD_ARGS `invalid arguments for <tool>: ...`,
  and tools/list advertises `additionalProperties:false`.
- Snapshots, the undo/redo history and the map's provenance live in Node memory and survive
  browser relaunches. After every call that changed the page (a mutating bridge call, an undo
  entry, a relaunch) the page map is kept as a restore point (`SnapshotStore.restorePoint`,
  ordered by a monotonic tick). A relaunch restores whichever is newest, so a crash or hang after
  an edit loses nothing (`Restored the map as '<tool>' left it (...) (nothing lost)`), and a
  mutating call that times out loses only itself (its undo point is newer). The restore point
  touches neither the sketch log nor the redo stack.
- A read-only call that stalls is not a reason to relaunch: the next call probes the page for up
  to 10 s and keeps it if it answers (`the page answers again after: ... It was not relaunched`).
  A call's `timeoutMs` budget starts after any launch or relaunch at its start. Put-back steps
  (`CallScope.cleanup`/`putBack`: sketch summary's return to the sketch map, screenshot
  layer/label/animation restore, flow overlay removal) ignore the caller's cancellation and get
  at least 60 s.
- Every map state carries an epoch (`Provenance.epoch`; a load, generate, restore or sketch open
  starts a new one, a shared_save keeps it). map_info against a baseline from another epoch
  reports `mapReplaced` instead of diffing two unrelated maps. Within one map, routes, markers
  and zones pair by a page-session identity, so a regenerate shows added/removed; across a reload
  they pair by id.
- `consoleErrors` in every result are folded (`msg (xN)`, most repeated first, at most 8 distinct
  of up to 300 chars, then a `+K more ...` line); `session` status keeps the newest 20 distinct.

## Tools by family

| family | tools | notes |
| --- | --- | --- |
| Session and reading | session, map_info, find, inspect, flow, lint, screenshot | read-only (screenshot `keepLayers` excepted); `format:'compact'` (also session, shared_status, sketch status), `diff:'counts'`, map_info `detail`, `crop:'changed'` keep results small |
| Entity edits | edit, add, paint_cells, display, apply | one undo entry per call; `dryRun`; replayable in sketches |
| Terrain and grid | set_heights, regrid, regenerate (biomes, relief) | set_heights replays; regrid is blob-only in a sketch |
| Bulk and cleanup | clear, compact | dependency-ordered cascades; id-stable stubs |
| Generation | generate_map, regenerate | seeded; only biomes, provinces, emblems and relief replay |
| History and escape hatch | snapshot, eval | eval replays verbatim and is marked unsafe |
| Files | load_map, save_map, export | path policy under TUPAIA_OUT; `compact:true` on save |
| Shared map | shared_status, shared_save, shared_restore, sketch, sketch_promote | the live-write gate below |

What the newer tools and fields replaced (all one undo entry each, all dryRun-able):

- `set_heights {grid|pack|image}` imports a heightmap and rebuilds coast, lakes, climate, rivers
  and biomes, carrying burgs, routes, markers, regiments and lake/island names to the new cells
  and keeping river identity by course; with `rebuild:'keep'` it is local (the changed cells'
  heights, temperature, biome and lake levels; rivers, economy and far biomes untouched;
  `rivers:'regenerate'` opts into the global river pass), like `paint_cells` height keep; `flow`
  previews drainage on current or proposed heights.
  App hook: `restoreRiskedData(opts)` in `public/modules/ui/heightmap-editor.js`.
- `edit {type:'map'}` sets world settings (mapSize, latitude, temperatures, winds, precipitation,
  units, ...) with locks that travel in the `.map` (`options.tupaiaLocks`) and an optional
  `recalculate` (climate, biomes, rivers+biomes, climate+biomes).
- Routes: freehand `add route {points, noPathfind:true}` (locked by default), route groups as
  entities (`add/edit routeGroup`, find/inspect `routeGroup`, `counts.routeGroups`), `edit route
  {points, group}`. `cells.routes` always equals what `Routes.buildLinks` would give.
- Rivers: `edit river {mainStem | split | merge | reroute | end | joinAt}` (a reroute that
  changes nothing is a no-op success); find/inspect report `joinsAt` and tributaries. `add river
  {points|cells, name, type, parent}` lays a new course (joined along land, extended to water or
  its parent; `cells.r/fl/conf`, discharge, width and length as rivers.js computes them).
- `add province {state, centre:{burg}|Place, name, cells|select}` makes a province like the
  provinces editor (grown over the state's nearer cells by default; shield, label, borders).
- Biomes as entities (`find/inspect/add/edit biome`), `paint_cells feather`, and `regenerate
  {parts:['biomes'], biomes:{noise, smooth, minRegion, seed, keepPainted, ...}}`. App fix: the
  biome line's 4th field keeps icon density, icons and cost through save/load.
- `regenerate {parts:['provinces','emblems'], provinces:{states, centres|count}, emblems:{...}}`
  for named states only (hand-made states too).
- `regenerate {parts:['relief'], relief:{density|matchIcons, perBiome, exclude, nearBurgs,
  seed}}` and `edit map {set:{reliefOnLoad:true}}` (saves drop the icons, loads redraw them;
  terraform-v3.map 4.75 -> 2.33 MB). App hooks: `src/renderers/relief-settings.ts` and friends;
  the app has the same switch (Style > Relief, "Redraw relief icons on load") and its biomes and
  heightmap editors redraw such a map's icons.
- `display {labels:{<group>:{minSize, maxSize, alwaysShow}}}` and `screenshot {labels:'all'}`.
  App hook: `invokeActiveZooming` in `public/main.js` reads `data-min-size`, `data-max-size`,
  `data-always-show`.
- `clear` (bulk removal in dependency order), `edit remove` for provinces, cultures and religions,
  forced burg removal (`force`, `newCapital`, `orphanRoutes`).
- `compact` and `compact:true` on save_map/shared_save/sketch save/sketch_promote (removed
  records become `{i, removed:true}` stubs; the shared v7 map: 697,400 B, about 15%, smaller).
- `regrid {density}` changes the cell density and keeps the map id (shared lineage), names,
  notes and labels; rivers are traced again as contiguous cell paths along their old lines and
  carved where the new heights would make them climb (`carve`, default on: only those cells are
  lowered, never below 20), and biomes re-derived from the climate (custom and painted ones
  carried) with one-biome speckles under `minRegion` cells (default 3) merged into their
  neighbour, through the same clean-up as regenerate biomes' minRegion. App hook:
  `Resample.process({keepId})`.
- `apply` (declarative spec, `mode:'check'|'upsert'|'update'`, idempotent; its `paint` list
  paints territory, biomes and heights in order, later entries winning, each entry only its
  differing cells, logged as replayable paint_cells steps; it creates provinces around their
  capital after the paint and rivers along their from/via/to points) and `lint` (23 checks with
  ready fix calls).

Behaviour worth knowing:

- `generate_map` is reproducible: the same seed and options give the same `digest` after other
  seeds, sizes and culture sets and in a fresh session (it clears the app's per-session caches:
  `Names.clearChains()`, `Rivers.smallLength`, the culture range inputs' max). Omitted
  width/height mean the server's default viewport. The page is reloaded from its own .map text,
  so snapshots hold the generated map exactly (the generator's river erosion of pack heights is
  not kept by .map files). `regenerate {parts:['rivers']}` keeps pack heights.
- find and inspect compute culture/religion/state/province `cells`, `area`, `rural`, `urban`
  and `burgs` live from the cells (the app refreshes the stored stats only in its editors);
  inspect adds `statsNote` when the stored values were stale. Unknown fields come back as
  `warnings`.
- `add culture` gives the culture a COA shield (the default culture's, a same-base culture's, a
  random one, else heater); `shield` is an editable culture field.
- After a `rebuild:'risk'` (set_heights, paint_cells height) a carried route point whose cell
  moved away from its x,y is re-recorded to the cell under it (`carried.routePointsRepointed`),
  so lint `route-point-cell` stays clean.
- App load repairs (`src/io/load-repairs.ts`): cells of an invalid culture become culture 0
  (provinces untouched), and the state-capital repair keeps `state.capital` in step with the
  burg it promotes.

## Run it

```bash
# from the repo root: build the app once (and after app changes); CF_BUILD=1 is required
CF_BUILD=1 npx vite build --emptyOutDir
cd mcp && npm install            # once; `npx playwright install chromium` if it is missing
npm start                        # = node src/server.ts, speaks MCP on stdio
```

The server refuses to start a browser without a CF_BUILD `dist/` and prints the build
command.

### Claude Code registration (stdio)

`.mcp.json` at the repo root registers the local-mode server:

```json
{
  "mcpServers": {
    "tupaia": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PROJECT_DIR:-.}/mcp/src/server.ts"],
      "env": { "TUPAIA_MODE": "local" },
      "timeout": 300000
    }
  }
}
```

Use `node` directly, never `npm run` (its banner goes to stdout and breaks the protocol). New
or changed MCP servers load only when Claude Code starts; to use the tools in a session that is
already running, use the CLI below.

A human who wants Claude to be able to write the live shared map adds a second entry by hand
(it is deliberately not committed), then restarts Claude Code; remove it when the write is
done:

```json
    "tupaia-live": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PROJECT_DIR:-.}/mcp/src/server.ts"],
      "env": { "TUPAIA_MODE": "live" },
      "timeout": 300000
    }
```

## Shared daemon (--http) and the tupaia CLI

`--http` serves the same tools from one long-lived local daemon that a running session, its
workflow subagents and shells all share: one browser, one page, one undo history, one sketch.
Calls from every caller queue on one mutex; each call is atomic.

```sh
node mcp/src/server.ts --http [--port N | --prefer-port N]   # usually started by mcp/bin/tupaia
```

- MCP Streamable HTTP at `http://127.0.0.1:<port>/mcp` (2026-07-28 and stateless 2025-era
  requests; GET returns 405).
- JSON API (the CLI uses it): `POST /call {name, args?, timeoutMs?, caller?}` ->
  `{isError, text[], images[]}` (images saved as `$TUPAIA_OUT/shots/call-*.jpg`); `GET /tools`,
  `GET /health`, `POST /shutdown`, `POST /listen {port}`.
- One daemon per `TUPAIA_OUT`. In that directory: `daemon.json` (0600: pid, port, ports, url,
  mcpUrl, mode, token, closing?, ...), `daemon.port.json` (the port the next auto-start uses),
  `daemon.log`, `maps/daemon-exit-*.map` (last 5) and `daemon.last.json`.
- Security: 127.0.0.1 only; the Host header must name the port the connection arrived on; any
  request with an `Origin` header gets 403; every route needs `Authorization: Bearer <token>`
  (random per start). The bearer token is the trust boundary: anyone holding it can confirm
  another caller's shared_save preview. The CLI hands it to a daemon it starts through a 0600
  file (`TUPAIA_HTTP_TOKEN_FILE`, read once and deleted), not the environment, so `ps eww` does
  not show it. `POST /listen` adds at most 3 ports (4 in all). daemon.log turns control
  characters in a caller name into spaces, so a caller cannot forge log lines.
- Mode is set as for stdio: live only from `TUPAIA_MODE=live` in the daemon's spawn
  environment; nothing over HTTP switches to live; the live-write gate is unchanged. But the
  first caller's environment sets the mode for every later caller on that TUPAIA_OUT, so the CLI
  checks: a live daemon refuses `call` and `headers` (exit 2, nothing runs) from a caller whose
  environment is local (or unset), or that names another `TUPAIA_LIVE_ORIGIN` (daemon.json and
  /health carry `liveOrigin`), unless `--accept-live`. `tools`, `status` and `stop` still work.
  Give a live daemon its own `--out`. A live daemon loads the shared map into its page on its
  first launch.
- A queued call whose caller disconnects or cancels is skipped; a started call runs to its end.
- Stopping (`tupaia stop`, idle, or another daemon taking over the TUPAIA_OUT): queued calls
  are refused (they never ran; `tupaia call` reruns them on a fresh daemon), the running call
  finishes (up to 15 s), a changed page is saved to `maps/daemon-exit-<time>.map` and the next
  start prints a `load_map` line for it.
- Idle shutdown after `TUPAIA_HTTP_IDLE_MIN` (default 120) minutes with no call and no attached
  MCP client (an open `subscriptions/listen` stream; Claude Code holds one per session). A live
  daemon a Claude Code session is attached to therefore stays live for that whole session:
  `tupaia stop` it once the write is done (after the session detaches).
- `session` status shows `serving: http daemon ...`.

### CLI: mcp/bin/tupaia

```
tupaia call <tool> [<json>|-]   # result text, then 'IMAGE: <path>' per image; a failed tool
                                # prints 'ERROR CODE: message' and exits 1
tupaia tools [<tool>] [--names] # list tools; with a name: its description and arguments
tupaia help <tool>              # same as tupaia tools <tool>
tupaia status | start | stop    # status exits 1 when not running (and says starting/stopping)
tupaia headers                  # {"Authorization":"Bearer ..."} for Claude Code's headersHelper
  --json  --timeout <ms>  --port <n>  --out <dir> (= TUPAIA_OUT)  --accept-live
```

- Use the absolute path of the checkout's bin, `/Users/mgm1/Desktop/code/vespucci/mcp/bin/tupaia`
  (no package.json `bin` entry); in a worktree use the worktree's bin, which runs that tree's
  code.
- `call`, `tools` and `headers` start a detached daemon when none serves this TUPAIA_OUT; it
  gets the caller's environment. Concurrent first callers start exactly one.
- The daemon's mode is fixed at its start. A live daemon refuses a local caller (above); a
  local daemon only warns a live caller and keeps running: `tupaia stop` first to change mode.
- Paths: the CLI makes a relative `load_map path`, `apply specPath`, `set_heights image.path`,
  `flow heights.image.path` (and `sketch onto.path`) absolute when the file exists from your
  cwd. The server reads a relative path from its own cwd, then TUPAIA_OUT, then the repo root
  (first match; NOT_FOUND lists them), and results name the absolute file (`path`, `specPath`,
  `imagePath`). `save_map` and `export` write relative paths under TUPAIA_OUT. Prefer absolute.
- Large arguments (heights, cell lists) go through stdin: `tupaia call set_heights - < args.json`.
  Plain-JSON args of 32 KB or more are sent to the page as one string (0.9 MB in about 80 ms).
- Exit codes: 0 ok, 1 tool error (or status: not running), 2 usage or daemon error (or a live
  daemon refused). An unusable `--out` exits 2 (no fallback directory). Calls or starts slower
  than 15 s print progress on stderr: the number of calls the daemon has in progress, or that it
  has none yet (the request has not reached it: a loaded machine). daemon.log has each call's
  daemon time (`call <tool> <ms> ok [caller]`); under load the CLI's wall time can be several
  times that. `tupaia help <tool>` prints a long shape repeated under several arguments once.

Several sessions or agents: one TUPAIA_OUT per independent task, so their pages do not collide.
Callers that pass the same `--out` share one page, undo history and sketch (one agent's undo
undoes the newest change from any agent); give workflow subagents the exact command prefix and
`TUPAIA_CALLER=<name>` to label their calls in daemon.log.

### Registering the daemon for future Claude Code sessions

Add an http entry next to the stdio `tupaia` entry (user scope or `--mcp-config`; its page is
separate from the stdio server's page):

```json
"tupaia-shared": {
  "type": "http",
  "url": "http://127.0.0.1:7392/mcp",
  "headersHelper": "TUPAIA_MODE=local /Users/mgm1/Desktop/code/vespucci/mcp/bin/tupaia headers",
  "timeout": 300000
}
```

or, once: `claude mcp add-json tupaia-shared '{"type":"http","url":"http://127.0.0.1:7392/mcp",
"headersHelper":"/Users/mgm1/Desktop/code/vespucci/mcp/bin/tupaia headers"}'` (not run).

- The token is random per daemon start, so use `headersHelper`, not a static header. Claude Code
  reads credential-like env vars as empty in http `headers` and strips TOKEN/KEY/AUTH-named vars
  from the helper's environment.
- `tupaia headers` reads `CLAUDE_CODE_MCP_SERVER_URL` (it refuses one whose host is not
  127.0.0.1 or localhost: the token only goes to this machine's daemon) and makes the daemon for
  its TUPAIA_OUT serve that port: it starts one there, or asks a daemon a CLI call started on another port to
  also listen there (same page). From then on that port is that TUPAIA_OUT's port.
- Without `TUPAIA_OUT` the daemon uses `<repo>/.tupaia-mcp-out`, so `tupaia call` without
  `--out` shares the registered server's page.
- Verified with Claude Code 2.1.293 (`claude -p --mcp-config`, type http, this helper with an
  absolute path): it negotiates 2026-07-28 and holds a `subscriptions/listen` stream all
  session, so the daemon does not idle out under it; it gives up on a helper after about 10 s
  (`headers` prints the token within about 7 s, even while the daemon is still starting); it
  does NOT reconnect after the daemon stops (later calls fail with ECONNREFUSED), so never
  `tupaia stop` a daemon a session is using.
- Not verified: whether `timeout` applies to http entries; a project `.mcp.json` helper with a
  relative path; reconnecting an interactive session with /mcp.

## Environment

| variable | default | meaning |
| --- | --- | --- |
| `TUPAIA_MODE` | `local` | `live` enables shared_save/shared_restore/sketch_promote and sketch save/discard. Only settable at spawn; `session {action:'set_mode', mode:'local'}` can drop live to local, never the reverse. |
| `TUPAIA_LIVE_ORIGIN` | `https://map.activationlayer.org` | Origin for shared reads (and writes in live mode). `none` disables shared reads too. |
| `TUPAIA_OUT` | `<repo>/.tupaia-mcp-out` | Screenshots, saves, exports, backups; under `--http` it also picks the daemon. |
| `TUPAIA_DIST` | `<repo>/dist` | The built app. |
| `TUPAIA_VIEWPORT` | `1280x720` | Page viewport. |
| `TUPAIA_SNAPSHOTS` | `10` | Named snapshots kept. |
| `TUPAIA_UNDO_DEPTH` | `10` | Auto-undo entries kept. |
| `TUPAIA_OFFLINE` | off | `1` stubs Google Fonts. |
| `TUPAIA_HEADED` | off | `1` shows the browser window. |
| `TUPAIA_DEBUG` | off | `1` logs page events to stderr. |
| `TUPAIA_TEST_HOOKS` | off | `1` enables `session {action:'crash'}` and `sketch rebase {onto}` (tests only). |
| `TUPAIA_BUILD_CACHE_MS` | `300000` | How long the deployed-build check is cached. |
| `TUPAIA_HTTP_PORT` | CLI: this TUPAIA_OUT's last port, else any free port | Port for `--http` (also `--port N`); strict when set. |
| `TUPAIA_HTTP_IDLE_MIN` | `120` | Daemon stops after this many idle minutes with no attached client (`0` = never). |
| `TUPAIA_START_TIMEOUT_MS` | `90000` | How long the CLI waits for a daemon start (a timed-out start is killed). |
| `TUPAIA_CALLER` | `pid N in <cwd>` | Your name in daemon.log. |
| `TUPAIA_HEADERS_WAIT_MS` | `7000` | `tupaia headers` prints the token by then, even mid-start. |
| `TUPAIA_CLI_HEARTBEAT_MS` | `15000` | First stderr progress line for a slow call or start. |
| `TUPAIA_HTTP_TRACE` | off | Log every MCP request's method and protocol version. |

`TUPAIA_HTTP_TOKEN` is internal: the CLI hands the daemon its token that way.

## The live-write gate

Writing the shared map is the one thing here that affects other people, so it has several
independent locks:

1. **Spawn-time mode.** Writes need `TUPAIA_MODE=live` in the server's environment, which only
   a human edits. There is no runtime switch to live. In local mode `shared_save`,
   `shared_restore` and `sketch_promote` return MODE before doing anything; the message names
   the fix for this process (stdio: the `tupaia-live` .mcp.json entry and a restart; the --http
   daemon: `tupaia stop` and a new start with `TUPAIA_MODE=live` in its environment).
2. **Preview and one-time token.** A call without `confirm` is a preview: what would be
   overwritten (version, who saved it, when, lock holder), lineage, stale, the build check,
   the exact request it would send, and a `token`. The confirmed call must pass
   `confirm:true` and that token. A token is valid for 10 minutes and one write, and only for
   the same live version, the same page map (body sha256) or restore target, and the same
   flags (`force`, `replaceWithUnrelated`, `skipBuildCheck`, `compact`). `src/shared-api.ts`
   re-checks the mode and the token itself before any PUT or POST.
3. **Lineage.** If the page map is not derived from the shared map (generated, or loaded from a
   file), the save is refused unless `replaceWithUnrelated:true`; `force` does not override
   this. Lineage is bound to the app's map id: anything that replaced the map outside
   load_map/generate_map/snapshot (an eval that calls `generate()`, a failed generate_map) makes
   it unrelated. `regrid` keeps the id (`Resample.process({keepId})`), so a regridded shared map
   still saves as the same map.
4. **Version and lock.** STALE (the shared map moved on since it was loaded) or LOCKED (someone
   holds the edit lock) is refused unless `force:true`. `expectVersion` adds a hard condition.
   The PUT always carries `X-Map-Version` and never `X-Map-Overwrite`, so the Worker's own guard
   still answers 409 on a race (CONFLICT, with the Worker's body).
5. **Build.** The deployed `versioning.js` VERSION is fetched (cached 5 minutes). A newer local
   VERSION blocks the save outright (live users would get "Newer file"). A map with
   `reliefOnLoad` is refused unless the deployed build is the local one or its entry chunk has
   the relief load hook (an older client would show no relief). When the builds cannot be
   compared, the save is refused unless `skipBuildCheck:true`; `force` does not imply it.
   `shared_status` runs the build check by default only in live mode.
6. **Backups.** Before every write the live blob is downloaded to
   `TUPAIA_OUT/shared-saves/v<N>-live-<time>.map`, and for a save the outgoing body is written
   next to it as `v<N>-outgoing-<time>.map`.

`shared_restore` has the same mode, token, lock and backup steps; its confirmed call also needs
`expectCurrent`, because the Worker has no version guard on restore. With `reload` (default)
the restored map is loaded into the page. Every request to the live origin (method, URL,
status) is listed in `session` status under `outwardRequests`.

## Sketches (provisional changes)

`sketch` records a proposed change to the shared map without writing it: base version N of
the shared map plus an ops log (`src/ops.ts`). `start` needs a page map loaded with
`load_map {source:'shared'}` and unedited. While a sketch records, every mutating call appends
`{seq, tool, args, resolved, summary, at, digestBefore, digestAfter}`; `resolved` comes from the
bridge's own apply result (ids, literal generated names, literal cell lists, created ids, layer
on/off lists, verbatim eval code, target identity fields, cell-graph fingerprints). Undo pops
the op it undid and redo re-appends it. `summary` writes markdown and like-for-like before/after
screenshots under `TUPAIA_OUT/sketches/<slug>/`.

### What replays

`src/replay.ts` replays a log onto whatever map is in the page through the same bridge
functions, rewriting ids of entities the sketch created (positional id map) and checking each op
first.

| tool / part | logged as | replay rule |
| --- | --- | --- |
| edit, add, paint_cells, display | resolved form | missing/removed target, a field both sides changed, a reused marker/route/zone id, a removal of something changed since, literal cells on a renumbered graph: conflict |
| edit river structure | literal cells and ids; mainStem `{ref, expect}`; end `{at:{cell}}`; joinAt `{ref, at:{cell}, cells}` | course comparison; a mainStem whose result differs from `expect` is REFUSED |
| edit map (settings, recalculate) | values, locks, derived-layer fingerprint | a recalculation whose derived layers changed on the target is a conflict; `skip` drops only both-changed fields |
| paint_cells height `keep` / `risk` | literal cells (`risk` with the graph it produced) | deterministic; `erase` is blob-only |
| set_heights | only the changed grid cells (deflated), digests, bbox | onto a target whose terrain changed since, its other heights are kept (note) |
| apply | one add/edit/paint_cells record per step | as those tools |
| clear | removed ids with fingerprints, capital/province-head successors | a removed id is REMOVED; changed, renumbered, reused or newly locked is CHANGED |
| compact | stub list, repoint `[[province, from, to]]` | repoints only where still valid |
| regenerate `biomes` / `provinces`,`emblems` / `relief` | literal outcome (`regenerate:biomes`, `regenerate:provinces-emblems`), relief settings + seed | a relief key someone else changed is a conflict |
| eval | verbatim code (marked unsafe) | ids inside the code are not rewritten |
| regenerate (any other part), generate_map, load_map, snapshot restore, shared_restore, regrid, paint_cells `erase`, screenshot `keepLayers`, a call that failed part-way | not replayable | the sketch is blob-only until the op is undone (undo past the start is permanent) |

A blob-only sketch can be saved, viewed and promoted as is while the shared map is still at its
base version, but not rebased. Read-only calls (and `display {labels:'list'}`, `apply` check,
no-op calls) are not logged.

### Saving, viewing and promoting sketches

A saved sketch is its own map on the Worker, `sketch-<slug>`: the page map as a blob (the Worker
keeps 20 versions) plus `ops.json` beside it (`GET|PUT /api/map/sketch-<slug>/ops`, holding
`{schema:1, slug, base, note, blobOnly, blobOnlyReasons, blockers, author:'tupaia-mcp', created,
updated, summaryMarkdown, baseCounts, blob:{id, version, bytes, sha256}, viewUrl, ops}`).

- `sketch {action:'save', confirm:true}` PUTs the blob (X-Map-Version = the sketch's own
  version, none on the first save) and then ops.json, and returns
  `viewUrl = <origin>/?maplink=<encodeURIComponent(origin + '/api/map/sketch-<slug>')>`, which
  opens the sketch, not the shared map. An ops.json over the Worker's 2 MB limit is refused
  before the blob goes up. `compact:true` saves a compacted blob.
- `list` (read-only, also in local mode) shows the `sketch-*` maps with their ops.json headers;
  `open {slug}` loads one as the active sketch. ops.json is not trusted: replayability, the
  unsafe mark and summaries are recomputed from each record.
- `rebase` replays the log onto the CURRENT shared map (a GET) and leaves the result in the page
  with the shared origin at that version; it does not save. Verified in local mode against the
  live v7 map (edit, freehand route, relief, compact: 4 of 4 applied).
- `discard {slug, confirm:true}` DELETEs `sketch-<slug>` (blob, versions, ops.json; live mode).
  An active sketch that was never saved is discarded locally in any mode: without `confirm` a
  preview `{preview, local:true, wouldDiscard}`, with it the sketch ends and its log is dropped
  (`{discarded:{slug, ops, local:true}}`); the page keeps its map and snapshot undo still works.
- `status` (and `session`, `shared_status`) take `format:'compact'`: one key=value line.
- `sketch_promote` refuses "rebase first" until the sketch's base version equals the shared
  map's current version; then it runs `shared_save`'s own code path (preview, token, confirm;
  lineage, lock, build, backups; one PUT with X-Map-Version). `then:'discard'` deletes the
  sketch afterwards.
- Plain `shared_save` refuses (SKETCH) while a stopped rebase holds the page; a confirmed
  `shared_save` with an active sketch ends that sketch.

Sketch writes are re-checked inside `src/shared-api.ts`: the id must match `sketch-<slug>` (so
`shared` can never be deleted or overwritten through them) and the server must be in its
spawn-time live mode. They take no token, because they never touch the shared map. The Worker
routes they use (`GET|PUT /api/map/:id/ops`, `DELETE /api/map/:id`, PUT and DELETE only for
`sketch-*`) are in `cloudflare/worker/src/index.ts`; until they are deployed, `save` probes for
them first and refuses before writing anything.

## Test

```bash
cd mcp
npm run typecheck
npm run lint            # root biome over src/ and test/
node --test --test-concurrency=3 "test/**/*.test.ts"
```

- `test/bridge.test.ts`, `test/ops.test.ts`, `test/paths.test.ts`: pure unit tests;
  `test/docs.test.ts` keeps the cheatsheet, this README, the skill and the server instructions in
  step with the registered tools; `test/integrate2.test.ts` checks small message fixes.
- `test/reliability.test.ts` (restore points, stalls, cancelled cleanups, failed undo/restore,
  console folding, epochs, compact status) and `test/core2.test.ts` (strict arguments, read
  paths, diff identity, generate reproducibility, live stats, shields, load repairs, route
  points, locks). They use test-only page faults: `__tupaia.testFaults.loadMap = n` (the next n
  loads fail part-way) and `__tupaia.testFaults.stall = {fn, ms}` (the next call of bridge
  function fn waits ms).
- `test/smoke.test.ts`: stdio end-to-end of every tool against `tests/fixtures/demo.map`; checks
  every description is at most 2048 chars, the instructions too, and the exact tool list.
- One file per feature: `terrain`, `regrid`, `clear`, `compact`, `apply`, `applypaint` (the paint
  list, territory, places, burg cells), `addprov` (add province/river, apply creating them),
  `lint`, `settings`,
  `routes`, `rivers`, `biomes`, `regen`, `relief`, `labels`, `tokens`, `http`; `fam-a/b/c` and
  `integrate.test.ts` cross the features (one apply spec over biomes, settings with locks,
  route groups and rivers; a sketch of 8 replayable records rebased onto someone else's v7).
- `test/sketch.test.ts` and `test/shared.test.ts`: sketches and the shared tools against
  `test/fake-worker.ts`, an in-process `node:http` fake of the Worker on 127.0.0.1.

Tests never touch the live site: `test/helpers.ts` defaults `TUPAIA_LIVE_ORIGIN=none` and
throws if any test points it at activationlayer.org. Never run the repo's Playwright e2e
suite as part of this. Known load flakes (pass when the file runs alone): smoke `aa`/`cc`
timing, tokens `pad widens the shown box`, http `a caller that leaves before its call starts is
skipped`.

A write rehearsal against a real Worker: run `wrangler dev --local` with a scratch config and
`--persist-to` a scratch directory (never the repo's `cloudflare/.wrangler`), then spawn the
server with `TUPAIA_MODE=live TUPAIA_LIVE_ORIGIN=http://127.0.0.1:<port>` and its own
`--out`/TUPAIA_OUT (on the default out dir a running production live daemon would serve the
rehearsal; the CLI refuses that origin mismatch). `test/fake-worker.ts` is a lighter stand-in
(see `test/sketch.test.ts` for how the tests drive it).
