# Overnight improvement loop — October19

User-authorized directperformance/UX work through6amEDT; approved candidate deployment first. See control/overnight-improvement-state-20261019.json for authoritative status and Astra ledger. No new Anthropic jobs.

## Deployment
Exact approved candidate ZIP 9af9bcfee57312ffb2965996aa59e058112c34564f19faaa0180270af9951f51 deployed as Worker 5224b113-4840-48e6-b5a5-9ca1a14e431e at23:39UTC. Production verification production-opt-in-20261018-1792366889554530000 PASS: hashes match; default SVG zero WebGL; both GPU modes current/visible/covered; exact marker editor once; no page errors or writes; shared metadata unchanged. SVG remains default. Subsequent changes are isolated.

## First isolated improvements (23:52UTC checkpoint)
- Batched clone resolution: per-call parent indexes preserve exact scalar identity/error semantics, duplicate IDs, anonymous ordinals and transient refusal. No cache survives rasterization/mutations. Independent Astra review found no blocker; added two suggested edge cases.
- Matched native Apple M1 Max Metal/DPR2/100k diagnostic: frozen baseline prepare7820.1ms/loss→draw8884.9ms; clone-only prepare7432.9ms/loss→draw8382.7ms. One pair, not acceptance. Same660 approved assets matched baseline; extra unreferenced stale dist files recorded in immutable manifest. Profiler window includes refinement; navigation timings deliberately invalid.
- User pure-navigation steering revealed unused eager picking: renderer=gpu never queriesGPUindex, yet built it. Rendering-only mode now skips hit-geometry construction; canonicalSVGcamera recovery/editor dispatch retained. gpu-select keeps eager exact selection. Independent Astra source review found no product blocker. Native comparison pending.
- Cmd/Ctrl-K palette integrated: settlements/states/routes, canonicalzoom, guarded label/route actions, keyboard/IME/focus/world invalidation. Build+typecheck and782tests/71files PASS; real browserUX pending.
- First canonical attempt preserved: actual five editors opened once, five edits persisted, exact save/export/load,10eligible stale-label resyncs,0pageerrors. Overall FAIL because old harness asserted rendering-only GPUindex availability. Corrected only mode-specific expectations; selection parity now explicitlyrequests gpu-select. All editor/persistence/coverage/errorassertions preserved. Rerun pending.

## Navigation-only GPU preparation measurement
Native Apple M1 Max Metal/DPR2/100k, same fixture and diagnostic, failure=null/errors=[]: presentation-only prepare6672.6ms, scene2497.6ms, loss→draw7683ms. Clone-only prepare7432.9ms/scene3234ms. Combined initialbaseline7820.1→6672.6ms (~14.7%) across single sequential runs. Context loss fallback/current recovered draw passed. Still far from500ms recovery target; not acceptance or navigation gesture timing. Core rendering/animations retained.
