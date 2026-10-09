---
name: tupaia-dexterity
description: Drive the Tupaia map app through the `tupaia` MCP server (or its `tupaia` CLI, without restarting Claude) to generate, query, edit, terraform, build from a spec, lint, style, screenshot, snapshot/undo and export maps, propose shared-map changes as sketches, and (only when the human asks) save the live shared map. Use for any request to look at or change a Tupaia or FMG (Fantasy Map Generator) map.
---

# Tupaia dexterity

The `tupaia` MCP server runs the built Tupaia app (Ryan's fork of Azgaar's Fantasy Map
Generator) in headless Chromium and exposes 28 tools. This skill is how to use them well.
Signatures, field tables and error codes: the resource `tupaia://docs/cheatsheet.md`
(`mcp/resources/cheatsheet.md`). Read `tupaia://docs/runtime-api.md` before any `eval`.

## 0. Using the tools without restarting Claude

MCP servers load only when Claude Code starts. If the `tupaia` tools are not in this session,
or several agents must work on ONE page, run the same tools from Bash with the CLI:

```sh
T="/Users/mgm1/Desktop/code/vespucci/mcp/bin/tupaia --out /abs/dir/for/this/task"
$T call session '{}'                                   # first call starts the daemon (stderr note)
$T call load_map '{"path":"/abs/base.map"}'
$T help edit                                           # one tool's description and argument types
$T call find '{"type":"burg","name":"Kazzuz","format":"compact"}'
$T call set_heights - < /abs/heights-args.json         # big arguments through stdin (MBs are fine)
$T call screenshot '{"full":true}'                     # -> IMAGE: /abs/dir/.../shots/call-....jpg (Read it)
$T tools ; $T status ; $T stop
```

- Use the `mcp/bin/tupaia` of the checkout you are testing: in a worktree, the worktree's bin
  (the main checkout's bin runs the main checkout's code).
- Output: the tool's text, then `IMAGE: <path>` lines. A tool error prints `ERROR CODE: message`
  and exits 1; exit 2 is a usage or daemon problem.
- **One `--out` per task, on every command.** Shell variables do not persist between Bash calls
  and subagents do not inherit them, so write the full prefix each time. The out dir picks the
  daemon: same dir, same page, undo history, snapshots and sketch. Without `--out` you share
  `<repo>/.tupaia-mcp-out` with every other default caller (including a registered
  `tupaia-shared` server). Unrelated sessions must use different dirs so they do not collide.
- **Workflow subagents** share one daemon and one page when they get the same prefix: put the
  exact command line in their prompt, add `TUPAIA_CALLER=<agent name>` so daemon.log names
  them, and let one agent mutate while the others read. Calls queue in arrival order and each
  is atomic, but `snapshot {action:'undo'}` undoes the newest change from ANY agent: take
  labelled snapshots and restore by label.
- **Mode** comes only from the daemon's spawn environment: local unless `TUPAIA_MODE=live` was
  set when it started. A live daemon refuses (exit 2, nothing runs) a caller whose environment is
  local or names another `TUPAIA_LIVE_ORIGIN`; `--accept-live` overrides, only when you mean to
  use that live daemon. A local daemon only warns a live caller; `stop` and call again to change
  it. Never start a live daemon unless the human asked for a shared-map write; give it its own
  `--out`. A live daemon loads the shared map into its page on its first launch.
- Every tool but `apply` refuses unknown top-level arguments (BAD_ARGS lists the allowed ones);
  per-op options such as `orphanRoutes` go inside the op. `tupaia help <tool>` shows them.
- `--timeout <ms>` is the call's budget once it starts; queueing is extra, so give Bash a timeout
  that covers both (e.g. 600000 for set_heights, regrid or a sketch rebase). Slow calls print
  progress on stderr (it says when the daemon has not received the call yet: a loaded machine).
  `<out>/daemon.log` has each call's daemon time; under load the wall time can be several times
  that. A CLI killed while queued skips the call; killed after the start, the call still finishes.
- Paths: prefer absolute. The CLI makes a relative input path (load_map `path`, apply
  `specPath`, set_heights/flow `image.path`) absolute when the file is in your cwd; otherwise the
  server tries its cwd, then the out dir, then the repo root, and results name the file it read.
  `save_map`/`export` write relative paths under the out dir.
- The daemon stops after 120 idle minutes; a changed page is saved first, and the next call
  prints the `load_map` line for `<out>/maps/daemon-exit-*.map`.
