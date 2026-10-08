# tupaia-mcp

An MCP server that drives the built Tupaia app (this repo's fork of Azgaar's Fantasy Map
Generator) in headless Chromium, so a Claude session can look at and change a map precisely
and check what it did: query entities, edit them in batches, paint cells, generate and
regenerate, screenshot and compare, snapshot and undo, save and export, and, only when a
human set it up, write the live shared map at map.activationlayer.org.

It is a separate Node package. Nothing here is imported by the app or shipped in `dist/`.

## How it works

- `node mcp/src/server.ts` (Node 24+ type stripping; not tsx). stdout carries only JSON-RPC;
  logs go to stderr.
- Startup registers 21 tools and 3 resources and opens no browser and no network. The first
  tool call starts a loopback static server over `<repo>/dist`, launches Chromium
  (Playwright 1.60.0) and opens one page at `/?local`.
- `src/bridge.js` and `src/bridge-mutations.js` are injected as classic scripts and define
  `globalThis.__tupaia`; every tool goes through one `__tupaia.call(name, args)`.
- A route firewall answers every page-originated non-GET `/api` request with 403 in all
  modes and aborts every non-loopback host (analytics are stubbed, fonts are allowed unless
  `TUPAIA_OFFLINE=1`). So `eval` cannot write the live map; only `shared_save`,
  `shared_restore` and `sketch_promote` can, from Node (`src/shared-api.ts`).
- Snapshots, the undo/redo history and the map's provenance live in Node memory and survive
  browser relaunches. A mutating call that times out marks the page dirty; the next call
  relaunches and restores the newest snapshot.

Tools: session, map_info, find, inspect, screenshot, display, edit, add, paint_cells,
generate_map, regenerate, snapshot, eval, load_map, save_map, export, shared_status,
shared_save, shared_restore, sketch, sketch_promote. Resources: `tupaia://docs/cheatsheet.md` (every tool, refs,
places, error codes, field tables, recipes), `tupaia://docs/runtime-api.md`,
`tupaia://docs/data-model.md`. The operating skill for Claude is
`.claude/skills/tupaia-dexterity/SKILL.md`.

## Run it

```bash
# from the repo root: build the app once (and after app changes); CF_BUILD=1 is required
CF_BUILD=1 npx vite build --emptyOutDir
cd mcp && npm install            # once; `npx playwright install chromium` if it is missing
npm start                        # = node src/server.ts, speaks MCP on stdio
```

The server refuses to start a browser without a CF_BUILD `dist/` and prints the build
command.

### Claude Code registration

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

Use `node` directly, never `npm run` (its banner goes to stdout and breaks the protocol).

A human who wants Claude to be able to write the live shared map adds a second entry by
hand (it is deliberately not committed), then restarts Claude Code:

```json
    "tupaia-live": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PROJECT_DIR:-.}/mcp/src/server.ts"],
      "env": { "TUPAIA_MODE": "live" },
      "timeout": 300000
    }
```

Remove it again when the write is done.

## Environment

| variable | default | meaning |
| --- | --- | --- |
| `TUPAIA_MODE` | `local` | `live` enables shared_save/shared_restore/sketch_promote and sketch save/discard. Only settable at spawn; `session {action:'set_mode', mode:'local'}` can drop live to local, never the reverse. |
| `TUPAIA_LIVE_ORIGIN` | `https://map.activationlayer.org` | Origin for shared reads (and writes in live mode). `none` disables shared reads too. |
| `TUPAIA_OUT` | `<repo>/.tupaia-mcp-out` | Screenshots, saves, exports, shared-save backups (gitignored). |
| `TUPAIA_DIST` | `<repo>/dist` | The built app. |
| `TUPAIA_VIEWPORT` | `1280x720` | Page viewport. |
| `TUPAIA_SNAPSHOTS` | `10` | Named snapshots kept. |
| `TUPAIA_UNDO_DEPTH` | `10` | Auto-undo entries kept. |
| `TUPAIA_OFFLINE` | off | `1` stubs Google Fonts. |
| `TUPAIA_HEADED` | off | `1` shows the browser window. |
| `TUPAIA_DEBUG` | off | `1` logs page events to stderr. |
| `TUPAIA_TEST_HOOKS` | off | `1` enables `session {action:'crash'}` (tests only). |
| `TUPAIA_BUILD_CACHE_MS` | `300000` | How long the deployed-build check is cached. |

## The live-write gate

Writing the shared map is the one thing here that affects other people, so it has several
independent locks:

1. **Spawn-time mode.** Writes need `TUPAIA_MODE=live` in the server's environment, which only
   a human edits. There is no runtime switch to live. In local mode `shared_save` and
   `shared_restore` return MODE before doing anything.
