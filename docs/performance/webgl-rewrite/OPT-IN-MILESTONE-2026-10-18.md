# Opt-in milestone — October 18, 2026

A reviewable local trial build is available after the first hardening pass. Daily-use sign-off remains incomplete: editor/large-world recovery latency and broader coverage are still open. SVG stays the default. No deployment, default flip, new agents or paid Anthropic jobs occurred.

## What changed

1. Rendering-only `?renderer=gpu` now recovers clicks against the current canonical SVG camera. Previously, recovery existed only with `gpu-select`, so a click during motion could use the old SVG position. The handler now reuses the existing SVG synchronization and native hit test with a null GPU selector. GPU index selection remains separately opt-in.
2. Save/export's class snapshot helper moved to `src/renderers/emblems/transient-classes.ts`. Default SVG save/export now loads a 594-byte shared helper instead of the 9,945-byte GPU presentation chunk. This is an emitted module boundary result, not a navigation timing claim.
3. Resync cohorts count eligible clicks rather than stopping at the required number of raw rows. The same 20-attempt budget, viewport exclusions and target assertions remain. Every attempt is preserved.

## Fresh verification

| Check | Result | Evidence under host-checks/ |
| --- | --- | --- |
| Broad Metal ALL/short, before the two product fixes | Route 10/10, marker 10/10, label 10/10; exact editor/save/export/world replacement; zero page errors | opt-in-integration-short-1792342819283982000.json |
| Rendering-only baseline | Reproduced missing click recovery hook without gpu-select; expected failure | opt-in-canonical-1792343658495458000.json |
| Final rendering-only browser diagnostic | Five editors exact once; all five edits persisted through exact save/export/load; 10 eligible label clicks recovered with zero GPU index queries; zero page errors | opt-in-canonical-1792343744563473000.json |
| Forced final fallback | SVG active; renderer and click globals cleared; GPU canvas removed | Same rendering-only report, canonicalFallback |
| Final unit suite | 770 tests / 70 files passed | opt-in-unit-1792343713326246000.log |
| Final build/typecheck | Passed | opt-in-build-1792343721769735000.log |
| Emblem contracts | All 47 source-backed browser assertions passed, including exact source/clone classes and fallback reveal | opt-in-paint-1792343735186492000.json |
| Default emitted bundle boundary | GPU presentation absent from current boot/save/export static graphs | opt-in-boundary-after-1792343734059775000.json |
| Packaged clean build | Default URL (no renderer flag), including lazy save/export imports: 0 WebGL requests, 0 GPU canvases; opt-in: active GPU frame and canonical click recovery; no missing assets/page errors | opt-in-package-default-smoke-1792344284160256000.json |

The broad short run used the frozen overnight product plus the eligible-count correction. The final product changes were then covered by unit/build, the 47 emblem contracts and the rendering-only browser diagnostic. This is not a fresh full broad-matrix acceptance result. The first boundary diagnostic failed because it also selected the unrelated JSON-export module; that raw attempt is retained, and entry discovery was corrected before the baseline/after comparison.

## Review and local trial

Use `?local&renderer=gpu` for the rendering-only candidate. Add `&gpu-select` only when explicitly reviewing experimental GPU target selection; only markers are enabled for that path. Hover during motion still follows the deferred SVG camera.

The packaged `build/` contains the current emitted assets plus all public assets. Historical hashed files left in the working dist directory are excluded by the fresh build log's emitted-file list. A manifest records every packaged build file and hash.

From the extracted package directory:

```sh
python3 -m http.server 8123 --bind 127.0.0.1 --directory build
```

Open `http://127.0.0.1:8123/?local&renderer=gpu`. This static server has no shared-map write backend. Open a local map copy, edit and save it locally; reopen that saved copy under `?local&renderer=svg` for comparison. The implementation checkout remains isolated from the original repository and production.

Review first: `src/gpu/renderer.ts` (click recovery installation), `src/gpu/editor-dispatch.ts` (null selector), `src/renderers/emblems/transient-classes.ts` (one shared snapshot store), `src/io/save.ts` and `src/io/export.ts` (canonical restoration). New unit cases cover rendering-only resync/current/drop behavior, absent versus empty classes, author edits and ownership release.

## Remaining work

- Route editor resumes were previously about 6–10 seconds. The 100k Metal loss-to-first-draw recovery was 8.84 seconds; the shared 42-emblem case was 642 ms. This pass does not claim to improve these timings or meet the 2-second/500-ms goals.
- Route open/close legitimately adds/removes cell overlays and debug controls. Ignoring them would hide real app behavior. The next optimization must measure and reuse unchanged work while preserving actual edits, world/cache/context invalidation and fallback.
- The short integration cohorts now have sufficient samples. Full 50-click integration and the wider picking/visual-reference matrix still require completion. Route undo remains a legacy untested capability: the existing undo controls belong to heightmap editing.
- The overnight ten-pair wheel evidence remains preserved: 8.45 ms versus 50 ms median per-arm frame p95 on one M1 Max Metal/DPR2/100k cohort. It was not rerun here and is not universal latency evidence.
- Primary source review and targeted checks are complete for this pass; no independent reviewer or new agent was launched.

## Preservation and accounting

The immutable checkpoint1008 remains the cumulative baseline (SHA256 f0c23ddceb4cd996eaf9035cb8cda7386679c75909eddb265fff26e7c4070a2d). The new package includes it, current changed sources, the current compiled build, machine state, receipts and raw attempts. Restore source according to the baseline archive instructions, then apply the authoritative current files in this package; build/ can be served directly.

Anthropic ledger remains $187.163099925 before credits, including the last native tranche's $4.890784875; reserve $0. New paid jobs: zero. Astra uses remain 2/2 from overnight, with zero new uses. The old heartbeat remains paused. Production 89902648-220c-40b8-8462-dce2bfed06d6 and SVG default are unchanged.
