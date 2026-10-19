# P0 audit: .map I/O format, save transforms, migrations, undo, export

Scope: read-only audit of `implementation/`. Evidence is `path:line` from Read/Grep/Glob. Items not verified in this pass are marked **UNPROVEN**.

## 1. Section format, load detection, CRLF, SVG insertion

**Section array (save.ts:171-218).** `prepareMapSections()` builds a 46-element array (indices 0-45). Index 0 is params (`VERSION|license|date|seed|...`), index 5 is `serializedSVG` (save.ts:177), and index 45 is `customGoodIcons` (save.ts:217).

**Text path.** `prepareMapData()` joins the 46 sections with `"\r\n"` (save.ts:55-57). Load splits on `"\r\n"` (load.ts:197). Custom good icon markup has its CRLF replaced with spaces at save time (save.ts:153-156), so the split does not cut it.

**Binary path.** `prepareMapFile()` returns `encodeBinarySections(prepareMapSections())` (save.ts:51-52). Sections are stored as separate directory entries, so CRLF is not used on this path.

**Load detection (load.ts:172-208, `parseLoadedResult`).**
- `isBinaryMap` is checked first (load.ts:177), then `decodeBinaryMap` (load.ts:178).
- Otherwise the text is decoded (load.ts:182). Delimited vs base64 is chosen at load.ts:185-186.
- An SVG CRLF repair regex runs at load.ts:189-195.
- Text is split on `"\r\n"` (load.ts:197).
- Gzip is **not** detected by magic bytes. `DecompressionStream("gzip")` (load.ts:161-170) is only tried in the catch path (load.ts:202), after `parseLoadedResult` throws.

**Validation (load.ts:130-159).** `uploadMap` rejects when `mapData.length < 10 || !mapData[5]` (load.ts:142). Version branches are at load.ts:145-155.

**SVG insertion (load.ts:352-359).**
- `svg.remove()` then `document.body.insertAdjacentHTML("afterbegin", data[5])` (load.ts:352-353). This uses the HTML parser, not DOMParser. Grep found no DOMParser in load.ts.
- The live root is re-selected with the global d3 v5 at load.ts:359: `(window as any).d3.select("#map")`. The code comment cites issue #1508 for avoiding d3 v7 event issues.

**Layer restore (load.ts:502-544).** All layers are turned off first (load.ts:505-509). `turnOn` checks run at load.ts:512-544. `data-layer-off` is honored at load.ts:539.

**Post-load hooks (load.ts:789-802).** Order: emblem href removal (790), `rulers.draw` (792), `drawGrid` (793), `compactBurgIcons` (794), `compactPathLayer` for biomes, landHeights and oceanHeights (795), `drawCellsCanvas` (796), `restoreReliefOnLoad` (797), `compactRelief` (798), `restoreDefaultEvents` (799), `focusOn` (800), `invokeActiveZooming` (801), `fitMapToScreen` (802).

**Binary container (binary-map.ts).**
- Constants: `MAGIC` at line 5 (bytes 84,85,80,65,73,65,0,1, i.e. "TUPAIA" plus version bytes), `HEADER = 12` (line 6), `ENTRY = 24` (line 7), `LIMIT = 256 MiB` (line 8), `CELL_SECTIONS` with 18 indices (line 9), `TYPES` (line 10).
- Header: u16 section count at offset 8, u16 entry size (24) at offset 10.
- Directory entry (24 bytes): type, compression, reserved, offset, length, rawLength, count, FNV-1a 32-bit checksum (checksum at lines 23-27).
- Compression: 0 = raw; 2 = fast block (`compressFast` / `decompressFast`); 1 = deflate, read-only (read path at binary-map.ts:226-247).
- Typed sections: the 18 cell-section indices are stored as typed arrays. `numbers()` (lines 29-71) converts text to the narrowest typed array and rejects non-canonical spellings, so those sections fall back to text. The test at binary-map.test.ts:41-56 confirms exact text round-trip for non-canonical values.
- Other sections are UTF-8 text.
- Encoding: `encodeBinarySections` (line 116) yields with `setTimeout` every 8 sections (line 132). It uses `compressFast` when raw length > 128 bytes (line 134) and keeps compression 2 only if smaller (line 135).
- `BinaryMapArchive` class (lines 166-304): constructor validation (173-206), `raw` (212), `#read` (222-250), `array` (252), `#array` (261-292), `section` (294), `text` (299).
- `decodeBinaryMap` (line 312) gives lazy text getters (lines 321-330).
- Size: the binary-map test asserts output under half the text size (binary-map.test.ts:38).

