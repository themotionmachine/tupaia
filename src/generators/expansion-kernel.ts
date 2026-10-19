import { ExpansionQueue } from "./expansion-queue";
export interface ExpansionCells {
  i: ArrayLike<number>;
  c: (number[] | Uint32Array)[];
  h: ArrayLike<number>;
  biome: ArrayLike<number>;
  f: ArrayLike<number>;
  r: ArrayLike<number>;
  fl: ArrayLike<number>;
  t: ArrayLike<number>;
  s: ArrayLike<number>;
  area: ArrayLike<number>;
  pop: ArrayLike<number>;
  state: Uint16Array;
  culture: Uint16Array;
}
export interface ExpansionCulture {
  i: number;
  center?: number;
  type: string;
  expansionism?: number;
  lock?: boolean;
  removed?: boolean;
}
export interface ExpansionState {
  i: number;
  center: number;
  capital: number;
  culture: number;
  type: string;
  expansionism: number;
  lock?: boolean;
  removed?: boolean;
}
export interface ExpansionInput {
  cells: ExpansionCells;
  states: ExpansionState[];
  cultures: ExpansionCulture[];
  burgs: { cell: number }[];
  features: { type: string }[];
  biomeCosts: number[];
  growthRate: number;
  statesGrowthRate: number;
  neutralRate: number;
}
const minmax = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
export function expandStates(input: ExpansionInput): Uint16Array {
  const cells = { ...input.cells, state: input.cells.state.slice() };
  const { states, cultures, burgs } = input;
  function getBiomeCost(b: number, biome: number, type: string) {
    if (b === biome) return 10; // tiny penalty for native biome
    if (type === "Hunting") return input.biomeCosts[biome] * 2; // non-native biome penalty for hunters
    if (type === "Nomadic" && biome > 4 && biome < 10) return input.biomeCosts[biome] * 3; // forest biome penalty for nomads
    return input.biomeCosts[biome]; // general non-native biome penalty
  }

  function getHeightCost(f: { type: string }, h: number, type: string) {
    if (type === "Lake" && f.type === "lake") return 10; // low lake crossing penalty for Lake cultures
    if (type === "Naval" && h < 20) return 300; // low sea crossing penalty for Navals
    if (type === "Nomadic" && h < 20) return 10000; // giant sea crossing penalty for Nomads
    if (h < 20) return 1000; // general sea crossing penalty
    if (type === "Highland" && h < 62) return 1100; // penalty for highlanders on lowlands
    if (type === "Highland") return 0; // no penalty for highlanders on highlands
    if (h >= 67) return 2200; // general mountains crossing penalty
    if (h >= 44) return 300; // general hills crossing penalty
    return 0;
  }

  function getRiverCost(r: number, i: number, type: string) {
    if (type === "River") return r ? 0 : 100; // penalty for river cultures
    if (!r) return 0; // no penalty for others if there is no river
    return minmax(cells.fl[i] / 10, 20, 100); // river penalty from 20 to 100 based on flux
  }

  function getTypeCost(t: number, type: string) {
    if (t === 1) return type === "Naval" || type === "Lake" ? 0 : type === "Nomadic" ? 60 : 20; // penalty for coastline
    if (t === 2) return type === "Naval" || type === "Nomadic" ? 30 : 0; // low penalty for land level 2 for Navals and nomads
    if (t !== -1) return type === "Naval" || type === "Lake" ? 100 : 0; // penalty for mainland for navals
    return 0;
  }

  cells.state = cells.state || new Uint16Array(cells.i.length);

  const queue = new ExpansionQueue<{ e: number; p: number; s: number; b: number }>();
  const cost: number[] = [];

  const growthRate = (cells.i.length / 2) * input.growthRate * input.statesGrowthRate;

  // remove state from all cells except of locked
  for (const cellId of Array.from(cells.i)) {
    const state = states[cells.state[cellId]];
    if (state.lock) continue;
    cells.state[cellId] = 0;
  }

  for (const state of states) {
    if (!state.i || state.removed) continue;

    const capitalCell = burgs[state.capital].cell;
    cells.state[capitalCell] = state.i;
    const cultureCenter = cultures[state.culture].center!;
    const b = cells.biome[cultureCenter]; // state native biome
    queue.push({ e: state.center, p: 0, s: state.i, b }, 0);
    cost[state.center] = 1;
  }

  while (queue.length) {
    const next = queue.pop()!;

    const { e, p, s, b } = next;
    const { type, culture } = states[s];

    cells.c[e].forEach(e => {
      const state = states[cells.state[e]];
      if (state.lock) return; // do not overwrite cell of locked states
      if (cells.state[e] && e === state.center) return; // do not overwrite capital cells

      const cultureCost = culture === cells.culture[e] ? -9 : 100;
      const populationCost = cells.h[e] < 20 ? 0 : cells.s[e] ? Math.max(20 - cells.s[e], 0) : 5000;
      const biomeCost = getBiomeCost(b, cells.biome[e], type);
      const heightCost = getHeightCost(input.features[cells.f[e]], cells.h[e], type);
      const riverCost = getRiverCost(cells.r[e], e, type);
      const typeCost = getTypeCost(cells.t[e], type);
      const cellCost = Math.max(cultureCost + populationCost + biomeCost + heightCost + riverCost + typeCost, 0);
      const totalCost = p + 10 + cellCost / states[s].expansionism;

      if (totalCost > growthRate) return;

      if (!cost[e] || totalCost < cost[e]) {
        if (cells.h[e] >= 20) cells.state[e] = s; // assign state to cell
        cost[e] = totalCost;
        queue.push({ e, p: totalCost, s, b }, totalCost);
      }
    });
  }

  return cells.state;
}
export function expandCultures(input: ExpansionInput): Uint16Array {
  const cells = { ...input.cells, culture: input.cells.culture.slice() };
  const { cultures } = input;
  const queue = new ExpansionQueue<{ cellId: number; cultureId: number; priority: number }>();
  const cost: number[] = [];

  const maxExpansionCost = cells.i.length * 0.6 * input.neutralRate;

  // remove culture from all cells except of locked
  const hasLocked = cultures.some(c => !c.removed && c.lock);
  if (hasLocked) {
    for (const cellId of Array.from(cells.i)) {
      const culture = cultures[cells.culture[cellId]];
      if (culture.lock) continue;
      cells.culture[cellId] = 0;
    }
  } else {
    cells.culture = new Uint16Array(cells.i.length);
  }

  for (const culture of cultures) {
    if (!culture.i || culture.removed || culture.lock) continue;
    queue.push({ cellId: culture.center!, cultureId: culture.i, priority: 0 }, 0);
  }

  const getBiomeCost = (c: number, biome: number, type: string) => {
    if (cells.biome[cultures[c].center as number] === biome) return 10; // tiny penalty for native biome
    if (type === "Hunting") return input.biomeCosts[biome] * 5; // non-native biome penalty for hunters
    if (type === "Nomadic" && biome > 4 && biome < 10) return input.biomeCosts[biome] * 10; // forest biome penalty for nomads
    return input.biomeCosts[biome] * 2; // general non-native biome penalty
  };

  const getHeightCost = (i: number, h: number, type: string) => {
    const f = input.features[cells.f[i]],
      a = cells.area[i];
    if (type === "Lake" && f.type === "lake") return 10; // no lake crossing penalty for Lake cultures
    if (type === "Naval" && h < 20) return a * 2; // low sea/lake crossing penalty for Naval cultures
    if (type === "Nomadic" && h < 20) return a * 50; // giant sea/lake crossing penalty for Nomads
    if (h < 20) return a * 6; // general sea/lake crossing penalty
    if (type === "Highland" && h < 44) return 3000; // giant penalty for highlanders on lowlands
    if (type === "Highland" && h < 62) return 200; // giant penalty for highlanders on lowhills
    if (type === "Highland") return 0; // no penalty for highlanders on highlands
    if (h >= 67) return 200; // general mountains crossing penalty
    if (h >= 44) return 30; // general hills crossing penalty
    return 0;
  };

  const getRiverCost = (riverId: number, cellId: number, type: string) => {
    if (type === "River") return riverId ? 0 : 100; // penalty for river cultures
    if (!riverId) return 0; // no penalty for others if there is no river
    return minmax(cells.fl[cellId] / 10, 20, 100); // river penalty from 20 to 100 based on flux
  };

  const getTypeCost = (t: number, type: string) => {
    if (t === 1) return type === "Naval" || type === "Lake" ? 0 : type === "Nomadic" ? 60 : 20; // penalty for coastline
    if (t === 2) return type === "Naval" || type === "Nomadic" ? 30 : 0; // low penalty for land level 2 for Navals and nomads
    if (t !== -1) return type === "Naval" || type === "Lake" ? 100 : 0; // penalty for mainland for navals
    return 0;
  };

  while (queue.length) {
    const { cellId, priority, cultureId } = queue.pop()!;
    const { type, expansionism } = cultures[cultureId];
    const sourceBiome = cells.biome[cellId];

    cells.c[cellId].forEach(neibCellId => {
      if (hasLocked) {
        const neibCultureId = cells.culture[neibCellId];
        if (neibCultureId && cultures[neibCultureId].lock) return; // do not overwrite cell of locked culture
      }

      const targetBiome = cells.biome[neibCellId];
      const biomeCost = getBiomeCost(cultureId, targetBiome, type as string);
      const biomeChangeCost = sourceBiome === targetBiome ? 0 : 20; // penalty on biome change
      const heightCost = getHeightCost(neibCellId, cells.h[neibCellId], type as string);
      const riverCost = getRiverCost(cells.r[neibCellId], neibCellId, type as string);
      const typeCost = getTypeCost(cells.t[neibCellId], type as string);
      const cellCost = (biomeCost + biomeChangeCost + heightCost + riverCost + typeCost) / (expansionism as number);
      const totalCost = priority + cellCost;

      if (totalCost > maxExpansionCost) return;

      if (!cost[neibCellId] || totalCost < cost[neibCellId]) {
        if (cells.pop[neibCellId] > 0) cells.culture[neibCellId] = cultureId; // assign culture to populated cell
        cost[neibCellId] = totalCost;
        queue.push({ cellId: neibCellId, cultureId, priority: totalCost }, totalCost);
      }
    });
  }

  return cells.culture;
}
