# P2 — SVG-vs-GPU fidelity: compat refine order and per-dash linecaps

Scope: isolated tree only. Nothing is deployed. Production stays on the frozen P1
`ad4f0bf6-2b07-4142-ac9f-a585a645fb98`. SVG stays the default renderer and GPU
stays opt-in. No budget, harness, tool-config, dependency, file-format or test/e2e
changes. Context stays `alpha:true, antialias:true` (4 samples in every run).

All artifacts are under `docs/performance/webgl-rewrite/host-checks/` with the
prefix `p1-delegated-`.

**The G-C fidelity gate is not met.** over16 fails at 4 of the 8 smoke configs,
and the worst case is DPR2 z1 at 2.57%. The harness does not compute SSIM, so no
SSIM figure is claimed. It also does not report the fraction of pixels with
delta > 44, so the "≤ 0.5% at delta ≤ 44" gate can't be evaluated. over16 is a
stricter stand-in for it: every pixel with delta > 44 is also over 16.

## Outcome

| Metric (DPR2 z1, worst config) | Baseline | After |
|---|---|---|
| over16Fraction | 0.026714 (`1792114036819682000`) | **0.025703** (`1792114674340152000`) |
| maxDelta | — | 221 |
| changedFraction | — | 0.186 |
| Peak tracked GPU memory | — (cap 167772160) | 159378993 |
| compat resolution | — | 0.637 |

That is a 3.8% relative improvement, which is real but small. Most of the
remaining error is not in the two items fixed here (see Blockers).

## Items (pattern → evidence → change → test)

### 1. Settle compat refinement spent its budget on large surfaces first (verified)
- **Pattern:** `refineCompat` raises compat raster density inside
  `budget − DETAIL_RESERVE`. It walked runs in document order, so large early
  runs could use up the headroom before small dense runs (labels, icons) were
  reached. Those small runs are where SVG differences are most visible.
- **Evidence:** code reading of `refineCompat` (document-order loop). DPR2 z1
  over16 was 0.026714 before the change. The new `compat.detail` telemetry is
  emitted, but none of the archived host-check artifacts contain it, so I can't
  cite per-run densities.
- **Change:** `refineOrder` in `src/gpu/budget.ts` puts the smallest visible area
  first. `src/gpu/prepare.ts` `refineCompat` now uses it and emits
  `compat.detail`. The budget, reserve and caps are unchanged.
- **Test:** 2 unit tests in `budget.test.ts`. DPR2 z1 over16 went to 0.025790
  (`1792114316589813000`). Peak stayed below 160 MiB.

### 2. Dashed strokes ignored stroke-linecap on each dash (verified, small gain)
- **Pattern:** SVG applies `stroke-linecap` to every dash, not only to subpath
  ends. The stroke fragment shader discarded every gap fragment, so dashed
  routes with round or square caps rendered short, butt-ended dashes.
- **Evidence:** with the routes layer isolated (diagnostic only), DPR2 z1 over16
  was 0.005171.
- **Change:**
  - `src/gpu/geometry.ts` adds `capCode` (shared with `appendStrokeCaps`) and
    `dashCovered`, a CPU mirror of the shader test.
  - `src/gpu/shaders.ts` keeps a gap fragment if it lies within `u_capReach` of
    the nearest dash end: a linear test for square caps, a disc test for round.
  - `src/gpu/framegraph.ts` sets `u_dashCap` and `u_capReach`. For hairline round
    caps (under 1 physical px) it uses a linear reach of π/4·w/2, which matches
    the area of the round cap.
  - `src/gpu/prepare.ts` passes `dashCap` per batch.
- **Test:** a `dashCovered` block (2 tests) in `geometry.test.ts`. With routes
  isolated, over16 went from 0.005171 to 0.005079. The full scene went from
  0.025790 to 0.025703. Hatch passes at DPR1 and DPR2, and navigation passes at
  DPR2 (this item changed the stroke shader).

## Diagnostic layer isolation (DPR2 z1, smoke `layer=`, not acceptance)

| Layer | over16 | Note |
|---|---|---|
| labels | 0.005090 | compat text raster |
| routes | 0.005171 → 0.005079 | maxDelta 223; hairline AA |
| borders | 0.002250 | maxDelta 135; hairline AA |
| markers | 0.001931 | compat `<svg>` raster |
| icons | 0.000442 | |
| provs, ocean, terrain, biomes, coastline | ~1e-5 each | negligible |

The isolated layers add up to about 1.5%, but the full scene is 2.57%. Isolation
is nonadditive. The full scene is limited by budget: compat resolution is 0.637
at DPR2 z1 and z2, and runs blend over each other. The artifact IDs for these
isolation runs were not kept for this report. Only the full-scene artifacts
below count as evidence.

