# Overnight Tupaia optimization — October 18, 2026

The isolated candidate substantially improves native wheel navigation while preserving canonical SVG hits and visible fallback. It remains unshipped, SVG remains the default, and the rewrite is not fully accepted.

## Final native navigation evidence

Ten interleaved ON/OFF pairs on the ordinary lazy-materialized 100k generated-world wheel cohort, M1 Max Metal, DPR2:

- Median per-arm frame p95: **8.45 ms ON vs 50 ms OFF**. ON range 8.4–8.8 ms.
- Median per-arm event-to-next-rAF p95: **25.2 ms ON vs 126.45 ms OFF**.
- All 20 arms have identical world and exact materialized-COA hashes: 403 definitions, 1,291 deferred empty uses, 5,189,316 bytes. No charge/page errors; full GPU presentation, zero prepares during motion, exact final camera.
- OFF retains the earlier offscreen culling; this comparison isolates the new motion paint suppression.
- First-event outliers remain: worst ON event-to-next-rAF 180.1 ms and frame 50.1 ms. These are injected browser events, not physical input-to-photon measurements. This is one cohort, not the full renderer matrix.

Raw results: host-checks/direct-final-native-ten-pairs-summary.json.

## Changes and correctness

- Consolidated duplicate live COA styles while retaining standalone embedded styles; batched export cloning/inlining and detached export clones before async asset waits.
- Added conservative offscreen native-emblem culling only beneath an opaque GPU frame. Visible SVG and fallback restore exact source classes.
- Added guarded motion-only native emblem paint suppression. Native painted-shape hit targets remain active; canonical scene/pick reads restore owned presentation synchronously.
- Pruned only provably unused generated COA definitions in isolated raster clones, following descendant/transitive/duplicate-ID dependencies and failing closed for unknown content.
- Batched adjacent compat roots before native geometry reads, restoring every class in finally before any yield. A matched native trace reduced the second prepare scene phase from 4,693 to 2,019 ms and layout from 2,832 to 184 ms; the first compositing-heavy camera did not improve.
- Restored preexisting preserveAspectRatio exactly after raster clone serialization, including failure.

Validation: 763 unit tests / 69 files passed after batching; fresh final build passed. Real-browser source contracts: 47 culling/paint, 25 definition/raster restoration, and 13 actual SVG batch geometry/restoration assertions passed. Actual moving proof checked 4,068 points / 741 emblem hits with zero exact native target mismatches, unchanged GPU canvas/source markup, and visible context-loss fallback.

The unchanged fixed route/fixture/short functional gate passed all five editor identities, persisted edits, header-time-masked save text and exact exported SVG, world replacement and zero page errors. Batch run integration-1792312738599540000.json: route resume 5,987 / 10,135 / 9,924 ms; the 2-second target remains unmet. The aspect-ratio repair afterward passed the final build and 25 browser assertions.

## Unfinished work and measurement boundaries

- The fixed integration launcher uses **SwiftShader Vulkan software rendering**. Native navigation uses **Apple M1 Max Metal**, verified through WebGL adapter queries. Broad software ALL/short timed out at 900 seconds during repeated robust route target search, not one hung operation.
- The first owned Metal ALL/short run completed ten eligible route resyncs and ten correct routed marker clicks, but failed overall on a localStorage page error. A controlled reproduction traced that exact error to the harness init script writing storage in a blocked foreign iframe's opaque chrome-error document. Restricting only the owned init script's writes to the local app origin preserved autosave0 and eliminated the error. No product code, functional assertion, network block or page-error failure rule was changed.
- The final owned Metal ALL/short run completed with zero page errors, five editors and exact roundtrip. Route resync was 10/10 eligible PASS; marker routing was 9/10 eligible UNDERCOVERED and label resync8/10 UNDERCOVERED. Earlier marker10/10 success remains a separate run. This is **not full acceptance**. The original fixed SwiftShader gate remains unchanged. Route undo is untested because there is no document-level route undo.
- Actual Metal 100k context recovery remains **8,835.9 ms**, with a 7,819.7 ms committed prepare. Scene 3,227 ms; clone 1,133; screen rasters 916; world rasters 2,542. CPU profiling showed predominantly native work. The 500 ms recovery target is unmet.
- Safe definition pruning preserved actual raster pixels: 1,694 to 1 definition / 18.116 to 0.806 MB in a full-assets sample; a partial-assets sample retained 468 definitions / 6.338 MB with zero changed pixels at both measured sizes. This does not imply universal GPU-vs-SVG pixel identity.
- Visible-SVG pruning/culling, removing legitimate animations and speculative cross-context bitmap caches were not adopted. A preparation/refinement paint extension produced insufficient gain and remains diagnostic only.

## Final lifecycle evidence

After the new persistent paint owner was added, a fresh 20-reload / 21-snapshot Metal lifecycle check explicitly materialized all42shared-world COAs on every cycle and exercised qualified paint on/off. Every snapshot retained42definitions/42tracked/40culled, restored paint at rest, and exactly4head style elements. Steady tracked GPU memory settled at137,197,381bytes; lifetime peak197,568,749bytes remained under256MiB.

Forced-GC JS heap increased35.5MB on the first reload, then1,646,372bytes from cycle2 to20, with a near-flat tail. This is not zero heap growth or a universal leak guarantee. The final shared-world context restore returned ACTIVE in641.9ms, still above500ms. Raw evidence: host-checks/direct-final-paint-lifecycle-1792316620844545000.json.

## Accounting and deployment

Native $10 tranche: **$4.890784875**, session 7003f36f-6b6c-43cd-9dbb-9418945ac5e9, including native Haiku. Cumulative Anthropic reported usage **$187.163099925 before credits**, outstanding reserve $0. Reconciled once. No additional Anthropic jobs overnight. Astra used **2 of 2**.

No overnight deployment or default flip. Production 89902648-220c-40b8-8462-dce2bfed06d6 and original /Users/mgm1/Desktop/code/vespucci remain untouched. Hard stop: October 18, 10:45 UTC / 6:45 a.m. EDT.


2026-10-18T10:45:55.628435+00:00 Authorized overnight window ended. Heartbeat PAUSED via app; all configuration fields except status/updated_at preserved and verified locally. No active implementation/gates; source frozen10:14UTC, local code/evidence ZIP1008 verified. No deployment/default flip/new Anthropic jobs. Total187.163099925 beforecredits,lastnative4.890784875inclHaiku,reserve0,Astra2/2. Rewrite acceptance remains incomplete; see OVERNIGHT-RESULTS. Await new user authorization.