- For future sessions, the human can register the daemon as an http MCP server (an entry with
  `"type":"http"`, `"url":"http://127.0.0.1:7392/mcp"` and `"headersHelper":"TUPAIA_MODE=local
  /Users/mgm1/Desktop/code/vespucci/mcp/bin/tupaia headers"`; details in `mcp/README.md`). It
  shares the page with CLI calls made without `--out`. Never `stop` a daemon a session uses:
  Claude Code does not reconnect.

## 1. Start

- Call `session` first (`format:'compact'` for one line). It launches the browser and reports
  the mode, the origin shared reads hit, the app version, the map's provenance and, under the
  daemon, `serving`.
- Mode is `local` unless the human spawned the server with `TUPAIA_MODE=live`. You cannot
  switch to live; do not try, and do not suggest it unless the human wants the live map changed.
- A fresh page holds a random map. Get the one you want with `load_map {path}`,
  `generate_map {seed, ...}`, or `load_map {source:'shared'}` (a read-only GET, safe in local
  mode for working on a copy of the shared map).

## 2. Coordinates and addressing

- Map px are graph space (0..graphWidth, 0..graphHeight). Places are `{x,y}`, `{lat,lon}`,
  `{cell}`, `{entity:{type,ref}}`, or `{entity:{type:'route'|'river', ref}, at:0.5}`.
- A ref is an id or an exact name (case and diacritics folded; states and provinces also match
  their full name). Never fuzzy. On NOT_FOUND or AMBIGUOUS read the candidates and retry with
  the id; ask the human when the choice changes what they meant.
- `find` discovers names (`find {type:'namesbase'}`, `find {type:'biome'}`,
  `find {type:'routeGroup'}`); `inspect` translates between ids, names, cells, x,y and lat/lon.
- Id 0 is a placeholder (Neutrals, Wildlands, No religion). Removed entities stay in their
  arrays; after `compact` they are stubs `{i, removed:true}`.
- `inspect {at:{screen:[px,py], shot:'s3'}}` maps a pixel of a returned screenshot (also a crop)
  to the map.

## 3. The working loop

1. `find` / `inspect` to pin down the targets.
2. `snapshot {action:'take', label}` before any multi-step or risky change.
3. Mutate with the batch tools (`edit`, `add`, `paint_cells`, `display`, `apply`, `clear`,
   `set_heights`). One call with many ops beats many calls; each call validates everything
   first and changes nothing if one op is invalid (unless `continueOnError`). `dryRun:true`
   for big batches and anything that resolves names you have not seen.
4. Check the diff cheaply: `map_info {diff:'counts'}` (or `since:'<label>'`). A baseline that
   holds another map (taken before a load or generate) answers `mapReplaced` with the new counts,
   not a diff.
5. `screenshot` framed on what changed; for before/after, keep a shotId and use
   `screenshot {compare:'<shotId>', crop:'changed'}`.
6. If wrong: `snapshot {action:'undo'}` (or `n:3`), or `snapshot {action:'restore', label}`.
7. After bulk work: `lint`, apply its fixes, `lint` again.

Token economy (results are counts first; ask for detail only when needed):

- Read with `find {format:'compact'}` and `inspect {format:'compact', fields:[...]}`; JSON only
  when you need nested data or false/null fields. Name a field in `fields` to get it uncut.
- `map_info {diff:'counts'}` before any full diff; the default `detail:'summary'` compacts more
  than 25 changed entities to counts plus 3 of each list (`'list'` = 50 per type, `'full'` = 1000).
- find/inspect `warnings` name fields that do not exist (a typo reads null in every row: check).
  Culture/religion/state/province cells, area, rural and urban are live, not stored (and burgs,
  for states and provinces only). Notes and labels show their id as `i`; where `{i}` matches it.
- `map_info {overview:false}` returns only the change list. `changes` and diffs show burg
  population in stored thousands; set/find use people.
- `shared_status` and `sketch {action:'status'}` take `format:'compact'` too.
- `consoleErrors` are folded (`msg (xN)`, 8 distinct at most); `session` lists the newest 20.
- `screenshot {compare, crop:'changed', sideBySide?:true}` instead of a full frame; a note with no
  image means nothing visible changed (it says when the edit ran with `redraw:[]` or only touched
  hidden layers). `compare.bbox` is map px: feed it to `target:{bbox}` or `find {near}`.
- `edit`/`add` `rows:'ids'` for big batches; `changes` already caps at 8 entities in full.
- `lint {limit:0}` for counts; `apply` lists counts and the actionable rows first.
- Never dump `pack` through eval to read it; find/inspect/map_info cover it.

## 4. Screenshots

