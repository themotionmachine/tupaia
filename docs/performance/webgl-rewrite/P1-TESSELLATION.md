# P1 tessellation candidate (not integrated, not production-ready)

`src/gpu/tessellate.ts` exports `tessellateFill(subpaths, evenOdd, limits?)`: a pure, conservative fast path that
turns a fill into non-overlapping triangles (one cover draw, no stencil) or returns a named refusal. The existing
stencil-then-cover fans (`appendFan`) remain the reference and must stay available; nothing calls this yet.

## Caller contract

- Input: the same `Subpath[]` given to `appendFan` (output of `flattenPath`), plus `evenOdd` from `fill-rule`.
- `{ ok: true, triangles, vertexCount, diagnostics }`: `triangles` is a `Float32Array` of `x,y` triplets (TRIANGLES,
  `vertexCount = triangles.length / 2`), in the input coordinate space, covering each filled point exactly once.
  May be empty when no subpath has ≥ 3 distinct points (the fan path also draws nothing). Draw with stencil disabled.
- `{ ok: false, reason, detail, work }`: draw the existing stencil fans unchanged. Never approximate or retry with a
  different rule. `reason` is one of `nonfinite | too-many-vertices | too-many-rings | degenerate-edge |
  degenerate-ring | self-intersection | ring-contact | budget-exceeded | triangulation-mismatch`.
- Open subpaths are implicitly closed (SVG fill semantics); exact consecutive duplicates and closing duplicates are dropped.
- Result depends only on inputs; callers may cache it per path `d` + fill-rule.

## Method

1. Normalise rings, reject nonfinite, enforce `maxVertices` (default 20000) and `maxRings` (1024).
2. Reject zero-area rings, edges ≤ `1e-9·extent`, and collinear fold-back spikes.
3. Sweep edges sorted by min x; every x-overlapping candidate pair costs one unit of `maxWork` (default 2,000,000).
   Any crossing or touching (including vertex-on-edge and collinear overlap, within `1e-12·extent²` orientation
   tolerance) refuses: `self-intersection` within a ring, `ring-contact` between rings. Near-contact is treated as contact.
4. With disjoint simple boundaries nesting is a forest. Parent = smallest containing ring (bbox prefilter + ray test of
   the first vertex, charged to the same budget). Face winding = sum of signed-area signs along the ancestor chain;
   depth = chain length. Filled faces: `depth` odd (evenodd) or `winding ≠ 0` (nonzero).
5. Each filled face (ring + direct children as holes) goes through three's bundled `Earcut` (no new dependency).
   The summed triangle area must equal `|ring| − Σ|children|` (rel. `1e-9`) else `triangulation-mismatch`.

## Limits

- Refuses (correctly falls back) on any self-intersecting, self-touching, or mutually touching rings, including
  legitimate SVG paths that share edges/vertices (e.g. adjacent cells merged without dissolve). Those keep stencil cost.
- Worst-case sweep is bounded by `maxWork`, not by n log n; dense near-vertical or long-x-span edge sets refuse with
  `budget-exceeded`. Nesting cost is `O(rings × containing-ring vertices)`, also budgeted.
- The area check detects dropped or extra area, not a hypothetical overlap exactly balanced by a gap; with validated
  simple input Earcut does not produce either. Pixel parity must still be verified by root.
- Tolerances are relative to the coordinate extent; very small features in huge coordinate spaces may refuse.
- Output is float32; T-junction-free only within one face (faces meet only at ring boundaries, which are shared exactly).
- Earcut cost is roughly linear for simple rings but degrades with many holes (hole bridging); `maxRings` caps it.
- Unverified here: test execution, typecheck of `three/src/extras/Earcut.js` import, bundle size, pixels, timings.

## Tests (`src/gpu/tessellate.test.ts`)

Grid-sampled exact single coverage vs a reference winding-number fill for: concave comb (area 280), open subpath,
opposite/same-winding holes under nonzero vs evenodd, nested islands + disjoint rings, same-direction nesting.
Refusals: bowtie, vertex self-touch, spike, crossing rings, vertex-on-edge, shared edge, duplicate ring, collinear
partial edge overlap, collinear ring, NaN, micro edge, and vertex/work/ring limits on a 2000-gon.
