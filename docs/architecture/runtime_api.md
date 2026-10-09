# Runtime API reference (for headless drivers)

This is a reference for scripting a running Tupaia page, for example from the planned MCP server (stdio, Playwright headless Chromium). It covers what to call, where it lives, and what you must redraw afterwards.

- **Basis.** Verified against commit `f35548f5` in two ways:
  - by reading the code (each `file:line` below);
  - by Playwright probes against the built `dist/` served locally, marked **[R]**.
- **Unverified items** are marked _unverified_.
- **Paths** are relative to the repo root. `public/` files are classic scripts; `src/` files are ES modules registered on `window`.

## 0. How to call things

- **Classic `var`/`function` globals are on `window`.** Examples: `grid`, `pack`, `seed`, `graphWidth`, `drawStates`.
- **Top-level `let`/`const` in classic scripts are not on `window`.** This includes `mapId`, `notes`, `options`, `svg`, every layer selection, `customization`, `regenerateMap` and `scale`.
  - Bare identifiers inside `page.evaluate(() => …)` still resolve them, because they are global lexical bindings. [R]
  - Never write `window.notes`. It is `undefined`. [R]
- **`window.mapId` is the exception.** It is copied explicitly at `public/main.js:1309`.
- **Lazy modules.** `await window.lazy.<name>()` returns the module namespace (`src/lazy-loaders.ts:4-39`). The names you need:
  - `load`, `save`, `exportMap`, `exportJson`, `sharedMap`
  - `statesEditor`, `culturesEditor`, `religionsEditor`
- **Script load order.** Defined at `src/index.html:8963-9024`:
  1. jquery and jquery-ui
  2. `versioning.js`
  3. d3 **v5.8.0** [R]: `d3.event` style, no `d3.pointer`
  4. flatqueue, delaunator
  5. module bundles (utils, generators, renderers, controllers, services, lazy-loaders)
  6. deferred `public/` UI scripts, with `main.js` before the editors
- **Seeded randomness.** `Math.random` is replaced globally by a seeded Alea (`main.js:774`) [R]. Anything you call that uses randomness consumes the map's random stream.

## 1. Boot and ready signals

| What | Where | Notes |
|---|---|---|
| `DOMContentLoaded` → `hideLoading` → `checkLoadParameters()` | `public/main.js:282, 320` | Then `restoreDefaultEvents`, `initiateAutosave`, `initTourPromptButton`. |
| URL `?maplink=` | `main.js:325` | `loadMapFromURL` (`src/io/load.ts:76`). |
| URL `?seed=` | `main.js:339` | `generateMapOnLoad()`; ~2.5s at the default size [R]. |
| Shared-map boot | `main.js:347-351` | Runs unless `?local`: `lazy.sharedMap().loadSharedMapOnBoot()` (`src/io/cloud-cloudflare.ts:78`). On a 404 it falls through to random generation [R]. **Pass `?local` or `?seed` in headless runs.** |
| `onloadBehavior` = lastSaved | `main.js:354` | Loads IndexedDB `lastMap`; otherwise `generateMapOnLoad` (`main.js:369`). |
| `generateMapOnLoad()` | `main.js:372` | Steps: `applyStyleOnLoad` → `await generate()` → `applyLayersPreset` → `drawLayers` → `fitMapToScreen` → `focusOn` → `toggleAssistant`. |
| `?width=&height=` | `public/modules/ui/options.js:535` (`applyStoredOptions`) | Overrides the stored map size. |
| `?options=default` | `options.js:598` | Forces `randomizeOptions`. |
| **Ready (first map)** | `main.js:1308-1314` | `showStatistics` sets `mapId = Date.now()` and `window.mapId`, pushes `mapHistory`, then dispatches `map:generated` with `{seed, mapId}`. |
| `map:loading` / `map:loaded` / `map:resampled` | `src/io/load.ts:127, 820`, `src/generators/resample.ts:476` | Tupaia additions: a load starts / a load succeeded / a density-only resample kept the map id (instead of `map:generated`). See §10. |

**Ready recipe [R].**

- **After generate or regenerate,** `map:generated` fires **before** `drawLayers`. At the event, and after a microtask, the SVG is still empty. After one `setTimeout(0)` it is fully drawn. So: listen for the event, then await one macrotask.
- **After a file load,** the event fires last, with the SVG already present.
- **Polling alternative:** `page.waitForFunction(() => window.mapId !== undefined)` works for the first map only. For later maps, compare against the previous `window.mapId`.

## 2. Globals and the data model (inspect)

