# GPU curved-label correctness notes (P1)

Scope: `src/gpu/text.ts`, `src/gpu/text.test.ts`. No other files touched. Not run here (no shell); host runs vitest,
tsc and browser visuals.

## Newly native (semantics preserved)

- **`xlink:href` textPath references.** `textPathTargetId` reads `href`, then `xlink:href` (namespaced, then
  qualified name). SVG 2 precedence: a present `href` wins even if unusable. Only same-document `#id` references are
  accepted; the target must be a `<path>` with no `transform` / `pathLength` and exactly one subpath.
- **Measured letter-spacing.** Computed `letter-spacing` resolved to px is added after every code point, the last
  included (Chromium/Firefox SVG behaviour), so it enters both the text-anchor extent and the advance whose midpoint is
  sampled on the path. Glyph pen origin = sample − spaced advance / 2, i.e. the glyph sits at the start of its spaced
  cell. Negative spacing is accepted only while every advance stays ≥ 0.
- **Absolute `startOffset`** (user units / px) alongside percentages.
- **tspan `x`** as a single length: each line is a chunk starting at `startOffset + x` (previously `x` was ignored,
  so legacy `x="shift"` labels were silently misplaced). A first tspan without `x` starts at `startOffset`.

## Named fallbacks (new or now explicit; previously silently approximated)

| reason | trigger |
| --- | --- |
| `textPath reference` | no direct-child textPath, no/external/malformed href, target not a `<path>` |
| `textPath geometry` | path `transform`/`pathLength`, multiple subpaths, zero length |
| `textPath attributes` | `path`, `method`, `spacing`, `side`, `textLength`, `lengthAdjust` on textPath |
| `text positioning` / `text transform` | `x y dx dy rotate textLength` / `transform` on `<text>` |
| `tspan structure` | non-whitespace text outside textPath, any text node directly in textPath (whitespace collapses into an addressable space that shifts anchoring), non-tspan or nested children |
| `tspan positioning` | `y dx rotate textLength lengthAdjust` on a tspan |
| `tspan x` | x list/unsupported unit, or a later tspan without `x` (it would continue the previous chunk) |
| `font-size/dy` | dy list or unit other than user/px/em (previously `parseFloat` read the first number) |
| `letter-spacing` | computed value not in px, or negative spacing producing a negative advance |
| `complex text` | combining marks / variation selectors, ZWJ/ZWNJ, flag pairs, Arabic/Hebrew/Syriac/Thaana/N'Ko |
| `whitespace` | leading/trailing space, double spaces, tab/newline (SVG collapsing would change it) |
| `word-spacing`, `text-transform`, `font-variant`, `font-feature-settings`, `font-kerning`, `font-stretch`, `direction`, `writing-mode`, `baseline`, `text-decoration`, `visibility` | non-default computed value on the tspan |
| `stroke-dasharray`, `vector-effect`, `stroke-linejoin` | only when a halo is drawn; `arcs`/`miter-clip` joins |

## Other fixes

- `text-anchor` now read from each tspan's computed style (anchor of the chunk's first character) rather than `<text>`.
- Halo uses the computed `stroke-linejoin` (miter/round/bevel) and `stroke-miterlimit` instead of always round;
  atlas cell padding grows to `miterlimit × halo / 2` for miter joins; cache key includes join + limit.
  **Visible change:** default SVG join is miter, so labels without an explicit `stroke-linejoin` get sharper halos.
- `paint-order` parsed per spec (`strokeBeforeFill`): `"markers stroke"` previously drew fill first.
- Pick boxes come from the first painted pass (previously none were emitted when fill was `none`).

## Audit conclusions (unchanged, believed correct)

- dy accumulates across tspans, em resolves against the tspan's font size, applied perpendicular to the path in
  glyph-local space (= SVG's post-path dy shift).
- Glyph centring: midpoint of the advance on the path, rotation about that sample point — matches SVG textPath.
- Element/ancestor transforms are rejected by scene classification; text.ts also rejects `<text transform>` itself.

## Remaining risks for host visual check

1. Trailing letter-spacing in the anchor extent: if the engine trims it (CSS Text 4 `letter-spacing-trim`), middle
   anchored labels would be offset by spacing/2. Compare a spaced label in Chromium against GPU.
2. Ligatures: prefix measurement includes default ligatures while glyphs are drawn per code point (pre-existing).
   Browsers disable ligatures when letter-spacing ≠ 0, so spaced labels are, if anything, more exact.
3. Grapheme clusters vs code points: letter-spacing is per typographic unit; mitigated by the `complex text` fallback
   but scripts outside that list (Indic without marks, Thai) are not exhaustively screened.
4. Miter halos: canvas vs SVG miter rendering of glyph outlines may differ slightly; compare a stroked label.
5. tspan `x` inside textPath is treated as an offset added to startOffset (matches how FMG's `x="0"` + `50%` labels
   render centred). Nonzero `x` (legacy `x="shift"`) is the case to eyeball.
6. With `paint-order: stroke`, pick quads come from the halo pass, so they are slightly larger than the fill glyphs.
7. Fallback counts may rise (new honest reasons) as well as fall (xlink/letter-spacing/absolute startOffset).
