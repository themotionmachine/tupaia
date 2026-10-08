# Tupaia MCP cheatsheet

> Stub from the core layer. Later layers fill in the remaining tools, the field tables and
> the worked recipes.

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

## Refs

`17`, `"17"`, `{id:17}`, `"Norvik"`, `{name:"Norvik"}`. Names: exact, then case/diacritic
folded (states/provinces also match fullName). Never fuzzy. Id 0 is valid only for state
(Neutrals), culture (Wildlands), religion (No religion). Notes and labels use string ids
(`burg12`, `label3`).

## Places

`{x,y}` map px | `{lat,lon}` | `{cell}` | `{entity:{type,ref}}` | `{entity:{type:'route',ref}, at:0.5}`.
Out-of-map places fail with OUT_OF_BOUNDS.

## Error codes

NOT_FOUND, AMBIGUOUS (both with candidates), REMOVED, OUT_OF_BOUNDS, BAD_ARGS, BAD_PLACE,
BAD_LAYER, REFUSED, MODE, TIMEOUT, CANCELLED, EVAL_ERROR, EVAL_SYNTAX, APP_ALERT, BROWSER,
RESULT_TOO_LARGE.

## Layer names

texture, heightmap (height), lakes, biomes, cells, grid, coordinates, compass, rivers, relief,
religions, cultures, states, provinces, zones, borders, routes, temperature, ice, goods,
markets, trade, precipitation, population, emblems, burgs (burgIcons), labels, military,
markers, rulers, scaleBar, vignette.
