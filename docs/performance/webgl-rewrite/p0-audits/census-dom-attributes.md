# Census: data-* and non-standard attributes on map SVG

Read-only audit (Read/Grep/Glob only). Scope: `public/main.js`, `public/modules/ui/{style,style-presets,layers,options,tools,heightmap-editor,relief-editor,transform-tool}.js`, `src/io/**/*.ts`, `src/renderers/**/*.ts` (tests excluded). Controllers and other UI markup (`data-id`, `data-state`, `data-culture` on editor DOM) are out of scope.

Counts are approximate: grep-based, from a single pass. Line numbers were verified in the source except where marked "not re-verified".

## 1. Totals

- Distinct map-facing `data-*` attribute names: **50**.
- Written but read only through the DOM (no in-memory mirror): about 20. See section 5.
- Written in the repo but never read back in scope: `data-relief-viewport`, `data-name`, `data-state` (draw-military), `data-f`.
- Read in the repo but never written in the repo (authored outside, e.g. by the MCP): `data-scale`, `data-biomes`, `data-min-height`, `data-exclude`, `data-near-burgs`, `data-min-size`, `data-max-size`, `data-always-show`.

## 2. Table A: data-* attributes

Format: attribute | writers (max 4) | element/layer | read back by (max 3).

| attribute | writers | element / layer | read back by |
|---|---|---|---|
| data-size | draw-emblems.ts:39,46,53; draw-goods.ts:90,112; draw-markets.ts:35; auto-update.ts:19 | legend, markets, goods, emblems, coordinates, labels | main.js:565; label-culling.ts:58,156; style-presets.js:208,225,227,262 |
| data-width | style.js:956; auto-update.ts:390 (remove only) | #statesHalo (halo width); river widthFactor (overloaded) | main.js:606; style.js:246; style-presets.js:247 |
| data-icon | draw-burg-icons.ts:51; style.js:809; auto-update.ts:1014 | #markets, burg icon groups | draw-markets.ts:37; burg-canvas.ts:111,133; draw-burg-icons.ts:21 |
| data-circle | draw-goods.ts:89; style.js (927-1030); auto-update.ts:1152 | #goodsIcons | style-presets.js:227 |
| data-dx | draw-burg-labels.ts:23,51; style.js (927-1030) | burg label groups | style-presets.js:346; style.js (279-441) |
| data-dy | draw-burg-labels.ts:24,52; style.js (927-1030); auto-update.ts:1034 | burg label groups | style-presets.js:347; auto-update.ts:1034 (dataset read) |
| data-x | auto-update.ts:20,728,821; style.js:539,547; draw-scalebar.ts:126 | #legend, #texture, #scaleBar | style-presets.js:107,290,322; auto-update.ts:558; load.ts (indirect) |
| data-y | auto-update.ts:21,728,822; style.js:539,547; draw-scalebar.ts:127 | #legend, #texture, #scaleBar | style-presets.js:108,291,322; auto-update.ts:559 |
| data-href | auto-update.ts:728; style.js:524; load.ts:416,575 | #texture (texture image href mirror) | style-presets.js:109,265; style.js:184-186; load.ts:575 |
| data-columns | style.js:834 | #legend | style-presets.js:292; style.js (279-441) |
| data-bar-size | draw-scalebar.ts:28,110; auto-update.ts:819; style.js (1152-1165) | #scaleBar | draw-scalebar.ts:28; style-presets.js:322 |
| data-label | draw-scalebar.ts:73; auto-update.ts:823; style.js (1152-1165) | #scaleBar | draw-scalebar.ts:73; style-presets.js:322 |
| data-top / data-right / data-bottom / data-left | auto-update.ts:833-836; draw-scalebar.ts:93-96 | #scaleBarBack (margins) | style-presets.js:329-332; draw-scalebar.ts:93-96 (read) |
| data-render | draw-heightmap.ts:66; style.js:742; auto-update.ts:788 | #oceanHeights, #landHeights | style-presets.js:271; draw-heightmap.ts:66 |
| data-height | draw-heightmap.ts:155,157 | heightmap cells | heightmap-editor.js:1473,1570,1602 (out of scope, read) |
| data-filter | style.js:1197,1202 (on root svg, outside #viewbox) | root `svg` | style-presets.js:474 |
| data-layer-off | save.ts:126 | #tradeAnimation | load.ts:539 |
| data-type | auto-update.ts:378 (remove) | legacy emblem `<use>` | auto-update.ts:376-380 |
| data-increment | auto-update.ts:391 (remove only) | legacy river | none (dead) |
| data-min-size / data-max-size / data-always-show | none in repo (MCP-authored) | burg label groups | main.js:572-595 (dataset); draw-burg-labels.ts:10,88 (preserved, not copied) |
| data-zone-hatch-fill | zone-hatching.ts:191 | hatched `path` | zone-hatching.ts:54,70,73,88; label-culling.ts (indirect) |
| data-zone-hatch-clone | zone-hatching.ts:180 | `pattern` clones | zone-hatching.ts:67,89; label-culling.ts:26,29 |
| data-dense-zoom | dense-zoom.ts:283 | dense-zoom marker | dense-zoom.ts:200; label-culling.ts:26,28,41 |
| data-zoom-visibility | dense-zoom.ts:177 (stash) | image | dense-zoom.ts:141,164 |
| data-zoom-hidden | dense-zoom.ts:180 | image | dense-zoom.ts:165,201 |
| data-relief | relief-canvas.ts:87 | relief `image` | relief-canvas.ts:143,172,197; dense-zoom.ts:35,216 |
| data-relief-count | relief-canvas.ts:88 | relief `image` | relief-canvas.ts:173; relief-settings.ts:251 |
| data-relief-viewport | relief-viewport.ts:123 | relief viewport `image` | **none found** |
| data-seed | relief-settings.ts:284 (default) | relief `image` | relief-settings.ts:151 (also MCP-authored) |
| data-scale, data-biomes, data-min-height, data-exclude, data-near-burgs | none in repo (MCP-authored) | relief `image` | relief-settings.ts:141-156 |
| data-regenerate | relief-settings.ts:282-283 | relief `image` | relief-settings.ts:209,246,257,279 (not re-verified) |
| data-path-vectors | path-layer-canvas.ts:124 | path `image` (markup stash) | path-layer-canvas.ts:12,30,31 |
| data-burg-vectors | burg-canvas.ts:73 | burg `image` (markup stash) | burg-canvas.ts:14,16,145; dense-zoom.ts:249 |
| data-cell-mesh | cell-mesh-canvas.ts:40 | mesh `image` | cell-mesh-canvas.ts:47 |
| data-border-key | draw-borders.ts:100 | `#borders path` | draw-borders.ts:11 |
| data-owners | draw-borders.ts:101 | `#borders path` | draw-borders.ts:95 |
| data-i | draw-emblems.ts:123,134,145; draw-goods.ts:101; emblems/renderer.ts:318 | emblem `use`, goods `g` | draw-emblems.ts:169; tools.js:246,251,293 |
| data-id | draw-burg-labels.ts:33,59; draw-burg-icons.ts:57,67; draw-military.ts:46,100 | burg labels/icons, military | draw-ice.ts:31-56; main.js:512; draw-markets.ts:73-74 |
| data-name | draw-military.ts:44,98 | military group | **none found** |
| data-state | draw-military.ts:45,99 | military group | **none found** |
| data-f | draw-features.ts:35,39,40,44,46,47,51 | feature `path`/`use` | **none found** |

## 3. Non-standard attributes (not data-*)

| attribute | writers | element / layer | read back by |
|---|---|---|---|
| scheme, terracing, skip, relax, curve | auto-update.ts:779-795, 800-806 (moved from `#terrs`) | #oceanHeights, #landHeights | style-presets.js:273-277, 281 |
| layers | auto-update.ts:215 | #oceanLayers | style-presets.js:267 |
| type (`pointyHex`) | auto-update.ts:216 | gridOverlay | not re-verified |
| size | auto-update.ts:1017,1029 (removeAttribute, then font-size) | legacy label groups | style-presets.js:302 (via data-size path) |
| box-size | auto-update.ts:281-288 (armies, value 3) | armies | not re-verified |
| color | auto-update.ts:848 | compass | not re-verified |
| letter-spacing | auto-update.ts:972 (set null) | labels | style-presets.js:301,313 |
| set, size, density | style-presets.js:240 (`#terrain`) | #terrain | style-presets.js:240 |

## 4. auto-update.ts migrations

Line numbers from the grep pass; the "what" column is from grep text unless marked.

- 17-21: legend group gets `font-family`, `font-size` 13, `data-size` 13, `data-x` 99, `data-y` 93.
- 79, 754, 778, 807: mask attributes added or removed on land/ocean layers.
- 78-92: fogging-cont / mask `#fog` created.
- 95-97: `statesBody` opacity moved onto `regions`.
- 124: labels `display` set to null.
- 137-198: lakes/coastline group creation; filter styling (`url(#crumpled)`, `url(#dropShadow)`).
- 202-205: defs `#land` / `#water` and coastline/lakes paths removed.
- 213: terrs `scheme`, `terracing`, `skip`, `relax`, `curve` read.
- 214: `oceanic` id renamed to `oceanicPattern`.
- 215: `oceanLayers` `layers="-6,-3,-1"`.
- 216: gridOverlay `type="pointyHex"`, `size` 10.
- 232-234: terrain defaults `set`, `size`, `density`.
- 241: `display` removed.
- 281-288: armies `box-size` 3, `font-size` 6.
- 296-303: dry lake group created.
- 303, 313: `filter` removed; ice filter `url(#dropShadow05)`.
- 363-370: `defs-emblems`, `emblems` group with burg/province/state sub-groups.
- 376-380: legacy emblem `<use>`: remove `xlink:href`, `data-type`, `data-size`; set `href`.
- 389-391: river `widthFactor` read from `data-width`; `data-width` and `data-increment` removed.
- 476: gridOverlay `size` removed.
- 482-484: oceanicPattern `opacity` removed, or set to 0.2.
- 489-493: `statesBody` takes `regions` opacity/filter; `statesHalo` gets `blur(5px)`.
- 679-681: element x/y set, `transform` removed.
- 713: x set to "0".
- 724-730: texture `data-href`, `data-x`, `data-y` written from the `<image>`; image removed.
- 737-758: vignette mask and rect created (`mask`, `filter blur(20px)`).
- 763-783: terrs attributes read, then nulled (`scheme`, `terracing`, `skip`, `relax`, `curve`, `mask`, ...).
- 786-807: `oceanHeights` / `landHeights` groups created with the moved attributes.
- 812-836: scaleBar created with `data-bar-size` 2, `data-x` 99, `data-y` 99, `data-label`; `scaleBarBack` gets `data-top/right/bottom/left`.
- 848-850: compass `color` set; `rect` fill set to currentColor.
- 858-862: compass `xlink:href` set to `#defs-compass-rose`.
- 869: routes `display` and `style` nulled.
- 962-974: featurePaths recreated; defs `#land`/`#water` and coastline paths removed; labels attributes nulled (`letter-spacing`, `fill`, `stroke`, `opacity`, `stroke-width`).
- 1017-1030: `size` removed, `font-size` set, `stroke-width` 1 on some labels.
- 1118-1128: ice group recreated with the dropShadow05 filter.
- 1152: `data-circle` set.

## 5. Written but DOM-only (scene-model risk)

Ranked by risk for a future SVG-to-scene model.

1. `data-burg-vectors`, `data-path-vectors`, `data-cell-mesh`: serialized markup stored in attributes and restored by `innerHTML` (burg-canvas.ts:16, path-layer-canvas.ts:31). Persistence depends on `restoreBurgVectorsIn` / `restorePathVectorsIn` in save.ts:104,107.
2. `data-zoom-visibility` + `data-zoom-hidden`: stash of original attributes (dense-zoom.ts:177,180) read back at dense-zoom.ts:141,164,201. save.ts clears these through `clearDenseZoom`.
3. `data-zone-hatch-fill` / `data-zone-hatch-clone`: restored on save via `restoreZoneHatching` (save.ts:106); read by label-culling.ts:26-29 to skip culling.
4. `data-filter` on the root `svg` (style.js:1197,1202), outside `#viewbox`, read via `style-presets.js:474`.
5. `data-layer-off`: only a save/load round-trip (save.ts:126 to load.ts:539). No in-memory state.
6. `data-relief`, `data-relief-count`, `data-relief-viewport`: relief state lives in DOM; `data-relief-viewport` has no reader.
7. MCP-authored `data-scale`, `data-biomes`, `data-min-height`, `data-exclude`, `data-near-burgs`, `data-min-size`, `data-max-size`, `data-always-show`: no in-repo writer, read on each render. Clamped in relief-settings.ts:132.
8. Write-only: `data-name`, `data-state` (draw-military.ts), `data-f` (draw-features.ts), `data-relief-viewport`, `data-increment` (dead).

## 6. Surprises

- `data-size` has at least four meanings: label font base (style-presets.js:376-378, with the explicit `#markets` exception), market circle, goods circle, emblem size. Overloaded across `label-culling.ts:58` and `main.js:565`.
- `data-width` overloaded: `#statesHalo` halo width (main.js:606, style.js:956) and river `widthFactor` (auto-update.ts:389-390).
- Two out-of-scope UI files write map-facing data: `public/modules/ui/submap-tool.js:95` writes `data-size` on map groups; `heightmap-editor.js:1563` writes `data-height`.
- `save.ts:128` mentions `data-regenerate` as legacy and does not write it.
- `draw-burg-labels.ts:87-91` explicitly excludes MCP override attributes from copying to new groups. The override is per-group and not inherited.
- `auto-update.ts:558-568` reads legend `dataset.x`, `dataset.y`, `dataset.size`, so legend position depends on a migration-era attribute.
- `data-i` is read (draw-emblems.ts:169) and renamed by tools.js:293. Emblem identity is a DOM attribute that UI code edits directly.

## 7. Not verified

- Style-preset lines 343-351 (`data-dx`, `data-dy`, `data-icon`) and their selectors were not re-read; only the grep line numbers were used.
- `style.js` writes at lines 927-1030 and 1152-1165 were taken from the earlier summary, not re-read in this pass.
- Controllers and UI templates were excluded by scope.
