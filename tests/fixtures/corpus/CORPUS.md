# Legacy map corpus

REWRITE-PLAN §5 row 33 (load + `src/io/auto-update.ts` migrations). Both other fixtures (`parity/parity-v1.map`, shared-v8) are
already 1.130.1, so no migration ever ran under the GPU renderer's tests. These maps were written by older versions of this app.
`manifest.json` is the machine-readable form of this page; `bench/host/corpus-lib.test.ts` (part of `gate bench`) keeps the two
honest, and `gate corpus` (`bench/host/corpus-load.ts`) loads them.

## Source

Not downloaded. This repository carries the upstream history, so each `legacy-*` map was made by **checking out an old git tag of this
repo, serving it, generating a map with a fixed seed (7319, 1280x720, the version's own default cell density) in headless Chromium
with every non-loopback request aborted, and saving it with that version's own serializer** (`saveMap()` for 0.9b to 1.4, `getMapData()` /
`prepareMapData()` after). `bench/host/corpus-generate.ts <tag>` does exactly that and is how to remake or extend the set:

```sh
node bench/host/corpus-generate.ts v1.0,v1.4,v1.7,v1.99,v1.109 --out /tmp/maps          # static (pre-Vite) tags
# Vite-era tags (v1.110+) need a build first, with the base at the root:
mkdir -p ~/.tupaia-gates/w2-corpus/old/v1.123 && git archive v1.123 | tar -x -C ~/.tupaia-gates/w2-corpus/old/v1.123
ln -s "$PWD/node_modules" ~/.tupaia-gates/w2-corpus/old/v1.123/node_modules
(cd ~/.tupaia-gates/w2-corpus/old/v1.123 && npx vite build --base=/) && node bench/host/corpus-generate.ts v1.123
```

The header's date field is the day the map was generated (2026-10-19). Everything else is deterministic for a given Chromium except
the map id. `demo-v1.112` is the repo's existing `tests/fixtures/demo.map` (written by 1.112.1), referenced in place.

## Maps

