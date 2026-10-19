# P0 census: document lookups and map/global consumers

Scope: read-only audit. Pattern for Task A: `document.getElementById(`, `document.querySelector(All)?`, bare `getElementById(`, `byId(`, `d3.select(All)?(`. Element-scoped bare `querySelector` calls are outside the pattern and are not counted.

## Task A: document-level lookups by file

Counts are strict-pattern lines per file. "Map" means the lookup targets a literal or template id that lives in the map SVG (`#map`, `#viewbox`, layer groups, defs). "Adj" means the target is outside `#map` but depends on it (minimap clone, emblem defs written into the map). Lookups with fully variable ids are listed as unknown.

### src/ (non-test, 37 files, 156 lines)

| file | lookups | map | example ids |
|---|---|---|---|
| src/io/export.ts | 24 | 24 | map, defElements, terrain, burgIcons, anchors, labels, textPaths |
| src/io/auto-update.ts | 14 | 14 | freshwater, oceanicPattern, defs-markers, markers, ice, #viewbox > #routes |
| src/renderers/relief-canvas.ts | 13 | 13 | #terrain, #terrain > image[data-relief] |
| src/renderers/draw-burg-icons.ts | 6 | 6 | burg${id}, anchor${id}, g#burgIcons > g, g#anchors > g |
| src/renderers/burg-canvas.ts | 6 | 5 | burgIcons, #burgIcons image[data-burg-vectors] |
| src/renderers/label-culling.ts | 6 | 5 | viewbox, map, map-label-culling-style |
| src/renderers/zone-hatching.ts | 5 | 2 | map, zones |
| src/renderers/relief-settings.ts | 3 | 2 | terrain (toggleRelief is UI) |
| src/renderers/emblems/renderer.ts | 3 | 2 | coas, ${type}Emblems |
| src/renderers/draw-borders.ts | 2 | 1 | #borders path |
| src/renderers/draw-burg-labels.ts | 2 | 2 | burgLabel${id}, g#burgLabels > g |
| src/renderers/dense-zoom.ts | 2 | 2 | map, defElements |
| src/renderers/path-layer-canvas.ts | 4 | 1 | map (3 others use variable id) |
| src/renderers/cell-mesh-canvas.ts | 1 | 1 | cells |
| src/renderers/heightmap-canvas.ts | 1 | 1 | heights |
| src/io/load.ts | 7 | 2 | d3.select("#map"), good-icons |
| src/controllers/minimap.ts | 5 | adj 5 | minimapSurface, minimapViewport, minimapMapUse (use href #viewbox) |
| src/generators/burgs-generator.ts | 1 | adj 1 | burgCOA${id} |
| src/controllers/states-editor.ts | 8 | adj 2 | #burgLabel${capital}, stateLabel${id} (6 UI or variable) |
| src/generators/expansion-worker.ts | 1 | unknown 1 | variable id |
| src/utils/nodeUtils.ts | 3 | unknown 3 | variable id, core + i |
| src/controllers/cultures-editor.ts | 3 | unknown 3 | variable id |
| src/generators/markers-generator.ts | 2 | 0 | culturesSet; plus variable id |
| src/generators/river-generator.ts | 3 | 0 | resolveDepressionsStepsOutput, lakeElevationLimitOutput |
| src/controllers/good-editor.ts | 4 | 0 | newGoodDistribution, mSummary_, demandCoverageSummary |
| src/controllers/markets-overview.ts | 8 | 0 | marketsTemp*, market${id} |
| src/controllers/battle-screen.ts | 3 | 0 | battlePhases_${type}_attackers |
| src/controllers/religions-editor.ts | 3 | 0 | religionsManuallyProtect |
| src/controllers/regiments-overview.ts | 2 | 0 | regimentAdd* |
| src/controllers/coastline-editor.ts | 1 | 0 | coastlineSettingsDialog |
| src/controllers/regiment-editor.ts | 1 | 0 | (bare querySelector only, see note) |
| src/services/ui-tour.ts | 2 | 0 | driver popover buttons (querySelector) |
| src/services/installation.ts | 1 | 0 | optionsContainer |
| src/services/fonts.ts | 1 | 0 | styleSelectFont |
| src/utils/commonUtils.ts | 1 | 0 | prompt |
| src/generators/cultures-generator.ts | 1 | 0 | emblemShape |
| src/renderers/view-3d-renderer.ts | 3 | 0 | options3dErosion, options3dSubdivide |
| src/io/save.ts | 0 | 0 | bare querySelector only: #viewbox, #ruler, #tradeAnimation |

src/ totals: 156 lookups in 37 files. Map-targeting explicit: 83 lookups in 16 files. Adjacent: 8 in 3 files (minimap, burgs-generator, states-editor). Unknown-only: 3 files (expansion-worker, nodeUtils, cultures-editor).

### public/ (non-libs, 29 files, 255 lines)

| file | lookups | map | example ids |
|---|---|---|---|
| public/modules/ui/emblems-editor.js | 41 | 4 | defs-emblems, stateCOA+, provinceCOA+, burgCOA+ |
| public/modules/ui/heightmap-editor.js | 20 | 0 | preview, canvas3d, imageConverter |
| public/modules/ui/tools.js | 18 | 16 | stateLabel, textPath_stateLabel, stateCOA, provinceCOA, stateEmblems |
| public/modules/ui/editors.js | 18 | 1 | g#defs-hatching > pattern (rest UI) |
| public/modules/ui/biomes-editor.js | 17 | 0 | biomesBody, biomesLegend |
| public/modules/ui/general.js | 24 | 0 | tooltip, notes, lock_, burgEl var (d3.select) |
| public/modules/ui/diplomacy-editor.js | 12 | 0 | diplomacyBody* |
| public/modules/ui/ice-editor.js | 11 | 0 | iceSize, iceNew (d3.select on event target) |
| public/modules/ui/relief-editor.js | 11 | 0 | reliefIndividual |
| public/modules/ui/labels-editor.js | 10 | 0 | #labelEditor > button |
| public/modules/ui/style-presets.js | 10 | 1 | #texture > image (rest UI or selector var) |
| public/modules/ui/markers-editor.js | 4 | 4 | marker${i}, #marker${i} > text/image/g |
| public/modules/ui/markers-overview.js | 3 | 3 | marker${i} |
| public/modules/ui/layers.js | 8 | 2 | provinceLabel${id}, province${suffix}${id} |
| public/modules/ui/rivers-creator.js | 6 | 0 | riverCreatorBody, toggleCells |
| public/modules/ui/options.js | 9 | 0 | options, mapLayers, key+Input |
| public/main.js | 13 | 2 | map (d3.select), marker${i} (rest UI: loading, tooltip, optionsContainer) |
| public/modules/ui/burg-editor.js | 3 | 1 | #anchors [data-id] (rest #burgBottom UI) |
| public/modules/ui/burgs-overview.js | 1 | 1 | #burgLabels [data-id] |
| public/modules/ui/provinces-editor.js | 3 | 1 | [id^='provinceCOA'] |
| public/modules/ui/routes-editor.js | 1 | 1 | d3.select("#" + id) (route layer) |
| public/modules/ui/rivers-editor.js | 1 | 1 | d3.select("#" + id) (river layer) |
| public/modules/ui/route-group-editor.js | 1 | 1 | getElementById(group) (route group) |
| public/modules/ui/style.js | 2 | 2 | d3.select("#" + styleElement), querySelector(selector) |
| public/modules/ui/zones-editor.js | 2 | 0 | zonesBottom |
| public/modules/ui/coastline-editor.js | 2 | 0 | coastlineEditor |
| public/modules/ui/hotkeys.js | 2 | 0 | dialog selectors |
| public/modules/ui/world-configurator.js | 1 | 0 | globe |
| public/versioning.js | 1 | 0 | versionText |

public/ totals: 255 lookups in 29 files. Map-targeting explicit: 40 lookups in 15 files. UI-only: 14 files.

### Totals

- Strict-pattern lookups: 156 (src non-test) + 255 (public non-libs) = 411 in 66 files.
- Map-targeting explicit: 83 + 40 = 123 lookups, in 31 files (16 src + 15 public).
- Adjacent: 8 lookups in 3 src files.
- Unknown (variable id only): 7 lookups in 3 src files, plus ambiguous variable ids in some UI files.
- Bare element-scoped `querySelector` lines exist that touch map ids (for example `src/io/save.ts` #viewbox, #ruler, #tradeAnimation; `src/services/fonts.ts` #labels g and #legend; `src/renderers/draw-trade-animation.ts`). They are excluded by the spec pattern.

## Task B: map/global consumers

### MCP bridge (mcp/src/bridge.js exists; bridge-mutations.js and bridge-ext/*.js also exist)

Reads and writes app globals by bare name (header comment, bridge.js:6-8): `pack`, `grid`, `notes`, `svg`, `zoom`, `scale`, `viewX`, `viewY`.

- View and zoom (bridge.js:1521-1534, 1566): reads `scale`, `viewX`, `viewY`, `svgWidth`.
- Zoom write (bridge.js:1740-1757): `svg.interrupt()`, `svg.call(zoom.transform, ...)`, mutates `scale`, `viewX`, `viewY` (1749-1750), and directly sets `viewbox.attr("transform", ...)` (1756-1757). Direct SVG DOM mutation of `#viewbox`.
- Layer on/off (bridge.js:1484-1498): FADE_SELECTORS `#labels,#ice,#compass,#terrain,#lakes,#scaleBar,#emblems,#vignette`, `getElementById(LAYERS[n])`.
- Labels (bridge.js:465, 678, 737): `querySelectorAll('#labels text[id^="label"]')`, `getElementById(textPath_${id})`.
- Label creation (bridge.js:1543-1562): d3 `append("g")`, `append("text")`, `append("textPath")` into the label group. Direct SVG creation.
- Map id (bridge.js:1574-1578): reads `window.mapId`.
- Save and load (bridge.js:2057-2058, 2079-2089): `prepareMapData()` via `lazy.save()`; overrides `FNS.loadMap` and calls `uploadMap(blob)` from `lazy.load()`.
- Export (bridge.js:2232-2237): `getMapURL("svg")`, fetches the SVG text.
- bridge-mutations.js direct DOM mutation: 335 remove `#anchors [data-id]`; 578-587 `#routes > g` lookup and `getElementById(route${id}).remove()`; 672-684 `textPath_` read and remove; 709, 718 `populationRateInput`, `urbanizationInput`; 747-757 `innerHTML` writes into a textPath; 792 `defs.append("g")` for COA; 799, 807, 818-819 `.remove()` on marker, zone, textPath, label element.
- bridge-ext/settings.js:29 `byId` helper; 575-667 reads `pack.cells`, `pack.rivers`, `pack.features`; 920-967 reads `grid.cells.temp/prec`; 991-992 wraps `FNS.loadMap`.
- bridge-ext/regen.js:139 reads `provincesRatio` input; 976-977 removes `provinceCOA${id}` and `#provinceEmblems > use` (direct SVG DOM removal); 39-982 reads `pack.states`, `pack.burgs`, `pack.provinces`, `pack.cells`.
- bridge-ext/relief.js:641-642 wraps `FNS.loadMap`.
- bridge-ext/regrid.js:161-162, 2522-2541 and compact.js:550-556 call `prepareMapData()` via `lazy.save()`.
- Not verified in this pass: bridge-ext/labels.js, routes.js, rivers.js, biomes.js, clear.js, apply.js, mcp/src/browser.ts (how the page is driven).

### Cloud path (src/io/cloud-cloudflare.ts)

- Imports `uploadMap` (line 14) from `@/io/load` and `prepareMapData` (line 15) from `@/io/save`.
- `saveSharedMap` calls `prepareMapData()` (line 130) and uploads.
- `loadSharedMap` and `loadSharedMapOnBoot` call `uploadMap(blob, ...)` (85, 108).
- Dialog positioning uses `of: "svg"` (191, 219). No direct `pack`, `grid`, or DOM id lookups in this file.

### Export (src/io/export.ts, 40 pack/grid/svg/DOM references)

- Clones `#map` (246) and reads `#defElements` (260).
- Clone reads: `terrain` (361-363), `burgIcons` (385-386), `anchors` (409), `regions`, `statePaths`, `labels`, `textPaths` (458-459), `armies` (462).
- Reads `grid.cells.i`, `grid.cells.h` (532-542), `pack.features`, `pack.routes`, `pack.rivers`, `pack.markers` (602-698).

### Minimap (src/controllers/minimap.ts)

- Creates `<svg id="minimapSurface">` with `<use id="minimapMapUse" href="#viewbox">` (81-84). Clones the live viewbox by reference.
- Reads globals `viewX`, `viewY`, `scale` (117-124). Calls `zoomTo` (106).
- Reads minimap DOM ids (27, 93, 110-112). No `pack` or `grid` access.

### 3D view (src/renderers/view-3d-renderer.ts)

- Reads `grid.cellsX`, `grid.cellsY` (92, 352), `grid.cells.h/c` (794-800), `pack.burgs`, `pack.states` (508-553), `pack.cells.g/i/f` (657-659, 807), `pack.features` (810).
- DOM ids `options3dErosion`, `options3dErosionSection`, `options3dSubdivide` (232-238). No `#map` or SVG dependency.

## Task C: svg globals (public/main.js)

- Line 35: `let svg = d3.select("#map");`
- Line 37: `let viewbox = svg.select("#viewbox");`
- Line 182: `let scale = 1;`
- Line 183: `let viewX = 0;`
- Line 184: `let viewY = 0;`
- Lines 232-234: assignments `scale = k; viewX = x; viewY = y;` (inside the zoom handler).
- Line 238: `const zoom = d3.zoom()...`
- Line 396: `const scale = +scaleParam || 8;` shadows the global inside that scope.

## Contradictions with the brief

1. "49 document lookups in 17 files": not supported. The spec pattern gives 156 lookups in 37 non-test src files, and 255 in 29 public files. Combined, 411 lookups in 66 files. Even src alone is well above 49 in 17 files.
2. "mcp/src/bridge.js absent": contradicted. `mcp/src/bridge.js` exists and is large (the `FNS.exportSvg` function is at line 2232). `mcp/src/bridge-mutations.js` and `mcp/src/bridge-ext/*.js` also exist.

## MCP bridge DOM dependencies on SVG

The bridge depends on these SVG ids and structures: `#map`, `#viewbox` (transform writes), `#labels` and `text[id^="label"]`, `textPath_${id}`, `#routes > g`, `#anchors [data-id]`, `#burgLabels`, `#provinceEmblems > use`, `defs` (for COA groups), `#terrain`, `#ice`, `#compass`, `#emblems`, `#scaleBar`, `#vignette`, `#lakes`. It writes directly to `#viewbox` transform and removes SVG nodes (routes, markers, zones, labels, province COA). It creates SVG text and textPath nodes in the label group.
