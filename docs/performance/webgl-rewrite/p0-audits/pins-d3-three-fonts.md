# P0 pin: d3, three, fonts (read-only audit, 2026-10-13)

Scope: Read/Grep/Glob only. Nothing executed. Line numbers are from the working tree at the start of the session.

## 1. d3

| Item | Value | Evidence |
|---|---|---|
| Vendored file | present: `public/libs/d3.min.js` | Glob |
| Bundle version | `5.8.0` (`.version="5.8.0"`) | d3.min.js:2 |
| Load mechanism | classic sync `<script>`, no defer, no type=module | src/index.html:8968 |
| Served path | Vite `root: './src'`, `publicDir: '../public'` so `libs/...` resolves to `public/libs/` | vite.config.ts:4, :12 |
| npm d3 | `^7.9.0` in `dependencies` | package.json:50 |
| npm types | `@types/d3 ^7.4.3` in devDependencies | package.json:34 |
| v5 API present | exports `t.event`, `t.mouse`, `t.touch`, `t.customEvent` | d3.min.js:2 (grep -o) |
| v6+ API | no `t.pointer=` export; only `pointer-events` attribute strings | d3.min.js:2 (grep -o) |

### src imports from "d3" (npm v7, bundled by Vite)

- 61 src files import from "d3" or "three" in total.
- d3 value (runtime) imports: 57 files. 54 are single-line `import {...} from "d3"`. 3 are multi-line: `renderers/draw-heightmap.ts:2-23`, `controllers/elevation-profile.ts:1-16`, `controllers/charts-overview.ts:1-19`.
- d3 type-only files: `types/global.ts:1`, `renderers/draw-scalebar.test.ts:1`.
- Files mixing `import type` and value imports: `io/export.ts:3`, `renderers/draw-scalebar.ts:1-2`, `renderers/ocean-layers.ts:1-2`, `controllers/hierarchy-tree.ts:1-2`, `renderers/draw-heightmap.ts:1`.
- `renderers/draw-scalebar.ts:15` uses `d3.Selection` as a type with no local `d3` binding (global UMD namespace reference). Compile behavior: UNPROVEN.

### Global `d3` (vendored v5.8.0) consumers

- `public/` has 0 ES `import`/`from` statements, so all of `public/modules/**/*.js` uses the global `d3`.
- Load order: `libs/d3.min.js` is sync at index.html:8968. `modules/ui/*.js` are `defer` from index.html:8983 onward, so d3 exists before they run.
- Raw counts in `public/modules` (regex, comments not separated):

| Symbol | Occurrences | Files | Present in v5.8.0 bundle |
|---|---|---|---|
| `d3.event` | 145 | 21 | yes (`t.event`) |
| `d3.mouse` | 38 | 19 | yes (`t.mouse`) |
| `d3.pointer` | 0 in code (4 hits, all in docs/) | 0 | no |