| Global | Decl | Meaning |
|---|---|---|
| `grid` | `var`, `main.js:145` | The initial jittered-square Voronoi. `grid.cells.h` holds the heightmap; `cellsDesired` is the target cell count. |
| `pack` | `var`, `main.js:146` | The packed graph plus all entities. |
| `seed` | `var`, `main.js:147` | String seed. |
| `mapId` | `let`, `main.js:148` | Equals `Date.now()` at the last `showStatistics`. It is **re-stamped on every load** [R]. |
| `mapHistory` | `let`, `main.js:149` | List of `{seed, width, height, template, created}`. |
| `notes` | `let`, `main.js:152` | `[{id, name, legend}]`. Ids look like `burg12`, `marker3`, `regiment1-0`, `stateLabel5`. `docs/architecture/data_model.md:394` wrongly says `i`. |
| `customization` | `let`, `main.js:154` | 0 = idle. Non-zero means an editing mode: 1 heightmap, 3 burgs overview, 6 biomes, 7/8 religions, 10 zones, 11/12 provinces, 15 markets. Save refuses while it is non-zero. |
| `options` | `let`, `main.js:157` | Runtime-only bag: `pinNotes`, `winds`, temperatures, `stateLabelsMode`, `burgs.groups`, `trade.animation`. Most generation options are **DOM inputs, not this object** (see §4). |
| `biomesData`, `nameBases`, `style` | `main.js:174-177` | |
| `scale`, `viewX`, `viewY`, `zoom` | `main.js:182-184, 248` | Current d3 zoom state. |
| `mapCoordinates` | `var`, `main.js:250` | `{latT, latN, latS, lonT, lonW, lonE}`. |
| `populationRate`, `distanceScale`, `urbanization`, `urbanDensity` | `main.js:251-254` | Read from DOM inputs. Defaults are 1000, 3, 1. |
| `graphWidth`/`graphHeight` | `var`, `main.js:259-260` | Map space. Set from `mapWidthInput`/`mapHeightInput`. |
| `svgWidth`/`svgHeight` | `let`, `main.js:263-264` | Viewport. With width 1600 in a 1280 viewport you get svg 1280x720, scaleExtent `[0.8, 20]` [R]. |
| SVG selections | `let`, `main.js:35-108` | `svg`, `viewbox`, `rivers`, `labels`, `burgIcons`, `burgLabels`, `statesBody`, `zones`, `markers`, and others. **They are reassigned on load** (`src/io/load.ts:339-397`). |

**Placeholders [R].**

- `pack.burgs[0] === 0`, `pack.provinces[0] === 0` and `pack.features[0] === 0` (the number zero).
- `pack.states[0]` is the Neutrals object, `pack.cultures[0]` is "Wildlands", and `pack.religions[0]` is "No religion".
- A removed entity stays in its array with `removed: true`. Always filter with `x && x.i && !x.removed`.

**Cell arrays (`pack.cells`) [R].**

- **Fields:**
  - `i`, `p` (`[x,y]`), `c` (neighbours), `v`, `b` (border flag), `h` (Uint8 height, 20+ is land), `t`, `f` (feature), `s` (suitability), `pop` (Float32)
  - `burg`, `state`, `province`, `culture`, `religion`, `biome`, `r` (river), `g` (grid cell)
  - `routes` (an object `{cellId: {neighbourId: routeId}}`), `good`, `market`
- **Types:** typed arrays (`i` Uint16, `h` Uint8, `t` Int8, `s` Int16, `pop` Float32, …) serialize through `page.evaluate` as `{0: v, …}` objects, not arrays [R]. Wrap them in `Array.from()` inside the page.

**Entity shapes.** The interfaces are authoritative:

| Entity | Interface | Key fields |
|---|---|---|
| Burg | `src/generators/burgs-generator.ts:9-37` | `i, cell, x, y, state, culture, name, population, capital, port, group, market, lock, removed` |
| State | `src/generators/states-generator.ts:24-55` | `i, name, color, capital, center, culture, type, form, formName, fullName, provinces[], neighbors[], diplomacy[], pole, lock, removed` |
| Province | `src/generators/provinces-generator.ts:5-18` | `i, state, center, burg, name, formName, fullName, color, pole, lock` |
| Marker | `src/generators/markers-generator.ts:19` (region) | `i, type, icon, x, y, cell, lock, …`; its note id is `marker<i>` |

## 3. Find and look up

| Signature | Meaning | Where |
|---|---|---|
| `findCell(x, y, radius?) → cellId` | Nearest pack cell to map coordinates. Uses a quadtree cached per `pack.cells.p`. | `src/utils/graphUtils.ts:235` (registered `src/utils/index.ts:131-160`) |
| `findGridCell(x, y, grid) → gridCellId` | Grid cell from the square-grid maths. | `graphUtils.ts:186` |
| `findAll(x, y, radius)`, `findGridAll` | All cells within a radius. | `src/utils/index.ts:131-160` |
| `getPackPolygon(i)`, `getGridPolygon(i)` | Polygon vertices of a cell. | same |
| `isLand(i)`, `isWater(i)` | Height test (`h >= 20`). | same |
| `getCoordinates(x, y, decimals) → [lon, lat]`, `getLongitude`, `getLatitude` | Map coordinates to geographic coordinates. | `src/utils/commonUtils.ts:218-253` |
| `findPath(start, isExit, getCost)` | A* where **the second argument is a predicate `(cellId) => boolean`, not an end cell**. | `src/utils/index.ts:99` |
| `Routes.getRoute(fromCell, toCell)` / `areConnected` / `hasRoad` / `isCrossroad` | Route lookups over `pack.cells.routes`. | `src/generators/routes-generator.ts:757-783` |
| `Rivers.getBasin(r)`, `Rivers.getNextId(rivers)` | River helpers. | `src/generators/river-generator.ts:519, 525` |
| `getCellPopulation(i)`, `getFriendlyHeight(…)` | UI-formatted values. | `public/modules/ui/general.js:442, 420` |
| `Names.getCulture(c, min, max, dupl)`, `Names.getState(name, culture, base)`, `Names.getMapName(force)` | Name generation. `getMapName` writes `mapName.value`. | `src/generators/names-generator.ts:160, 203, 281` |