2. **Preview and one-time token.** A call without `confirm` is a preview: what would be
   overwritten (version, who saved it, when, lock holder), lineage, stale, the build check,
   the exact request it would send, and a `token`. The confirmed call must pass
   `confirm:true` and that token. A token is valid for 10 minutes and one write, and only for
   the same live version, the same page map (body sha256) or restore target, and the same
   override flags. `src/shared-api.ts` re-checks the mode and the token itself before any
   PUT or POST, not only the tool layer.
3. **Lineage.** If the page map is not derived from the shared map (it was generated, or
   loaded from a file), the save is refused unless `replaceWithUnrelated:true`. `force` does
   not override this. Lineage is bound to the app's map id (`mapId`, stamped on every generate
   and load): if anything replaced the map without going through load_map/generate_map/
   snapshot (an eval that calls `generate()`, a failed generate_map, a relaunch), the id no
   longer matches and the map counts as unrelated.
4. **Version and lock.** If the shared map moved on since the page map was loaded (STALE),
   or someone holds the edit lock (LOCKED), the save is refused unless `force:true`.
   `expectVersion` adds a hard condition. The PUT always carries `X-Map-Version` and never
   `X-Map-Overwrite`, so the Worker's own guard still answers 409 on a race; that comes back
   as CONFLICT with the Worker's body.
5. **Build.** The deployed `versioning.js` VERSION is fetched (cached 5 minutes). If the local
   app VERSION is newer, the save is blocked outright: `prepareMapData` stamps the local
   VERSION into the file and live users would get "Newer file". An entry-chunk mismatch with
   the same VERSION is a warning. When the builds cannot be compared (the deployed
   `versioning.js` is unreachable or unreadable), the save is refused unless
   `skipBuildCheck:true`, a separate flag the preview names on its own; `force` does not
   imply it. `shared_status` runs the build check (GET `/versioning.js` and `/`) by default
   only in live mode; in local mode it sends the single meta GET unless `build:true`.
6. **Backups.** Before every write the current live blob is downloaded to
   `TUPAIA_OUT/shared-saves/v<N>-live-<time>.map`, and for a save the outgoing body is
   written next to it as `v<N>-outgoing-<time>.map`.

`shared_restore` has the same mode, token, lock and backup steps; its confirmed call also
needs `expectCurrent`, because the Worker has no version guard on restore. With
`reload` (default) the restored map is loaded into the page.

Every request to the live origin (method, URL, status) is listed in `session` status under
`outwardRequests`.

## Sketches (provisional changes)

`sketch` records a proposed change to the shared map without writing it: base version N of
the shared map plus an ops log (`src/ops.ts`). `start` needs a page map loaded with
`load_map {source:'shared'}` and unedited. While a sketch records, every mutating tool call
appends `{seq, tool, args, resolved, summary, at, digestBefore, digestAfter}`; `resolved` comes
from the bridge's own apply result (ids, literal generated names, literal cell lists, the
created entities' ids, the layer on/off lists, verbatim eval code, and for replay's checks the
target's identity fields and the cell-graph fingerprint of a literal cell list). regenerate,
generate_map, load_map, snapshot restore and a paint_cells height rebuild ('risk' or 'erase')
are logged as non-replayable, which makes the sketch blob-only until they are undone; undo pops
the op it undid and redo re-appends it.

`src/replay.ts` replays a log onto whatever map is in the page through the same bridge
functions, rewriting the ids of entities the sketch created through an id map and checking
each op first (missing or removed targets, fields both sides changed, a marker/route/zone id
that now names another entity, a removal of an entity someone changed since, a literal cell
list on a renumbered cell graph). Created ids are mapped positionally: an op only sees ids that
earlier adds created. `summary` writes markdown and like-for-like before/after screenshots
under `TUPAIA_OUT/sketches/<slug>/`.
`rebase {onto:{path}}` (replay onto a map file) is a test hook (`TUPAIA_TEST_HOOKS=1`).

### Saving, viewing and promoting sketches

A saved sketch is its own map on the Worker, `sketch-<slug>`: the page map as a blob (the
Worker already accepts any id and keeps 20 versions of it) plus `ops.json` beside it
(`GET|PUT /api/map/sketch-<slug>/ops`), holding `{schema:1, slug, base, note, blobOnly,
blobOnlyReasons, blockers, author:'tupaia-mcp', created, updated, summaryMarkdown, baseCounts,
blob:{id, version, bytes, sha256}, viewUrl, ops}`.

- `sketch {action:'save', confirm:true}` PUTs the blob (X-Map-Version = the sketch's own
  version, none on the first save) and then ops.json, and returns
  `viewUrl = <origin>/?maplink=<encodeURIComponent(origin + '/api/map/sketch-<slug>')>`. The app
  checks `?maplink` before its shared-map boot load, so the link opens the sketch, not the
  shared map. A log whose ops.json would exceed the Worker's 2 MB limit is refused before the
  blob goes up.
