# Tupaia MCP cheatsheet

The `tupaia` MCP server drives the built Tupaia app (Azgaar's Fantasy Map Generator fork) in
headless Chromium. 21 tools. Local mode by default: nothing writes the live shared map
(map.activationlayer.org) except `shared_save`/`shared_restore`/`sketch_promote`, and those
only in a server a human spawned with `TUPAIA_MODE=live`, behind a preview and a one-time token.
`sketch` save/discard write only the Worker's `sketch-<slug>` maps (live mode too).

## The 21 tools

| tool | one line |
| --- | --- |
| `session {action?:'status'\|'set_mode'\|'restart', mode?:'local', restore?, clear?}` | status: mode, origin reads hit, app version, browser, map provenance, snapshot/undo counts, console errors (`clear:true`), outward requests. `set_mode` only drops live to local. `restart {restore:'latest'}` reloads the map that was in the page (newest snapshot/undo point only if the page no longer answers; lost calls are named). |
| `map_info {since?, detail?}` | overview + diff since the newest snapshot/undo point, `'checkpoint'` (the previous map_info), a snapshot index/label, or `'none'`. |
| `find {type, name?, where?, near?, radius?, sort?, fields?, limit?, offset?}` | list/filter entities of one type; `type:'namesbase'` lists name bases. |
| `inspect {entity:{type,ref}} \| {at:Place} \| {at:{screen:[px,py], shot}}` | everything about one entity or one cell; id/name and x,y/lat,lon conversion. |
| `screenshot {target?, zoom?, full?, view?, layers?, keepLayers?, compare?, format?, maxSide?, scale?, saveTo?, overwrite?}` | JPEG (maxSide 1024) + full PNG on disk + shotId; `compare:shotId` returns a diff image and changedPct. |
| `display {on?, off?, only?, layersPreset?, stylePreset?, styleRules?}` | persistent layer visibility and style (undoable). |
| `edit {type, ops:[{ref, set}\|{ref, remove:true}], dryRun?, continueOnError?, redraw?}` | change or remove many entities of one type. |
| `add {type, items:[...], dryRun?, continueOnError?, redraw?}` | create burgs, states, markers, routes, zones, labels, notes, cultures, religions. |
| `paint_cells {select, set, dryRun?, redraw?}` | assign state/province/culture/religion/biome/zone/height to a cell selection. |
| `generate_map {seed, template?, cells?, states?, cultures?, ...}` | new map, deterministic for the same seed and options. |
| `regenerate {parts:[...], restoreLayers?}` | partial regeneration (rivers, routes, states, burgs, zones, ...). |
| `snapshot {action:'take'\|'list'\|'drop'\|'restore'\|'undo'\|'redo', label?, index?, n?, saveTo?}` | named whole-map snapshots and the auto-undo/redo history. |
| `eval {code, args?, readOnly?, redraw?, timeoutMs?}` | escape hatch: JS in the page (read tupaia://docs/runtime-api.md first). |
| `load_map {path} \| {source:'shared'}` | load a .map file, or the live shared map (a read-only GET). |
| `save_map {path?, overwrite?, allowOutside?}` | write the map as a .map file. |
| `export {format, path?, scale?, quality?, fullMap?, noLabels?, noWater?, noScaleBar?, noIce?, noVignette?, overwrite?, allowOutside?}` | svg, png, jpeg, json-full, json-minimal, geojson-cells/-routes/-rivers/-markers/-zones. |
| `shared_status {versions?, build?}` | live shared map metadata vs the page map: lineage, stale, build check (default only in live mode); `versions:true` lists retained versions. |
| `shared_save {confirm?, token?, force?, replaceWithUnrelated?, expectVersion?, skipBuildCheck?}` | OUTWARD: overwrite the live shared map (preview, then confirm + token). |
| `shared_restore {version, confirm?, token?, expectCurrent?, force?, reload?}` | OUTWARD: roll the live shared map back to a retained version. |
| `sketch {action:'start'\|'status'\|'summary'\|'stop'\|'rebase'\|'save'\|'list'\|'open'\|'discard', slug?, note?, onConflict?, confirm?, shots?, full?}` | provisional sketch: log every mutating call against base version N of the shared map; summarise it; save it as `sketch-<slug>` with a view link; replay it onto the current shared map. |
| `sketch_promote {confirm?, token?, then?:'keep'\|'discard'}` | OUTWARD: put the active sketch on the live shared map (refused until its base is the current version: rebase first); shared_save's preview + token gate. |

## Mutating tools: common rules

Every mutating tool validates everything first (nothing changes on an invalid op), takes ONE
auto-undo entry (`snapshot {action:'undo'}` reverts the whole call), coalesces redraws and
returns `changes` (the diff since that undo point). `dryRun:true` returns the plan only.
Layers that are hidden are not redrawn (`skippedHidden`); they draw when turned on.

- `edit {type, ops:[{ref, set:{...}} | {ref, remove:true}], dryRun?, continueOnError?, redraw?}`
  (one type per call; type `map` takes no ref).
- `add {type, items:[...], dryRun?, continueOnError?, redraw?}`.
- `paint_cells {select, set, dryRun?, redraw?}`.
- `generate_map {seed?, template?, cells?, states?, provincesRatio?, religions?, sizeVariety?,
  growthRate?, burgs?, cultures?, culturesSet?, width?, height?, options?}`.
- `regenerate {parts:[...], restoreLayers?}`.
- `display {on?, off?, only?, layersPreset?, stylePreset?, styleRules?}`.

`redraw`: `false` = redraw nothing; an array of redraw layers replaces the computed list
(all, features, heightmap, biomes, cultures, religions, states, provinces, borders, rivers,
routes, zones, markers, burgIcons, labels, stateLabels, burgLabels, emblems).

### edit fields

| type | fields (set) | remove |
| --- | --- | --- |
| burg | name, population (people), group (options.burgs.groups), type, culture, port (bool), lock, move (Place: land, free cell; a capital stays in its state) | yes, except capitals and market centres; its routes stay |
| state | name (fullName recomputed unless given), fullName, form, formName, color, capital (burg ref inside the state), culture, lock | yes (app stateRemove; not Neutrals) |
| province | name, fullName, formName, color, capital (burg inside the province), lock | REFUSED |
| culture | name (code re-abbreviated), color, type, base (namesbase), expansionism, lock | REFUSED |
| religion | name (code re-abbreviated), color, type, form, deity, expansionism, lock | REFUSED |
| river | name, type | yes (with tributaries) |
| route | group (roads, trails, searoutes or another #routes group), name, lock | yes |
| marker | type, icon, size, pinned, lock, note {name?, legend? (HTML)}, move (Place) | yes (with its note) |
| zone | name, type, color, hidden | yes |
| feature | name, group | REFUSED |
| note | name, legend | yes |
| label | text ('\|' = new line), move (Place; straight labels only) | yes |
| map | name, populationRate, urbanization, year, era | - |

A state's capital changes only through `edit state {capital: burgRef}`; `edit burg
{capital}` is BAD_ARGS. The old capital is demoted, the new one promoted, the state centre
moves to the new capital's cell.

Names: a string, or `{generate:{base:<namesbase ref>}}`, `{generate:{culture:<culture ref>}}`,
`{generate:{}}` (the entity's own culture). States/provinces get a state-style name;
generated names avoid names already used by that type.

### add items

| type | item |
| --- | --- |
| burg | `{at: Place (land, free cell), name?, population?, group?, type?, culture?, port?}` |
| state | `{capital: Place \| {burg: ref}, name?, color?, culture?, form?, formName?, expand?}`; a new burg is created at a Place; `expand:true` re-expands every unlocked state and regenerates provinces |
| marker | `{at, type?, icon?, size?, pinned?, note?: {name, legend}}`; a known type (volcanoes, ...) also gets the app's generated note |
| route | `{through: [Place, Place, ...], group?: 'roads'\|'trails'\|'searoutes', name?}`; pathfinds each leg; NO_PATH says why (water end, different landmasses, impassable); returns length in px and map units |
| zone | `{name?, type?, color?, cells?: [ids] \| select?: <paint_cells select>}` |
| label | `{at, text, group?}` (group default addedLabels) |
| note | `{id: 'burg12' \| entity: {type, ref}, name, legend?}`; fails if the note exists (edit it instead) |
| culture | `{at (land), name?, color?, type?, base?, expansionism?, expand?}` |
| religion | `{at (land), name?, color?, type?, form?, deity?, expansionism?, expand?}` |

### paint_cells

`select`: union of `cells:[ids]`, `circle:{at, radius, unit?:'px'|'km'|'mi'}`,
`polygon:[Place, Place, Place, ...]`, `entity:{type, ref}` (state, province, culture,
religion, feature, river, zone, burg, marker, route), then filtered by `where:{land, water,
hMin, hMax, biome, state, province, culture, religion, feature, burg, river}` (where alone
scans every cell).

| set | rules |
| --- | --- |
| state | land only; never a state's centre cell or a capital's cell; burgs follow; provinces re-fitted (`provincesAdjusted`) |
| province | land of the province's own state only; never a province centre |
| culture | land only; burgs follow |
| religion | land only |
| biome | name or id; land only |
| zone | ref (adds cells) or `{ref, op:'add'\|'remove'}` |
| height | alone in its call; `{value \| delta \| smooth:n, rebuild?}` |

Height `rebuild`:
- `keep` (default): land only, 20..100; any change that would cross height 20 (land to
  water or water to land) is REFUSED (message names 'risk'); `clamp:true` stops land at 20.
  Rivers, biomes and the coastline are not recomputed.
- `risk`: rebuilds the coastline, lakes, climate and the cell graph while keeping burgs,
  states, cultures, religions, provinces and zones (cell ids change; non-capital burgs that
  end up in water are removed). `erosion:true` also re-runs river erosion.
- `erase`: regenerates every entity from the new heights; needs `confirmErase:true`.

### generate_map, regenerate, display

- generate_map: options given are written to the options panel and locked so the generator
  keeps them; locks from an earlier generate_map that are not given again are released.
  Same seed + same options = same map (compare `digest`). `cells` is a density 1-13
  (1 = 1K, 4 = 10K, 13 = 100K) or a cell count. `cultures` is capped by the culture set
  (world 32, european 15, oriental 13, english 10, antique 10, highFantasy 17,
  darkFantasy 18, random 100). width/height also resize the browser viewport.
  Templates: volcano, highIsland, lowIsland, continents, archipelago, atoll, mediterranean,
  peninsula, pangea, isthmus, shattered, taklamakan, oldWorld, fractious, plus the
  precreated heightmaps.
- regenerate parts run in this order: rivers, population, cultures, burgs, states,
  provinces, routes, religions, emblems, military, markers, zones, ice, goods, markets,
  economy, production. Some turn their layer on (`layerChanges`); `restoreLayers:true`
  turns them back. `states` reseeds the random stream (not reproducible).
- display: `layersPreset` first, then `only`, then `on`/`off`. Layer presets: political,
  cultural, religions, provinces, biomes, heightmap, physical, poi, goods, trade, military, emblems,
  landmass. Style presets: default, ancient, gloom, pale, light, watercolor, clean, atlas,
  darkSeas, cyberpunk, night, monochrome, or a saved `fmgStyle_*`. `styleRules`
  `{'#states': {opacity: 0.6}}` is applied like a style fragment; unmatched selectors are
  warnings.

## Refs

`17`, `"17"`, `{id:17}`, `"Norvik"`, `{name:"Norvik"}`. Names: exact, then case/diacritic
folded (states/provinces also match fullName). Never fuzzy. Id 0 is valid only for state
(Neutrals), culture (Wildlands), religion (No religion). Notes and labels use string ids
(`burg12`, `label3`).

## Places

`{x,y}` map px | `{lat,lon}` | `{cell}` | `{entity:{type,ref}}` | `{entity:{type:'route',ref}, at:0.5}`.
Out-of-map places fail with OUT_OF_BOUNDS.

## Error codes

Errors come back as `isError` with the text `CODE: message`, an optional
`candidates: name (i), ...` line, then a JSON line `{error:{code, message, candidates?,
details?}, consoleErrors?, notes?}`.

| code | meaning |
| --- | --- |
| NOT_FOUND, AMBIGUOUS | ref did not resolve; read `candidates` and retry with an id |
| REMOVED | the id exists but the entity was removed |
| OUT_OF_BOUNDS, BAD_PLACE | a Place outside the map / malformed |
| BAD_ARGS, BAD_FIELD, BAD_TYPE, BAD_REF, BAD_LAYER | invalid input |
| NO_PATH | add route: no path (water end, different landmass, impassable) |
| REFUSED | a guard said no (capital removal, path policy, editor open, token missing/used/mismatched, ...) |
| MODE | local mode: no shared or sketch writes, or TUPAIA_LIVE_ORIGIN=none: no shared reads |
| STALE | the shared map moved on since the page map was loaded (or expectVersion/expectCurrent mismatch) |
| LOCKED | someone else holds the shared map's edit lock |
| LINEAGE | the page map is not derived from the shared map |
| BUILD | local app VERSION newer than the deployed one (never overridable), or unverifiable |
| CONFLICT | the Worker answered 409; `details.body` is its answer, `details.backup` the backups |
| NETWORK | a request to the live origin failed |
| TIMEOUT, CANCELLED | the call ran out of time / was cancelled (a mutating one relaunches the page and restores the newest snapshot before the next call) |
| EVAL_ERROR, EVAL_SYNTAX | eval threw / did not parse |
| APP_ALERT | the app showed an error dialog (Invalid/Ancient/Newer file, Generation error) |
| PAGE_ERROR, BROWSER, STALE_OP | page or browser failure |
| RESULT_TOO_LARGE | narrow the request (limit, fields, where) |
| SIZE_MISMATCH | screenshot compare of different-size shots |

Batch errors carry `details.errors` [{index, code, message, candidates?}].

## Layer names

texture, heightmap (height), lakes, biomes, cells, grid, coordinates, compass, rivers, relief,
religions, cultures, states, provinces, zones, borders, routes, temperature, ice, goods,
markets, trade, precipitation, population, emblems, burgs (burgIcons), labels, military,
markers, rulers, scaleBar, vignette.

(`height` = heightmap, `burgs` = burgIcons; screenshot/display take the names above.)

## Templates and style presets

Templates (generate_map `template`): volcano, highIsland, lowIsland, continents,
archipelago, atoll, mediterranean, peninsula, pangea, isthmus, shattered, taklamakan,
oldWorld, fractious, plus the precreated heightmaps.

Style presets (display `stylePreset`): default, ancient, gloom, pale, light, watercolor,
clean, atlas, darkSeas, cyberpunk, night, monochrome, or a saved `fmgStyle_*`.
Layer presets (display `layersPreset`): political, cultural, religions, provinces, biomes,
heightmap, physical, poi, goods, trade, military, emblems, landmass.

## Files: save_map and export

- Relative paths go under TUPAIA_OUT (default `<repo>/.tupaia-mcp-out`). A path in the
  repo is allowed only in a subfolder outside `src/`, `public/`, `mcp/`, `cloudflare/`,
  `docs/`, `dist/`, `tests/`, `node_modules/` and dot-folders, never in the repo root and
  never over a git-tracked file. Anything else needs `allowOutside:true` (only when the human
  named that place).
- `overwrite:true` to replace an existing file (also for `screenshot {saveTo}`).
  `tests/fixtures` is always refused.
- Extensions: save_map `.map`; export svg `.svg`, png `.png`, jpeg `.jpg`/`.jpeg`, json-* `.json`,
  geojson-* `.geojson`/`.json`.
- Both refuse while an app editor is open (`customization != 0`).
- export png/jpeg rasterise the whole map at graph size x `scale` (the renderer of
  `screenshot {full:true}`); for the current view use screenshot. svg takes `fullMap:false`
  for the current view. json-packcells and
  json-gridcells exist but are rarely what you want (eval returns arrays directly).

## Shared map (outward)

- Reads work in both modes: `shared_status`, `load_map {source:'shared'}`. They GET the
  origin `session` names (TUPAIA_LIVE_ORIGIN; `none` disables them). In local mode
  `shared_status` sends one GET (meta); `build:true` adds the build check (two more GETs).
- Writes need a server spawned with `TUPAIA_MODE=live` (a second `.mcp.json` entry a human
  adds by hand). `session {action:'set_mode', mode:'local'}` turns them off for good.
- A live-mode server loads the shared map on its first launch.
- `shared_save` without `confirm` = preview `{wouldOverwrite, base, lineage, stale,
  buildCheck, bytes, sha256, sends, overrides?, token, refusalReason?}`. The token is valid
  10 minutes, for one write, and only for the same live version, the same page map and the
  same flags (`force`, `replaceWithUnrelated`, `skipBuildCheck`). Preview with the flags you
  will confirm with.
- Checks: LINEAGE (only `replaceWithUnrelated` overrides; bound to the page's map id, so an
  eval that regenerates or loads a map breaks it), STALE and LOCKED (`force` overrides),
  BUILD block (nothing overrides), BUILD unknown (only `skipBuildCheck` overrides),
  `expectVersion` (nothing overrides).
- Before the PUT: the live blob and the outgoing body are written to
  `TUPAIA_OUT/shared-saves/v<N>-live-<time>.map` and `v<N>-outgoing-<time>.map`. The PUT
  carries `X-Map-Version: <N>` and never `X-Map-Overwrite`.
- `shared_restore` needs `expectCurrent` with `confirm`; the Worker itself has no version
  guard on restore. `reload` (default true) loads the result into the page.
- Layer visibility and style are part of the saved map: a `display` change ships with the
  next shared_save.

## Sketches (provisional changes)

A sketch is base version N of the shared map plus the ops log that produced it. Nothing here
writes the shared map.

- `sketch {action:'start', slug?, note?}`: needs the page map loaded with
  `load_map {source:'shared'}` and no edits since (else REFUSED with that fix). From then on
  every mutating call is logged as `{seq, tool, args, resolved, summary, at, digestBefore,
  digestAfter}`. `resolved` is what was applied: ids instead of names, literal generated names
  (a replay gives the SAME names), literal cell lists for paint selections, created ids for add,
  layer on/off lists for display, verbatim code for eval (flagged unsafe).
- Not replayable: `regenerate`, `generate_map`, `load_map`, `snapshot restore`, a call that
  failed part-way. They are logged and make the sketch blob-only (can be saved and viewed, not
  rebased) until undone. Undo stepping back past the sketch's start is permanent blob-only.
- `snapshot {action:'undo'}` takes the last op out of the log; `redo` puts it back. A call
  that failed without changing anything is logged as a no-op.
- `sketch {action:'status', full?}`: base, ops (`log`: seq, tool, summary), blobOnly and
  `blobOnlyReasons`, `dirty`. `full:true` adds every record with its resolved form (large).
- `sketch {action:'summary', shots?}`: markdown (base, one sentence per op, map counts vs base)
  plus four screenshots under `TUPAIA_OUT/sketches/<slug>/` (before/after, full map and framed
  on the most-changed entity, with that entity's layers on). It loads the base to shoot it and
  loads the sketch back (no undo entry). `shots:false` skips them.
- `sketch {action:'stop'}`: ends recording; the page keeps the changes. Later changes are not
  logged (status shows `diverged`).
- `sketch {action:'rebase', onto:{path}, onConflict?}` (test hook, TUPAIA_TEST_HOOKS=1):
  replay the log onto another map. Per op: ids of entities the sketch created are rewritten
  through the id map, then validated: a missing or removed target, an occupied cell, a NO_PATH
  route, or a field that both the sketch and someone else changed (`both changed <field>`) is
  a conflict. `onConflict:'stop'` (default) stops there and leaves the page with the partial
  replay (`snapshot undo n` returns to the sketch); `'skip'` drops the op and goes on. Each
  applied op pushes one undo entry. On completion the sketch's base is the new map and its
  ops are the applied ones. Returns `{applied, skipped, conflicts:[{seq, reason, op}], idMap}`.
- eval code is replayed verbatim: ids inside the code are not rewritten.

### Sketches on the Worker (network)

A saved sketch is the Worker map `sketch-<slug>` (the page map as a .map blob) plus
`/api/map/sketch-<slug>/ops` (ops.json: `{schema:1, slug, base, note, blobOnly,
blobOnlyReasons, blockers, author:'tupaia-mcp', created, updated, summaryMarkdown, baseCounts,
blob:{id, version, bytes, sha256}, viewUrl, ops}`). Sketch writes never touch `shared`: the
client refuses any id not starting with `sketch-`, and they need a server spawned with
`TUPAIA_MODE=live` (MODE otherwise). They never send X-Map-Overwrite.

- `sketch {action:'save', confirm:true}`: PUT the page map to `sketch-<slug>` (X-Map-Version =
  the sketch's own version; none on the first save, so an existing id answers CONFLICT), then
  PUT ops.json. Refreshes a stale summary (text only). Returns `viewUrl` =
  `<origin>/?maplink=<encodeURIComponent(origin + '/api/map/sketch-<slug>')>`, which opens the
  sketch in the app (not the shared map). Without `confirm`: a preview of the two PUTs.
  Refused while a stopped rebase holds the page, or for a test-hook (file-based) sketch.
- `sketch {action:'list'}`: read-only (works in local mode with a live origin): GET /api/maps,
  the `sketch-*` ids, each with its ops.json header (base, ops count, first 50 op summaries,
  blobOnly, author, created/updated) and viewUrl.
- `sketch {action:'open', slug}`: GET the blob and ops.json, load the blob into the page (an
  undo entry), make it the active, recording sketch. Origin kind `sketch` (`sketchSlug`,
  `sketchVersion`, `sharedVersion` = its base). A blob whose version or checksum differs from
  the one its ops.json was saved with is blob-only. Refused while another sketch records.
  Summaries of an opened sketch have no before shots (the Worker keeps no copy of its base).
- `sketch {action:'rebase', onConflict?}` (no `onto`): GET the current shared map vM, load it
  (one undo entry), replay the log onto it. On completion the base is vM, ops are the applied
  ones and the page holds the result with origin shared vM; nothing is saved. Refused for a
  blob-only sketch. On a stop, `snapshot undo n` returns to the sketch.
- `sketch {action:'discard', slug, confirm:true}`: DELETE `sketch-<slug>` (blob, versions,
  ops.json; cannot be undone). Without `confirm`: a preview with its version and author.
- `sketch_promote {}`: REFUSED "rebase first" unless the active sketch's base version is the
  shared map's current version. Otherwise it is `shared_save` with `expectVersion` = the base:
  the preview `{sketch, wouldOverwrite, lineage, stale, buildCheck, sends, token}`; then
  `sketch_promote {confirm:true, token, then?}`. LOCKED and BUILD refuse as in shared_save (no
  force here). On success the origin is shared at the new version, the sketch is no longer
  active, and `then:'discard'` DELETEs `sketch-<slug>` (`'keep'`, the default, leaves it).

## Recipes

1. Rename many burgs from a name base.
   `find {type:'burg', where:{state:'Fondia'}, sort:'-population', fields:['population'], limit:100}` →
   `edit {type:'burg', ops:[{ref:12, set:{name:{generate:{base:'Hawaiian'}}}}, ...], dryRun:true}` →
   the same without dryRun → `screenshot {target:{entity:{type:'state', ref:'Fondia'}}}`.
2. Recolour states. `edit {type:'state', ops:[{ref:'Chanland', set:{color:'#a33'}}, {ref:4, set:{color:'#3a6'}}]}`
   → `screenshot {full:true}`.
3. Carve a new state. `snapshot {action:'take', label:'before-carve'}` →
   `add {type:'state', items:[{capital:{burg:'Norvik'}, name:'Norvia'}]}` →
   `paint_cells {select:{circle:{at:{entity:{type:'burg', ref:'Norvik'}}, radius:60, unit:'km'}}, set:{state:'Norvia'}, dryRun:true}`
   → without dryRun → `map_info` (diff) → `screenshot {target:{entity:{type:'state', ref:'Norvia'}}}`.
4. Trade route with a midpoint marker. `add {type:'route', items:[{through:[{entity:{type:'burg', ref:'A'}}, {entity:{type:'burg', ref:'B'}}], group:'roads'}]}`
   → `add {type:'marker', items:[{at:{entity:{type:'route', ref:<new i>}, at:0.5}, type:'inns', note:{name:'Halfway Inn', legend:'...'}}]}`
   → `export {format:'svg', path:'route.svg'}`.
5. Zoomed screenshot of one entity. `screenshot {target:{entity:{type:'burg', ref:'Norvik'}}, zoom:8}`;
   for the pixel under something: `inspect {at:{screen:[412, 300], shot:'s3'}}`.
6. A/B a regenerate. `snapshot {action:'take', label:'A'}` → `screenshot {full:true}` (shot s1) →
   `regenerate {parts:['routes'], restoreLayers:true}` → `map_info {since:'A'}` →
   `screenshot {full:true, compare:'s1'}` → keep, or `snapshot {action:'restore', label:'A'}`.
7. Drain a lake (changes the coastline). `inspect {at:{x:800, y:400}}` (feature is a lake) →
   `snapshot {action:'take', label:'lake'}` →
   `paint_cells {select:{entity:{type:'feature', ref:<lake id>}}, set:{height:{value:25, rebuild:'risk'}}}` →
   `regenerate {parts:['rivers']}` → `screenshot {target:{bbox:[...]}, compare:<earlier shot>}`.
8. Export a full-map PNG. `export {format:'png', path:'map.png', scale:2}` (or `screenshot {full:true, scale:2}`
   to also see it).
9. eval + redraw. `eval {code:"pack.states.filter(s => s.i && !s.removed).forEach(s => s.color = d3.interpolateRainbow(s.i / 20)); return 'ok'", redraw:['states','borders']}`
   (undoable; `readOnly:true` for pure reads).
10. Safe shared_save (only when the human asked for the live map to change).
    `session` (mode must be live) → `shared_status {versions:true}` → `shared_save {}` (preview) →
    tell the human: version N, saved by X at T, lock holder, lineage, build check, refusalReason →
    on their yes: `shared_save {confirm:true, token:'<token>'}` → report the new version and the
    backup path. On STALE/LOCKED: stop and ask; only on an explicit yes preview again with
    `force:true` and confirm with `force:true` + the new token, and say that you forced it.
11. Propose a change as a sketch. `load_map {source:'shared'}` → `sketch {action:'start', slug:'harbour', note:'...'}`
    → edits + screenshots → `sketch {action:'summary'}` → `sketch {action:'save', confirm:true}` → give the
    human `viewUrl` and the markdown. On yes: `sketch {action:'rebase'}` → `sketch_promote {}` (tell them
    the version it replaces) → `sketch_promote {confirm:true, token:'<token>', then:'discard'}` → report
    the new version. On no: `sketch {action:'discard', slug:'harbour', confirm:true}`.
