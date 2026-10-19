# GPU renderer candidate — current review guide

This is an experimental local trial candidate. SVG remains canonical and default; no deployment has occurred. Daily-use sign-off is incomplete.

## Current evidence

Read [OPT-IN-MILESTONE-2026-10-18.md](OPT-IN-MILESTONE-2026-10-18.md) first for the latest source changes, exact fresh gate scopes, local build instructions and open work.

Then read [OVERNIGHT-RESULTS-2026-10-18.md](OVERNIGHT-RESULTS-2026-10-18.md) for the cumulative navigation, recovery, lifecycle and accounting evidence. Earlier route-state/recovery and phase reports are historical; their 90-second full-suite stalls and earlier shortfalls do not describe every current result.

## Opt-in behavior

- No renderer flag: SVG; no WebGL probe or GPU backend allocation.
- ?local&renderer=gpu: GPU rendering with canonical SVG click recovery. GPU selection is never queried by this click path.
- Add &gpu-select: experimental GPU target selection, currently enabled only for markers; unready kinds synchronize and re-hit-test canonical SVG.
- Save and export use canonical SVG. Failed GPU rendering falls back to SVG.
- Hover during motion still follows the deferred SVG camera.

## Source review

- src/gpu/renderer.ts: camera, prepare, recovery, editor suspension, click recovery and teardown.
- src/gpu/editor-dispatch.ts and tests: canonical recovery with null selector; separately gated ready-kind routing.
- src/renderers/emblems/transient-classes.ts and tests: shared canonical class snapshots without GPU dependencies.
- src/io/save.ts and src/io/export.ts: exact clone restoration and serialization.
- src/gpu/emblem-culling.ts / emblem-paint.ts: opaque-cover qualification, observed invalidation and restoration.
- src/gpu/compat-assets.ts / compat-pick.ts / prepare.ts: raster dependency closure, exact restoration and batched geometry reads.
- bench/renderer-integration.ts: canonical integration harness; owned native diagnostic is bench/direct-integration-metal-local-init.ts.
- bench/renderer-bundle-boundary.ts: emitted static graph check.

## Remaining sign-off work

Editor/100k context recovery still takes seconds; full 50-click integration, wider picking/visual-reference coverage and independent review remain. Short diagnostic success does not complete rewrite acceptance. Route undo has no document-level implementation in the legacy editor.

The current compiled local build and cumulative source/evidence are preserved in TUPAIA-OPT-IN-REVIEW-2026-10-18.zip. See the milestone report for how to serve it.
