---
name: tupaia-dexterity
description: Drive the Tupaia map app through the `tupaia` MCP server to generate, query, edit, style, screenshot, snapshot/undo and export maps, propose shared-map changes as sketches, and (only when the human asks) save the live shared map. Use for any request to look at or change a Tupaia or FMG (Fantasy Map Generator) map.
---

# Tupaia dexterity

The `tupaia` MCP server runs the built Tupaia app (Ryan's fork of Azgaar's Fantasy Map
Generator) in headless Chromium and exposes 21 tools. This skill is how to use them well.
For full signatures, field tables and error codes, read the resource
`tupaia://docs/cheatsheet.md`. Read `tupaia://docs/runtime-api.md` before any `eval`.

## 1. Start

- Call `session` (status) first. It launches the browser (about 1 s) and reports the mode,
  the origin that shared reads would hit, the app version and the map's provenance.
- Mode is `local` unless the human spawned the server with `TUPAIA_MODE=live`. You cannot
  switch to live; do not try, and do not suggest it unless the human wants the live map
  changed.
- A local-mode page boots with a random map. Get the map you actually want with
  `load_map {path}`, `generate_map {seed, ...}`, or `load_map {source:'shared'}`. That last one
  is a read-only GET, so it is safe in local mode for experimenting on a copy of the shared
  map.
- A live-mode server loads the shared map on its first launch; `session` shows its version.

## 2. Coordinates and addressing

- Map px are graph space (0..graphWidth, 0..graphHeight), not screen pixels. Places are
  `{x,y}`, `{lat,lon}`, `{cell}`, `{entity:{type,ref}}`, or `{entity:{type:'route'|'river',
  ref}, at:0.5}` (a fraction along it).
- A ref is an id or an exact name. Case and diacritics are folded; states and provinces
  also match their full name. Fuzzy matches are never applied.
- On NOT_FOUND or AMBIGUOUS, read the candidates. Retry with the id. Ask the human when the
  choice changes what they meant.
- Use `find` to discover names (`find {type:'namesbase'}` lists name bases) and `inspect` to
  translate between ids, names, cells, x,y and lat/lon.
- Id 0 is a placeholder: Neutrals (state), Wildlands (culture), No religion. Removed
  entities stay in their arrays with `removed: true`.
- `inspect {at:{screen:[px,py], shot:'s3'}}` maps a pixel of a returned screenshot to the
  map, so you can act on what you see.

## 3. The working loop

1. `find` / `inspect` to pin down the targets.
2. `snapshot {action:'take', label}` before any multi-step or risky change.
3. Mutate with the batch tools: `edit`, `add`, `paint_cells`, `display`. One call with many
   ops beats many calls; each call validates every op first and changes nothing if one is
   invalid (unless `continueOnError`).
4. Read the diff: the result's `changes`, or `map_info` (diff since the newest snapshot or
   undo point; `since:'<label>'` for a named one).
5. `screenshot` framed on what changed.
6. If it is wrong: `snapshot {action:'undo'}` (or `{action:'undo', n:3}`), or
   `snapshot {action:'restore', label}`. `snapshot {action:'list'}` shows the undo history as
   `{n, op, args, at}`; `redo` exists.

Use `dryRun:true` for big batches and for anything that resolves names you have not seen.
Every mutating tool is undoable, including `eval` (unless `readOnly:true`), `display` and
`load_map`.

## 4. Screenshots

- Take one after any visual change, framed on the change (`target:{entity}` or
  `{bbox:[x0,y0,x1,y1]}`, with `zoom`), and before telling the human the work is done.
- Do not take one after pure reads.
- `full:true` shows the whole map. `layers:{off:[...]}` isolates what you are checking for
  that one shot.
- The default JPEG (maxSide 1024) keeps results small. The full PNG is saved on disk (`file`);
  name that path when the human wants the file.
- Before/after: keep the first shotId, then `screenshot {compare:'<shotId>'}` for a diff image
  and `changedPct` at the same view.

## 5. Generation

- Always pass an explicit `seed` to `generate_map` and report it. The same seed and options
  give the same map; options you leave out may be randomised.
- `regenerate {parts}` consumes the random stream, so it cannot be reproduced against a fresh
  generate, and `states` reseeds it. Snapshot first. Some parts switch layers on;
  `restoreLayers:true` turns them back off.
- Height edits: `paint_cells ... set:{height:{..., rebuild:'keep'}}` changes land only and
  refuses anything that crosses height 20. `rebuild:'risk'` changes the coastline (drain or
  raise a lake) and keeps the entities. `rebuild:'erase'` wipes every entity; use it only when
  asked, with `confirmErase:true`.
