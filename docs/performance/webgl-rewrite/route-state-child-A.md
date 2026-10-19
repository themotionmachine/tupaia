# Route-state child A: accumulation candidates for GPU prepare slowdown

Scope: read-only audit of `src/gpu` (GpuRenderer), `src/renderers/renderer-mode.ts`, and app-level editor and world-load code under `public/` and `src/io/`. No tests, builds, browsers, npm, or checks were run. Only this file was written.

Tags: every claim is marked **VERIFIED-IN-CODE** (read in the source at the cited line) or **UNVERIFIED** (inferred, not read, or not measured).

## Verdict

- **VERIFIED-IN-CODE:** no monotonic growth across world loads or editor opens was found in the audited files. The GpuRenderer is created once per page (`renderer-mode.ts:198-232`) and re-pointed with `worldReplaced()` (`renderer.ts:416-448`).
- **VERIFIED-IN-CODE:** the strongest per-prepare cost mechanism is `GpuDevice.track()`, which calls `memory()` over every tracked resource on each add (`device.ts:309-312`, `289-298`). Total cost over n resources is O(n²).
- **VERIFIED-IN-CODE:** revision churn from editor opens and closes raises prepare frequency (`classify()` treats `#debug` edits as static, `markers.ts:230-266`). It does not by itself raise per-prepare cost.
- **UNVERIFIED:** that the tracked set actually grows across the integration sequence. Releases are present on the verified paths (`device.ts:270-273`), but live counts were never measured.
- **Ratio check:** the brief gives 90 s vs about 1.3 s, which is about 69x, not 10x. If O(n²) dominates, live tracked resources would need to be about 8.3x (69x) or about 3.2x (10x) larger than in the baseline run. Which ratio is correct must be confirmed by the user (UNVERIFIED).

## Candidate table

Columns: what / file:line / created / disposed / growth unit / expected main-thread effect / in-page measurement / status.