There is **no "nearest burg" or "entity by name" helper**. Scan linearly instead, for example `pack.burgs.find(b => b && !b.removed && b.name === n)`. For nearest-burg, use `pack.cells.burg[findCell(x, y)]` (only an exact cell hit) or `d3.quadtree` (_unverified_).

## 4. Generate

### 4.1 Full map

| Signature | Meaning | Where | Redraw |
|---|---|---|---|
| `regenerateMap(options?)` | **Leading-edge throttle, not a debounce.** A second call within 250ms is **silently dropped**. It returns `undefined`, not a promise. Steps: closeDialogs, `customization = 0`, resetZoom, undraw, generate, drawLayers, fitMapToScreen. | `public/main.js:1317`; throttle at `src/utils/commonUtils.ts:81-92` | Done for you. Await `map:generated` plus one macrotask. |
| `await generate({seed?, graph?})` | Data pipeline only (`main.js:668-729`). On an error it opens a "Generation error" `#alert` (`main.js:741`) and does not throw. | `main.js:662` | You must call `undraw()` before it, and `drawLayers(); fitMapToScreen()` after. Takes ~1.07s at 20K cells [R]. |
| `undraw()` | Clears the SVG layers and **sets `notes = []`**. | `main.js:1339` | |
| `setSeed(s)` | The URL seed applies to the first map only, otherwise `generateSeed()`. Reseeds `Math.random`. | `main.js:761` | |
| `regeneratePrompt(options)` | UI entry point. Shows no dialog if the map is under 1 minute old, otherwise a confirm `#alert`. | `options.js:726` | Avoid it; call `regenerateMap` directly. |

The direct path, verified [R]: `undraw(); await generate({seed:"5555"}); drawLayers(); fitMapToScreen();`.

### 4.2 Options

Options are DOM inputs plus a localStorage lock system. There is no config object.

- **Each option is an `<input>`/`<select>`.** Examples:
  - `pointsInput` (with `dataset.cells`)
  - `templateInput`
  - `statesNumber`, `provincesRatio`, `manorsInput`, `religionsNumber`
  - `culturesInput` together with `culturesOutput`
  - `culturesSet`, `sizeVariety`, `growthRate`
  - `temperatureEquatorInput`, `precInput`, `distanceScaleInput`
  - `mapWidthInput`, `mapHeightInput`
- **`randomizeOptions()` (`options.js:598`) re-randomizes most of these on every generation unless `locked(id)`.** Therefore set the value **and** call `lock(id)`.
- **Lock helpers** (`public/modules/ui/general.js`):
  - `lock(id)` at :532 stores the `[data-stored=id]` value in localStorage.
  - `unlock` :542, `locked` :551 (reads `#lock_<id>.dataset.locked`), `stored` :557, `store` :562.
  - `applyOption($select, value, name)` at :583 adds the option to a select if it is missing.
  - **Locks persist in localStorage across reloads.** Use a fresh browser context or clear them.
- **`changeCellsDensity(n)`** (`options.js:345`). n runs from 1 to 13: 4 = 10K, 5 = 20K, … 13 = 100K (table at `options.js:329`). Verified: `changeCellsDensity(5); lock("points")` gives `grid.cellsDesired = 20000` [R].
- **Cultures are clamped.** `changeCultureSet` (`options.js:357`) clamps `culturesInput` to `culturesOutput` or to the set maximum. Setting only `culturesInput = 4` produced 10 cultures [R]. Set `culturesInput` and `culturesOutput` and lock both `cultures` and `culturesSet`.
- **Templates** (`templateInput`, read in `src/generators/heightmap-generator.ts:546`):
  - volcano, highIsland, lowIsland, continents, archipelago, atoll, mediterranean, peninsula, pangea, isthmus, shattered, taklamakan, oldWorld, fractious
  - plus precreated image heightmaps, which are fetched.
- **Extreme-climate warnings.** `Cultures.generate` can open climate dialogs (`src/generators/cultures-generator.ts:1038-1063`).

### 4.3 Partial regeneration (`public/modules/ui/tools.js`)

The UI buttons (`tools.js:37-66`) open a confirm unless `sessionStorage.regenerateFeatureDontAsk` is set. Calling these functions directly skips the confirm.

| Call | Line | Effect and redraw |
|---|---|---|
| `regenerateRoutes()` | 133 | Keeps locked routes; `Routes.generate(locked)` then `drawRoutes()`. |
| `regenerateRivers()` | 141 | `Rivers.generate()` (reseeds Alea(seed)), specify, `Features.defineGroups`, `Lakes.defineNames`, `drawRivers()`. |
| `recalculatePopulation()` | 149 | Recomputes burg populations. |
| `regenerateStates()` | 165 | Calls `recreateStates` (196); redraws states, borders and labels. |
| `regenerateProvinces()` | 353 | `Provinces.generate(true, true)` then redraw. |
| `regenerateBurgs()` | 369 | Rebuilds burgs and remaps notes `burg<i>`. |
| `regenerateGoods` 495, `regenerateMarkets` 501, `regenerateEconomy` 507, `regenerateProduction` 524 | | Economy layers. |
| `regenerateEmblems` 534, `regenerateReligions` 586, `regenerateCultures` 593, `regenerateMilitary` 619, `regenerateIce` 627, `regenerateMarkers` 633 | | Each redraws its own layer (_unverified_ for every branch). |
| `regenerateZones(event)` | 640 | **Throws without an event**: "Cannot read properties of undefined (reading 'ctrlKey')" [R]. Pass `{}` or call `Zones.generate(1); drawZones()`. |

