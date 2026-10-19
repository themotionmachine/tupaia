# Zone hatch scaling fix

Zone hatching previously used map-unit spacing, making the stripes and dots grow with camera zoom. The renderer now uses private per-map pattern copies with inverse camera scaling. Canonical patterns, their colors/angles/geometry, the color picker and `pack.zones` remain unchanged. Plain colors and non-local or unsupported pattern references retain existing behavior.

The helper caches zone fills and pattern copies, drains synchronous mutation records, handles inherited pattern definitions and normalized CSS URLs, and performs no writes when scale/content is unchanged. Manual zone-assignment group/polygon fills are supported. Saved maps and full-map exports restore original references and remove temporary patterns; viewport exports retain the visible density with temporary metadata removed.

Six focused tests cover scaling, rotations/dots, inherited definitions, picker preservation, normalized inline fills, changed colors, root replacement, unchanged-frame work and save/export cleanup. All 249 app tests pass with one Vitest worker; an initial parallel run hit CPU-contended timeouts in existing tests, and no timeout thresholds were changed. Production build and TypeScript checks pass.

A browser loaded the actual shared map and measured the red hatch pitch at 1×, 2×, 4× and 8×: 6 pixels at each level. Canonical definitions and zone records remain unchanged; saved SVG contains no temporary pattern data. Full-map and viewport export normalization passes, and the rendered image was visually inspected.

Deployed 2026-10-11: Worker version `3363d6de-a866-43bb-9402-c4ade2fa35c7`. Previous rollback version: `96603d0c-2785-4406-a5cb-432a3550a954`. Live entry `/index-ewavl04_.js`, `main.js` and `modules/ui/layers.js` match the built hashes. Live browser verification confirms 6-pixel pitch at all four zoom levels, clean saving and zero page errors. Shared map remains version 8; API writes were blocked during verification.
