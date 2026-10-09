# Tupaia MCP cheatsheet

The `tupaia` MCP server drives the built Tupaia app (Azgaar's Fantasy Map Generator fork) in
headless Chromium. 28 tools. Local mode by default: nothing writes the live shared map
(map.activationlayer.org) except `shared_save`/`shared_restore`/`sketch_promote`, and those
only in a server a human spawned with `TUPAIA_MODE=live`, behind a preview and a one-time token.
`sketch` save/discard write only the Worker's `sketch-<slug>` maps (live mode too).

## The 28 tools

| tool | one line |
| --- | --- |
| `session {action?:'status'\|'set_mode'\|'restart', mode?:'local', restore?, clear?, format?:'compact'}` | mode, origin reads hit, app version, browser, provenance, undo counts, console errors (newest 20 distinct), outward requests, `serving` (http daemon). `set_mode` only drops live to local. |
| `map_info {since?, diff?:'list'\|'counts', overview?, detail?:'summary'\|'list'\|'full'}` | overview + diff since the newest snapshot/undo point, `'checkpoint'`, a snapshot index/label, or `'none'`. `diff:'counts'` = counts only, no overview. A baseline holding another map gives `mapReplaced`, not a diff. |
| `find {type, name?, where?, near?, radius?, sort?, fields?, limit?, offset?, format?}` | list/filter one type (incl. `routeGroup`, `biome`, `namesbase`); `format:'compact'` = text rows; `warnings` for unknown fields. |
| `inspect {entity:{type,ref}} \| {at:Place} \| {at:{screen:[px,py], shot}}, format?, fields?` | one entity or one cell; id/name and x,y/lat,lon conversion; `warnings` for unknown fields. |
| `flow {from, heights?, fill?, detail?, screenshot?}` | read-only: where water runs from a place, on current or proposed heights. |
| `screenshot {target?, zoom?, full?, view?, layers?, labels?:'all', compare?, crop?:'changed', pad?, sideBySide?, ...}` | JPEG (maxSide 1024, at most 2048) + full PNG on disk + shotId; compare diffs against a shot (its frame and layers). |
| `lint {checks?, types?, bbox?\|near+radius, minSeverity?, ignore?, limit?, ...}` | read-only quality check; rows carry ready `fix` calls, some checks a `fixAll`. |
| `display {on?, off?, only?, layersPreset?, stylePreset?, styleRules?, labels?}` | persistent layers, style and label visibility (undoable). |
| `edit {type, ops:[{ref, set}\|{ref, remove:true}], force?, recalculate?, dryRun?, rows?, ...}` | change or remove many entities of one type; type `map` = map fields and world settings. |
| `add {type, items:[...], dryRun?, rows?, ...}` | create burgs, states, markers, routes, routeGroups, zones, labels, notes, cultures, religions, biomes. |
| `paint_cells {select, set, feather?, dryRun?}` | assign state/province/culture/religion/biome/zone/height to cells. |
| `set_heights {grid\|pack\|image, fill?, rebuild?, erosion?, keepHeights?, biomes?, dryRun?}` | replace the heightmap and rebuild coast, climate, rivers, biomes; entities carried over. |
| `apply {<lists>, map?, specPath?, mode?:'upsert'\|'update'\|'check', mapping?, ignore?, tolerance?, only?}` | bring the map in line with a spec by name, or check it. Idempotent. |
| `clear {types, where?, keep?, force?, orphanRoutes?, detail?, dryRun?}` | remove every entity of some types (wipe a random base), with each editor's cascade. |
| `compact {types?, repointProvinces?, dryRun?, details?, limit?}` | shrink removed records to id-keeping stubs; drop their notes and SVG. |
| `regrid {density, heights?, ice?, relief?, biomes?, details?, dryRun?}` | change the cell density and keep the map (id, names, notes, labels). |
| `generate_map {seed, template?, cells?, states?, cultures?, width?, height?, ...}` | new map, deterministic for the same seed and options (`digest`), in any session. |
| `regenerate {parts:[...], restoreLayers?, biomes?, provinces?, emblems?, relief?, dryRun?}` | partial regeneration; biomes/provinces/emblems/relief take options and replay in sketches. |
| `snapshot {action:'take'\|'list'\|'drop'\|'restore'\|'undo'\|'redo', label?, index?, n?, saveTo?}` | named whole-map snapshots and the auto-undo/redo history. |
| `eval {code, args?, readOnly?, redraw?:[layers]\|false, timeoutMs?}` | escape hatch: JS in the page (read tupaia://docs/runtime-api.md first). |
| `load_map {path} \| {source:'shared'}` | load a .map file, or the live shared map (a read-only GET). |
| `save_map {path?, overwrite?, allowOutside?, compact?}` | write the map as a .map file (`compact:true` = compacted copy). |
| `export {format, path?, scale?, ...}` | svg, png, jpeg, json-full, json-minimal, geojson-cells/-routes/-rivers/-markers/-zones. |
| `shared_status {versions?, build?, format?:'compact'}` | live shared map metadata vs the page map: lineage, stale, build check. |
| `shared_save {confirm?, token?, force?, replaceWithUnrelated?, expectVersion?, skipBuildCheck?, compact?}` | OUTWARD: overwrite the live shared map (preview, then confirm + token). |
| `shared_restore {version, confirm?, token?, expectCurrent?, force?, reload?}` | OUTWARD: roll the live shared map back to a retained version. |
| `sketch {action, slug?, note?, onConflict?, confirm?, shots?, full?, compact?, format?}` | provisional change: ops log against shared version N; status, summary, save (view link), list, open, rebase, discard. |
| `sketch_promote {confirm?, token?, then?:'keep'\|'discard', compact?}` | OUTWARD: put the active sketch on the live shared map (rebase first). |

Every tool's arguments: `tupaia help <tool>` (CLI) or the tool's own schema. Every tool except
`apply` (its lists go under any key) refuses an unknown top-level argument: BAD_ARGS `<tool> does
not take 'k'; allowed arguments: ...` (`details {unknown, allowed}`); a schema error is BAD_ARGS
`invalid arguments for <tool>: ...`. Per-op options (e.g. `orphanRoutes`) go inside the op.

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
call), coalesces redraws and returns `changes`. `dryRun:true` returns the plan only. Ops and
items apply in the order given. `redrawn` lists the layers the call drew, including what it drew
directly (routes, labels, burg names); hidden layers are not redrawn (`skippedHidden`, also for
`edit map` recalculate); they draw when turned on.

- `changes` lists up to 8 changed entities in full; beyond that, per type `counts` + the first 3
  of each list + `more:{list:n}` (`{mapReplaced:true}` in the rare case the call's own undo point
  holds a different map). Routes, markers and zones pair by identity within one map, so a
  regenerate shows them as added/removed, not modified; across a reload (undo, restore, load)
  they pair by id. `edit`/`add` `rows:'ids'` returns `appliedIds`/`createdIds` instead of one row
  per op (a dryRun still returns the plan). `changes` and map_info diffs show stored values: burg
  population in thousands (`[30, 4.677]`), while `set`, `applied` and find use people.
- `consoleErrors` in any result: identical messages fold into `msg (xN)`, most repeated first, at
  most 8 distinct (300 chars each), then `+K more distinct message(s) (M of T errors not shown)`;
  `session` status lists the newest 20 distinct `{at, kind, text, count?}`.
- `redraw:false` redraws nothing; an array replaces the computed list (all, features, heightmap,
  biomes, cultures, religions, states, provinces, borders, rivers, routes, zones, markers,
  burgIcons, labels, stateLabels, burgLabels, emblems).

### edit fields

| type | set | remove |
| --- | --- | --- |
| burg | name, population (people), group, type, culture, port, lock, move (Place: land, free cell) | yes; a capital or market centre needs `force` |
| state | name, fullName, form, formName, color, capital (burg ref inside), culture, lock | yes: its provinces, label and regiment notes go too (not Neutrals) |
| province | name, fullName, formName, color, capital (burg inside), lock | yes: cells become province-less |
| culture | name, color, type, base (namesbase), shield (a COA shield name), expansionism, lock | yes: cells, burgs, states, religions fall back to 0 |
| religion | name, color, type, form, deity, expansionism, lock | yes: cells fall back to No religion |
| river | name (its note's title follows when it holds the old name), type, mainStem, split, merge, reroute (see Rivers) | yes (with tributaries) |
| route | group (id or name), name, lock, points | yes |
| routeGroup | id (rename), name, stroke, width, dash, linecap, opacity, after, before | only when empty, or `force` (+`moveTo`) |
| marker | type, icon, size, pinned, lock, note {name?, legend? (HTML)}, move | yes (with its note) |
| zone | name, type, color, hidden | yes |
| feature | name, group | REFUSED |
| note | name, legend | yes |
| label | text ('\|' = new line), move (straight labels), group (another #labels group, made if missing) | yes |
| biome | name, color (any CSS colour), habitability, iconsDensity (> 0 needs icons), icons, cost | no (biomes cannot be removed; repaint their cells) |
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
| burg | `{at: Place (land, free cell), name?, population?, group?, type?, culture?, port?}`; like the app, a new burg gets a route to its nearest neighbour (row `routes`, a note) |
| state | `{capital: Place \| {burg: ref}, name?, color?, culture?, form?, formName?, expand?, capitalName?}`: a Place makes a new capital burg (with `culture`, it takes that culture and a name in it); `expand:true` re-expands unlocked states, regenerates provinces |
| marker | `{at, type?, icon?, size?, pinned?, note?: {name, legend}}` |
| route | pathfound `{through:[Place...], group?, name?}` (land only; NO_PATH says why) or freehand `{points:[Place \| [x,y,cell]...], noPathfind:true, group?, name?, lock?}` |
| routeGroup | `{id:'route-<slug>', name?, stroke?, width?, dash?:'2 1.2'\|null, linecap?, opacity?, after?\|before?}` |
| zone | `{name?, type?, color?, cells?: [ids] \| select?: <paint_cells select>}` |
| label | `{at, text, group?}` (default addedLabels) |
| note | `{id:'burg12' \| entity:{type,ref}, name, legend?}` (entity types incl. zone: id `zone3`); fails if it exists (edit it) |
| culture / religion | `{at (land), name?, color?, type?, base?/shield?/form?/deity?, expansionism?, expand?}` (a culture gets a shield: the default culture's, a same-base culture's, else random) |
| biome | `{name, base?:<biome to copy>, color?, habitability?, iconsDensity?, icons?, cost?}` (no base: 50, 0, none, 50) |

### paint_cells

`select`: union of `cells:[ids]`, `circle:{at, radius, unit?:'px'|'km'|'mi'}`,
`polygon:[Place...]`, `entity:{type, ref}`; then `buffer` (map px, grows the shapes, negative
shrinks), filtered by `where:{land, water, hMin, hMax, biome, state, province, culture, religion,
feature, burg, river}`, minus `except:<another select>` ('polygon except circle', 'not Glacier':
`except:{where:{biome:'Glacier'}}`). An unknown key in select, where, set or height is BAD_FIELD
(`details {unknown, allowed}`), never ignored.

| set | rules |
| --- | --- |
| state | land only; never a state centre or a capital's cell; burgs follow; provinces re-fitted |
| province | land of the province's own state; never a province centre |
| culture / religion | land only (culture: burgs follow) |
| biome | name or id; land only; `feather:{width, unit?:'px'\|'cells', seed?}` frays the edge (use `unit:'cells'`, width 2-4; under one cell spacing it does nothing and a note says so) |
| zone | ref (adds cells) or `{ref, op:'add'\|'remove'}` |
| height | alone in its call; `{value \| delta \| smooth:n, rebuild?, clamp?, erosion?, confirmErase?}`; the local way to edit a few cells |

Height `rebuild`: `keep` (default) land only, 20..100, refuses a change across 20 (`clamp:true`
stops at 20); `risk` rebuilds coast, lakes, climate, rivers and re-packs the cells, carrying
burgs, routes, markers, regiments and lake/island names to the new cells (`erosion:true` re-runs
erosion; a carried route point off its old cell is re-recorded to the cell under it,
`carried.routePointsRepointed`); `erase` regenerates every entity (`confirmErase:true`). For whole-map terrain use
`set_heights`.

## Feature notes

**World settings** (`edit {type:'map'}`): mapSize, latitude, longitude, temperatureEquator,
temperatureNorthPole, temperatureSouthPole (Celsius), winds (6 angles north to south, or
`{tier: degrees}` for some tiers 0-5), precipitation, distanceScale, distanceUnit, areaUnit,
heightUnit, heightExponent, temperatureScale. A value or `{value, lock:true|false}`; op-level
`lock`/`unlock`: names or `'all'`; such rows carry `locked:{before, after}`, the whole lock set
(dryRun: the set the op would leave). Locks survive generate_map and travel in the .map
(`options.tupaiaLocks`), so save/load, undo and restore keep them. `lock:'all'` locks every
lockable setting (14, incl. longitude, temperatureSouthPole, areaUnit, temperatureScale); name
them to lock fewer. Settings only set inputs:
`recalculate:'climate'|'biomes'|'rivers+biomes'|'climate+biomes'` refreshes now (rivers and
hand-painted biome cells are replaced; lake names and custom-biome cells kept; `ops` may be
omitted); otherwise read `stale` in the result.

**Rivers** (one structural change per op; ops of a call apply in order):
`mainStem:<tributary>` (its upper course becomes this river's; the old upper course becomes
that tributary), `split:{at: Place, name?, type?}` (upper part = new river, in `created`; each
part keeps 3+ cells), `merge:true` (inverse of split), `reroute:{cells:[...]}` or
`{from, to: Place|'edge', through?, snap?:false, edge?}` (no crossings; a climb is a warning;
lint river-uphill only flags rises of `riverTol`, 12; notes give discharge before -> after).
`{cells}` must be neighbours in order (inspect `{at}` lists a cell's `neighbours`; the error lists
both cells'). A reroute through cells the river already holds is REFUSED, and a cell on
another river must be freed first. To move a confluence or end a river earlier, use three ops in
ONE call (they apply in order; a dryRun checks the later ones only when applied): detour river A
off the cells (`reroute {cells}` via neighbours), reroute river B through the freed cell, then
reroute A to its new end (`{cells:[...]}` ending on B). `find river fields:['joinsAt','tributaries']`.

**Routes**: freehand routes are drawn exactly, may cross water, are locked by default (regenerate
keeps them), up to 2000 points; a burg point uses the burg's cell; `[x,y,cell]` pins a cell
(keep it the cell under the point: one over 1.5 spacings away is warned).
One cell link per consecutive pair; the last route through a pair owns it. `edit route
{set:{points}}` re-links (add `lock:true` to a generated route). `regenerate routes` renumbers
locked routes: read `routeIds {old:new}`. Style presets leave custom groups alone.

**Biomes**: icons are weights over acacia, cactus, conifer, deadTree, deciduous, dune, grass,
palm, swamp, hill, mount, mountSnow, vulcan. New values show after `regenerate
{parts:['relief']}`. `regenerate {parts:['biomes'], biomes:{from?:'climate'|'current', noise?,
mode?:'warp'|'jitter', smooth?, minRegion?, seed?, keepPainted?:true|'custom'|false, keepRivers?,
keep?, exclude?, select?}}`: natural edges; custom biomes and painted cells are kept by default
(`keepPainted:'custom'` keeps only custom-biome cells). Try seeds with dryRun, then apply once.
The .map biome line carries iconsDensity, icons and cost (a 4th field). Files saved before it
(terraform-v3, shared v6/v7) load custom biomes with 0, none and 50 and edited stock biomes with
defaults; load_map says so in `note`. Set them again with `edit {type:'biome'}` and save.

**Provinces and emblems**: `regenerate {parts:['provinces','emblems'], provinces:{states, centres?:
[{state, burg|at, name?}] | count?:N | ratio?, crossForeign?, keepLocked?, lockedStates?},
emblems:{states, provinces?, burgs?, shieldOnly?, stateCulture?}}`: only those states (also
hand-made ones with no burgs). One call mixes modes: `states` lists all, `centres` covers some,
`count` (else auto, `ratio`) the rest. `crossForeign:true` floods over foreign land too (a script
that gives every land cell its nearest centre, like provinces.js); add `lockedStates:true` for
locked states. dryRun previews centres-mode sizes; auto mode and generated names are random per
call. emblems: provinces and burgs default true; `stateCulture` gives provinces and burgs the
state's culture shield; `shieldOnly` keeps the designs. Turns no layer on.

**Relief icons**: `regenerate {parts:['relief'], relief:{density?|matchIcons?, perBiome?,
minHeight?, exclude?|excludeAdd?|excludeRemove?, nearBurgs?:{radius, unit}, seed?, onLoad?}}` draws
seeded icons with settings stored on the map (map_info `relief`). The count goes with density²
(0.7 = about half). `matchIcons:<n>` picks the density that draws about n (`true` = the current
count; the relief layer must be on). `edit map {set:{reliefOnLoad:true}}`: saves drop the icons
and loads redraw them (about 80 B per icon: terraform-v3.map 4.75 -> 2.33 MB); shared_save and
sketch_promote refuse it (BUILD) until the deployed app has the hook.

**Labels**: the app hides a label group while its on-screen size is under 6 px or over 60 px
(emblems 25/300); whether that hides burg labels at full-map zoom depends on the map's font sizes
(on the shared map none are hidden). The usual problem is legibility in a 1024 px JPEG: frame a
region (target/zoom) or raise maxSide. `display {labels:{town:{minSize:0},
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
restores land heights the rebuild changed. `biomes:'redefine'` (default) | `'keep'`. An
`image.path` is read like load_map's path (Files); the result names `imagePath`. dryRun
returns changed, toLand/toWater, landPct, lakes, pits, grid (cellsX, cellsY, spacing),
burgsOnNewWater (count 0 included), paintedBiomes. Even a 1-cell `pack` edit rebuilds the whole
map: rivers regenerate, biomes are redefined map-wide and every burg's economy and state treasury
re-roll; for a few cells use `paint_cells {set:{height}}` (keep). The apply result: `carried.*`
(entities moved to the new cells), `burgsBackOnTheirCell` (burgs put back on their own cell),
`raisedForBurgs` (water cells kept as land under a burg), `deepLakes` (depressions erosion made
lakes), `routeLinksBridged` (route steps added between cells no longer neighbours), `portsLost`
(ports no longer by water). Verify: the same set_heights dryRun says `changed:0`, and `edit
{type:'map', recalculate:'biomes', dryRun:true}` says `replaces.biomeCellsEdited:0`. `flow {from:[Place|{gridCell}...],
heights?:<same sources>, fill?}` traces drainage first (`end.type` sea/lake/river/border/pit;
`goesTo` where a river ends; lengths use the current map's distance scale).

**regrid**: density 1-13 (4 = 10K, 6 = 30K) or 1000-100000 points; dryRun gives cells.est,
bytes.est and atRisk. Entities move by coordinates; read entities.*.lost, fixed, warnings, then
screenshot the coast. Lowering merges cells. River courses are re-anchored and gaps between
cells that are no longer neighbours filled (`fixed.riverGapCellsFilled`); lint river-gap rows left
have a ready reroute `fix`/`fixAll`. Biomes stay as they were (cell by cell) unless
`biomes:'redefine'` (recomputes from climate, hand-painted cells too); 'keep' warns with the stale
count. A new ocean (water cut off at the edge) is a warning.

**clear**: types notes, labels, markers, zones, routes, rivers, burgs, provinces, states,
religions, cultures, emblems (run in that dependency order). `where` per type
(`{burgs:{populationMax:500}, routes:{group:'trails'}}`, `{i:[ids]}`) or bare with one type; with
where keyed by type, an unlisted type is cleared entirely. `keep:[{type,ref}]` and `lock:true`
entities stay unless `force` (freehand routes are locked by default; route groups are not
removed: `edit {type:'routeGroup', remove}`). Never removes id 0. Emblems are hidden (coa.size 0),
not deleted.

**compact**: removed burgs/states/provinces/cultures/religions become `{i, removed:true}`
(cultures keep base and center); no id changes. Records live data still points at stay whole:
`keptBy`/`keptWhy` say what frees them (deal: `regenerate {parts:['production']}`, re-rolls every
live burg's economy; provinceBurg: `repointProvinces:true`). Afterwards a removed id answers
REMOVED without its name. Markers, notes, labels, routes and zones are spliced out when removed,
so compact has nothing to stub for them. `save_map {compact:true}` writes the same bytes as
compact then save. Refused while an editor is open.

**apply**: lists burgs, markers, labels, zones, routes, notes, states, provinces, cultures,
religions, rivers, features, biomes, routeGroups, plus `map` (fields and settings, incl. locks).
Keyed by name (labels: text; notes: id | entity:{type,name} | entity:'Name' | name), route
groups by id. Found: only differing fields edited; missing: created (`upsert`) or reported
(`update`); `check` is read-only and previews exactly what upsert would do. Routes:
`through:[names|[x,y]]` (pathfound) or `draw:'points'` (freehand). An entry's `note` (string or
{name, legend}) becomes its note. Rivers are matched, never created. `mapping` {lists, keys,
values} renames first; `ignore` {list:[keys]}; `tolerance` {px, number, fields, legend:'contains'}.
Rows: unchanged | updated | created | differs | missing | error with diffs {field, have, want};
identical differs/error rows are grouped (count, at, keys). `created` lists every created entity
(`<list>.note` its note). Keys apply cannot use come back in `ignored` (with `ignoredNote`), e.g.
markers[].places; a blocked field is an error row. Provinces, rivers and features are never
created (UNSUPPORTED, with how: regenerate provinces centres, add a river by reroute/split, paint
cells). So a spec with territory paints, provinces, free-standing notes without an id, or a
curved-path label (eval only) never checks as all unchanged: expect those residuals.

**lint checks**: label-offcanvas, label-overlap, label-orphan, marker-stacked, marker-cell-link,
marker-in-water, burg-in-water, burg-shared-cell, burg-cell-link, capital-outside, province-empty,
state-empty, unnamed, name-duplicate, river-uphill, river-loop, river-gap, route-link,
route-point-cell, route-end-burg, note-orphan; opt-in (name them): label-marker-overlap,
marker-near-burg. Rows `{sev, e:[[type,ref,name]], at, msg, fix:{tool,args}|hint}`; `fixAll` per
check for route-link, route-point-cell, route-end-burg (an eval that trims points and may remove
routes left under 2 points: `{pointsTrimmed, routesRemoved}`), marker-cell-link, note-orphan,
river-gap (an `edit river` reroute per gap; a gap with no land path gets a hint:
`edit {type:'map', recalculate:'rivers+biomes'}`, which replaces every river). label-overlap also
flags a custom label repeating a burg/state label (fix: remove it). capital-outside on a state
with no burg is a warn with a hint (add a burg, set a capital, or ignore). A curved-path label has
no tool fix (remove it, eval, or ignore). An unfiltered overview lists warn/error rows only.

## Reading cheaply

- `find {..., format:'compact'}`: `burg 12 Agamathel pop=61419 state=3 capital at=(812,440)` rows
  plus a `names:` legend; `fields` picks columns; strings cut at 80 chars unless named. Unknown
  fields, where-fields and sort keys come back as `warnings` (compact: `warning:` lines).
- `inspect {..., format:'compact', fields:[...]}`: key=value lines (about a fifth of the JSON);
  unknown field names are `warnings`.
- Cultures, religions, states and provinces: `cells`, `area`, `rural`, `urban` in find (fields,
  where, sort) and inspect are computed live from the cells (the stored stats go stale after
  paints and adds; inspect says so in `statsNote`); states and provinces also have `burgs`.
- Notes and labels show their string id as `i`; `where:{i:...}` and `where:{id:...}` both match it.
  routeGroup rows: id, name, stroke, width, dash (`'none'` or null = solid), linecap, opacity, routes,
  order, after, before.
- inspect `{at}` lists the cell's `neighbours`; JSON inspect of a burg shortens `production` and
  `deals` past 10 items (`fields:['production']` lists them).
- `map_info {since:'<label>', diff:'counts'}`: `{type:{added, removed, changed}, cells, settings}`.
  `detail`: `'summary'` (default) lists up to 25 changed entities in full, past that per-type
  counts + the first 3 of each list + `changesTruncated`; `'list'` up to 50 per type; `'full'` up
  to 1000. A baseline that holds another map (since:'checkpoint' or a snapshot from before a
  load_map, generate_map, shared_restore, sketch open or another map's restore) returns
  `{changed:true, changes:{mapReplaced:true, counts}, mapReplaced:'...'}`; `detail:'list'|'full'`
  diffs anyway with a warning. Right after a whole-map replacement the default since is
  `changed:false`. `overview:false` returns only the change list.
- `session`, `shared_status` and `sketch {action:'status'}` take `format:'compact'`: one
  key=value line (`session mode=local browser=ready launches=1 app=1.130.1 map=Chanland ...
  undo=1 redo=0 consoleErrors=0 ...`; `shared v7 name=.. by=.. lock=none | page lineage=..
  opsSince=N | mode=local writes=off build=skipped`, plus a `versions:` line with versions:true;
  `sketch <slug> recording base="shared v7" ops=2 dirty saved=never ...`, with full:true one line
  per op).
- `screenshot {compare:'s3', crop:'changed', sideBySide?:true}`: only the changed region; nothing
  changed = no image, one-line note (a plain compare too). Keep the frame: no target/zoom with
  compare; the capture takes s3's layers unless `layers` is given. `view:'s3'` repeats a frame
  (with any layers, across load_map and regrid). A full-map compare crops small changes to a few
  dozen px: take the baseline zoomed on the area, then compare with `view` (recipe 9). Pass the
  same `scale` as the compared shot. maxSide is 256-2048 and never upscales; the PNG in `file`
  keeps full resolution.
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
| BAD_ARGS, BAD_FIELD, BAD_TYPE, BAD_REF, BAD_LAYER | invalid input (incl. an unknown top-level argument) |
| NO_PATH | add route: no land path (use a freehand route) |
| REFUSED | a guard said no (capital without force, path policy, editor open, token, ...) |
| CHANGED | sketch replay of a clear: the target was renamed, renumbered, reused or locked since |
| MODE | local mode: no shared writes, no sketch save/promote (the message says how a human enables live for this stdio server or daemon); or TUPAIA_LIVE_ORIGIN=none |
| STALE, LOCKED, LINEAGE, BUILD, CONFLICT | shared-map gate (see below) |
| SKETCH | a stopped rebase holds the page: every mutating call is refused (nothing changes) until `snapshot {action:'undo', n}`, a rebase with onConflict:'skip', or `sketch {action:'stop'}` |
| NETWORK | a request to the live origin failed |
| TIMEOUT, CANCELLED | out of time / cancelled. A mutating call: the next call relaunches and restores the state before it (only that call is lost). A read-only call whose page stops answering: the next call gives it 10 s more and keeps the page if it answers |
| EVAL_ERROR, EVAL_SYNTAX | eval threw / did not parse |
| APP_ALERT | the app showed an error dialog (Invalid/Ancient/Newer file, Generation error) |
| PAGE_ERROR, BROWSER, STALE_OP | page or browser failure |
| RESULT_TOO_LARGE | narrow the request (limit, fields, where) |
| SIZE_MISMATCH | image diff of different sizes (screenshot compare now says BAD_ARGS: use the compared shot's scale) |

Recovery: after every call that changed the map the server keeps the page map as a restore
point; a relaunch (crash, hang, a restart that finds the page gone) restores it with the note
`Restored the map as '<tool>' left it (<time>) (nothing lost).` A call's `timeoutMs` starts after
any relaunch at its start. Put-back steps (sketch summary's return to the sketch map, screenshot
layer/label restore, flow overlay removal) ignore a cancellation and get at least 60 s. A
`snapshot` undo/redo/restore whose load fails is an error `<action> failed: <cause>. Nothing
changed: the map from before the <action> was loaded back into the page. The undo/redo history
is as it was.` with `details.pageRestored` `'now'` or `'on the next call (relaunch)'`.

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
or a count; omitted `width`/`height` = the server's default viewport (not the previous call's).
Same seed + options = same map (`digest`) across calls and sessions. The page is then reloaded
from its own .map text, so snapshots and saves hold exactly that map (generator river erosion of
heights is not kept by .map files). regenerate parts run in this order:
rivers, biomes, population, cultures, burgs, states, provinces, routes, religions, emblems,
military, markers, zones, ice, goods, markets, economy, production, relief; `states` reseeds the
random stream; `rivers` keeps pack heights; `restoreLayers:true` undoes layer changes.

## Files

- Writes (save_map, export): relative paths go under TUPAIA_OUT (default `<repo>/.tupaia-mcp-out`).
- Reads (load_map `path`, apply `specPath`, set_heights `image.path`, flow `heights.image.path`):
  an absolute path as given; a relative one from the server cwd, then TUPAIA_OUT, then the repo
  root, first match wins (NOT_FOUND lists every place looked). Results name the absolute file
  (`path`, `specPath`, `imagePath`). The CLI makes a relative path that exists from your cwd
  absolute first. Prefer absolute paths.
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
- Backups go to `TUPAIA_OUT/shared-saves/` before every write. Display changes ship with the save,
  and the save records the Trade layer as off or on as the page has it.
- Every write renames the Worker row to the page's file name (a timestamp), as the app's own save
  does. Sizes: the shared map is about 6.7 MB; compact saved about 0.7 MB, relief density 0.5 with
  exclusions about 1.7 MB, reliefOnLoad about 0.75 MB on it.
- `TUPAIA_LIVE_ORIGIN=http://127.0.0.1:<port>` points a daemon at a test Worker (mcp/test/fake-worker.ts)
  for a write rehearsal: give it its own `--out` so it never serves another caller.

## Sketches

A sketch is base version N of the shared map plus the ops log that produced it.
`load_map {source:'shared'}` (no edits) -> `sketch {action:'start', slug, note}` -> every
mutating call is logged with what it resolved to (ids, literal names and cells, created ids) ->
`summary` -> `save {confirm:true}` (live mode; returns `viewUrl`) -> on yes `rebase` (replays
onto the current shared map, keeping others' edits) -> `sketch_promote {}` -> `{confirm:true,
token}`. `status` shows the log, `blobOnly` and `blobOnlyReasons`; undo/redo pops/pushes ops.
A summary cancelled part-way leaves the sketch map in the page (or the next call restores it).
`discard` of an active sketch that was never saved works in local mode too: without confirm a
preview `{preview, local:true, wouldDiscard}`, with `confirm:true` the sketch ends and its log is
dropped; the page keeps its map. A saved sketch or another slug needs live mode + confirm.

| replays on rebase | makes the sketch blob-only (save/view/promote as is; no rebase) |
| --- | --- |
| edit (incl. map settings + recalculate), add, paint_cells (incl. height keep and risk, feather), display (incl. labels), apply (logged as its add/edit/paint_cells steps), set_heights, clear, compact, regenerate with only biomes/provinces/emblems/relief, eval (verbatim, marked unsafe) | regenerate with any other part, generate_map, load_map, snapshot restore, regrid, paint_cells height `erase`, screenshot `keepLayers`, a call that failed part-way |

Read-only calls (find, inspect, map_info, flow, lint, screenshot, `display {labels:'list'}`) and
no-op calls are not logged. Rebase conflicts: a missing/removed target, a field both sides
changed, a reused id, a removal of something changed since, renumbered cells, a changed
derived layer (settings recalculate, relief keys), a CHANGED clear target, cells both sides
painted. `onConflict:'stop'` (default) leaves the partial replay (`snapshot undo n` returns;
until then every other mutating call is refused: SKETCH); `'skip'` drops only what conflicts: the
conflicting items of an edit/add (`itemsSkipped`), the conflicting fields of a map edit, the
cells someone else painted (`cellsSkipped`); other ops drop whole. The report has `replayMs`
and `slowOps`; a rebase takes 2-10 s, over a minute on a loaded machine (give the CLI a long
timeout). `sketch status` adds `sharedNow`/`rebaseNeeded`. `sketch_promote` `then` defaults to
'keep': the kept copy is marked promoted (status, list and open show it; rebase and promote
refuse it), so its adds cannot run twice. A blob-only sketch: promote it while the shared map is still at its base;
otherwise start over.

## CLI (no Claude restart)

`<checkout>/mcp/bin/tupaia --out <dir> call <tool> '<json>'` (or `-` with JSON on stdin) runs any
tool on a shared http daemon (one per out dir: same page, undo, sketch). Use the bin of the
checkout or worktree under test: it runs that tree's code. Prints the result, then
`IMAGE: <path>`; a tool error prints `ERROR CODE: message`, exit 1. Also `tools [<tool>]`,
`help <tool>`, `status`, `start`, `stop`, `headers`. Mode comes from the daemon's spawn
environment only; a live daemon refuses a caller whose environment is local (or names another
TUPAIA_LIVE_ORIGIN): exit 2, unless `--accept-live`. A live daemon loads the shared map on its
first launch. `$TUPAIA_OUT/daemon.log` has each call's daemon time; under load the CLI's wall
time can be several times that, and stderr progress lines say whether the daemon has the call yet.

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
   mode:'check'}` -> `apply {specPath}` -> `apply {..., mode:'check'}` (expect unchanged plus the
   residuals under apply: paints, provinces via regenerate, rivers, id-less notes).
6. Quality pass: `lint {}` -> run each `fixAll`/`fix` call -> `lint {checks:[...]}` until clean;
   `ignore:[{check, type, id}]` for accepted findings.
7. Smaller file: `compact {dryRun:true, details:true}` -> `compact {repointProvinces:true}` ->
   `edit {type:'map', ops:[{set:{reliefOnLoad:true}}]}` -> `save_map {path:'x.map', compact:true}`.
8. Labels: `screenshot {target:{bbox:[...]}}` to read them; to show hidden groups at full-map zoom
   `display {labels:{town:{minSize:0}, capital:{alwaysShow:true}}}` -> `screenshot {full:true,
   maxSide:2048}`.
9. A/B check of an edit: `screenshot {target:{entity:{type:'burg', ref:'Norvik'}}}` (s1) -> edit ->
   `map_info {diff:'counts'}` -> `screenshot {view:'s1', compare:'s1', crop:'changed',
   sideBySide:true}` (a full-map baseline makes a tiny crop).
10. Safe shared_save (only when the human asked): `session` (mode live) -> `shared_status
    {versions:true}` -> `shared_save {}` -> tell the human version, saver, lock, lineage, build ->
    on yes `shared_save {confirm:true, token}` -> report the new version and backup path.
11. Propose a change: `load_map {source:'shared'}` -> `sketch {action:'start', slug:'harbour',
    note:'...'}` -> edits -> `sketch {action:'summary'}` -> `sketch {action:'save', confirm:true}` ->
    give the human `viewUrl` -> on yes `sketch {action:'rebase'}` -> `sketch_promote {}` ->
    `sketch_promote {confirm:true, token, then:'discard'}`; on no `sketch {action:'discard', slug,
    confirm:true}` (live mode; an unsaved sketch: `sketch {action:'discard', confirm:true}`).