- `list` (read-only, also in local mode) shows the `sketch-*` maps with their ops.json headers;
  `open {slug}` loads one into the page as the active sketch (origin kind `sketch`). ops.json
  is not trusted: replayability, the unsafe mark and summaries are recomputed from each record.
- `rebase` without `onto` replays the log onto the CURRENT shared map (a GET) and leaves the
  result in the page with the shared origin at that version; it does not save.
- `discard {slug, confirm:true}` DELETEs `sketch-<slug>` (blob, versions, ops.json).
- `sketch_promote` refuses with "rebase first" until the active sketch's base version equals
  the shared map's current version; then it runs `shared_save`'s own code path end to end
  (preview, one-time token, confirm; lineage, lock, build, backups; one PUT with
  X-Map-Version, never X-Map-Overwrite). `then:'discard'` deletes the sketch afterwards.
- Plain `shared_save` refuses while a stopped rebase holds the page, and a confirmed
  `shared_save` with an active sketch ends that sketch (its changes went live directly).

Sketch writes (blob PUT, ops PUT, DELETE) are re-checked inside `src/shared-api.ts`: the id
must match `sketch-<slug>` (so `shared` can never be deleted or overwritten through them) and
the server must be in its spawn-time live mode. Every request goes into `session`'s
`outwardRequests`. They take no token, because they never touch the shared map.

The two Worker routes they use (`GET|PUT /api/map/:id/ops`, `DELETE /api/map/:id`; the PUT
and the DELETE only for `sketch-*` ids, 403 otherwise) are in
`cloudflare/worker/src/index.ts` but are NOT deployed until Ryan deploys them. Until then,
against the live site: `save` probes for them first (one GET of `/api/map/shared/ops`; a Worker
without them answers its generic 404) and refuses before writing anything; `list` shows the
sketches without headers; `open` answers NOT_FOUND (no ops.json); `discard` gets a 404.

The app guard: a page booted from a sketch link (or one that loaded a file or generated a map)
used to send a versionless PUT on "Save to shared map", get a 409 and offer an Overwrite
button that sent `X-Map-Overwrite: true`. `src/io/cloud-cloudflare.ts` now asks first ("Replace
the shared map v<N>?") and saves with that version, so a concurrent save still answers 409.

## Test

```bash
cd mcp
npm run typecheck
npm run lint            # root biome over src/ and test/
npm test                # node --test "test/**/*.test.ts"
```

- `test/bridge.test.ts`: pure unit tests of the bridge in `node:vm` (no browser).
- `test/smoke.test.ts`: stdio end-to-end tests of every local tool against
  `tests/fixtures/demo.map` (core, mutations, persistence blocks).
- `test/sketch.test.ts`: a sketch of 9 ops on demo.map (renames incl. a generated name, a
  recolour, a new burg, a route to it by its sketch id, a marker with a note, a painted circle,
  a layer toggle), undo/redo inside it, the summary, and replays onto copies someone else
  edited: ids shift and their edits survive; a removed target and a both-changed field are
  conflicts (`stop` and `skip`); a regenerate makes it blob-only.
- `test/sketch.test.ts` (network): in a live-mode server against the fake Worker: save →
  list → the view link opened in a test-owned headless page loads the sketch (and its Save to
  shared asks first) → open in a fresh local-mode server (save/discard/promote refused there)
  → someone else saves v7 → sketch_promote refuses "rebase first" → rebase → promote preview,
  token, confirm (one PUT with X-Map-Version 7, no overwrite) → `then:'discard'` DELETE; a
  blob-only sketch refuses rebase but saves; never a DELETE of shared.
- `test/ops.test.ts`: pure tests of the ops log, id rewriting and replay helpers.
- `test/shared.test.ts`: the shared tools against `test/fake-worker.ts`, an in-process
  `node:http` fake of `cloudflare/worker/src/index.ts` on 127.0.0.1. It covers local-mode
  refusals and, in a live-mode server, preview, token, confirm (exactly one PUT with
  X-Map-Version and no overwrite header), token reuse, STALE, force, a 409, LOCKED, the
  build block, LINEAGE and restore. Also: `SharedApi` refuses sketch writes to any id not
  starting with `sketch-` and outside live mode before sending anything, and the app's client
  guard (a ?maplink page asks before replacing shared, Replace sends the named version, a
  normal boot saves at once).

Tests never touch the live site: `test/helpers.ts` defaults `TUPAIA_LIVE_ORIGIN=none` and
throws if any test points it at activationlayer.org. Never run the repo's Playwright e2e
suite as part of this.

A write rehearsal against a real Worker: run `wrangler dev --local` with a scratch config and
`--persist-to` a scratch directory (never the repo's `cloudflare/.wrangler`), then spawn the
server with `TUPAIA_MODE=live TUPAIA_LIVE_ORIGIN=http://127.0.0.1:<port>`.
