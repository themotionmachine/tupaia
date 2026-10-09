# Tupaia MCP cheatsheet

The `tupaia` MCP server drives the built Tupaia app (Azgaar's Fantasy Map Generator fork) in
headless Chromium. 28 tools. Local mode by default: nothing writes the live shared map
(map.activationlayer.org) except `shared_save`/`shared_restore`/`sketch_promote`, and those
only in a server a human spawned with `TUPAIA_MODE=live`, behind a preview and a one-time token.
`sketch` save/discard write only the Worker's `sketch-<slug>` maps (live mode too).

## The 28 tools

| tool | one line |
| --- | --- |
| `session {action?:'status'\|'set_mode'\|'restart', mode?:'local', restore?, clear?}` | mode, origin reads hit, app version, browser, provenance, undo counts, console errors, outward requests, `serving` (http daemon). `set_mode` only drops live to local. |
| `map_info {since?, diff?:'list'\|'counts', overview?, detail?}` | overview + diff since the newest snapshot/undo point, `'checkpoint'`, a snapshot index/label, or `'none'`. `diff:'counts'` = counts only, no overview. |
| `find {type, name?, where?, near?, radius?, sort?, fields?, limit?, offset?, format?}` | list/filter one type (incl. `routeGroup`, `biome`, `namesbase`); `format:'compact'` = text rows. |
| `inspect {entity:{type,ref}} \| {at:Place} \| {at:{screen:[px,py], shot}}, format?, fields?` | one entity or one cell; id/name and x,y/lat,lon conversion. |
| `flow {from, heights?, fill?, detail?, screenshot?}` | read-only: where water runs from a place, on current or proposed heights. |
| `screenshot {target?, zoom?, full?, view?, layers?, labels?:'all', compare?, crop?:'changed', pad?, sideBySide?, ...}` | JPEG (maxSide 1024) + full PNG on disk + shotId; compare diffs against a shot. |
| `lint {checks?, types?, bbox?\|near+radius, minSeverity?, ignore?, limit?, ...}` | read-only quality check; rows carry ready `fix` calls, some checks a `fixAll`. |
| `display {on?, off?, only?, layersPreset?, stylePreset?, styleRules?, labels?}` | persistent layers, style and label visibility (undoable). |
| `edit {type, ops:[{ref, set}\|{ref, remove:true}], force?, recalculate?, dryRun?, rows?, ...}` | change or remove many entities of one type; type `map` = map fields and world settings. |
| `add {type, items:[...], dryRun?, rows?, ...}` | create burgs, states, markers, routes, routeGroups, zones, labels, notes, cultures, religions, biomes. |
| `paint_cells {select, set, feather?, dryRun?}` | assign state/province/culture/religion/biome/zone/height to cells. |
| `set_heights {grid\|pack\|image, fill?, rebuild?, erosion?, keepHeights?, biomes?, dryRun?}` | replace the heightmap and rebuild coast, climate, rivers, biomes; entities carried over. |
| `apply {<lists>, map?, specPath?, mode?:'upsert'\|'update'\|'check', mapping?, ignore?, tolerance?, only?}` | bring the map in line with a spec by name, or check it. Idempotent. |
| `clear {types, where?, keep?, force?, orphanRoutes?, detail?, dryRun?}` | remove every entity of some types (wipe a random base), with each editor's cascade. |
| `compact {types?, repointProvinces?, dryRun?, details?, limit?}` | shrink removed records to id-keeping stubs; drop their notes and SVG. |
| `regrid {density, heights?, ice?, relief?, details?, dryRun?}` | change the cell density and keep the map (id, names, notes, labels). |
| `generate_map {seed, template?, cells?, states?, cultures?, ...}` | new map, deterministic for the same seed and options. |
| `regenerate {parts:[...], restoreLayers?, biomes?, provinces?, emblems?, relief?, dryRun?}` | partial regeneration; biomes/provinces/emblems/relief take options and replay in sketches. |
| `snapshot {action:'take'\|'list'\|'drop'\|'restore'\|'undo'\|'redo', label?, index?, n?, saveTo?}` | named whole-map snapshots and the auto-undo/redo history. |
| `eval {code, args?, readOnly?, redraw?, timeoutMs?}` | escape hatch: JS in the page (read tupaia://docs/runtime-api.md first). |
| `load_map {path} \| {source:'shared'}` | load a .map file, or the live shared map (a read-only GET). |
| `save_map {path?, overwrite?, allowOutside?, compact?}` | write the map as a .map file (`compact:true` = compacted copy). |
| `export {format, path?, scale?, ...}` | svg, png, jpeg, json-full, json-minimal, geojson-cells/-routes/-rivers/-markers/-zones. |
| `shared_status {versions?, build?}` | live shared map metadata vs the page map: lineage, stale, build check. |
| `shared_save {confirm?, token?, force?, replaceWithUnrelated?, expectVersion?, skipBuildCheck?, compact?}` | OUTWARD: overwrite the live shared map (preview, then confirm + token). |
| `shared_restore {version, confirm?, token?, expectCurrent?, force?, reload?}` | OUTWARD: roll the live shared map back to a retained version. |
| `sketch {action, slug?, note?, onConflict?, confirm?, shots?, full?, compact?}` | provisional change: ops log against shared version N; summary, save (view link), list, open, rebase, discard. |
| `sketch_promote {confirm?, token?, then?:'keep'\|'discard', compact?}` | OUTWARD: put the active sketch on the live shared map (rebase first). |

Every tool's arguments: `tupaia help <tool>` (CLI) or the tool's own schema.

## Refs and places

- Ref: `17`, `"17"`, `{id:17}`, `"Norvik"`, `{name:"Norvik"}`. Names: exact, then case/diacritic
  folded (states/provinces also match fullName). Never fuzzy. Id 0 only for state (Neutrals),
  culture (Wildlands), religion (No religion). Notes and labels use string ids (`burg12`,
  `label3`); route groups too (`route-tunnels`, or the display name).
- Place: `{x,y}` map px | `{lat,lon}` | `{cell}` | `{entity:{type,ref}}` |
  `{entity:{type:'route'|'river',ref}, at:0.5}` (fraction along). Out of the map: OUT_OF_BOUNDS.
- Names to set: a string, or `{generate:{base:<namesbase>}}`, `{generate:{culture:<ref>}}`,
  `{generate:{}}` (own culture). Generated names avoid names already used by that type.

## Mutating tools: common rules

Every mutating tool validates everything first (nothing changes on an invalid op unless
`continueOnError`), takes ONE auto-undo entry (`snapshot {action:'undo'}` reverts the whole
call), coalesces redraws and returns `changes`. `dryRun:true` returns the plan only. Hidden
layers are not redrawn (`skippedHidden`); they draw when turned on.

- `changes` lists up to 8 changed entities in full; beyond that, per type `counts` + the first 3
  of each list + `more:{list:n}`. `edit`/`add` `rows:'ids'` returns `appliedIds`/`createdIds`
  instead of one row per op.
- `redraw:false` redraws nothing; an array replaces the computed list (all, features, heightmap,
  biomes, cultures, religions, states, provinces, borders, rivers, routes, zones, markers,
  burgIcons, labels, stateLabels, burgLabels, emblems).

### edit fields

| type | set | remove |
| --- | --- | --- |
| burg | name, population (people), group, type, culture, port, lock, move (Place: land, free cell) | yes; a capital or market centre needs `force` |
| state | name, fullName, form, formName, color, capital (burg ref inside), culture, lock | yes: its provinces, label and regiment notes go too (not Neutrals) |
| province | name, fullName, formName, color, capital (burg inside), lock | yes: cells become province-less |
| culture | name, color, type, base (namesbase), expansionism, lock | yes: cells, burgs, states, religions fall back to 0 |
| religion | name, color, type, form, deity, expansionism, lock | yes: cells fall back to No religion |
| river | name, type, mainStem, split, merge, reroute (see Rivers) | yes (with tributaries) |
| route | group (id or name), name, lock, points | yes |
| routeGroup | id (rename), name, stroke, width, dash, linecap, opacity, after, before | only when empty, or `force` (+`moveTo`) |
| marker | type, icon, size, pinned, lock, note {name?, legend? (HTML)}, move | yes (with its note) |
| zone | name, type, color, hidden | yes |
| feature | name, group | REFUSED |
| note | name, legend | yes |
| label | text ('\|' = new line), move (straight labels), group (another #labels group, made if missing) | yes |
| biome | name, color (any CSS colour), habitability, iconsDensity (> 0 needs icons), icons, cost | - |
| map (no ref) | name, populationRate, urbanization, year, era, reliefOnLoad + world settings | - |

- A state's capital changes only through `edit state {capital}`: the old one is demoted, the
  centre moves to the new capital's cell.
- A single edit remove ignores `lock`, as the app's editors do; `clear` honours it.
- Burg remove options per op: `force:true` (or `edit {type:'burg', force:true}` for every op),
  `newCapital:<burg in the same state>` (default: its most populous other burg),
  `orphanRoutes:true` (also remove routes that served only removed burgs; locked ones only with
  force). Markets are removed and their burgs join other markets; a province headed by the burg
  gets its first other burg. Route links are repaired once per call (`routeLinksFixed`).

### add items

| type | item |
| --- | --- |
| burg | `{at: Place (land, free cell), name?, population?, group?, type?, culture?, port?}` |
| state | `{capital: Place \| {burg: ref}, name?, color?, culture?, form?, formName?, expand?}` (`expand:true` re-expands unlocked states, regenerates provinces) |
| marker | `{at, type?, icon?, size?, pinned?, note?: {name, legend}}` |
| route | pathfound `{through:[Place...], group?, name?}` (land only; NO_PATH says why) or freehand `{points:[Place \| [x,y,cell]...], noPathfind:true, group?, name?, lock?}` |
| routeGroup | `{id:'route-<slug>', name?, stroke?, width?, dash?:'2 1.2'\|null, linecap?, opacity?, after?\|before?}` |
| zone | `{name?, type?, color?, cells?: [ids] \| select?: <paint_cells select>}` |
| label | `{at, text, group?}` (default addedLabels) |
| note | `{id:'burg12' \| entity:{type,ref}, name, legend?}`; fails if it exists (edit it) |
| culture / religion | `{at (land), name?, color?, type?, base?/form?/deity?, expansionism?, expand?}` |
| biome | `{name, base?:<biome to copy>, color?, habitability?, iconsDensity?, icons?, cost?}` (no base: 50, 0, none, 50) |

### paint_cells

`select`: union of `cells:[ids]`, `circle:{at, radius, unit?:'px'|'km'|'mi'}`,
`polygon:[Place...]`, `entity:{type, ref}`, then filtered by `where:{land, water, hMin, hMax,
biome, state, province, culture, religion, feature, burg, river}`.

| set | rules |
| --- | --- |
| state | land only; never a state centre or a capital's cell; burgs follow; provinces re-fitted |
| province | land of the province's own state; never a province centre |
| culture / religion | land only (culture: burgs follow) |
| biome | name or id; land only; `feather:{width, unit?:'px'\|'cells', seed?}` frays the edge |
| zone | ref (adds cells) or `{ref, op:'add'\|'remove'}` |
| height | alone in its call; `{value \| delta \| smooth:n, rebuild?}` |

Height `rebuild`: `keep` (default) land only, 20..100, refuses a change across 20 (`clamp:true`
stops at 20); `risk` rebuilds coast, lakes, climate, rivers and re-packs the cells, carrying
burgs, routes, markers, regiments and lake/island names to the new cells (`erosion:true` re-runs
erosion); `erase` regenerates every entity (`confirmErase:true`). For whole-map terrain use
`set_heights`.

## Feature notes

**World settings** (`edit {type:'map'}`): mapSize, latitude, longitude, temperatureEquator,
temperatureNorthPole, temperatureSouthPole (Celsius), winds (6 angles north to south, or
`{tier: degrees}` for some tiers 0-5), precipitation, distanceScale, distanceUnit, areaUnit,
heightUnit, heightExponent, temperatureScale. A value or `{value, lock:true|false}`; op-level
`lock`/`unlock`: names or `'all'`. Locks survive generate_map and travel in the .map
(`options.tupaiaLocks`), so save/load, undo and restore keep them. Settings only set inputs:
`recalculate:'climate'|'biomes'|'rivers+biomes'|'climate+biomes'` refreshes now (rivers and
hand-painted biome cells are replaced; lake names and custom-biome cells kept; `ops` may be
omitted); otherwise read `stale` in the result.

**Rivers** (one structural change per op; ops of a call apply in order):
`mainStem:<tributary>` (its upper course becomes this river's; the old upper course becomes
that tributary), `split:{at: Place, name?, type?}` (upper part = new river, in `created`; each
part keeps 3+ cells), `merge:true` (inverse of split), `reroute:{cells:[...]}` or
`{from, to: Place|'edge', through?, snap?:false, edge?}` (no crossings; a climb is a warning;
notes give discharge before -> after). `find river fields:['joinsAt','tributaries']`.

**Routes**: freehand routes are drawn exactly, may cross water, are locked by default (regenerate
keeps them), up to 2000 points; a burg point uses the burg's cell; `[x,y,cell]` pins a cell.
One cell link per consecutive pair; the last route through a pair owns it. `edit route
{set:{points}}` re-links (add `lock:true` to a generated route). `regenerate routes` renumbers
locked routes: read `routeIds {old:new}`. Style presets leave custom groups alone.

**Biomes**: icons are weights over acacia, cactus, conifer, deadTree, deciduous, dune, grass,
palm, swamp, hill, mount, mountSnow, vulcan. New values show after `regenerate
{parts:['relief']}`. `regenerate {parts:['biomes'], biomes:{from?:'climate'|'current', noise?,
mode?:'warp'|'jitter', smooth?, minRegion?, seed?, keepPainted?:true|'custom'|false, keepRivers?,
keep?, exclude?, select?}}`: natural edges; custom biomes and painted cells are kept by default.
Try seeds with dryRun, then apply once.

**Provinces and emblems**: `regenerate {parts:['provinces','emblems'], provinces:{states, centres?:
[{state, burg|at, name?}] | count?:N, crossForeign?, keepLocked?, lockedStates?}, emblems:{states,
provinces?, burgs?, shieldOnly?, stateCulture?}}`: only those states (also hand-made ones with no
burgs); culture shields. dryRun previews sizes. Turns no layer on.

**Relief icons**: `regenerate {parts:['relief'], relief:{density?|matchIcons?, perBiome?,
minHeight?, exclude?|excludeAdd?|excludeRemove?, nearBurgs?:{radius, unit}, seed?, onLoad?}}` draws
seeded icons with settings stored on the map (map_info `relief`). The count goes with density²
(0.7 = about half). `matchIcons:<n>` picks the density that draws about n (`true` = the current
count; the relief layer must be on). `edit map {set:{reliefOnLoad:true}}`: saves drop the icons
and loads redraw them (about 80 B per icon: terraform-v3.map 4.75 -> 2.33 MB); shared_save and
sketch_promote refuse it (BUILD) until the deployed app has the hook.

**Labels**: the app hides a label group while its on-screen size is under 6 px or over 60 px
(emblems 25/300), so most burg labels vanish at full-map zoom. `display {labels:{town:{minSize:0},
capital:{alwaysShow:true}, '*':{...}, emblems:{...}, <group>:null}}` overrides that per group,
saved with the map; the result says each group's `zoom` range. `display {labels:'list'}` reads
them (pass it alone). `screenshot {labels:'all'}` shows every text label for one shot only.
Labels must be drawn: a map saved without them needs `eval {code:'1', readOnly:true,
redraw:['labels']}`.

**Terrain**: `set_heights` takes exactly one source: `grid` (one 0-100 per GRID cell, grid order;
a wrong length says the expected one), `pack:{cellId: h}` (sparse) or `image:{path|dataUrl,
invert?, range?:[lo,hi], channel?}`. Sea level 20. `fill:true` fills pits. `rebuild:'risk'`
(default) re-packs and carries entities; `'keep'` refuses land/water flips. Rivers regenerate;
a river overlapping an old course keeps its id, name and type. `keepHeights` (default true)
restores land heights the rebuild changed. `biomes:'redefine'` (default) | `'keep'`. dryRun
returns changed, toLand/toWater, landPct, lakes, pits, burgsOnNewWater, paintedBiomes.
`flow {from:[Place|{gridCell}...], heights?:<same sources>, fill?}` traces drainage first
(`end.type` sea/lake/river/border/pit; `goesTo` where a river ends).

**regrid**: density 1-13 (4 = 10K, 6 = 30K) or 1000-100000 points; dryRun gives cells.est,
bytes.est and atRisk. Entities move by coordinates; read entities.*.lost, fixed, warnings, then
screenshot the coast. Lowering merges cells.

**clear**: types notes, labels, markers, zones, routes, rivers, burgs, provinces, states,
religions, cultures, emblems (run in that dependency order). `where` per type
(`{burgs:{populationMax:500}, routes:{group:'trails'}}`, `{i:[ids]}`) or bare with one type; with
where keyed by type, an unlisted type is cleared entirely. `keep:[{type,ref}]` and `lock:true`
entities stay unless `force`. Never removes id 0. Emblems are hidden (coa.size 0), not deleted.

**compact**: removed burgs/states/provinces/cultures/religions become `{i, removed:true}`
(cultures keep base and center); no id changes. Records live data still points at stay whole:
`keptBy`/`keptWhy` say what frees them (deal: `regenerate {parts:['production']}`, re-rolls every
live burg's economy; provinceBurg: `repointProvinces:true`). Afterwards a removed id answers
REMOVED without its name. Refused while an editor is open.

**apply**: lists burgs, markers, labels, zones, routes, notes, states, provinces, cultures,
religions, rivers, features, biomes, routeGroups, plus `map` (fields and settings, incl. locks).
Keyed by name (labels: text; notes: id | entity:{type,name} | entity:'Name' | name), route
groups by id. Found: only differing fields edited; missing: created (`upsert`) or reported
(`update`); `check` is read-only and previews exactly what upsert would do. Routes:
`through:[names|[x,y]]` (pathfound) or `draw:'points'` (freehand). An entry's `note` (string or
{name, legend}) becomes its note. Rivers are matched, never created. `mapping` {lists, keys,
values} renames first; `ignore` {list:[keys]}; `tolerance` {px, number, fields, legend:'contains'}.
Rows: unchanged | updated | created | differs | missing | error with diffs {field, have, want}.

**lint checks**: label-offcanvas, label-overlap, label-orphan, marker-stacked, marker-cell-link,
marker-in-water, burg-in-water, burg-shared-cell, burg-cell-link, capital-outside, province-empty,
state-empty, unnamed, name-duplicate, river-uphill, river-loop, river-gap, route-link,
route-point-cell, route-end-burg, note-orphan; opt-in (name them): label-marker-overlap,
marker-near-burg. Rows `{sev, e:[[type,ref,name]], at, msg, fix:{tool,args}|hint}`; `fixAll` per
check for route-link, route-point-cell, route-end-burg, marker-cell-link, note-orphan. An
unfiltered overview lists warn/error rows only.

## Reading cheaply

- `find {..., format:'compact'}`: `burg 12 Agamathel pop=61419 state=3 capital at=(812,440)` rows
  plus a `names:` legend; `fields` picks columns; strings cut at 80 chars unless named.
- `inspect {..., format:'compact', fields:[...]}`: key=value lines (about a fifth of the JSON).
- `map_info {since:'<label>', diff:'counts'}`: `{type:{added, removed, changed}, cells, settings}`.
- `screenshot {compare:'s3', crop:'changed', sideBySide?:true}`: only the changed region; nothing
  changed = no image, one-line note. Keep the frame: no target/zoom with compare.
- `edit`/`add` `rows:'ids'`; `lint {limit:0}` = counts only; `apply` lists counts first.

## Error codes

Errors come back as `isError` with `CODE: message`, an optional `candidates:` line, then JSON
`{error:{code, message, candidates?, details?}}`. Batch errors carry `details.errors`
[{index, code, message, candidates?}].

| code | meaning |
| --- | --- |
| NOT_FOUND, AMBIGUOUS | ref did not resolve; read `candidates` and retry with an id |
| REMOVED | the id exists but the entity was removed |
| OUT_OF_BOUNDS, BAD_PLACE | a Place outside the map / malformed |
| BAD_ARGS, BAD_FIELD, BAD_TYPE, BAD_REF, BAD_LAYER | invalid input |
| NO_PATH | add route: no land path (use a freehand route) |
| REFUSED | a guard said no (capital without force, path policy, editor open, token, ...) |
| CHANGED | sketch replay of a clear: the target was renamed, renumbered, reused or locked since |
| MODE | local mode: no shared or sketch writes; or TUPAIA_LIVE_ORIGIN=none |
| STALE, LOCKED, LINEAGE, BUILD, CONFLICT | shared-map gate (see below) |
| SKETCH | a stopped rebase holds the page |
| NETWORK | a request to the live origin failed |
| TIMEOUT, CANCELLED | out of time / cancelled (a mutating one relaunches and restores before the next call) |
| EVAL_ERROR, EVAL_SYNTAX | eval threw / did not parse |
| APP_ALERT | the app showed an error dialog (Invalid/Ancient/Newer file, Generation error) |
| PAGE_ERROR, BROWSER, STALE_OP | page or browser failure |
| RESULT_TOO_LARGE | narrow the request (limit, fields, where) |
| SIZE_MISMATCH | screenshot compare of different-size shots |

## Layers, templates, presets

Layers: texture, heightmap (height), lakes, biomes, cells, grid, coordinates, compass, rivers,
relief, religions, cultures, states, provinces, zones, borders, routes, temperature, ice, goods,
markets, trade, precipitation, population, emblems, burgs (burgIcons), labels, military,
markers, rulers, scaleBar, vignette.

Templates: volcano, highIsland, lowIsland, continents, archipelago, atoll, mediterranean,
peninsula, pangea, isthmus, shattered, taklamakan, oldWorld, fractious, plus the precreated
heightmaps. Style presets: default, ancient, gloom, pale, light, watercolor, clean, atlas,
darkSeas, cyberpunk, night, monochrome, or a saved `fmgStyle_*`. Layer presets: political,
cultural, religions, provinces, biomes, heightmap, physical, poi, goods, trade, military,
emblems, landmass. display order: `layersPreset`, then `only`, then `on`/`off`.

generate_map: options given are locked so the generator keeps them; `cells` is a density 1-13
or a count; same seed + options = same map (`digest`). regenerate parts run in this order:
rivers, biomes, population, cultures, burgs, states, provinces, routes, religions, emblems,
military, markers, zones, ice, goods, markets, economy, production, relief; `states` reseeds the
random stream; `restoreLayers:true` undoes layer changes.

## Files

- save_map/export: relative paths go under TUPAIA_OUT (default `<repo>/.tupaia-mcp-out`). load_map:
  relative paths resolve from the repo root (the CLI first tries your cwd). Prefer absolute paths.
- In the repo only a subfolder outside `src/`, `public/`, `mcp/`, `cloudflare/`, `docs/`, `dist/`,
  `tests/`, `node_modules/` and dot-folders, never over a git-tracked file. Elsewhere needs
  `allowOutside:true` (only where the human named). `overwrite:true` replaces. `tests/fixtures`
  is always refused. Both refuse while an app editor is open.
- export png/jpeg rasterise the whole map at graph size x `scale`; svg `fullMap:false` = the view.

## Shared map (outward)

- Reads work in both modes: `shared_status`, `load_map {source:'shared'}`, `sketch list/open/rebase`.
- Writes need a server spawned with `TUPAIA_MODE=live`. `shared_save` without `confirm` =
  preview `{wouldOverwrite, lineage, stale, buildCheck, bytes, token, refusalReason?}`; the token
  is valid 10 minutes, one write, the same live version, page map and flags (`force`,
  `replaceWithUnrelated`, `skipBuildCheck`, `compact`).
- LINEAGE: only `replaceWithUnrelated` overrides. STALE, LOCKED: `force` (human-approved).
  BUILD: a newer local app VERSION, or a reliefOnLoad map on a deploy without the hook, is never
  overridable; an unverifiable build needs `skipBuildCheck`. CONFLICT: the Worker answered 409.
- Backups go to `TUPAIA_OUT/shared-saves/` before every write. Display changes ship with the save.

## Sketches

A sketch is base version N of the shared map plus the ops log that produced it.
`load_map {source:'shared'}` (no edits) -> `sketch {action:'start', slug, note}` -> every
mutating call is logged with what it resolved to (ids, literal names and cells, created ids) ->
`summary` -> `save {confirm:true}` (live mode; returns `viewUrl`) -> on yes `rebase` (replays
onto the current shared map, keeping others' edits) -> `sketch_promote {}` -> `{confirm:true,
token}`. `status` shows the log, `blobOnly` and `blobOnlyReasons`; undo/redo pops/pushes ops.

| replays on rebase | makes the sketch blob-only (save/view/promote as is; no rebase) |
| --- | --- |
| edit (incl. map settings + recalculate), add, paint_cells (incl. height keep and risk, feather), display (incl. labels), apply (logged as its add/edit/paint_cells steps), set_heights, clear, compact, regenerate with only biomes/provinces/emblems/relief, eval (verbatim, marked unsafe) | regenerate with any other part, generate_map, load_map, snapshot restore, regrid, paint_cells height `erase`, screenshot `keepLayers`, a call that failed part-way |

Read-only calls (find, inspect, map_info, flow, lint, screenshot, `display {labels:'list'}`) and
no-op calls are not logged. Rebase conflicts: a missing/removed target, a field both sides
changed, a reused id, a removal of something changed since, renumbered cells, a changed
derived layer (settings recalculate, relief keys), a CHANGED clear target. `onConflict:'stop'`
(default) leaves the partial replay (`snapshot undo n` returns); `'skip'` drops the op. A
blob-only sketch: promote it while the shared map is still at its base; otherwise start over.

## CLI (no Claude restart)

`/Users/mgm1/Desktop/code/vespucci/mcp/bin/tupaia --out <dir> call <tool> '<json>'` (or `-` with
JSON on stdin) runs any tool on a shared http daemon (one per out dir: same page, undo, sketch).
Prints the result, then `IMAGE: <path>`; a tool error prints `ERROR CODE: message`, exit 1.
Also `tools [<tool>]`, `help <tool>`, `status`, `start`, `stop`, `headers`. Mode comes from the
daemon's spawn environment only.

## Recipes

1. Rename burgs from a name base: `find {type:'burg', where:{state:'Gazd'}, format:'compact'}` ->
   `edit {type:'burg', ops:[{ref:108, set:{name:{generate:{base:'Hawaiian'}}}}], dryRun:true}` ->
   without dryRun -> `screenshot {target:{entity:{type:'state', ref:'Gazd'}}}`.
2. Remove a capital: `edit {type:'burg', ops:[{ref:'Krar', remove:true, newCapital:'Kazzuz',
   orphanRoutes:true}], force:true, dryRun:true}` -> without dryRun.
3. Styled freehand road: `add {type:'routeGroup', items:[{id:'route-tunnels', name:'tunnels',
   stroke:'#5b4a3a', width:0.6, dash:'2 1.2', linecap:'butt'}]}` -> `add {type:'route',
   items:[{points:[{entity:{type:'burg', ref:'Kazzuz'}}, {x:230, y:560}, {x:300, y:620}],
   noPathfind:true, group:'tunnels', name:'Deep Way'}]}`.
4. Terraform: `snapshot {action:'take', label:'pre-terrain'}` -> `set_heights {image:{path:'/abs/h.png',
   range:[0,80]}, fill:true, dryRun:true}` -> `flow {from:[{x:840, y:420}], heights:{image:{...}},
   fill:true}` -> `set_heights {...}` -> `edit {type:'map', ops:[{set:{precipitation:{value:150,
   lock:true}}}], recalculate:'climate+biomes', dryRun:true}` -> `lint` -> `screenshot {full:true}`.
5. Build from a spec: `clear {types:['labels','markers','zones','routes','burgs','provinces',
   'states','religions','cultures'], dryRun:true}` (locked entities, e.g. freehand routes, are
   kept unless `force`) -> without dryRun -> `apply {specPath:'/abs/spec.json',
   mode:'check'}` -> `apply {specPath}` -> `apply {..., mode:'check'}` (expect only unchanged).
6. Quality pass: `lint {}` -> run each `fixAll`/`fix` call -> `lint {checks:[...]}` until clean;
   `ignore:[{check, type, id}]` for accepted findings.
7. Smaller file: `compact {dryRun:true, details:true}` -> `compact {repointProvinces:true}` ->
   `edit {type:'map', ops:[{set:{reliefOnLoad:true}}]}` -> `save_map {path:'x.map', compact:true}`.
8. Labels at full-map zoom: `display {labels:{town:{minSize:0}, capital:{alwaysShow:true}}}` ->
   `screenshot {full:true}`.
9. A/B check of an edit: `screenshot {full:true}` (s1) -> edit -> `map_info {diff:'counts'}` ->
   `screenshot {compare:'s1', crop:'changed', sideBySide:true}`.
10. Safe shared_save (only when the human asked): `session` (mode live) -> `shared_status
    {versions:true}` -> `shared_save {}` -> tell the human version, saver, lock, lineage, build ->
    on yes `shared_save {confirm:true, token}` -> report the new version and backup path.
11. Propose a change: `load_map {source:'shared'}` -> `sketch {action:'start', slug:'harbour',
    note:'...'}` -> edits -> `sketch {action:'summary'}` -> `sketch {action:'save', confirm:true}` ->
    give the human `viewUrl` -> on yes `sketch {action:'rebase'}` -> `sketch_promote {}` ->
    `sketch_promote {confirm:true, token, then:'discard'}`; on no `sketch {action:'discard', slug,
    confirm:true}`.