## 5. Edit (per entity)

Editor dialogs are **closures** (`editBurg` at `public/modules/ui/burg-editor.js:2`) or **module-private** (`src/controllers/states-editor.ts` exports only `open`, at line 24). Their handlers cannot be called. Reproduce the mutation plus redraw listed below; each row cites the reference handler.

- **Sync rule:** after any change to `pack.cells.state`, `culture`, `religion` or `province`, the matching `draw*` call is needed. Borders need `drawBorders()`.
- **Undo:** there is no general undo. Snapshot with `prepareMapData()` before risky edits.

### Burg

| Operation | How | Reference | Redraw |
|---|---|---|---|
| Add | `Burgs.add([x, y]) → id`. Draws the icon and label itself and connects a route [R]. | `burgs-generator.ts:706` | none |
| Rename | `b.name = n` | `burg-editor.js:122` | `drawBurgLabel(b)` [R] (`src/renderers/draw-burg-labels.ts:92-94`) |
| Population | `b.population = people / populationRate / urbanization` | `burg-editor.js:161` | none (`b.population` is in thousands) |
| Group | `Burgs.changeGroup(b, group or null)` | `burgs-generator.ts:751` | Done for you (icon and label). |
| Port | Set `b.port` (the feature id) and move it to the port group. | `burg-editor.js:182` | `drawBurgIcon(b)` |
| Capital | Update `states[s].capital` and `center`, set `b.capital = 1`, unset it on the old capital, then `Burgs.changeGroup` for both. | `burg-editor.js:222` | `drawStateLabels([s])`, icons |
| Move | Update `cells.burg` for the old and new cells, `b.cell`, `b.x`, `b.y` and `b.state`. A capital cannot change state. | `burg-editor.js:368` | `drawBurgIcon`, `drawBurgLabel` (_unverified_ that these suffice) |
| Remove | `Burgs.remove(id)` sets `removed`, clears the cell and the note, and removes the COA, icon and label. The UI refuses capitals and market centres; do the same. | `burgs-generator.ts:764`; UI at `burg-editor.js:427` | none |
| Lock | `b.lock = true` survives regenerateBurgs and port reassignment. | `burgs-generator.ts:198-230` | |

The low-level draw calls are `drawBurgIcon(b)`, `removeBurgIcon(id)`, `drawBurgLabel(b)` and `removeBurgLabel(id)` (`src/renderers/draw-burg-icons.ts:116-118`, `draw-burg-labels.ts:92-94`).

### State

| Operation | How | Reference | Redraw |
|---|---|---|---|
| Rename | Set `s.name`, `s.fullName = States.getFullName(s)` | states-editor `applyNameChange` | `drawStateLabels([s.i])`. **It skips locked states** (`src/renderers/draw-state-labels.ts:55`). |
| Colour | Set `s.color` | `states-editor.ts:378` | `drawStates()` (or set the `#state<i>` fill attributes) |
| Add | Steps: `Burgs.add` for the capital, push the state, diplomacy, `COA.generate`, `States.getPoles/findNeighbors/collectStatistics/defineStateForms`. | `states-editor.ts:1346` | `drawStateLabels([id])`, `COArenderer.add`, `drawStates()`, `drawBorders()` |
| Remove | Clear `cells.state`, the burgs' `state`, the provinces, the emblem and the military; filter the neighbours; replace with `{i, removed: true}`. | `states-editor.ts:701` | `drawStates(); drawBorders(); drawProvinces()` |
| Re-expand | `States.expandStates(); Provinces.generate(); States.getPoles()` | `states-editor.ts:965` | `drawStates`, `drawBorders`, `drawStateLabels` |
| Assign cells | Write `pack.cells.state[c]` | `states-editor.ts:1109` | Then `States.collectStatistics()`, `getPoles()`, draw as above. |

`States.*` methods (`src/generators/states-generator.ts`):

- generate 141, expandStates 155, normalize 225, getPoles 245, findNeighbors 255, assignColors 284
- collectStatistics 307, generateCampaigns 356, generateDiplomacy 364, defineStateForms 552, getFullName 705, collectTaxes 732

### Province, culture, religion

| Entity | Operations | Reference | Redraw |
|---|---|---|---|
| Province | `Provinces.generate(regenerate = false, regenerateLockedStates = false)`; reseeds Alea(seed) when not regenerating. | `provinces-generator.ts:65` | `drawProvinces()` |
| Province | Rename: set `p.name`/`fullName`, then update the `#provinceLabel<i>` text. Colour: `changeFill`. Capital: `center`/`burg`. Remove. | `public/modules/ui/provinces-editor.js:257, 486, 598` | `drawProvinces()`, `drawBorders()` |
| Culture | `Cultures.add(centerCell)`, `Cultures.expand()` | `cultures-generator.ts:1206, 1247` | `drawCultures()`; burg cultures are recomputed by the editor (`src/controllers/cultures-editor.ts:716`) |
| Culture | Rename (also sets `code` via `abbreviate`), colour, remove | `cultures-editor.ts:346, 332, 551` | `drawCultures()` |
| Religion | `Religions.add(centerCell)`, `Religions.recalculate()`, remove | `religions-generator.ts:1008, 1001`; `religions-editor.ts:526` | `drawReligions()` |