**Helper modules.**
- `fast-map-compression.ts` (127 lines): LZ4-style block codec. `compressFast` (line 11), `decompressFast` (line 68), `HASH_BITS = 16` (line 4), 256 MiB input limit (line 3, thrown at line 13).
- `lazy-map-records.ts` (33 lines): `assignMapRecords` (line 2) defines a property whose getter JSON-parses the source string on first access, then replaces itself with a plain value. The setter replaces it without parsing. Used at load.ts:451 and load.ts:470 for hidden-layer records.

**Fixture and tests.**
- `tests/fixtures/demo.map` **exists** (Glob confirmed).
- `binary-map.test.ts` reads it at line 32 and asserts:
  - byte-exact round trip (line 37)
  - size under half of text (line 38)
  - lazy decode counter (lines 36, 60-67)
  - corruption and truncation rejection (lines 80-107)
  - malformed Unicode rejection (lines 113, 149)
  - native typed-array types (lines 134-139)
  - nonfinite fallback (lines 146-147)
  - prior deflate files readable and unknown compression rejected (lines 154-173)
- The synthetic `map()` helper (lines 6-16) builds 46 sections, with SVG at index 5.

## 2. Save-time SVG transforms (save.ts:102-131, applied to a clone of `#map`)

| Line | Transform | Purpose |
|---|---|---|
| 103 | `ensureEl("map").cloneNode(true)` | Work on a clone; the live DOM is not mutated |
| 104 | `restoreBurgVectorsIn` (burg-canvas.ts:12-18) | Burg canvas icons back to SVG vectors |
| 105 | `clearDenseZoom` (dense-zoom.ts:195-204) | Drop dense-zoom cached indexes from the clone |
| 106 | `restoreZoneHatching` (zone-hatching.ts:66-82) | Put original fills back, remove clone patterns and `data-zone-hatch-*` markers |
| 107 | `restorePathVectorsIn` (path-layer-canvas.ts:29-33) | Canvas-path layers back to SVG paths |
| 108-109 | `prepareReliefSerialization` (relief-canvas.ts:170-195) and `materializeRelief` (142-152) | Canonical relief glyphs become string markers; raster fallback embedded only for custom cases |
| 110-112 | Remove `.viewport-culled` class | Culling state not persisted |
| 115-117 | Reset `width`/`height` to graph size; remove `#viewbox` transform | Default view transform |
| 119-122 | Empty `#ruler` and `#tradeAnimation` | Transient content not persisted |
| 124-127 | `data-layer-off` on `#tradeAnimation` from `layerIsOn("toggleTrade")` | Records Trade toggle state |
| 130-131 | `XMLSerializer` then replace relief markers with markup | Final string |

Note: `save.ts` does **not** inline computed styles or embed font data URLs. Fonts are stored as a JSON list of used font descriptors (save.ts:100, index 34).

## 3. Version-gated auto-update migrations (src/io/auto-update.ts, 1185 lines)

- `isOlderThan(tag)` at line 7 is `compareVersions(mapVersion, tag).isOlder`.
- Loaded via dynamic import and `resolveVersionConflicts(mapVersion)` at load.ts:559-560.
- **40 gates**, each an `if (isOlderThan("X")) {` block:

| # | Line | Threshold | # | Line | Threshold |
|---|---|---|---|---|---|
| # | Line | Threshold | # | Line | Threshold |
|---|---|---|---|---|---|
| 1 | 9 | 1.0.0 | 21 | 636 | 1.86.0 |
| 2 | 113 | 1.1.0 | 22 | 651 | 1.88.0 |
| 3 | 211 | 1.11.0 | 23 | 658 | 1.91.0 |
| 4 | 237 | 1.21.0 | 24 | 710 | 1.92.0 |
| 5 | 263 | 1.22.0 | 25 | 717 | 1.94.0 |
| 6 | 268 | 1.3.0 | 26 | 735 | 1.95.0 |
| 7 | 293 | 1.4.0 | 27 | 761 | 1.96.0 |
| 8 | 343 | 1.5.0 | 28 | 855 | 1.98.0 |
| 9 | 384 | 1.6.0 | 29 | 867 | 1.99.0 |
| 10 | 420 | 1.61.0 | 30 | 931 | 1.100.0 |
| 11 | 474 | 1.62.0 | 31 | 946 | 1.104.0 |
| 12 | 479 | 1.63.0 | 32 | 952 | 1.105.0 |
| 13 | 487 | 1.64.0 | 33 | 960 | 1.106.0 |
| 14 | 496 | 1.65.0 | 34 | 981 | 1.107.0 |
| 15 | 538 | **1.652.0** (see note) | 35 | 987 | 1.108.0 |
| 16 | 544 | 1.7.0 | 36 | 999 | 1.109.0 |
| 17 | 604 | 1.72.0 | 37 | 1065 | 1.111.0 |
| 18 | 615 | 1.73.0 | 38 | 1136 | 1.113.0 |
| 19 | 626 | 1.84.0 | 39 | 1143 | 1.124.0 |
| 20 | 631 | 1.85.0 | 40 | 1181 | 1.127.0 |