| # | What | File:line | Created | Disposed | Growth unit | Expected main-thread effect | In-page measurement | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | `GpuDevice.tracked` Set | `device.ts:309-312` (track), `270-273` (release), `289-298` (memory), `325-332` (dispose) | `track()` on every texture, buffer, framebuffer | `release()` deletes from Set; `dispose()` releases all | +1 per resource not released | `track()` runs `memory()` over all n tracked entries, so each prepare costs O(n²) in resource count | Read device tracked size (needs a read-only getter, not present) before and after each world load and each editor open | Mechanism VERIFIED-IN-CODE. Growth UNVERIFIED |
| 2 | Programs added directly to `tracked` | `device.ts:266` | Program compile | `dispose()` path only (`device.ts:325-332`) | +1 per program created | Same O(n) `memory()` cost as row 1 if programs are recreated per load; otherwise none | Count `tracked` entries that are programs, before and after load | Bypass of `track()` VERIFIED-IN-CODE. Whether programs are recreated per load UNVERIFIED |
| 3 | Compat clone cache | `compat.ts:16-28` (build and cache), `30-32` (`forgetCompatClone`) | `prepareMapClone("gpu", { debug: true })` once per revision | Old clone replaced in `cached`; no explicit DOM removal (GC only) | One clone per revision, not accumulated | Full serialization of `#viewbox` per revision; cost scales with live DOM size inside `#viewbox` | Time `compatClone()` and record `#viewbox` descendant count at each call | Replacement VERIFIED-IN-CODE. Cost and whether compat runs every prepare UNVERIFIED (`prepare.ts:679` is inside `refineDetail`) |
| 4 | Revision counter and invalidation | `renderer.ts:186` (field), `745-748` (static path), `756-760` (`invalidate`) | `mutated()` on a static mutation | n/a (counter) | +1 per static mutation, each schedules `schedulePrepare(PREPARE_DELAY, "revision")` | More full prepares per editor session; no per-prepare growth | Log `revision` and `invalidations.count` per step | Mechanism VERIFIED-IN-CODE |
| 5 | `#debug` group inside `#viewbox` | `public/main.js:91`; `markers.ts:216-223` (`overlayRoot` returns null under `#viewbox`); `markers.ts:230-266` (`classify`) | Once at load | Not removed | Editor open and close edits inside `#debug` each count as static | Each open and close adds one static revision, so one prepare each | Count `#viewbox` mutations per open and close | Mechanism VERIFIED-IN-CODE |
| 6 | Route editor control layers | `public/modules/ui/routes-editor.js:12`, `18-19`, `406-408` | Open (`editRoute`) | Close removes `#controlPoints` and `#controlCells` | 0 net per open/close cycle | Two extra static revisions per cycle (row 5) | Check both groups absent after close | Create and remove VERIFIED-IN-CODE. Net growth none |
| 7 | Route creator control layers and listeners | `public/modules/ui/routes-creator.js:12-14`, `32-33` (guard), `40`, `127-130` | Create | `closeRouteCreator` removes both groups | 0 net per cycle; `viewbox.on("click")` replaces (`:14`) | Same as row 5 | Count `#controlPoints` and `#controlCells` after close | VERIFIED-IN-CODE |
| 8 | Route creator body markup | `public/modules/ui/routes-creator.js:52` (`body.innerHTML +=`) | Per point added | Reset path not read | +1 DOM fragment per point | Re-parse of body each point; can enlarge live DOM read by row 3 if body is inside `#viewbox` (UNVERIFIED) | Record `body.innerHTML.length` per point | Append VERIFIED-IN-CODE. Reset path and growth in session UNVERIFIED |
| 9 | Label font-size input | `public/modules/ui/labels-editor.js:390`; close at `434-437` | Per input event | Not reverted on close (no font-size write in close path) | +1 static revision per input event | One prepare per input event while typing or dragging | Count revisions per input event | VERIFIED-IN-CODE. Earlier hypothesis that route close reverts font size is WRONG (no font-size write in `routes-editor.js`) |
| 10 | Coordinate overlay | `public/modules/ui/layers.js:696-717` (`drawCoordinates`); `public/main.js:205-228` (`details()`, gated at `215` by `gpuRenderer.defers`) | Each call | Children removed at start of each call (`697`) | 0 net per call | If `#coordinates` is inside `#viewbox` (UNVERIFIED), one static revision per camera update while toggled on | Count `#coordinates` children and revision per pan | Child removal VERIFIED-IN-CODE. Placement inside `#viewbox` UNVERIFIED |
| 11 | Trade marker data buffer | `markers.ts:357-360` (capacity doubling), `375`, `404`, `411-414` | Doubling on growth | `release()` at `411-414` | Capacity never shrinks | None on time. `framegraph.ts:180` uploads `count * MARKER_FLOATS`, so only memory is affected | Read `markers.data.length` and `count` | VERIFIED-IN-CODE (no time effect) |
| 12 | Slicer MessageChannel | `src/gpu/slice.ts:7-16` (`yieldToMain`) | One per yield | `port1.close()` on message; `port2` never closed | +1 `port2` per yield | Likely small; GC retention of `port2` would add memory only | Count live `MessageChannel` objects via heap snapshot (UNVERIFIED) | Port2 not closed VERIFIED-IN-CODE. Retention UNVERIFIED |
| 13 | Map history array | `public/main.js:1336-1342` (`showStatistics`); push at `1338` | Per generate and per load | Not removed | +1 entry per world load | Memory only, unless entries hold DOM or big payloads (UNVERIFIED) | Read `mapHistory.length` and sum of payload sizes | `push` VERIFIED-IN-CODE. Payload size UNVERIFIED |
| 14 | d3 `.on` listeners on editor elements | `routes-editor.js:12`, `routes-creator.js:14`, `provinces-editor.js:27-43` | On each editor open | Replaced on re-bind | 0 net if d3 replaces same-type listeners | None if replacement holds | Count listeners per element via devtools `getEventListeners` (not allowed here, so UNVERIFIED) | d3 replace semantics UNVERIFIED against d3-selection source |
| 15 | jQuery UI dialog per route open | `public/modules/ui/routes-editor.js:29-34` | Per open | `close: closeRouteEditor` | Per-open dialog; growth UNVERIFIED | Dialog DOM per open | Count `.ui-dialog` nodes after N opens | Create per open VERIFIED-IN-CODE. Removal on close UNVERIFIED |
| 16 | Renderer observers and listeners | `renderer.ts:231-235`, `290-295` (dialogs observer, set once), `282-289` (`#map` observer, re-observed in `worldReplaced`), `296-299` | Constructor | `dispose()` at `543-568` | 0 net; `worldReplaced` disconnects and re-observes | None observed | Count observer callbacks per load | Ruled out, VERIFIED-IN-CODE |
| 17 | Module-level window listeners | `renderer-mode.ts:241-243`; `src/io/cloud-cloudflare.ts:47, 51`; `public/modules/ui/general.js:4` | Module load, once | Not removed (by design) | 0 net | None | Count window listeners at load and after loads | Added once VERIFIED-IN-CODE |
| 18 | Voice interval | `public/modules/ui/options.js:245` | Module load | Not cleared | 0 net if once | Periodic work, size UNVERIFIED | Confirm interval count is 1 | Creation VERIFIED-IN-CODE. Body UNVERIFIED |
| 19 | Dense-zoom polling, autosave, trade-animation timers | Not read | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | Count timers via wrapper (not allowed here) | Not read |