- `d3.event` examples: `public/modules/ui/measurers.js:74`, `:77` (`d3.event.on("drag", ...)`), `:84` (`d3.event.sourceEvent.shiftKey`), `:224`.
- `d3.mouse` examples: `public/modules/ui/biomes-editor.js:378`, `:397`; `public/modules/ui/ice-editor.js:63`; `public/modules/ui/general.js:81`; `public/modules/ui/relief-editor.js:112`.
- `src/` reads of the global: `src/io/load.ts:359` `(window as any).d3.select("#map")`.
- `src/` hits for `d3.event`: 6, all in comments (`controllers/regiments-overview.ts:200`; `controllers/regiment-editor.ts:273, :325, :403`; `io/load.ts:356-357`).
- `io/load.ts:356-357` comment: a v7 selection does not set the v5 global `d3.event`, which breaks mouse/zoom handlers after a map load (#1508). So two d3 runtimes coexist: npm v7 bundled for `src/`, and vendored v5.8.0 global for `public/modules` plus `io/load.ts:359`.
- d3-drag code in the bundle reads `t.event.view` (d3.min.js:2, minified). Listener-lifetime semantics: UNPROVEN, not traced.

## 2. three

| Item | Value | Evidence |
|---|---|---|
| Vendored file | present: `public/libs/three.min.js` | Glob |
| License header | `Copyright 2010-2022 Three.js Authors` | three.min.js:3 |
| Revision | `REVISION` is `e`, and `const e="140"` | three.min.js:6 (grep -o) |
| Load mechanism | lazy, on demand. `loadTHREE()` injects `<script src="libs/three.min.js">`, then sets `Three = window.THREE` in onload | src/renderers/view-3d-renderer.ts:1135-1151 (script at :1140, assign at :1143) |
| Callers of `loadTHREE()` | 2 | view-3d-renderer.ts:327, :858 |
| Referenced from index.html | 0 | grep |
| npm three | `^0.184.0` in `dependencies` | package.json:55 |
| npm types | `@types/three ^0.184.1` in devDependencies | package.json:39 |
| src value imports of "three" | 0 | grep |
| src type-only imports | 3 files: `renderers/view-3d-renderer.ts:1`, `renderers/draw-satellite-texture.ts:2`, `renderers/erosion-bake.ts:3` (all `import type * as ...`) | grep |
| `typeof import("three")` | `view-3d-renderer.ts:15`, `:1143` | grep |
| Imports from "three" outside src/ | 0 | grep (excludes src, docs, public, node_modules, dist) |

Version mismatch: runtime is r140 (vendored), while npm and types are 0.184.x. Whether any type-checked `THREE.*` API is missing from r140 at runtime: UNPROVEN.

## 3. Fonts

File: `src/services/fonts.ts` (423 lines). Loaded by `src/services/index.ts:2` (`import "./fonts";`), which is loaded from `src/index.html:8976`.

Ambient globals declared at fonts.ts:3-11: `declareFont`, `getUsedFonts`, `loadFontsAsDataURI`, `addGoogleFont`, `addLocalFont`, `addWebFont`, `fonts`.

| Symbol | Lines | Behavior |
|---|---|---|
| `window.fonts` (default list) | 20-269 | 53 entries: 14 system names with no src (21-34), 39 Google families with `src: url(https://fonts.gstatic.com/...)` (36-264) |
| `window.declareFont` | 271-278 | always calls `addFontOption` (273). If `src` is set: `new FontFace` (276) and `document.fonts.add` (277) |
| `declareDefaultFonts` | 282-286 | runs at module evaluation (280) |
| `addFontOption` | 288-295 | appends `<option>` to `#styleSelectFont` |
| `fetchGoogleFont` | 297-321 | `fetch` to `https://fonts.googleapis.com/css2?family=` (298); regex-parses `@font-face` (303). Network at runtime |
| `readBlobAsDataURL` | 323-330 | FileReader |
| `window.loadFontsAsDataURI` | 332-344 | fetches each `src` URL and returns data URLs. Used only by export: `io/export.ts:488-491` |
| `window.getUsedFonts` | 346-364 | collects `font-family` from `#labels g` (349-353), `provs` (355-356), `#legend` (358-360), then filters `fonts` (362) and returns the stored objects unchanged |
| `window.addGoogleFont` | 366-396 | fetch; `FontFace.load()` (377); `document.fonts.add` (383); `fonts.push` (385) |
| `window.addLocalFont` | 398-410 | `fonts.push({family})` (399); `FontFace` with `local(family)` src (401); `document.fonts.add` (404) |
| `window.addWebFont` | 412-423 | `fonts.push` (414); `FontFace` with `url('...')` (416); `document.fonts.add` (417) |

Uses `document.fonts` and `FontFace`: yes. `new FontFace` at :276, :373, :401, :416. `document.fonts.add` at :277, :383, :404, :417.

### Save and load

- Save: `src/io/save.ts:100` `JSON.stringify(getUsedFonts(svg.node()!))`. It lands in the `mapData` array (opened at save.ts:171) at element index 34 (`fonts` at save.ts:206). Index counted by hand from the array literal, and it matches the load side.
- Stored content is the FontDefinition objects, so `src` is a URL string (remote https, `local(...)`, or a user URL), not font bytes. This follows from getUsedFonts returning the stored objects (fonts.ts:362-363).
- Load: `src/io/load.ts:324-335`.
  - `JSON.parse(data[34])` at load.ts:325. Index 34 is consistent with save.ts:206.
  - For each used font, push to `fonts` if no exact match on family, unicodeRange and variant (328-332).
  - `declareFont(usedFont)` is called for every used font, including defaults (333). That recreates `FontFace` for `src` entries.
  - Because `declareFont` always calls `addFontOption`, default families may get a second `<option>`. INFERRED from code (fonts.ts:273 plus load.ts:333). Not run.

## 4. Claim check

| Claim | Verdict | Evidence |
|---|---|---|
| "d3.min.js absent from snapshot" (README.md:45, :97; REWRITE-PLAN.md:212; backlog O01) | CONTRADICTED. File present, v5.8.0 | public/libs/d3.min.js:2; index.html:8968 |
| "font loader definitions absent" (README.md:97) | CONTRADICTED. All loaders defined | src/services/fonts.ts:3-423 |
| "npm three is types-only" (README.md:11; REWRITE-PLAN.md:10, :272) | PARTLY TRUE. src has 0 runtime imports, but `three` is listed under `dependencies` (package.json:55), not devDependencies. Runtime is vendored r140 | package.json:55; view-3d-renderer.ts:1135-1151 |
| "runtime three version unknown" (REWRITE-PLAN.md:10) | RESOLVED: REVISION "140" | three.min.js:6 |
| "legacy global D3 (v5)" (docs/architecture/migration_guide.md:76) | CONSISTENT with `.version="5.8.0"` | d3.min.js:2 |

## 5. UNPROVEN

- Runtime behavior of anything. Nothing was executed.
- Whether the Vite build serves npm d3 v7 for src imports (ESM bundling assumed, not verified in build output).
- d3-drag `event.view` listener lifetime. Minified only, not traced.
- three r140 runtime versus 0.184 types: API compatibility not checked.
- Duplicate `<option>` on load (inferred from code, not run).
- `d3.event` and `d3.mouse` counts include comments; not separated.
- `renderers/draw-scalebar.ts:15` global `d3` namespace type reference: compile behavior not verified.