## G-C table (full scene, all 8 smokes)

Gate: over16 ≤ 1%. SSIM was not computed. delta ≤ 44 could not be evaluated.

| DPR | Zoom | Artifact | over16 | Gate | maxDelta | changed | Peak | compat res |
|---|---|---|---|---|---|---|---|---|
| 2 | 1 | `1792114674340152000` | 0.025703 | **FAIL** | 221 | 0.186 | 159378993 | 0.637 |
| 2 | 2 | `1792114688233625000` | 0.012466 | **FAIL** | 243 | 0.168 | 159380293 | 0.636 |
| 2 | 4 | `1792114695566544000` | 0.007908 | pass | 237 | 0.154 | 155087005 | 0.893 |
| 2 | 8 | `1792114702929375000` | 0.002084 | pass | 158 | 0.130 | 137195593 | 0.582 |
| 1 | 1 | `1792114709514045000` | 0.013214 | **FAIL** | 137 | 0.139 | 132196081 | 0.568 |
| 1 | 2 | `1792114715513528000` | 0.007592 | pass | 113 | 0.136 | 130441389 | 0.921 |
| 1 | 4 | `1792114721649987000` | 0.011817 | **FAIL** | 125 | 0.132 | 127756549 | 1.035 |
| 1 | 8 | `1792114727834228000` | 0.002746 | pass | 158 | 0.107 | 123240757 | 0.995 |

Every smoke has peak ≤ 167772160, alpha and antialias on with 4 samples,
preparesWhileMoving 0, swapDrops 0 and prepares 1.

## Review

The optional Haiku review was **skipped** to stay within the $8 slice budget.
Correctness rests on the unit tests above (the CPU mirror `dashCovered` follows
the shader branch for branch) and on the serialized host checks.

## Rejected root causes

- **Dash phase reset per subpath:** `appendSegments` already restarts the
  distance at 0 for each subpath, which matches SVG. No change.
- **Coastline, ocean, terrain, biomes, provinces:** about 1e-5 over16 each when
  isolated. Not a meaningful source.
- **Raising the budget or lowering resolution to fit:** prohibited, and not
  attempted.

## Check matrix

| Check | Artifact | Result |
|---|---|---|
| unit | `1792114573841578000` | 558/558 (was 554) |
| build | `1792114578277601000` | ok; renderer chunk 104.77 kB (was 103.73 kB) |
| bench | `1792114672825943000` | 20/20 |
| smoke × 8 | see G-C table | exit 0, failure null; over16 fails 4/8 |
| hatch DPR1 | `1792114773129636000` | failure null; maxDelta ≤ 1, over16 0 at every zoom and pan; noReprepare true |
| hatch DPR2 | `1792114822186526000` | failure null; maxDelta ≤ 1, over16 0; noReprepare true |
| navigation DPR2 | `1792114831078710000` | failure null; preparesWhileMoving 0/0 and swapDrops 0 in every run; peak 204850141 (≤ 268435456) |
| context | `1792114899598053000` | failure null; restore 596.9 ms (was 607.3 ms); peak 159380293 |
| lifecycle | `1792114910423023000` | failure null; heap growth 42291544 B ≈ +42.29 MB (was +42.27 MB) |

All checks ran one at a time.

- **Memory:** steady peak ≤ 159380293 and navigation peak 204850141, both within
  the 160 MiB steady and 256 MiB peak caps.
- **Navigation:** no prepare started or committed while the camera was moving,
  in any run.
- **Semantic edits:** none lost. The editor and SceneDocument were not touched.

## Blockers

- The G-C over16 gate fails at DPR2 z1 (2.57%), DPR2 z2 (1.25%), DPR1 z1 (1.32%)
  and DPR1 z4 (1.18%).
- SSIM is not computed by the harness, and the delta ≤ 44 fraction is not
  reported. Full G-C acceptance cannot be shown even where over16 passes.
- The rewrite is **not** complete.

## Next slice

1. **Hairline stroke AA vs SVG** (routes and borders, about 0.7% combined when
   isolated, maxDelta up to 223). Compare SVG's coverage-based hairline against
   the halfWidth 0.5 alpha-scaled quad with MSAA, and try analytic edge coverage
   in the stroke shader.
2. **Compat resolution under budget pressure at DPR2 z1/z2** (0.636–0.637).
   Reduce the base compat footprint instead of raising the budget, for example
   by moving more labels to native glyphs.
3. **Compat label and marker rasters** (about 0.5% and 0.2% when isolated).