### River, route, marker, zone, lake, label, note

| Entity | Operations | Reference | Redraw |
|---|---|---|---|
| River | `Rivers.remove(id)` also removes tributaries and their paths. Rename: `r.name`. Type: `Rivers.getType`. | `river-generator.ts:497`; UI `rivers-editor.js:252` | done / `drawRivers()` |
| River | Add by clicking only: `addRiverOnClick` (`tools.js:753`). Building one programmatically means `cells.r` plus `getRiverPath` (_unverified_). | | `drawRivers()` |
| Route | Add: push `{i: Routes.getNextId(), group, feature, points: [[x, y, cell], …]}` and link `pack.cells.routes` **both ways** for each consecutive cell pair. | `public/modules/ui/routes-creator.js:95-123` | `drawRoute(route)` (`layers.js:864`) |
| Route | `Routes.connect(cellId)` attaches a cell to the network. `Routes.remove(routeObject)` takes the **object, not an id**, and removes the path. | `routes-generator.ts:725, 794` | none for remove |
| Marker | `Markers.add({type, icon, x, y, cell, …}) → marker` (gets `i`) | `markers-generator.ts:74` | `markers.append(...)` with the `drawMarker(m)` HTML (`src/renderers/draw-markers.ts:94-96`) or `drawMarkers()` |
| Marker | `Markers.deleteMarker(id)` **does not remove the DOM**. Also remove `#marker<i>` and the `marker<i>` note. | `markers-generator.ts:89` | manual |
| Zone | Push `{i, name, type, color: "url(#hatchN)", cells: []}`; edit `zone.cells`; remove by splicing. `Zones.generate(globalModifier)` replaces `pack.zones`. | `public/modules/ui/zones-editor.js:371, 482`; `zones-generator.ts:42` | `drawZones()` (`layers.js:978`) |
| Lake or feature | Rename via `pack.features[f].name`. A group change needs a redraw. | `public/modules/ui/lakes-editor.js` | `drawFeatures()` (`src/renderers/draw-features.ts`) |
| Custom label | It lives **only in the SVG** (`#addedLabels text#label<N>` plus `defs #textPaths path#textPath_label<N>`), not in data. | `tools.js:675`, `public/modules/ui/labels-editor.js:309`, `layers.js:912` | none |
| Note | `notes.push({id, name, legend})` (`legend` is HTML). Attach it by element id: `burg<i>`, `marker<i>`, or the selected element's id, such as `stateLabel<i>` or a river or route id (`labels-editor.js:412`, `rivers-editor.js:249`). | `public/modules/ui/notes-editor.js:18-30` | none |
| Emblem | `COA.generate(parent, kinship, dominion, type)`, `COArenderer.add(type, i, coa, x, y)` | `src/generators/emblems/generator.ts:51`; `src/renderers/emblems/renderer.ts:312` (draws only while the emblems layer is on, :321) | `drawEmblems()` |

## 6. Redraw, layers, view and style

- **`drawLayers()`** (`layers.js:225`) draws every layer whose button is on. `applyLayersPreset()` is at :141.
- **Layer state:** `layerIsOn("toggleStates")` (:1026) means the button lacks `buttonoff`. `turnButtonOn(id)` is at :1035 and `turnButtonOff(id)` at :1030.
- **Draw functions (`layers.js`):**
  - drawBiomes 302, drawPrecipitation 333, drawPopulation 394, drawCells 446
  - drawCultures 480, drawReligions 509, drawStates 537, drawProvinces 592
  - drawGrid 632, drawCoordinates 673, drawTexture 783, drawRivers 810
  - drawRoutes 845, drawRoute 864
  - drawLabels 922 (state labels, burg labels and `invokeActiveZooming`)
  - drawZones 978
- **Renderers registered on window:**
  - `drawBorders`, `drawBurgIcons`, `drawBurgLabels`, `drawEmblems`, `drawFeatures`, `drawHeightmap`, `drawIce`
  - `drawMarkers`, `drawMilitary`, `drawReliefIcons`, `drawScaleBar(scaleBar, scale)`, `drawStateLabels(list?)`, `drawTemperature`
  - `drawGoods`, `drawMarketsLayer`
- **Toggles FLIP state; they do not set it.** Examples: `toggleStates` 525, `toggleLabels` 908, `toggleRivers` 798, `toggleBurgIcons` 928, `toggleMarkers` 884, `toggleZones` 966.
  - Guard each call with `layerIsOn` to make it idempotent.
  - Some decide by DOM content: Height, Temperature, Biomes, Cultures, Religions, Grid.
  - Some fade through jQuery (~400-600ms before `display: none`) [R]: Labels, Ice, Emblems, ScaleBar, Vignette.
