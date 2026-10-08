# Tupaia MCP cheatsheet

> Core and mutation layers. The worked recipes are still to come.

## Tools (core layer)

- `session` - status (mode, origin reads hit, versions, browser, map provenance, snapshots,
  console errors, outward requests); `set_mode {mode:'local'}` (one-way); `restart {restore}`.
- `map_info {since?, detail?}` - overview + diff since the newest snapshot/undo point,
  `'checkpoint'` (previous map_info), a snapshot index/label, or `'none'`.
- `find {type, name?, where?, near?, radius?, sort?, fields?, limit?, offset?}`.
- `inspect {entity:{type,ref}} | {at:Place} | {at:{screen:[px,py], shot}}`.
- `screenshot {target?, zoom?, full?, view?, layers?, compare?, format?, maxSide?, scale?, saveTo?}`.
- `snapshot {action:'take'|'list'|'drop'|'restore'|'undo'|'redo', label?, index?, n?, saveTo?}`.
- `eval {code, args?, readOnly?, redraw?, timeoutMs?}`.
- `load_map {path} | {source:'shared'}`.

## Tools (mutation layer)

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

NOT_FOUND, AMBIGUOUS (both with candidates), REMOVED, OUT_OF_BOUNDS, BAD_ARGS, BAD_FIELD,
BAD_TYPE, BAD_PLACE, BAD_LAYER, NO_PATH, REFUSED, MODE, TIMEOUT, CANCELLED, EVAL_ERROR,
EVAL_SYNTAX, APP_ALERT, BROWSER, RESULT_TOO_LARGE. Batch errors carry `details.errors`
[{index, code, message, candidates?}].

## Layer names

texture, heightmap (height), lakes, biomes, cells, grid, coordinates, compass, rivers, relief,
religions, cultures, states, provinces, zones, borders, routes, temperature, ice, goods,
markets, trade, precipitation, population, emblems, burgs (burgIcons), labels, military,
markers, rulers, scaleBar, vignette.
