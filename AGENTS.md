Tupaia is Ryan Williams's fork of Azgaar's Fantasy Map Generator (FMG), deployed as a shared collaborative map at map.activationlayer.org (see `cloudflare/README.md`). FMG is a web application for procedurally generating, editing, and visualizing fantasy maps. Before making architectural decisions, read the `CONTEXT.md` file in the root.

For deeper knowledge, consult the `docs/` directory, especially `docs/domain/glossary.md`, `docs/architecture/architecture.md` and `docs/architecture/data_model.md`.

For the active completion round, follow ROUND2-HOST-COORDINATION.md: primary owns one serialized shared gate queue; children must not run a gate per task. This is explicit user steering.