- **View:**
  - `zoomTo(x, y, z = 8, d = 2000)` (`main.js:538`) is a d3 transition. With `d = 0` it applies after about 2 rAFs [R].
  - `resetZoom(d = 1000)` is at :544.
  - `fitMapToScreen()` (`options.js:208`) sets `svgWidth = min(mapWidth, innerWidth)`.
  - `invokeActiveZooming()` (`main.js:549`) rescales labels and icons for the current `scale`.
  - The `focusOn()` at `main.js:383` reads URL parameters only.
  - An immediate alternative: `svg.call(zoom.transform, d3.zoomIdentity.translate(…).scale(k))` [R].
- **Style:**
  - `changeStyle(preset)` (`public/modules/ui/style-presets.js:139`) applies a preset; `applyStyle(json)` (:74) applies selector → attributes. Styles persist inside the SVG.
  - Presets (:4-17): default, ancient, gloom, pale, light, watercolor, clean, atlas, darkSeas, cyberpunk, night, monochrome.
  - `requestStylePresetChange` (:121) opens a dialog; avoid it.
- **UI helpers (`public/modules/ui/editors.js`):**
  - `closeDialogs(except?)` 54, `unselect` 44, `highlightElement` 639, `refreshAllEditors` 988
  - `tip(text, main, type, time)` (`general.js:32`) writes `#tooltip`
  - `fitContent()` (83) is a CSS string helper, **not** a zoom function.

## 7. Save, load and export

| Signature | Meaning | Where | Notes |
|---|---|---|---|
| `(await lazy.save()).prepareMapData() → string` | Full `.map` text: 46 CRLF-joined lines. ~3MB at the default size [R]. **No customization check.** | `src/io/save.ts:43` | The best "get map bytes" primitive. |
| `saveMap("storage" \| "machine" \| "dropbox")` | Refuses during customization. "machine" triggers a download. | `save.ts:7` | |
| `saveToStorage(data, showTip)` | Writes IndexedDB `lastMap`. | `save.ts:188` | |
| `(await lazy.load()).uploadMap(blob, cb?)` | **Fire-and-forget** (FileReader). `cb` runs at `onloadend`, **before parsing**. Accepts plain, base64 or gzip. | `src/io/load.ts:120` | Await `map:generated` (~450ms for `tests/fixtures/demo.map`) [R]. |
| `showUploadMessage` | Invalid, ancient or newer files open an `#alert`; **no event fires** [R]. | `load.ts:198` | Add a timeout and check `#alert`. |
| `parseLoadedData` | Calls `closeDialogs`, then `svg.remove()` and reassigns every layer selection (339-397), auto-updates via `resolveVersionConflicts` (539), applies integrity fixes (560-800), then `showStatistics` (812). Errors open a "Loading error" `#alert` (819-841). | `load.ts:233` | Old DOM handles go stale. `mapId` is re-stamped. |
| `loadMapFromURL(url, random?)`, `quickLoad()` | Load from a URL or from IndexedDB. | `load.ts:76, 4` | |
| `(await lazy.exportMap()).getMapURL(type, {fullMap, noLabels, noWater, noScaleBar, noIce, noVignette, debug})` | Returns a blob URL **revoked after 5s** (`src/io/export.ts:496`). | `export.ts:229` | Fetch it immediately in the page. The SVG is ~587KB [R]. |
| `exportToSvg` 21, `exportToPng` 40, `exportToJpeg` 82, `exportToPngTiles` 124 | Download only. PNG covers **the current view** at svgWidth×svgHeight×`pngResolutionInput`. | `export.ts` | Prefer a Playwright screenshot or a rasterized `getMapURL`. |
| `saveGeoJsonCells/Routes/Rivers/Markers/Zones` | Download only. | `export.ts:565-660` | Capture with Playwright's `download` event. |
| `exportToJson("Full" \| "Minimal" \| "PackCells" \| "GridCells")` | Download only; the builders (30-75) are not exported. | `src/io/export-json.ts:10` | |

**.map line layout** (from `save.ts:43`):

| Line | Contents |
|---|---|
| 0 | params `VERSION\|license\|date\|seed\|w\|h\|mapId` |
| 1 | settings (includes the `options` JSON; the MCP stores setting locks there as `tupaiaLocks`, see §10) |
| 2 | coords |
| 3 | biomes: `color\|habitability\|name`, plus a 4th field `{iconsDensity, icons, cost}` in Tupaia (§10) |
| 4 | notes |
| 5 | SVG (carries `#terrain` relief settings and label-group visibility attributes, §10) |
| 6 | grid |
| 7-11 | grid cells |
| 12 | features |
| 13 | cultures |
| 14 | states |
| 15 | burgs |
| 16-28 | pack cells |
| 29 | religions |
| 30 | provinces |
| 31 | name bases |
| 32 | rivers |
| 33 | rulers |
| 34 | fonts |
| 35 | markers |
| 36 | cell routes |
| 37 | routes |
| 38 | zones |
| 39 | ice |
| 40 | `cells.good` |
| 41 | goods |
| 42 | markets |
| 43 | deals |
| 44 | `cells.market` |
| 45 | custom icons |

**Autosave** (`src/services/autosave.ts`) writes to IndexedDB every 15 minutes, along with a save-reminder tip.

## 8. Shared map (Cloudflare)

**Client:** `src/io/cloud-cloudflare.ts`, via `await lazy.sharedMap()`.

- **`MAP_ID`** is `"shared"` (:18). The API base is same-origin unless `window.FMG_API_BASE` is set (:22).
- **`loadSharedMap()`** (:49):
  - fetches `/api/map/shared`;
  - on a 404, shows a tip;
  - otherwise calls `uploadMap` and shows a success tip **before parsing finishes**.
  - It sets the module-private `loadedVersion` (:31, assigned at :64, :87 and :124 only).
