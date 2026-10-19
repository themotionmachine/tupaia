# Round 2 host-load coordination — explicit user steering
The user emphasizes realistic mgm1 capacity: gates on every subagent are unnecessary and counterproductive.

- Haiku reasoning is remote; shared local builds, Chromium instances and fixtures are the bottleneck.
- Primary alone schedules expensive checks. At most ONE browser/build/full-suite gate at a time across the tree.
- Children hand over code, focused regression tests, and the exact verification they recommend. They do not each run unit/build/bench/browser gates.
- Batch integrated changes and run a shared check once. Repeat only after a relevant source change, failure, or unresolved concern.
- During implementation, use small pure tests only when primary explicitly schedules them; no competing full suites.
- Use a short debug cohort while repairing a harness; full final cohorts only when that path is stable.
- Six remote model workers do not imply six local browser/test workers.
- Do not consume tokens polling the host-lock. A busy result means defer the check to primary.