- Names from a culture's language: `set:{name:{generate:{base:'Hawaiian'}}}` or
  `{generate:{culture:<ref>}}`.

## 6. eval

- Last resort, when no tool covers the change. Read `tupaia://docs/runtime-api.md` first.
- Use bare globals (`pack`, `grid`, `notes`, `svg`), not `window.notes`.
- It is undoable by default; pass `readOnly:true` for reads. After a mutation, pass
  `redraw:[...]` with the layers you touched.
- Never call `regenerateMap`, `saveSharedMap`, `restoreSharedMap` or `cloudflare.save`. Page
  writes to `/api` get a 403 anyway. Never change the shared map through eval.

## 7. Persistence

- `save_map` and `export` write under TUPAIA_OUT by default (relative paths). Write elsewhere
  only to a path the human named; outside the repo that needs `allowOutside:true`.
- Replacing a file needs `overwrite:true`. Never write into `tests/fixtures` (always refused)
  or source folders.
- Both refuse while an app editor is open (`customization != 0`).
- `export` formats: svg, png, jpeg (whole map, `scale`), json-full, json-minimal,
  geojson-cells/-routes/-rivers/-markers/-zones.

## 8. Outward writes: the live shared map

The shared map at map.activationlayer.org is used by other people. `shared_save`,
`shared_restore` and `sketch_promote` (section 9) are the only tools that change it.

- Use them ONLY when the human, in this conversation, explicitly asks for the live shared map
  to change. Never as a side effect, never to "back up" work, never because a task seems to
  imply it.
- They work only in a server the human spawned with `TUPAIA_MODE=live`. In local mode they
  return MODE; tell the human that, and do not look for another way.
- The sequence, every time:
  1. `shared_status {versions:true}`: live version, who saved it and when, lock holder,
     lineage, stale, build check.
  2. `shared_save {}` without `confirm`: the preview. Nothing is written. It returns a
     `token` unless there is a `refusalReason`.
  3. Tell the human, in plain words: the live version you would overwrite, who saved it and
     when, any lock holder, whether the page map is derived from the shared map (lineage),
     whether it is stale, the build check, and any overrides. Ask for a yes.
  4. Only after that yes: `shared_save {confirm:true, token:'<token from step 2>'}` with the
     same flags as the preview.
  5. Report the new version and the backup paths from the result.
- The token is valid for 10 minutes and one write, and only while the live version, the page
  map and the flags stay as previewed. If anything changed, preview again and tell the human
  again.
- STALE (someone saved since you loaded) or LOCKED (someone holds the edit lock): stop and
  tell the human who and when. Use `force:true` only after they say yes to that specific
  overwrite: preview again with `force:true`, show it, confirm with `force:true` and the new
  token, and say in your reply that you forced it and what it replaced.
- LINEAGE (the page map was generated or loaded from a file, not from the shared map): it
  would replace the shared map with an unrelated one. Only `replaceWithUnrelated:true`
  overrides it, and only when the human asked for exactly that.
- BUILD block (local app VERSION newer than the deployed one): nothing overrides it. The
  shared map would become unloadable for live users. Tell the human to deploy first.
- BUILD unknown (the deployed build could not be read): `force` does not help. Only
  `skipBuildCheck:true` overrides it, and only after the human agreed to save without that
  check.
- Never replace the map with eval (`generate()`, `uploadMap()`): lineage is bound to the
  app's map id, so the shared map then counts as unrelated. Use load_map/generate_map.
- CONFLICT (the Worker answered 409): someone saved in between. Report it; do not retry
  with force on your own.
- `shared_restore` follows the same rules: preview `{version}`, tell the human, then
  `{version, confirm:true, token, expectCurrent:<live version you told them>}`.
- Layer visibility and style are saved with the map; a `display` change ships with the next
  shared_save. Mention it if you changed them.

## 9. Sketches: proposing a change

When Ryan (or anyone) wants a change to the shared map that people can look at before it lands,
make it a sketch instead of editing the live map. A sketch is "base version N of the shared map
plus the ops that produced it". It is stored on the Worker as its own map, `sketch-<slug>`, and
has a link that opens it in the app. Accepting it replays the ops onto whatever the shared map
is by then, so edits other people made in the meantime survive.

The loop:

1. `load_map {source:'shared'}` (a read-only GET). Make no edits yet.
2. `sketch {action:'start', slug:'short-name', note:'what this proposes'}`. It is REFUSED if the
   page map did not come from the shared map or was already edited; do what the message says.