**Count: 40** (grep of `isOlderThan(` in auto-update.ts returned exactly 40 gate lines; gates are in line order, left column then right).

**Notes.**
- Line 538 uses `"1.652.0"`. Read as a semver-style comparison this is minor 652, which is far above neighbors (1.65.0 at 496, 1.7.0 at 544). This is likely a typo for 1.65.2, but it is **UNPROVEN** without the release history. It is also a gate that sits between 1.65.0 and 1.7.0 in source order, so it changes which maps run its block.
- Data-only gates (per prior pass): 1.6 rivers/lakes (384), 1.86 origins (636), 1.88 coa shield (651), 1.91 coa/coaSize (658), 1.113 zone cells unique (1136), 1.127 goods visible (1181).
- Draw or side-effect gates (per prior pass): 1.7 drawMarkers (544), 1.99 drawRoutes (867), 1.100 drawZones (931), 1.109 drawBurgIcons (999), 1.111 drawIce (1065), 1.124 Goods/Markets/Production (1143).
- Which gates run for a given file depends on `compareVersions` semantics (numeric per segment is assumed; not re-read in this pass, **UNPROVEN**).

## 4. Undo, redo and history systems

There is **no document-level undo/redo** in the code read. Each system is local to one editor, and each snapshots a different thing.

| System | Location | Snapshot type | Cap | Notes |
|---|---|---|---|---|
| Heightmap editor (global `undo`/`redo` buttons and `templateUndo`/`templateRedo`) | heightmap-editor.js:583-610 (`updateHistory`, `restoreHistory`), 613-619 (`restartHistory`), 637-638 (wiring) | Full copy of `grid.cells.h` per step (`grid.cells.h.slice()`, line 586) | **None seen** in the read path | `edits` is a global array (`window.edits`, line 614) with `edits.n` as cursor. Each `updateHistory` truncates forward steps (line 585). Restore copies back (line 604). Memory grows with the number of steps (**UNPROVEN** in practice). |
| Heightmap: hotkeys | public/modules/ui/hotkeys.js:37-38 | Routes Ctrl+Z / Ctrl+Y to `undo.click()` / `redo.click()` | n/a | `undo` and `redo` are not declared in public/modules. They resolve through named window access to the `#undo` and `#redo` elements (index.html:4080-4081). **UNPROVEN** as to exact resolution. |
| States brush | src/controllers/states-editor.ts:1307-1324 (`saveStatesManualSnapshot`, `undoStatesManualAssignment`) | Sparse pairs `[cell, state]` in a `Uint32Array` built from `pendingStates` | 100 (line 1315) | Pushed at the start of each brush drag (line 1065). Undo clears `pendingStates` and reapplies pairs (1321-1323). Stored as a diff of pending assignments, not the full state array. Reset at lines 1042 and 1278. |
| Cultures brush | src/controllers/cultures-editor.ts:869-882 | `innerHTML` string of the `#temp` group | 100 (line 874) | DOM-serialized snapshot. Pushed at drag start (line 780). Undo writes `innerHTML` back (line 881). Reset at 756 and 843. |
| Markets brush | src/controllers/markets-overview.ts:194-196, 234, 316-320 | Full copy `Uint16Array.from(marketsWorking)` | **None** (line 195) | Pushed at each stroke (line 234). Undo pops and calls `renderMarketsTemp()` (line 319). Reset at 158 and 335. |

Other undo/history matches were checked and are **not** editor undo:
- `src/io/load.ts:48` and `public/modules/ui/options.js:729`: `mapHistory`, a seed/session log used for "working time" and the seed history dialog (options.js:285-304). Not undo.
- `src/io/cloud-cloudflare.ts:177-253`: server-side version history for shared maps ("stay recoverable from history"). Not client undo.
- `src/generators/states-generator.ts:300, 478`: diplomacy chronicle.
- `public/modules/ui/notes-editor.js:90`: TinyMCE's own undo toolbar item.
- `public/modules/ui/diplomacy-editor.js:77-445`: "relations history" dialog, a log, not undo.
- `public/modules/ui/transform-tool.js:201-212`: comments only.
- `src/renderers/relief-canvas.ts:157, 190` and `src/renderers/dense-zoom.ts:196`: snapshot naming and cache cleanup, not undo.