- Take one after any visual change, framed on the change (`target:{entity}` or
  `{bbox:[x0,y0,x1,y1]}`, with `zoom`), and before telling the human the work is done. Not after
  pure reads.
- `full:true` shows the whole map at the full-map label sizes. `layers:{off:[...]}` isolates
  what you check for that one shot; `labels:'all'` shows every zoom-hidden text label once.
- The default JPEG (maxSide 1024, at most 2048, never upscaled) keeps results small; the full
  PNG is on disk (`file`). Labels are rarely hidden at full-map zoom; they are just small in a
  1024 px JPEG: frame the region to read them.
- A compare needs the same frame: do not pass target/zoom with `compare`. It reuses the compared
  shot's frame and layers (unless you pass `layers`) and needs its `scale`. For a legible small
  change take the baseline framed on the area (`target`/`zoom`), edit, then `screenshot
  {view:'<id>', compare:'<id>', crop:'changed'}`; a full-map baseline crops a one-label change to
  about 130 px. `view:'<id>'` repeats a frame across load_map and regrid too. A compare that
  finds nothing returns no image, just a note.

## 5. Recipes

**Terraform from a heights grid or an image.**
1. Get the grid geometry: any `set_heights` dryRun (or a wrong-length grid's error) returns
   `grid` {cells, cellsX, cellsY, spacing}; `eval` on `grid.points` gives each cell's [x,y]. Write
   the heights (one 0-100 per grid cell, sea level 20) as `{"grid":[...]}` in a file.
2. `snapshot {action:'take', label:'pre-terrain'}`.
3. `set_heights {grid:[...], fill:true, dryRun:true}` (or `image:{path:'/abs/h.png',
   range:[0,80]}`, or sparse `pack:{cellId:h}`): check `landPct`, `lakes`, `pits`,
   `burgsOnNewWater` (count 0 included), `paintedBiomes`; `detail:true` lists pits.
   `rebuild:'keep'` (no land/water flips) is local: only the changed cells' heights,
   temperature, biome and lake levels change; rivers, other biomes, burg economies and
   treasuries stay (`local.rivers.climbing` lists rivers to reroute; `rivers:'regenerate'` is
   the opt-in global river pass). `paint_cells {set:{height:{...}}}` is the same local keep.
4. `flow {from:[{x:840, y:420}, {gridCell:5005}], heights:{grid:[...]}, fill:true}`: key rivers
   should end at `sea` (or `river` whose `goesTo` is the sea); `screenshot:true` draws them.
5. `set_heights {...}` without dryRun. Read `rivers` (kept/new/gone, `notesOrphaned`) and
   `carried` (field meanings in the cheatsheet, Terrain). Even an identity import with rebuild
   'risk' regenerates rivers (ids and names carry over by course). Verify: the same dryRun says `changed:0`, and
   `edit {type:'map', recalculate:'biomes', dryRun:true}` reports `replaces.biomeCellsEdited:0`.
6. World settings: `edit {type:'map', ops:[{set:{mapSize:1.1, latitude:38.8,
   temperatureEquator:30, temperatureNorthPole:-28, winds:[225,45,45,315,135,315],
   precipitation:150, distanceScale:0.1, distanceUnit:'mi'}, lock:'all'}],
   recalculate:'climate+biomes', dryRun:true}`, then without dryRun. `lock:'all'` locks 14
   settings; the builder's frame locked 10 (name them: `lock:['mapSize','latitude',...]`).
   `recalculate:'climate'` alone leaves rivers and biomes alone; without recalculate read
   `stale`. `flow` lengths use the current distance scale, so run it after this step to read
   them in the new units.
7. More cells: `regrid {density:6, dryRun:true}` (check `bytes.est`, `atRisk`), then apply and
   screenshot the coast and a river mouth. Rivers are traced again as contiguous cell paths
   along their old lines (ids, names, parents, confluences kept; `rivers.retraced`) and carved
   where they would climb (`rivers.carved {rivers, cells, maxDrop}`; `carve:false` leaves the
   interpolated heights), so lint river-gap/river-loop/river-uphill stay clean. Biomes are
   re-derived from the climate on the new cells, custom and painted ones carried where they
   were (`biomes`: redefined, carriedCustom, carriedPainted), then speckles under `minRegion`
   cells (default 3, 0 = off) merged into their neighbour (`biomes.cleanup`; river and carried
   cells stay); `biomes:'climate'` carries custom only, `'keep'` the old pattern (warns).
8. `lint` (markers on new water, route links), then `screenshot {full:true}`.

**Wipe the random base and build from a spec.**
1. `clear {types:['labels','markers','zones','routes','burgs','provinces','states','religions',
   'cultures'], dryRun:true}`: counts, cascade, what is kept and why (locked entities and `keep`
   stay unless `force`). Keep anchors with `keep:[{type:'burg', ref:'Name'}]`. Then without
   dryRun.
2. `apply {specPath:'/abs/design/build-spec.json', <mapping and paint below>, mode:'check'}`:
   what upsert would do (paint rows count each entry's differing cells).
3. The same without `mode`: creates, edits and paints; one undo entry. Provinces
   (`states[].provinces`, each around its `capital` burg) are made after the paint, in their
   states' painted territory; rivers (`rivers_intended` from/via/to) run along the land and are
   extended downhill to the sea or the river they join.
4. `apply {..., mode:'check'}` again: every row `unchanged` except what the spec cannot express,
   each an error row saying why: a river whose course the map already holds under another name
   (the row names it: rename it with `edit river {ref, set:{name}}`), notes the spec gives twice
   (CONFLICT), a curved-path label. A second upsert changes nothing.

The builder's spec needs this mapping and paint list (verified on a wiped copy of the builder's
terraform-v3.map: check, upsert, check gives 348 unchanged and 13 error rows: 11 rivers already
on the map under other names, 2 duplicate notes; all 12 provinces made and unchanged; a second
upsert changes nothing):

```
mapping: {lists:{frame:'map', rivers_intended:'rivers'},
  keys:{burgs:{type:'group'}, states:{note:null},
        map:{mapSizePct:'mapSize', latitudePct:'latitude', precipitationPct:'precipitation'}},
  values:{burgs:{group:{'capital city':null, 'underground capital':null, 'Oom capital':null,
            'pilgrimage village':'monastery', 'under-mountain city':'city', 'tunnel town':'town',
            'Oom eyrie':'fort', 'Oom village':'village'}},
          routes:{group:{roads:'roads', trails:'trails', searoutes:'searoutes',
            tunnels:'route-tunnels', 'tunnels-proposed':'route-tunnels_proposed',
            'Oom flyways':'route-oom_flyways', relics:'route-relics', journeys:'route-journeys',
            'deep past':'route-deep_past'}},
          labels:{group:'lbl_{}'},
          notes:{entity:{
            'Map: The Five Valleys and the Spire Lands':{id:'mapNote', name:'The Five Valleys and the Spire Lands'},
            'Not mapped':{id:'notMapped', name:'Not mapped'},
            'Retired: Towers of the Oom (old map icon at 1202,535)':{id:'retiredTowersOfTheOom',
              name:'Retired: Towers of the Oom (old map icon at 1202,535)'},
            Takeet:{type:'state', name:'Takeet'}, Oom:{type:'state', name:'Oom'},
            'The twenty-two great mountains':{type:'label', name:'Orena'},
            Lowlanders:{type:'label', name:'The Lowlands'},
            'Sea lanes (edge label)':{type:'label', name:'Sea lanes east|round the continent,|then south to the warm seas'}}}}},
tolerance:{legend:'contains'}, ignore:{states:['form']},
paint:[
  {from:'biomes_paint'},
  {from:'terrain_paint.Takeet', set:{culture:'Takeet', state:'Takeet'}},
  {from:'terrain_paint.Somnean', set:{culture:'Somnean', state:'Somnean Realm'}},
  {from:'terrain_paint.Oom', set:{culture:'Oom', state:'Oom'}},
  {from:'cultures.Wainfolk.territory', set:{culture:'Wainfolk'}},
  {from:'cultures.Lowlanders.territory', set:{culture:'Lowlanders'}},
  {select:{any:[{entity:{type:'culture', ref:'Somnean'}}, {entity:{type:'culture', ref:'Takeet'}}]},
   set:{religion:'Gallima'}},
  {from:'religions.Soul in Stone.territory', set:{religion:'Soul in Stone'}},
  {select:{entity:{type:'culture', ref:'Oom'}}, set:{religion:'Oom ways'}},
  {select:{entity:{type:'culture', ref:'Wainfolk'}}, set:{religion:'Wainfolk hearth ways'}},
  {select:{entity:{type:'culture', ref:'Lowlanders'}}, set:{religion:'Lowland fen rites'}}]
```

- The paint list is the spec's territory: `terrain_paint` in its order (Takeet, then Somnean and
  Oom over it), cultures then the same cells for states, religions by culture (their rules are
  prose, so they are spelled out), and `biomes_paint` (its custom biomes are created from
  `custom:true, base, color, habitability`). `feature_polygon` + `buffer_px` name shapes in
  `terrain.features`; the buffer is exact (cells within buffer px of the polygon), as the builder's
  sel.py drew it. `terrain_paint.burg_cells` is apply's own rule: each burgs entry's `state` is
  painted on the burg's cell last. A territory no paint entry sets is listed in `notes`.