3. Make the changes with the normal tools, with screenshots as usual. Every mutating call is
   logged with what it actually did (ids, literal generated names, literal cells). Prefer
   edit, add, paint_cells and display. `regenerate`, `generate_map`, `load_map`,
   `snapshot restore` and a height paint with `rebuild:'risk'` or `'erase'` make the sketch
   blob-only (it can be saved, viewed and promoted as is,
   but not replayed onto a newer map); undo them if that was not intended. eval is replayed
   verbatim and marked unsafe; avoid it. `snapshot {action:'undo'}` takes the last op out of
   the log.
4. `sketch {action:'summary'}`: markdown (base version, one sentence per op, counts vs base,
   the view link) and before/after screenshots.
5. `sketch {action:'save', confirm:true}` (needs the live-mode server). It writes only
   `sketch-<slug>` and its ops.json, never the shared map, and returns `viewUrl`.
6. Give Ryan the `viewUrl` and the summary markdown (and the framed before/after images). The
   link opens the sketch in the app, not the shared map. Then stop and wait for his answer.
7. When he says yes:
   1. `sketch {action:'rebase'}`: replays the sketch onto the CURRENT shared map. If nobody
      saved since the base, it is a clean replay onto the same version. Read `applied`,
      `skipped` and `conflicts`.
   2. `sketch_promote {}`: the preview (what it overwrites, lineage, build check) and a token.
      Tell Ryan the version it replaces and anything unusual in the preview.
   3. `sketch_promote {confirm:true, token:'<token>', then:'discard'}` (or `then:'keep'` if he
      wants the sketch kept). It is shared_save underneath: one PUT with X-Map-Version.
   4. Report the new shared version and the backup paths.
8. When he says no: `sketch {action:'discard', slug, confirm:true}`.

Stop and ask Ryan, instead of working around it, when:

- the rebase reports a conflict (a target someone removed, `both changed <field>`, an id that
  now names another entity, a removal of something someone changed since, renumbered cells):
  name each op and its `reason`; do not rerun with `onConflict:'skip'` unless he agrees to
  drop those ops. While a stopped rebase holds the page, shared_save refuses too: undo it
  (`snapshot {action:'undo', n}` as the rebase said) first;
- `sketch save` refuses because ops.json would pass 2 MB: undo the largest ops (big paint
  selections) or split the sketch, his call;
- the sketch is blob-only and the shared map moved since its base: it cannot be replayed, and
  promoting it would need the shared map's newer edits thrown away (sketch_promote refuses);
- sketch_promote refuses with LOCKED, BUILD or STALE, or the preview shows a version you did not
  tell him about: preview again only after telling him;
- `sketch save` answers CONFLICT: `sketch-<slug>` already exists at another version (someone
  else's sketch or another session); open it or pick another slug, his call;
- the status shows `diverged` (the page changed after the sketch stopped recording): the blob
  then has changes the log does not.

Other actions: `sketch {action:'list'}` (read-only; works in local mode) shows the saved sketches
with their headers; `sketch {action:'open', slug}` loads one into the page as the active sketch
(local mode can open and rebase, not save). `sketch {action:'status'}` shows the base, the log,
`dirty` since the last save, `viewUrl`, and why a sketch is blob-only.

## 10. Failure handling

- Results list `alerts` (app dialogs, auto-dismissed), `consoleErrors` and `notes`. Read them.
- TIMEOUT on a mutating call, or a note that the browser relaunched: call `session`, check
  the map, and restore the latest snapshot if it is not what you expect.
- APP_ALERT on load means the app rejected the file (Invalid, Ancient or Newer file).
- REFUSED with "customization": an editor is open; close it first
  (`eval {code:"closeDialogs(); customization = 0"}`).
- A batch error names the item index (`details.errors`); fix that item and resend the batch.

## 11. Pitfalls

- Layer toggles flip state; `display` and `screenshot {layers}` handle that for you.
- Locked states' labels, marker removal (icon and note) and state removal are handled for
  you. Removing a capital or a market centre is refused; change the capital with
  `edit state {capital}` first.
- Removing a province, culture or religion is refused; repaint the cells instead.
- Typed arrays come back from eval as plain arrays; large results are capped, so ask for
  what you need.
- `mapId` is not an identity; it changes on every load.
- Snapshots live in server memory: they survive browser relaunches, not a server restart.
  Use `snapshot {action:'take', saveTo}` or `save_map` for anything that must last.