Ruled out (VERIFIED-IN-CODE): renderer per world load; `#map` observer re-pointing; dialogs observer per open; routes-editor and routes-creator listener growth (guarded); `#controlPoints` and `#controlCells` growth; compat detail and overlay textures (released before reassign, `prepare.ts:664-679`, `815-843`, `847-853`; `overlays.ts:26-60`); module-level window listeners.

## Top 3 by evidence strength

1. **`device.track()` O(n) `memory()` per add** (`device.ts:309-312`, `289-298`). Mechanism VERIFIED-IN-CODE. Accumulation UNVERIFIED. This is the only candidate whose mechanism alone matches a per-prepare slowdown that grows with resource count. A live-count measurement decides it.
2. **Compat clone per revision, serializing live `#viewbox` DOM** (`compat.ts:16-28`). One clone per revision and cache replacement VERIFIED-IN-CODE. Whether DOM inside `#viewbox` grows across sessions (row 10 placement, row 5 `#debug`) UNVERIFIED. Revision churn (rows 4, 5, 9) raises how often this runs.
3. **Untracked program creation** (`device.ts:266`). Bypass of `track()` VERIFIED-IN-CODE. Per-load program creation UNVERIFIED. Weaker, because programs are usually created once per renderer.

Rejected as top 3: revision churn alone (VERIFIED-IN-CODE that it adds prepares, not cost per prepare); `TradeMarkers` capacity (VERIFIED-IN-CODE no time effect); slicer ports (UNVERIFIED and probably small).

## Unverified gaps (not read or not measured)

- `public/main.js` `loadMap` internals, beyond `load.ts` region `796-810` (VERIFIED from earlier read only for the tail).
- `src/io/export.ts` `prepareMapClone`: cost and whether it caches anything.
- `src/gpu/renderer.ts` `telemetry()` body: what `window.rendererStatus` (`renderer-mode.ts:254`) exposes.
- Whether `compatClone` runs on every prepare or only when compat runs (`prepare.ts:679`).
- Program creation per world load.
- `routes-creator.js` reset path for `body.innerHTML` (row 8).
- Placement of `#coordinates` relative to `#viewbox` (row 10).
- `mapHistory` payload size (row 13).
- d3-selection `.on` replace semantics (row 14).
- Autosave, dense-zoom polling, trade-animation and draw-trade-animation timers (row 19).
- Burg, marker, relief editors.
- `src/gpu/slice.ts` port2 GC retention (row 12).
- Actual live counts of tracked resources, DOM nodes, and listeners after the sequence. No measurement was taken.

## One-run in-page measurement protocol

Run once, in a fresh page, with the same integration sequence used for the 90 s vs 1.3 s comparison. Use only read-only probes. A probe that needs a new getter must be added in a separate change and is not part of this audit.

1. Baseline (step 0): record `revision`, `invalidations.count`, device tracked size, `#viewbox` descendant count, `document.body.innerHTML.length`, `mapHistory.length`, and the prepare time from telemetry (exact fields UNVERIFIED until `telemetry()` is read).
2. Load the world, then record the same fields and the prepare time.
3. Open and close the route editor, then record again.
4. Open and close the route creator, add three points, then record again.
5. Change the label font size with three input events, then record again.
6. Repeat steps 2 to 5 three times. Keep the same zoom and viewport throughout.
7. Plot prepare time against tracked size and against `#viewbox` descendant count.

Interpretation:
- If prepare time tracks tracked size with a slope of roughly n-squared, row 1 is confirmed.
- If prepare time tracks `#viewbox` descendant count (row 3) and tracked size is flat, row 3 is the cause.
- If neither moves, the 90 s is in a path not covered here (UNVERIFIED).
- If `revision` rises but prepare time per call is flat, revision churn is ruled out as the cause of the per-prepare slowdown (VERIFIED-IN-CODE mechanism, measurement UNVERIFIED).

## Notes

- All line numbers come from reads made before this report was written. They were not re-checked against a fresh checkout.
- The earlier note that `closeRouteEditor` leaves font size changed is wrong and is withdrawn (see row 9).