- Custom route groups need a `routeGroups` list (`[{id:'route-tunnels', name:'tunnels',
  stroke:'#3d2b6b', ...}]`); `draw:'points'` routes are freehand.
- Notes whose entity name is shared (Takeet, Oom: a state and a culture) need
  `entity:{type, name}`, here through the `notes.entity` value table; a free-standing note is
  `entity:{id, name}` (or `id`). Zone notes (`zones[].note`, id `zone<i>`) and markers' `places`
  (joined into the legend as the builder wrote them) need nothing. Two duplicates stay CONFLICT
  rows: Wainfolk (cultures[3].note and notes[10]) and Kaisma's road (routes[13].note and
  notes[7]); the builder joined each pair into one legend.
- apply matches rivers by name and creates a missing one along its from/via/to (`add river`);
  a river whose first place is already on a river is an error row naming that river. Use
  `edit river` for structure.
- `specPath`: absolute (a relative one: your cwd via the CLI, else the server's cwd, the out dir,
  the repo root; the result's `specPath` names the file read).

**Quality pass.** `lint {}` (overview: warn and error rows) -> run each `fixAll` call and the
per-row `fix` calls (ready `edit`/`paint_cells`/`eval` calls; read them first: route-end-burg's
fixAll can remove routes left under 2 points and says which, label duplicates are fixed by
removing the custom label) -> `lint {checks:[...]}` to confirm.
`ignore:[{check, type, id}]` for findings the human accepts. Label checks need the labels drawn
(else `skipped` says how); `atScale` measures one zoom. Opt-in checks (label-marker-overlap,
marker-near-burg) run only when named.

**File size.**
1. `compact {dryRun:true, details:true}`: read `keptBy`/`keptWhy`.
2. Deals hold removed burgs: `regenerate {parts:['production']}` (tell the human: it re-rolls
   every live burg's economy). provinceBurg: `compact {repointProvinces:true}`.
3. `compact` (or only the file: `save_map {compact:true}`, `shared_save {compact:true}`).
4. Relief icons: `edit map {set:{reliefOnLoad:true}}` makes saves drop the icons and loads redraw
   them (seeded); `regenerate {parts:['relief'], relief:{matchIcons:<old count>}}` keeps the
   count if the switch changed it (it changed 30667 -> 41798 on v7). Hand edits in the relief
   editor are lost. Humans have the same switch in the app (Style > Relief, "Redraw relief icons
   on load"), and the app's biomes and heightmap editors redraw such a map's icons themselves. The shared map then needs a deployed app with the hook (shared_save refuses
   with BUILD until then; `shared_status {build:true}` checks the deploy). A relief dryRun shows
   settings, not icon counts.
5. Typical savings on the ~6.7 MB shared map: compact about 0.7 MB, relief density 0.5 with
   exclusions about 1.7 MB, reliefOnLoad about 0.75 MB. compact stubs burgs, states, provinces,
   cultures and religions only; removed markers, notes, labels, routes and zones are already
   gone.

**Propose a change as a sketch.** See section 10; the replay table there says which calls keep
the sketch rebasable.

**Hand-made state with provinces and arms.** `add {type:'state', items:[{capital:{burg:'X'},
name:'S'}]}` -> `paint_cells {select, set:{state:'S'}}` (and `{culture}`) ->
`regenerate {parts:['provinces','emblems'], provinces:{states:['S'], count:3}, emblems:{states:
['S']}, dryRun:true}` (sizes) -> without dryRun. One province at a time: `add {type:'province',
items:[{centre:{burg:'Y'}, name:'March'}]}` (state from the centre; it grows over the state's
nearer cells, or takes `cells`/`select`; shield, label and borders drawn). Locked states need `lockedStates:true`. A
Place capital makes a new burg; with `culture` it takes that culture. Every new burg also gets a
route to its nearest neighbour, as in the app (its row lists `routes`).

**Rivers.** A new river: `add {type:'river', items:[{points:[{x,y}, ...], name, parent?}]}`
(joined along land, extended downhill to the sea or `parent`; flux, width and the discharge
downstream follow), or literal `cells`. `inspect {at:{cell}}` lists a cell's `neighbours` (reroute `{cells}` must be
neighbours, in order). To move a confluence or end a river earlier: one edit call, three ops
in order: detour river A off the cells, reroute B through the freed cell, reroute A to its new
end. A climb is warned; lint river-uphill only flags rises of `riverTol` (12). For the
builder's rivfix examples load `build/snap-r2-start.map` (v3 and v7 already contain the fixes).

**Labels at full-map zoom.** Usually they are drawn but small: frame a region to check them. To
show groups the zoom rule hides: `display {labels:{town:{minSize:0}, capital:{alwaysShow:true}}}` (or
`'*'`); read `labels.groups.<g>.zoom`; `display {labels:'list'}` reads them back; clear with
`{labels:{'*':null}}`. `'*'` is not sticky for groups made later.

## 6. From eval workarounds to tools

What the builder did by eval (`primordial-soup/map/build/scripts`, `r1`, `r2`) and the call that
replaces it:

| builder did by eval | now |
| --- | --- |
| Wrote `grid.cells.h`/`pack.cells.h`, forced the rebuild, swapped `Rivers.alterHeights` to restore heights after erosion, `Biomes.define()` (apply_terrain.py) | `set_heights {grid\|pack\|image, fill, keepHeights:true, erosion:false, biomes:'redefine'}` after `flow` |
| Set option inputs, `options.*`, `distanceScale`, then `lock()`/`store()` (frame.js) | `edit {type:'map', ops:[{set:{...}, lock:'all'}], recalculate}` (locks saved in the .map) |
| 41 freehand routes: pushed `pack.routes`, wrote `cells.routes`, `drawRoute` (add_routes_pts.py) | `add {type:'route', items:[{points, noPathfind:true, group, name}]}` (locked; links kept consistent) |
| Route-group `<g>` styles by DOM (rgroups.js) | `add/edit {type:'routeGroup'}` (id, stroke, width, dash, linecap, opacity, after/before) |
| Custom biomes in `biomesData`, polygon painting, edge noise (biomes2.js) | `add/edit {type:'biome'}` (saved in the .map since this build: files from before, v3 and shared v6/v7, lost iconsDensity/icons/cost, so re-apply them with `edit biome`, e.g. Glass desert `{iconsDensity:3, icons:{dune:3, cactus:6, deadTree:1}, cost:200}`), `paint_cells {set:{biome}, select:{polygon, buffer, except}, feather:{width:3, unit:'cells'}}`, `regenerate {parts:['biomes'], biomes:{...}}` |
| Provinces spread from chosen centres with a flat queue (provinces.js) | `regenerate {parts:['provinces'], provinces:{states, centres:[{state, burg, name}], crossForeign:true}}` (`crossForeign:true` is what makes it a flat flood; add `lockedStates:true` for locked states; one call can mix centres and count) |
| Emblem shields via `COA.getShield` | `regenerate {parts:['emblems'], emblems:{states, stateCulture:true}}` (provinces and burgs default true; `shieldOnly` keeps designs) |
| River splices, splits, renames, moving notes (rivfix.js, split.py, rename_rivers.py) | `edit {type:'river', ops:[{ref, set:{split\|merge\|mainStem\|reroute\|end\|joinAt\|name\|type}}]}`; rivfix in two calls: `[{ref:28, set:{end:{at:7437}}}, {ref:14, set:{reroute:{cells:[7141,7289,7437,7586]}}}]` then `[{ref:9, set:{mainStem:8}}, ...renames]` |
| Burg labels hidden at full-map zoom | `display {labels:{...}}`, `screenshot {labels:'all'}` (check first: usually they show, just small) |
| Relief icon density by hand | `regenerate {parts:['relief'], relief:{density\|matchIcons, perBiome, exclude, nearBurgs}}` |
| Removed entities bloating the .map | `compact`, `compact:true` on saves; `edit map {reliefOnLoad:true}` |
| Territory and biome cell lists by eval (sel.py: feature polygons + buffer_px, except), then paint_cells per culture/state/religion/biome (territory.py, paint_territory.py, paint_biomes.py) | `apply {specPath, paint:[{from:'terrain_paint.Somnean', set:{culture, state}}, {from:'biomes_paint'}, ...]}` (the mapping above); one-off: `paint_cells {select:{polygon, buffer, except}}` |
| Composite marker legends, map/label notes by id (add_markers.py, add_notes.py) | `markers[].places` and `notes[].entity` through apply (the mapping above) |
| Spec checks by hand (verify.js, placecheck.py, overlaps.py, rivcheck.py) | `apply {specPath, mode:'check'}`, `lint` |
| Removing the random base entity by entity | `clear {types:[...]}` |
| Its own HTTP bridge (tb.py, port 7391) | `tupaia call` (section 0) |
| Dumping `pack` to JSON to read it | `find`/`inspect` `format:'compact'`, `map_info {diff:'counts'}` |

Still eval: zone fill patterns (zones_style.py), state label paths (sl.js), smoothing river
points (spire.js), ice shapes. Read the runtime API first and pass `redraw`.

## 7. Generation

- Always pass an explicit `seed` to `generate_map` and report it; the same seed and options give
  the same `digest` in any session. Omitted width/height = the server's default viewport. World
  settings: set and lock them with `edit map` first (locks survive generate_map; edit map rows
  with lock/unlock show the whole set as `locked:{before, after}`).
- `regenerate {parts}` consumes the random stream; `states` reseeds it. Snapshot first.
  `restoreLayers:true` turns back layers a part switched on. biomes, provinces, emblems and
  relief take options, are seeded or literal, and replay in sketches.
- Height edits on part of the map: `paint_cells ... set:{height:{..., rebuild:'keep'}}` (land
  only, refuses crossing 20, local: rivers and the economy stay), `'risk'` (coastline changes, entities carried), `'erase'` (wipes
  every entity; only when asked, with `confirmErase:true`).
- Names from a culture's language: `set:{name:{generate:{base:'Hawaiian'}}}` or
  `{generate:{culture:<ref>}}`.

## 8. eval

- Last resort, when no tool covers the change (section 6). Read `tupaia://docs/runtime-api.md`.
- Use bare globals (`pack`, `grid`, `notes`, `svg`), not `window.notes`. Undoable by default;
  `readOnly:true` for reads; pass `redraw:[...]` with the layers you touched (`redraw:false`
  redraws nothing).
- Never call `regenerateMap`, `saveSharedMap`, `restoreSharedMap` or `cloudflare.save`, and never
  replace the map with `generate()`/`uploadMap()` (lineage breaks). Page writes to `/api` get 403.
- After `compact`, never read `.name`/`.x`/`.cell` of removed records: they are stubs.
- In a sketch eval replays verbatim (ids inside the code are not rewritten) and is marked unsafe.

## 9. Persistence and outward writes

- `save_map` and `export` write under TUPAIA_OUT by default. Elsewhere only to a path the human
  named (`allowOutside:true` outside the repo); `overwrite:true` to replace; never
  `tests/fixtures` or source folders. Both refuse while an app editor is open.
- `shared_save`, `shared_restore` and `sketch_promote` change the live shared map that other
  people use. Use them ONLY when the human, in this conversation, explicitly asks for the live
  map to change; they work only in a server spawned with `TUPAIA_MODE=live` (otherwise MODE:
  tell the human, do not look for another way).
- Every time: `shared_status {versions:true}` -> `shared_save {}` (preview, token) -> tell the
  human the version you would overwrite, who saved it and when, lock holder, lineage, stale,
  build check, overrides -> on their yes `shared_save {confirm:true, token}` with the same flags
  -> report the new version and the backup paths.
- STALE or LOCKED: stop and tell the human; `force:true` only after a yes to that specific
  overwrite (preview again with force, confirm with force and the new token, say you forced
  it). LINEAGE: only `replaceWithUnrelated:true`, only when asked for exactly that. BUILD block:
  nothing overrides; tell the human to deploy first (also for a `reliefOnLoad` map on an old
  deploy). BUILD unknown: only `skipBuildCheck:true` after the human agreed. CONFLICT: report it.
- `shared_restore`: preview `{version}`, tell the human, then `{version, confirm:true, token,
  expectCurrent}`.
- Layer visibility, style and label overrides are saved with the map; mention them.

## 10. Sketches: proposing a change

A sketch is "base version N of the shared map plus the ops that produced it", stored on the
Worker as `sketch-<slug>` with a link that opens it in the app. Accepting it replays the ops onto
whatever the shared map is by then, so other people's edits survive.

1. `load_map {source:'shared'}`. Make no edits yet.
2. `sketch {action:'start', slug:'short-name', note:'what this proposes'}`.
3. Make the changes with the normal tools and screenshots. Check `sketch {action:'status'}`:
   `blobOnly` must stay false if the sketch should be rebasable.
   - Replay: edit (incl. world settings and recalculate), add, paint_cells (incl. height keep and
     risk, feather), display (incl. labels), apply, set_heights, clear, compact, regenerate with
     only biomes/provinces/emblems/relief, eval (unsafe; avoid).
   - Blob-only (save and promote as is, never rebase): regenerate with any other part,
     generate_map, load_map, snapshot restore, regrid, a height paint with `rebuild:'erase'`,
     screenshot `keepLayers`. `snapshot {action:'undo'}` takes the last op out of the log and
     makes the sketch replayable again.
4. `sketch {action:'summary'}`: markdown and before/after shots (`shots:false` skips them).
5. `sketch {action:'save', confirm:true}` (live-mode server; writes only `sketch-<slug>`),
   returns `viewUrl`. Give the human the link and the summary, then stop and wait.
6. On yes: `sketch {action:'rebase'}` (read `applied`, `skipped`, `conflicts`, `replayMs`; it
   can take minutes on a loaded machine) -> `sketch_promote {}` (tell the human the version it
   replaces) -> `sketch_promote {confirm:true, token:'<token>', then:'discard'}` -> report the
   new version. The token is bound to `then`. `then` defaults to 'keep': the kept copy is
   marked promoted: open says so and rebase and promote refuse it (its adds would run twice).
   `sketch {action:'status'}` says `rebaseNeeded` when the shared map moved past the base.
   A blob-only sketch: promote directly while `shared_status` still shows its base version;
   if the shared map moved, start a new sketch from it and redo the work.
7. On no: `sketch {action:'discard', slug, confirm:true}` (live mode). A sketch you never saved:
   `sketch {action:'discard'}` (preview) then `{action:'discard', confirm:true}`, in any mode; the
   page keeps its map.

Stop and ask instead of working around: a rebase conflict (name each op and its reason; do not
`onConflict:'skip'` without a yes; 'skip' drops only the conflicting items, fields or cells:
`itemsSkipped`, `cellsSkipped`; while a stopped rebase holds the page every mutating call is
refused with SKETCH, for every agent on the daemon: undo it as the rebase said); ops.json over 2 MB; a CONFLICT on save (the slug exists);
`diverged` in status; any LOCKED/BUILD/STALE on promote.

Local mode can start, summarise, list, open and rebase sketches and discard an unsaved one;
save, discarding a saved sketch, and promote need the live-mode server.

## 11. Failure handling

- Results list `alerts` (app dialogs, auto-dismissed), `consoleErrors` and `notes`. Read them.
- TIMEOUT on a mutating call: only that call is lost; the next call relaunches and restores the
  map from before it. A crash or hang after an edit: the relaunch note says `Restored the map as
  '<tool>' left it (...) (nothing lost)`. A read-only call that stalls usually keeps the page
  (`the page answers again ... not relaunched`). Check with `session`/`map_info` if unsure. Under
  the daemon a call refused while it was closing never ran.
- A failed `snapshot` undo/redo/restore changes nothing: the map from before it is loaded back
  (`details.pageRestored`) and the history is as it was.
- APP_ALERT on load: the app rejected the file (Invalid, Ancient or Newer file).
- REFUSED with "customization": an editor is open (`eval {code:"closeDialogs(); customization =
  0"}`).
- A batch error names the item index (`details.errors`); fix that item and resend the batch.
- A failed call changed nothing and took no undo entry: do not `snapshot undo` after an error (it
  would undo the previous successful call).

## 12. Pitfalls

- Removing a capital or market centre needs `force:true` (`newCapital` picks the successor);
  a single edit remove ignores locks, `clear` honours them.
- Freehand routes are locked; `regenerate routes` keeps them but renumbers every locked route
  (use `routeIds`). An edited generated route needs `lock:true` to survive.
- After a risk rebuild (set_heights, paint_cells height risk) or regrid, run `lint`: markers can
  sit on new water (route points are re-recorded to their cells: `carried.routePointsRepointed`).
  A river cell list with gaps (`river-gap`, after an eval edit say) has a fixAll that reroutes it.
- `paint_cells`: an unknown key in select/where/set is BAD_FIELD, never ignored; select has
  `buffer` (px) and `except` (another select). A feather narrower than one cell does nothing.
- Biomes cannot be removed (repaint their cells). `clear` keeps locked entities (freehand routes)
  and never removes route groups.
- Population in `changes`/diffs is stored thousands; set and find use people.
- Biome icon changes show only after `regenerate {parts:['relief']}`.
- Settings only set inputs: recalculate or read `stale`.
- Typed arrays come back from eval as plain arrays; large results are capped.
- `mapId` is not an identity; it changes on every load.
- Snapshots live in server memory: they survive browser relaunches, not a server or daemon
  restart. `snapshot {action:'take', saveTo}` or `save_map` for anything that must last.
