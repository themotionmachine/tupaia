// tupaia-mcp: two load-time data integrity repairs from src/io/load.ts, moved here so they can be
// tested, each with an upstream bug fixed:
// - cells of an invalid culture are reset to culture 0 (upstream reset their province instead,
//   leaving the invalid culture on the cells and wiping valid provinces);
// - a state's capital repair keeps state.capital in step with the burg it promotes or keeps
//   (upstream promoted the first burg of a capital-less state without setting state.capital, and
//   of several capitals kept the first even when state.capital named another).

interface CellsLike {
  i: ArrayLike<number> & Iterable<number>;
  culture: { [k: number]: number } & ArrayLike<number>;
}

interface CultureLike {
  removed?: boolean;
}

/** Reset cells whose culture does not exist (or was removed) to culture 0; returns the invalid ids. */
export function repairInvalidCultures(cells: CellsLike, cultures: ArrayLike<CultureLike | undefined>): number[] {
  const invalid = [...new Set(Array.from(cells.culture))].filter(c => !cultures[c] || cultures[c]?.removed);
  if (!invalid.length) return invalid;
  const bad = new Set(invalid);
  for (const i of cells.i) if (bad.has(cells.culture[i])) cells.culture[i] = 0;
  return invalid;
}

interface BurgLike {
  i?: number;
  state?: number;
  capital?: number | boolean;
  removed?: boolean;
}

interface StateLike {
  i: number;
  capital?: number;
  removed?: boolean;
}

export type CapitalRepair =
  | { state: number; kind: "neutral"; demoted: number[] }
  | { state: number; kind: "multiple"; kept: number; demoted: number[] }
  | { state: number; kind: "none"; promoted: number };

/**
 * One state's capital checks: Neutrals hold no capitals; of several capitals the one state.capital
 * names (else the first) stays and state.capital names it; a state with burgs but no capital gets
 * its first burg as capital and state.capital names it. changeGroup re-groups a burg whose capital flag
 * changed (Burgs.changeGroup(burg, null) in the app). Returns what was repaired, or null.
 */
export function repairStateCapital(
  state: StateLike,
  burgs: BurgLike[],
  changeGroup: (burg: BurgLike) => void
): CapitalRepair | null {
  if (state.removed) return null;
  const stateBurgs = burgs.filter(b => b.state === state.i && !b.removed);
  const capitalBurgs = stateBurgs.filter(b => b.capital);

  if (!state.i && capitalBurgs.length) {
    for (const burg of capitalBurgs) {
      burg.capital = 0;
      changeGroup(burg);
    }
    return { state: state.i, kind: "neutral", demoted: capitalBurgs.map(b => b.i as number) };
  }

  if (capitalBurgs.length > 1) {
    const keep = capitalBurgs.find(b => b.i === state.capital) ?? capitalBurgs[0];
    const demoted: number[] = [];
    for (const burg of capitalBurgs) {
      if (burg === keep) continue;
      burg.capital = 0;
      changeGroup(burg);
      demoted.push(burg.i as number);
    }
    state.capital = keep.i;
    return { state: state.i, kind: "multiple", kept: keep.i as number, demoted };
  }

  if (state.i && stateBurgs.length && !capitalBurgs.length) {
    const capital = stateBurgs[0];
    capital.capital = 1;
    changeGroup(capital);
    state.capital = capital.i;
    return { state: state.i, kind: "none", promoted: capital.i as number };
  }

  return null;
}