- **`loadSharedMapOnBoot()`** is at :78.
- **`saveSharedMap(force = false)`** (:99):
  - refuses during customization;
  - sends a PUT with `X-Map-Name = getFileName()`;
  - adds `X-Map-Version` when `loadedVersion` is set, and `X-Map-Overwrite: true` when `force`.
  - A 409 response calls `promptConflict` (:133), an `#alert` with Reload, Overwrite and Cancel.
  - **It returns void.** The outcome is visible only through `tip()` ("Cannot save shared map…" on failure [R]).
- **`showSharedMapVersions()`** (:161) is an `#alert` listing versions.
- **`restoreSharedMap(version)`** (:198) POSTs **immediately, without confirmation**, then runs `closeDialogs("#alert")` and `loadSharedMap()`.
- **`cloudflare.save()`** (provider object, :214) **always** sends `X-Map-Overwrite: true`.

**Worker:** `cloudflare/worker/src/index.ts`.

- **Read routes:**
  - `GET /api/maps`
  - `GET /api/map/:id`: returns the blob, with headers `X-Map-Version`, `X-Map-Updated-By` and `X-Map-Updated-At`
  - `GET /api/map/:id/meta`
  - `GET /api/map/:id/versions`
- **Write routes:**
  - `PUT /api/map/:id`. **Stale guard (156-169):** if the row exists and the request has no overwrite flag, a missing or mismatched `X-Map-Version` gets a 409 `{error, version, updated_by, updated_at}`. Each save snapshots the prior version (20 are kept). Success returns `{id, version, updated_at, updated_by}`.
  - `POST /api/map/:id/restore?v=<n>`, `/api/map/:id/claim` and `/api/map/:id/release` (the claim is an advisory lock that never blocks a save). The router is at :260-271.
- **No CORS:** there is no `Access-Control-Allow-Origin` and no `OPTIONS` handling (only Expose-Headers, at :86). Call it **same-origin from inside the page, or from Node**, not cross-origin from another page.
- **Writes are anonymous.** The Access gate is deferred (`cloudflare/README.md:68-75`).
- **Live state** (read-only GET of meta): version 6, `updated_by` "anonymous".

**A safer MCP save path** (proposal, _unverified_):

1. Run `prepareMapData()` in the page.
2. GET `/meta` for the current version.
3. PUT from Node with `X-Map-Version`, with no overwrite unless the user explicitly asks.
4. Surface the 409 body as a tool error, not a dialog.

## 9. Pitfalls checklist

1. **Scoping.** `let`/`const` globals (`notes`, `options`, `svg`, `mapId`, `regenerateMap`, `customization`) are invisible on `window`. Use bare names inside `evaluate`.
2. **`regenerateMap` is throttled.** Calls within 250ms are dropped, and it returns `undefined`. Await `map:generated` and then a macrotask.
3. **`map:generated` fires before drawing** on generate. Wait one `setTimeout(0)`.
4. **`mapId` is new on every load and generate.** It cannot identify a file; hash `prepareMapData()` or use the seed.
5. **No load event on failure.** `uploadMap` failures and generate errors open an `#alert` rather than throwing. After each action, check for a visible `.ui-dialog` and read `#alertMessage`.
6. **The shared `#alert` dialog** is reused by every prompt (update notice, conflict, errors, regenerate confirm). No native `alert`/`confirm` fires [R]. `window.prompt` is overridden by a DOM prompt (`src/utils/commonUtils.ts:279`).
7. **Options re-randomize** unless locked. Locks persist in localStorage. Culture inputs come in Input/Output pairs.
8. **Toggles flip.** Some fade asynchronously.
9. **Detached DOM handles.** The SVG and every layer selection are replaced on load; re-query after loading.
10. **Seeded randomness.** `Math.random` is the seeded Alea, and `Rivers.generate` and `Provinces.generate` reseed it.
11. **`regenerateZones()` without an event throws.**
12. **`Markers.deleteMarker` leaves the DOM behind.**
13. **`drawStateLabels` skips locked states.**
14. **`findPath`'s second argument is a predicate.**
15. **Typed arrays** serialize as objects.
16. **Placeholders.** Index 0 holds the number `0` for burgs, provinces and features. Removed entities stay in their arrays.
17. **`getMapURL` blobs are revoked after 5s.** `exportToPng` covers the current view only. `#map` screenshots (~121ms [R]) show the viewport only, and overlays cover it:
    - `#tourPromptButton` (bottom right), `#optionsTrigger`, `#tooltip`
    - the openwidget chat, unless `localStorage.azgaarAssistant = "hide"` before boot.