| id | file | header version | size | expect | gates triggered | notes |
|---|---|---|---|---|---|---|
| `legacy-v0.9b` | `legacy-v0.9b.map` | 0.9b | 1.04 MB | ancient | 40 | Version 0.9b parses as 0.9.0, below the loader's 0.70.0 floor, so the loader refuses it as ancient. The 1.0.0 gate is only reachable by such files. |
| `legacy-v1.0` | `legacy-v1.0.map` | 1.0 | 1.55 MB | load | 39 | Oldest loadable map. Header has 6 fields (no map id). Triggers every gate but 1.0.0. |
| `legacy-v1.4` | `legacy-v1.4.map` | 1.4 | 1.61 MB | load | 36 | First map with a map id (7 header fields). |
| `legacy-v1.7` | `legacy-v1.7.map` | 1.7 | 1.99 MB | load | 33 | Pre markers-data rewrite (the 1.7.0 gate is skipped, the 1.72+ gates run). |
| `legacy-v1.99` | `legacy-v1.99.map` | 1.99.01 | 1.71 MB | load | 11 | Static pre-Vite tree. |
| `legacy-v1.109` | `legacy-v1.109.map` | 1.109.1 | 1.96 MB | load | 4 | Runs 1.111, 1.113, 1.124 and 1.127. |
| `legacy-v1.123` | `legacy-v1.123.map` | 1.123.0 | 2.14 MB | load | 2 | Vite-era build. Runs only 1.124 (goods, markets, #tradeAnimation) and 1.127. |
| `demo-v1.112` | `../demo.map` | 1.112.1 | 4.31 MB | load | 3 | Not copied: referenced in place. Runs 1.113, 1.124 and 1.127. |

Total committed: 12.0 MB in 7 files (plain text, as the app saves them; the files mix CRLF and LF, so `.gitattributes` marks `*.map` as `-text` to keep the pinned sha256 and size stable under `core.autocrlf`).

## Migration gates

`auto-update.ts` has 40 `isOlderThan(...)` gates (listed in file order, which is the old float order, not semver
order). A map triggers every gate whose semver is newer than its own version. The oldest loadable map runs all of them at once, but a newer map
does **not** run a clean suffix of the file: `parseMapVersion` reads the float-era headers as semver (see "Findings: migration ordering").
Each manifest entry lists the gates it triggers; the unit test recomputes that list from `auto-update.ts` and fails when it is stale.
Gates triggered by at least one map that must load: 1.0.0, 1.1.0, 1.3.0, 1.4.0, 1.5.0, 1.6.0, 1.7.0, 1.11.0, 1.21.0, 1.22.0, 1.61.0, 1.62.0, 1.63.0, 1.64.0, 1.65.0, 1.65.2, 1.72.0, 1.73.0, 1.84.0, 1.85.0, 1.86.0, 1.88.0, 1.91.0, 1.92.0, 1.94.0, 1.95.0, 1.96.0, 1.98.0, 1.99.0, 1.100.0, 1.104.0, 1.105.0, 1.106.0, 1.107.0, 1.108.0, 1.109.0, 1.111.0, 1.113.0, 1.124.0, 1.127.0.

**Not triggerable: `1.0.0`.** Only a file older than 1.0.0 runs it, and `load.ts` refuses every file below `0.70.0` as ancient. The real
pre-1.0 save (`legacy-v0.9b`, header `0.9b`) parses to `0.9.0` and is refused, so the 1.0.0 migration is dead code for every file the loader
accepts. In the old float scheme `0.9b` was above the `0.7` floor; `"0.70.0"` in the semver form looks like a mistranslation of that
floor. See "Findings" for what happens when the floor is lowered. `manifest.knownUnreachable` records this and the coverage check allows
exactly this one gate.

## What `gate corpus` checks, per map, svg arm against gpu arm

1. loads through `uploadMap` (the File > Open path), no page error; `legacy-v0.9b` must instead be refused with the "too old" message;
2. the migrated world has cells, one `#tradeAnimation`, and is saved as the current version with 46 sections;
3. the gpu arm is on the gpu path with no fallback after the load and after two reloads;
4. pack/grid member hashes equal between the arms, and the document census (elements, drawables, visibility and style per layer) equal;
5. the gpu scene routes every visible layer that has drawables;
6. text saves equal between the arms (date and map id masked), and save 2 equals save 3 in each arm (reloading a migrated save is a fixed point);
7. a per-map layer golden at k 1 (`bench/host/layer-golden.ts`, the file's own style, `over44` reading, centred camera). Families with nothing to paint
   in either arm and no drawables are reported as empty. Families listed in `manifest.goldenKnownGaps` fail the same way on the parity
   fixture; their metric failures are reported but do not gate (some are scoped to a single map: legacy-only gaps found by this corpus, listed with their suspected cause) (`strict=1` gates them).
   A known gap excuses **metric drift only** (ssim, over16, over44), and only up to the family's bound in the manifest (`maxOver16`, `maxOver44`,
   `minSsim`: the worst value measured across the corpus plus about 30 %; a metric with no bound has no tolerance). `empty in GPU arm`, `empty in SVG arm`,
   `census changed`, a dropped GPU path or a harness error are never excused, so a routed-but-invisible layer fails whatever the family. The bounds for
   `zones` are a guess (no corpus map failed zones).
   The ink-emptiness test used to be vacuous: every cell carried about 76901 px of baseline "ink" against the blank (the "Map is successfully loaded" toast was
   in the blank of one arm only), so a layer that paints nothing passed. With the toast and the Navigate/Edit indicator kept out of the capture (two small
   edits in `layer-golden.ts`, COVER's file) the baseline is 0 and the test works. A layer with drawables that paints nothing in either arm (opacity 0, hidden
   by the file: `states`, `lakes`, `fog`, `vignette` on `demo-v1.112`) is reported under `golden.quiet`, not judged: there is nothing to compare. A layer that
   paints in one arm and not the other stays judged and is never excused. The gpu-routed check (5) remains the backstop for routing.

## Findings: migration ordering (decision for Ryan)

`auto-update.ts` compares versions as semver (`isOlderThan` over `parseMapVersion`), but the gates were written for upstream's float versions
(`version < 1.7`, `version < 1.11`, `version < 1.652`). The two orders disagree because a float's decimals are not a minor number:
- `1.7` parses to `1.7.0` and `1.4` to `1.4.0`, so the v1.7 map runs the `1.11`, `1.21`, `1.22` and `1.61`..`1.65.2` gates, which in the float era were
  **older** than 1.7. Those gates reset the terrain scheme, `oceanLayers` and the grid type (1.11), rebuild rulers (1.61), move the regions opacity (1.64) and
  rewrite river data (1.65). The v1.4 map runs `1.11`/`1.21`/`1.22` the same way.
- 1.2x maps (minor 21 or 22, greater than 3) skip the `1.3` to `1.7` gates, and 1.61 to 1.66 maps skip the `1.7.0` markers migration.

The svg-vs-gpu checks cannot see this: both arms migrate identically. It is upstream behaviour, left unchanged here. Fixing it means deciding, for
each gate, what the float era meant, and a wrong guess would corrupt maps that load fine today. The manifest lists the gates each map actually runs.

## Findings: the first save after a migration is not a fixed point

Save 1 (right after loading the legacy file) differs from save 2 (after reloading save 1) in section 5 (svg) for `legacy-v1.0` and `legacy-v1.4`, in both
arms. This is recorded as INFO (`save.*.first-reload`); only save 2 equals save 3 is gated. A migrated map therefore settles after one round trip.

## Findings so far

Fixed in this packet (`src/io/auto-update.ts`):
- The `1.652.0` gate. Upstream wrote the float `version < 1.652`; `parseMapVersion` reads the compact `1.652` as `1.65.2`. As `1.652.0` it was
  newer than every real map, **including current ones**, so every load stripped `style` from `#rivers` and `#borders` and re-showed layers the
  author had hidden. Now `1.65.2`. A unit test fails any gate that is not older than the current version.
- The `1.22.0` gate (and `1.0.0`) called `States.collectStatistics()` to turn the serialized neighbour `Set` into an array. That function no longer
  computes neighbours (`findNeighbors()` was split out), so every map older than 1.22 left `state.neighbors` as `{}` and the 1.3.0 gate's
  `Military.generate()` threw `neighbors.map is not a function`: **the v1.0 map did not load at all.** Both gates now call `findNeighbors()`.
- The duplicate `#tradeAnimation` is already handled in the current tree (the 1.124.0 gate reuses the shell's container and
  `keepSingleTradeContainer` collapses saved duplicates); the corpus asserts exactly one after every load.

Known fidelity bugs this corpus found, for STROKE/COMPAT (also see `manifest.goldenKnownGaps`):
- `ice` on v1.7 and v1.99 (fixed, no longer a known gap): the files carry an inline `style="opacity: ..."` (a jQuery fade caught mid-way by the old
  version: 0.04 on v1.7, 0.008 on v1.99) next to `opacity="0.9"`; the SVG honours the style (CSS beats the attribute). RES made the GPU honour it too
  (`src/io/inline-style.ts`). v1.99's ice then still failed the coverage ink rule (0.875 against 0.9) and that was a metric artifact, not a rendering
  difference: at opacity 0.008 the layer is 0.18 of a code value at its strongest, so which pixels reach a whole value is a rounding accident of each
  renderer. Lifted to opacity 1 the two arms have the identical footprint (149 208 ink px each, ratio 1.000). The golden now judges such FAINT layers
  at full opacity (`FAINT` in `bench/golden-metrics.ts`, GATE.md "Faint layers"). The `ice` known-gap entry was removed from the manifest.
- v0.9b `#borders` routed 0 when the floor is lowered (evidence `~/.tupaia-gates/w2-corpus/exp09c`).

Observed, not changed:
- 1.65.2 now keeps hidden `#rivers`/`#borders` `style` on load (the gate used to fire for every map). Nothing in the current code sets `style` on those groups
  (toggles remove children). `load.ts` turns `toggleRivers` on from `hasChildren()` before auto-update runs, so a hand-edited map with `#rivers { display: none }`
  would show the button on with the layer hidden. This deviates from upstream and will conflict on an upstream rebase.
- `showStatistics()` ends every load and sets `mapId = Date.now()`, so the map id in the file is never kept (the same for the parity fixture).
- The loader's `0.70.0` floor (above).
- With the floor lowered to `0.7.0` (scratch build, reverted), `legacy-v0.9b` loads and migrates under both arms with equal hashes and saves, but
  the GPU draws nothing for `#borders` (the 1.0.0 gate builds fresh `stateBorders`/`provinceBorders` groups; SVG ink 79k px, 0 routed) and `ocean`
  differed by 2% over16 (very likely the load toast artifact described next, not a map finding). Evidence: `~/.tupaia-gates/w2-corpus/exp09c`.
- The `ocean` over16 ~2% failures seen intermittently (v1.4 in one run, v1.123 in another) were not map gaps: the GPU arm of the first golden cell was captured
  while the 7 s "Map is successfully loaded" toast was still showing at the bottom of the frame (diff: a 1400x35 bar). `layer-golden.ts` now clears the main tip after the
  load (a small change in COVER's file), and the `ocean` known gap for v1.4 was dropped from the manifest.
- Legacy-only golden gaps (scoped known gaps in the manifest, cause not confirmed): `texture` on demo.map (a fixed 1280x720 image in a 1680x849 world) and a borderline `rivers` on demo.map (over44 0.57%).
- The golden on every legacy map fails the known parity families (cells, states, provinces, coordinates, markets, military, markers).
