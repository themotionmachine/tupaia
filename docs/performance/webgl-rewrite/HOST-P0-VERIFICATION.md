# Host verification after P0

304 tests /38 files pass; 18 benchmark node tests pass; strict project TypeScript and CF_BUILD production build pass. Project formatter applied to the four new renderer source/test files.

Host corrected legacy fixture section count (40; current shared map 46), awaited actual async binary-map encode/section/text APIs, and made the global test Node stub callable so Vitest containment assertions work. No map IO implementation was changed.

Both demo.map and real shared-v8 map SVG sections shadow-parse/serialize byte-identically. Shared map contains 9 existing duplicate IDs; these remain untouched. Full legacy migration corpus is still a release gate.

Read-only Metal/Apple M1 Max navigation on baseline and P0 verifies modelUnchanged and settledExact. Wide-pan median iteration p95 frame:25ms both; callback26.4 baseline/23.0 P0. No speed gain claimed. Formal comparator refuses old baseline lacking rendererStatus; descriptive report retains that limitation. Historical ±10% reproduction is not established: host cadence differs and no100k test has run in P0. This does not prevent building an opt-in P1 proof behind SVG default, but G1 requires current paired measurements and fidelity before further migration.

API usage P0 $4.28965105; including ideation $12.134646895. No deployment. Dependencies, build and test caches are isolated.