18. **The resize handler** (`general.js:4-9`) overwrites `mapWidthInput`/`mapHeightInput` with the window size unless `mapWidth` and `mapHeight` are stored or locked. Set the viewport before boot.
19. **`window.onbeforeunload`** is set on non-localhost hosts (`general.js:11-13`). Handle the `beforeunload` dialog when navigating on the live site.
20. **External loads:** openwidget, Google Analytics and Google Fonts. Block them for determinism and speed.
21. **Update popup.** `versioning.js:27-29` shows an "update" `#alert` after 6s when `localStorage.version` is older than `VERSION` ("1.130.1"; `package.json` says 1.130.0). Pre-seed `localStorage.version`.
22. **Autosave and reminder timers** fire every 15 minutes.
23. **Shared map: `loadedVersion` is never reset** on regenerate or local load. A later `saveSharedMap()` sends the stale version and can **silently overwrite the shared map with an unrelated map**. Also, `cloudflare.save()` always overwrites, `restoreSharedMap` has no confirmation, and a null `loadedVersion` produces a 409 dialog.
24. **`customization !== 0`** blocks `saveMap` and `saveSharedMap`. `regenerateMap` resets it to 0. Close editors (`closeDialogs()`) before saving.
25. **Docs drift:** `data_model.md:394` documents `notes[].i`, but the code uses `id`.

## 10. Tupaia additions to the app runtime (for the MCP server)

Small hooks the fork adds, each marked `// tupaia-mcp:` and listed in `cloudflare/README.md`'s
fork-surface paragraph. Without the attributes or options below, every one behaves as upstream,
and old `.map` files load unchanged. The MCP tools set all of these; set them by `eval` only when
no tool covers the change.

- **Relief settings** (`src/renderers/relief-settings.ts`, read by `draw-relief-icons.ts` on every
  draw). Map-level attributes of `#terrain`, so they ride in the saved SVG:
  - `data-seed` (deterministic draw, one stream per cell), `data-scale` (multiplier on the style
    density; the icon count goes with its square, down to 0), `data-biomes` (`"biomeId:k,..."`),
    `data-min-height`, `data-near-burgs` (px), `data-exclude` (`"<gridKey>:<ranges>[;<g.e>,...]"`,
    ignored on another grid).
  - `data-regenerate`: `prepareMapData` (`src/io/save.ts:100`) empties `#terrain` in the saved
    copy, so every save drops the icons, and `restoreReliefOnLoad()` (called from
    `src/io/load.ts:810`) draws them again after a load. Manual relief-editor edits are lost on
    such a map (the editor warns).
  - `window.ReliefSettings` = `{attrs, gridKey, packCellKey, encodeRanges, parseExclusion, clear}`;
    `generate()` (`public/main.js:692`) calls `ReliefSettings.clear()`, so a new map starts as
    upstream. MCP: `regenerate {parts:['relief'], relief:{...}}`, `edit map {set:{reliefOnLoad}}`.
- **Biome extras** (`src/io/biome-extras.ts`). The `.map` biome line (line 3) gets a 4th `|` field,
  JSON `{iconsDensity:[], icons:[[]], cost:[]}`, written by `save.ts` and applied by `load.ts:341`
  when present. Upstream keeps only `color|habitability|name`, so custom biomes lost their icon
  density, icons and cost on reload. An older client ignores the field and drops it on re-save.
- **Label visibility attributes** (`invokeActiveZooming`, `public/main.js:566` and `:584`). A
  `#labels` or `#emblems` group may carry `data-min-size` (replaces the lower bound: 6 for labels,
  25 for emblems), `data-max-size` (replaces 60 / 300) and `data-always-show` (`1`: skip both).
  They are SVG attributes, so they save with the map. `createLabelGroups`
  (`src/renderers/draw-burg-labels.ts:87`) keeps a new burg group, which copies the `town` style,
  from inheriting them. MCP: `display {labels:{...}}`.
- **Resample keepId** (`src/generators/resample.ts:24, 469`). `Resample.process({projection,
  inverse, scale, keepId})`: with `keepId` and scale 1 the map keeps its `mapId` and fires
  `map:resampled` `{seed, mapId, cells}` instead of `showStatistics()` (a new id and
  `map:generated`), so a shared map stays the same map. The MCP `regrid` passes it; the Transform
  tool passes it only for a density-only change (no shift, rotation, zoom, mirror or canvas
  resize; `transform-tool.js` `isDensityOnly`). Submap never does.
- **Setting locks in the file** (`options.tupaiaLocks`; MCP only, no app change). The app's
  `lock(id)` keeps a value in localStorage, which never reached the `.map`. Whenever the MCP takes
  the map text (save_map, snapshots, undo points, shared_save) `mcp/src/bridge-ext/settings.js`
  first writes the names of the locked world settings into the global `options` object as
  `tupaiaLocks: [...]`, so they land in the options JSON on the settings line; the MCP's load
  (load_map, undo, restore, relaunch) applies them. The stock app reads the options object back
  whole and ignores the key (a File > Save carries whatever value the object last held); a file
  without it leaves the page's locks alone. MCP: `edit {type:'map', ops:[{set:{...},
  lock:[names]|'all'}]}`.
- **Other hooks**: `window.__tupaiaInternals = {adjustProvinces, stateRemove}` (set when the states
  editor module loads); `editHeightmap({tupaiaExport:true})` returns `{restoreKeptData,
  restoreRiskedData, regenerateErasedData}` without opening the editor, and
  `restoreRiskedData({erosion, regenerateRivers, redefineBiomes, afterRivers})` is what
  `set_heights` drives; `focusOn` ignores a `?burg=` id whose record is a compacted stub
  `{i, removed:true}`; `map:loading`/`map:loaded` (`load.ts`) let `cloud-cloudflare.ts` know
  whether the page still holds the map it loaded from `shared`.