## 5. Export clone and serialize (src/io/export.ts)

**Entry points.** `exportToSvg` (line 26) calls `getMapURL("svg", { fullMap: true })`. `exportToPng` (45), `exportToJpeg` (87) and `exportToPngTiles` (129) are raster paths.

**`getMapURL(type, options)` (line 234).**
1. Waits for `reliefRenderReady` and `burgRenderReady` (245).
2. Deep-clones `#map` (246), sets id `fantasyMap` (247).
3. Materializes relief (248), restores burg vectors (249), clears dense zoom (250), restores path vectors (251), removes `.viewport-culled` (252-254).
4. Appends the clone to `document.body` (255). This is required so that `getComputedStyle` in `inlineStyle` has a live node.
5. Removes `#debug` unless debug is set (257).
6. Copies referenced `<defs>` items from the live `#defElements` into the clone: emblems, roses, icons, anchors, patterns (lines 259-418 region, `cloneDefs.appendChild(...cloneNode(true))`).
7. Adds an inline `<style>` for `#armies` text (462-467).
8. For `type === "svg"`, rewrites `href` to `xlink:href` (470-476).
9. Copies hatch `<pattern>` defs referenced by fills (478-485).
10. `normalizeZoneHatching(clone, fullMap)` (287). `removeUnusedElements` for svg only (288). `updateMeshCells` for customization + mesh (289). `inlineStyle` for **all** types (290).
11. Removes unused filters and fog/regions/labels when empty (457-459).
12. Fonts (487-503): `getUsedFonts` (488) returns families. Entries with `src` go to `loadFontsAsDataURI` (491), which fetches each URL and returns a `data:` URL (fonts.ts:332-344). A `<style>` with `@font-face` rules is appended to the first `<defs>` (493-502). Fonts without `src` are left as-is (fonts.ts:334-335).
13. Removes the clone from the body (505), serializes with `XMLSerializer` (507), creates an object URL and revokes it after 5 s (508-511).

**`inlineStyle` (lines 546-577).** Creates an empty `<g>` to get default computed styles (547-548). For `g, #ruler *, #scaleBar > text` (550), it writes every computed property that differs from the default, skipping `cursor` and any property already present as an attribute, into a `style` attribute. The empty `<g>` is removed (576). This **inlines computed styles** for the matched elements. It does not cover the whole tree.

**`removeUnusedElements` (515-528)** drops `#defs-relief` if there are no relief `<use>` nodes and removes empty and hidden `<g>` elements. Runs only for SVG.

**`updateMeshCells` (530)** runs only in customization for mesh export.

**Fonts.** Export **does** embed font data as data URLs for fonts that have a URL source. `save.ts` does **not** embed fonts; it stores the used-font list only (save.ts:100).

**Serialize functions.** `getMapURL` is the only SVG serializer in export.ts (line 507). The save path uses `XMLSerializer` at save.ts:130. `saveGeoJson*` functions (579-690) build GeoJSON, not SVG.

**Differences between save and export.**
- Save: no computed style inlining, no font embedding, no `<defs>` copy, no hatch copy, no unused-element pruning. It keeps relief and zone markers so load can restore them.
- Export: all of the above, and it produces a self-contained SVG for external viewers.

## 6. Open items (UNPROVEN)

1. Exact global binding of `undo`/`redo` in hotkeys.js (named window access inferred).
2. Whether heightmap `edits` is capped anywhere outside the read path (`updateHistory` read at 583-596 has no cap).
3. Intent of the `"1.652.0"` gate at auto-update.ts:538.
4. `compareVersions` numeric semantics (not re-read).
5. Whether the binary-map `TYPES` table and `CELL_SECTIONS` indices match the 46-section layout beyond the test fixture (only read, not cross-checked against each index).
6. Runtime memory and time cost of any snapshot. No measurement was done (read-only audit).
7. Whether `export.ts` lines 259-418 do anything beyond the `cloneDefs` copies (read by grep only, not in full).

## 7. Answers to the top-line questions

- "46 CRLF sections, SVG = mapData[5]": **Partly confirmed.** There are 46 sections (save.ts:171-218). SVG is index 5 (save.ts:177, load.ts:142, load.ts:353). CRLF is the **text** path separator only (save.ts:56, load.ts:197). The binary path has no CRLF.
- demo.map: **exists** at `tests/fixtures/demo.map`.
- Binary format: see section 1 (TUPAIA container, 12-byte header, 24-byte directory entries, compression 0/1/2, typed cell arrays).
- Migration count: **40** `isOlderThan` gates (auto-update.ts).
- Undo systems: four local editor systems (heightmap, states brush, cultures brush, markets brush). No global undo.
