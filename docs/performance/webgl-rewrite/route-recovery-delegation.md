# Route recovery ($20 chunk, 2026-10-17): delegation record

Lead: Opus 5.5 (integration, decisions, every check). Children: native Haiku 5.5 only, ≤6 concurrent, no recursion,
no checks (host coordination: the primary alone runs one build/browser/suite check at a time).

| Child | Kind | Task | Files | Outcome | Integration |
| --- | --- | --- | --- | --- | --- |
| C | implementation | Defer GPU prepare while an editor suspends a frame-holding renderer; resume on close | `src/gpu/motion.ts`, `src/gpu/motion.test.ts`, `src/gpu/renderer.ts` | Delivered `prepareStart` "suspend", `prepareStale` "suspended", `suspendWanted` + `resume()` | Reviewed line by line by the primary; kept |
| E | adversarial review (read-only) | Attack the suspend deferral: stuck flags, stale frames, loops, world replacement, dialogs | — | No logic bug in `motion.ts`; flagged minimap dialog counts as editor (design), `takeRecords` drain (already handled at `renderer.ts:720`), `customization` without observer (stall-until-interaction only), model gap in `motion.test.ts` | Model gap fixed by the primary (`suspend` records wanted) + new case "revision while an editor is already open"; minimap/customization recorded as known limits |
| F | diagnosis + fix | Compat fallback "missing #debug for <g> #controlPoints" seen in the BEFORE run | `src/gpu/prepare.ts` (+ test) | Correct cause: the compat clone was built without `#debug`, where editors draw overlays. Made no edit | The primary wrote the fix (`compatClone` passes `{debug: true}`, `src/gpu/compat.ts:21`) and the test (`src/gpu/compat.test.ts`) |
| G | diagnosis (read-only) | 10.9 s single long task when the route editor turns `#cells` on at k=8 | — | Ranked `context.stroke()` as the likely cost | Measurement disagreed: the path build loop took 10632 ms and stroke 1 ms. The primary added the exact-geometry raster cache and the `cells-mesh:*` measures, then built the path as one `Path2D` string (path 37 ms). Files: `src/renderers/cell-mesh-canvas.ts` (+ test) |
| H | diagnosis (read-only) | Why every prepare phase is ~10× slower in the full suite's route cohort than in route focus | — | See the report, section 6 | Hypotheses only; nothing integrated |

Every check was run by the primary, one at a time. No child ran a check.
