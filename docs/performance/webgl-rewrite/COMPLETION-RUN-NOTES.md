# Completion run 2026-10-16: lead checkpoint notes

The run is finished. The final report is `COMPLETION-RUN-2026-10-16.md`, with `completion-run-status.json` and
`REVIEWER-README.md` alongside it.

## Done
- **Dialog-scan cache.** In `renderer.ts`, the editorReason dialog scan is cached behind a MutationObserver and
  drained with `takeRecords()` per query (`dialogScans` telemetry).
- **Editor dispatch adapter.** `src/gpu/editor-dispatch.ts` is wired through the `clicked()` hook in `editors.js`.
  It is default-off (`&gpu-select`), and `READY_KINDS = ["marker"]`.
- **Recovery listener.** A capture-phase listener with a live `#map` lookup handles stale-view clicks on the
  background.
- **pickStatus.** It reports a dialog-open suspension before staleness.
- **Integration harness.** `bench/renderer-integration.ts` covers the editors, the save/export roundtrip, the
  resync cohort and the marker cohort.
- **Final checks** on the frozen source: unit, bench, build, lifecycle, context, navigation, integration, and
  all 8 picking cells (DPR 1/2 × zoom 2/4 × compact/materialized).

## Children (Haiku 5.5)
- A: the dash contour measure (`compat-pick.ts`, `dash-measure.ts`). Integrated.
- B: a read-only exploration of `clicked()`, the editors, save/export and the harness bootstrap. No code.
- C: zoom-4 marker extras and wrong rows (`markers.ts`, `pick.ts`). Integrated.

## Not done (see report section 7)
- The labeled ≥ 50-per-kind fixture.
- The paired 10-pair timing comparison.
- Locating the artifact for the final timing check.
