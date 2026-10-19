import { describe, expect, it, vi } from "vitest";
import { captureExpansionInput, expandInWorker, type ExpansionOperation } from "./expansion-worker";
import ts from "typescript";
import { expandStates, expandCultures, type ExpansionInput } from "./expansion-kernel";
import { ExpansionQueue } from "./expansion-queue";
const stateSource =
  '  private getBiomeCost(b: number, biome: number, type: string) {\n    if (b === biome) return 10; // tiny penalty for native biome\n    if (type === "Hunting") return biomesData.cost[biome] * 2; // non-native biome penalty for hunters\n    if (type === "Nomadic" && biome > 4 && biome < 10) return biomesData.cost[biome] * 3; // forest biome penalty for nomads\n    return biomesData.cost[biome]; // general non-native biome penalty\n  }\n\n  private getHeightCost(f: any, h: number, type: string) {\n    if (type === "Lake" && f.type === "lake") return 10; // low lake crossing penalty for Lake cultures\n    if (type === "Naval" && h < 20) return 300; // low sea crossing penalty for Navals\n    if (type === "Nomadic" && h < 20) return 10000; // giant sea crossing penalty for Nomads\n    if (h < 20) return 1000; // general sea crossing penalty\n    if (type === "Highland" && h < 62) return 1100; // penalty for highlanders on lowlands\n    if (type === "Highland") return 0; // no penalty for highlanders on highlands\n    if (h >= 67) return 2200; // general mountains crossing penalty\n    if (h >= 44) return 300; // general hills crossing penalty\n    return 0;\n  }\n\n  private getRiverCost(r: any, i: number, type: string) {\n    if (type === "River") return r ? 0 : 100; // penalty for river cultures\n    if (!r) return 0; // no penalty for others if there is no river\n    return minmax(pack.cells.fl[i] / 10, 20, 100); // river penalty from 20 to 100 based on flux\n  }\n\n  private getTypeCost(t: number, type: string) {\n    if (t === 1) return type === "Naval" || type === "Lake" ? 0 : type === "Nomadic" ? 60 : 20; // penalty for coastline\n    if (t === 2) return type === "Naval" || type === "Nomadic" ? 30 : 0; // low penalty for land level 2 for Navals and nomads\n    if (t !== -1) return type === "Naval" || type === "Lake" ? 100 : 0; // penalty for mainland for navals\n    return 0;\n  }\n\n  expandStates() {\n    TIME && console.time("expandStates");\n    const { cells, states, cultures, burgs } = pack;\n\n    cells.state = cells.state || new Uint16Array(cells.i.length);\n\n    const queue = new FlatQueue();\n    const cost: number[] = [];\n\n    const globalGrowthRate = (document.getElementById("growthRate") as HTMLInputElement | null)?.valueAsNumber || 1;\n    const statesGrowthRate =\n      (document.getElementById("statesGrowthRate") as HTMLInputElement | null)?.valueAsNumber || 1;\n    const growthRate = (cells.i.length / 2) * globalGrowthRate * statesGrowthRate; // limit cost for state growth\n\n    // remove state from all cells except of locked\n    for (const cellId of cells.i) {\n      const state = states[cells.state[cellId]];\n      if (state.lock) continue;\n      cells.state[cellId] = 0;\n    }\n\n    for (const state of states) {\n      if (!state.i || state.removed) continue;\n\n      const capitalCell = burgs[state.capital].cell;\n      cells.state[capitalCell] = state.i;\n      const cultureCenter = cultures[state.culture].center!;\n      const b = cells.biome[cultureCenter]; // state native biome\n      queue.push({ e: state.center, p: 0, s: state.i, b }, 0);\n      cost[state.center] = 1;\n    }\n\n    while (queue.length) {\n      const next = queue.pop();\n\n      const { e, p, s, b } = next;\n      const { type, culture } = states[s];\n\n      cells.c[e].forEach(e => {\n        const state = states[cells.state[e]];\n        if (state.lock) return; // do not overwrite cell of locked states\n        if (cells.state[e] && e === state.center) return; // do not overwrite capital cells\n\n        const cultureCost = culture === cells.culture[e] ? -9 : 100;\n        const populationCost = cells.h[e] < 20 ? 0 : cells.s[e] ? Math.max(20 - cells.s[e], 0) : 5000;\n        const biomeCost = this.getBiomeCost(b, cells.biome[e], type);\n        const heightCost = this.getHeightCost(pack.features[cells.f[e]], cells.h[e], type);\n        const riverCost = this.getRiverCost(cells.r[e], e, type);\n        const typeCost = this.getTypeCost(cells.t[e], type);\n        const cellCost = Math.max(cultureCost + populationCost + biomeCost + heightCost + riverCost + typeCost, 0);\n        const totalCost = p + 10 + cellCost / states[s].expansionism;\n\n        if (totalCost > growthRate) return;\n\n        if (!cost[e] || totalCost < cost[e]) {\n          if (cells.h[e] >= 20) cells.state[e] = s; // assign state to cell\n          cost[e] = totalCost;\n          queue.push({ e, p: totalCost, s, b }, totalCost);\n        }\n      });\n    }\n\n    burgs\n      .filter(b => b.i && !b.removed)\n      .forEach(b => {\n        b.state = cells.state[b.cell]; // assign state to burgs\n      });\n    TIME && console.timeEnd("expandStates");\n  }\n\n';
const cultureSource =
  '  expand() {\n    TIME && console.time("expandCultures");\n    const { cells, cultures } = pack;\n\n    const queue = new FlatQueue();\n    const cost: number[] = [];\n\n    const neutralRate = (document.getElementById("neutralRate") as HTMLInputElement | null)?.valueAsNumber || 1;\n    const maxExpansionCost = cells.i.length * 0.6 * neutralRate; // limit cost for culture growth\n\n    // remove culture from all cells except of locked\n    const hasLocked = cultures.some(c => !c.removed && c.lock);\n    if (hasLocked) {\n      for (const cellId of cells.i) {\n        const culture = cultures[cells.culture[cellId]];\n        if (culture.lock) continue;\n        cells.culture[cellId] = 0;\n      }\n    } else {\n      cells.culture = new Uint16Array(cells.i.length);\n    }\n\n    for (const culture of cultures) {\n      if (!culture.i || culture.removed || culture.lock) continue;\n      queue.push({ cellId: culture.center, cultureId: culture.i, priority: 0 }, 0);\n    }\n\n    const getBiomeCost = (c: number, biome: number, type: string) => {\n      if (cells.biome[cultures[c].center as number] === biome) return 10; // tiny penalty for native biome\n      if (type === "Hunting") return biomesData.cost[biome] * 5; // non-native biome penalty for hunters\n      if (type === "Nomadic" && biome > 4 && biome < 10) return biomesData.cost[biome] * 10; // forest biome penalty for nomads\n      return biomesData.cost[biome] * 2; // general non-native biome penalty\n    };\n\n    const getHeightCost = (i: number, h: number, type: string) => {\n      const f = pack.features[cells.f[i]],\n        a = cells.area[i];\n      if (type === "Lake" && f.type === "lake") return 10; // no lake crossing penalty for Lake cultures\n      if (type === "Naval" && h < 20) return a * 2; // low sea/lake crossing penalty for Naval cultures\n      if (type === "Nomadic" && h < 20) return a * 50; // giant sea/lake crossing penalty for Nomads\n      if (h < 20) return a * 6; // general sea/lake crossing penalty\n      if (type === "Highland" && h < 44) return 3000; // giant penalty for highlanders on lowlands\n      if (type === "Highland" && h < 62) return 200; // giant penalty for highlanders on lowhills\n      if (type === "Highland") return 0; // no penalty for highlanders on highlands\n      if (h >= 67) return 200; // general mountains crossing penalty\n      if (h >= 44) return 30; // general hills crossing penalty\n      return 0;\n    };\n\n    const getRiverCost = (riverId: number, cellId: number, type: string) => {\n      if (type === "River") return riverId ? 0 : 100; // penalty for river cultures\n      if (!riverId) return 0; // no penalty for others if there is no river\n      return minmax(cells.fl[cellId] / 10, 20, 100); // river penalty from 20 to 100 based on flux\n    };\n\n    const getTypeCost = (t: number, type: string) => {\n      if (t === 1) return type === "Naval" || type === "Lake" ? 0 : type === "Nomadic" ? 60 : 20; // penalty for coastline\n      if (t === 2) return type === "Naval" || type === "Nomadic" ? 30 : 0; // low penalty for land level 2 for Navals and nomads\n      if (t !== -1) return type === "Naval" || type === "Lake" ? 100 : 0; // penalty for mainland for navals\n      return 0;\n    };\n\n    while (queue.length) {\n      const { cellId, priority, cultureId } = queue.pop();\n      const { type, expansionism } = cultures[cultureId];\n      const sourceBiome = cells.biome[cellId];\n\n      cells.c[cellId].forEach(neibCellId => {\n        if (hasLocked) {\n          const neibCultureId = cells.culture[neibCellId];\n          if (neibCultureId && cultures[neibCultureId].lock) return; // do not overwrite cell of locked culture\n        }\n\n        const targetBiome = cells.biome[neibCellId];\n        const biomeCost = getBiomeCost(cultureId, targetBiome, type as string);\n        const biomeChangeCost = sourceBiome === targetBiome ? 0 : 20; // penalty on biome change\n        const heightCost = getHeightCost(neibCellId, cells.h[neibCellId], type as string);\n        const riverCost = getRiverCost(cells.r[neibCellId], neibCellId, type as string);\n        const typeCost = getTypeCost(cells.t[neibCellId], type as string);\n        const cellCost = (biomeCost + biomeChangeCost + heightCost + riverCost + typeCost) / (expansionism as number);\n        const totalCost = priority + cellCost;\n\n        if (totalCost > maxExpansionCost) return;\n\n        if (!cost[neibCellId] || totalCost < cost[neibCellId]) {\n          if (cells.pop[neibCellId] > 0) cells.culture[neibCellId] = cultureId; // assign culture to populated cell\n          cost[neibCellId] = totalCost;\n          queue.push({ cellId: neibCellId, cultureId, priority: totalCost }, totalCost);\n        }\n      });\n    }\n\n    TIME && console.timeEnd("expandCultures");\n  }';
function legacy(source: string, input: ExpansionInput, method: string) {
  const pack = {
    cells: input.cells,
    states: input.states,
    cultures: input.cultures,
    features: input.features,
    burgs: input.burgs.map((b, i) => ({ ...b, i }))
  };
  const compiled = ts.transpile(`class Legacy {${source}}; return new Legacy();`, { target: ts.ScriptTarget.ES2022 });
  const module = new Function("pack", "biomesData", "document", "FlatQueue", "TIME", "minmax", compiled)(
    pack,
    { cost: input.biomeCosts },
    {
      getElementById: (id: string) => ({
        valueAsNumber:
          id === "growthRate"
            ? input.growthRate
            : id === "statesGrowthRate"
              ? input.statesGrowthRate
              : input.neutralRate
      })
    },
    ExpansionQueue,
    false,
    (n: number, min: number, max: number) => Math.max(min, Math.min(n, max))
  );
  module[method]();
  return method === "expandStates" ? pack.cells.state : pack.cells.culture;
}
function fixture(locked: boolean, n = 240): ExpansionInput {
  return {
    cells: {
      i: Uint32Array.from({ length: n }, (_, i) => i),
      c: Array.from({ length: n }, (_, i) => [i - 1, i + 1, i - 12, i + 12].filter(j => j >= 0 && j < n)),
      h: Uint8Array.from({ length: n }, (_, i) => (i % 13 === 0 ? 10 : 20 + (i % 70))),
      biome: Uint8Array.from({ length: n }, (_, i) => i % 12),
      f: Uint16Array.from({ length: n }, (_, i) => i % 2),
      r: Uint16Array.from({ length: n }, (_, i) => (i % 7 === 0 ? 1 : 0)),
      fl: Float32Array.from({ length: n }, (_, i) => i * 2),
      t: Int8Array.from({ length: n }, (_, i) => (i % 4) - 1),
      s: Int16Array.from({ length: n }, (_, i) => i % 31),
      area: Float64Array.from({ length: n }, (_, i) => 1 + (i % 8)),
      pop: Float32Array.from({ length: n }, (_, i) => (i % 5 === 0 ? 0 : 10)),
      state: Uint16Array.from({ length: n }, (_, i) => (locked && i > 200 ? 2 : 0)),
      culture: Uint16Array.from({ length: n }, (_, i) => (locked && i > 200 ? 2 : 1))
    },
    states: [
      { i: 0, center: 0, capital: 0, culture: 0, type: "Generic", expansionism: 1 },
      { i: 1, center: 12, capital: 1, culture: 1, type: "Naval", expansionism: 2 },
      { i: 2, center: 220, capital: 2, culture: 2, type: "Highland", expansionism: 3, lock: locked }
    ],
    cultures: [
      { i: 0, type: "Generic" },
      { i: 1, center: 12, type: "Naval", expansionism: 2 },
      { i: 2, center: 220, type: "Highland", expansionism: 3, lock: locked }
    ],
    burgs: [{ cell: 0 }, { cell: 12 }, { cell: 220 }],
    features: [{ type: "land" }, { type: "lake" }],
    biomeCosts: [10, 30, 50, 10, 20, 30, 40, 50, 60, 70, 80, 90],
    growthRate: 6,
    statesGrowthRate: 4,
    neutralRate: 8
  };
}
describe("expansion fidelity", () => {
  for (const locked of [false, true])
    for (const kind of ["states", "cultures"] as const) {
      it(`${kind} matches legacy costs, heap ties and locked boundaries (${locked})`, () => {
        const input = fixture(locked),
          original = structuredClone(input);
        const result = kind === "states" ? expandStates(input) : expandCultures(input);
        expect(result).toEqual(
          legacy(
            kind === "states" ? stateSource : cultureSource,
            structuredClone(input),
            kind === "states" ? "expandStates" : "expand"
          )
        );
        expect(input).toEqual(original);
        expect(result).toEqual(kind === "states" ? expandStates(input) : expandCultures(input));
      });
    }
});

it("transfers owned copies and packed adjacency without detaching live cells", async () => {
  let terminated = 0;
  class TestWorker {
    onmessage?: (event: { data: { result: Uint16Array } }) => void;
    onerror?: (event: { message: string }) => void;
    postMessage(
      message: { operation: ExpansionOperation; input: ExpansionInput; offsets: Uint32Array; neighbors: Uint32Array },
      transfer: Transferable[]
    ) {
      const owned = structuredClone(message, { transfer });
      owned.input.cells.c = Array.from({ length: owned.offsets.length - 1 }, (_, i) =>
        owned.neighbors.subarray(owned.offsets[i], owned.offsets[i + 1])
      );
      const result = owned.operation === "expandStates" ? expandStates(owned.input) : expandCultures(owned.input);
      queueMicrotask(() => this.onmessage?.({ data: { result } }));
    }
    terminate() {
      terminated++;
    }
  }
  vi.stubGlobal("Worker", TestWorker);
  try {
    for (const operation of ["expandStates", "expandCultures"] as const) {
      const input = fixture(true, 20001),
        original = structuredClone(input);
      expect(await expandInWorker(operation, input)).toEqual(
        operation === "expandStates" ? expandStates(input) : expandCultures(input)
      );
      expect(input).toEqual(original);
    }
    expect(terminated).toBe(2);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("captures culture generation before burgs and states exist", () => {
  const input = fixture(false);
  vi.stubGlobal("pack", { cells: input.cells, cultures: input.cultures, features: input.features });
  vi.stubGlobal("biomesData", { cost: input.biomeCosts });
  vi.stubGlobal("document", { getElementById: () => null });
  try {
    const snapshot = captureExpansionInput();
    expect(snapshot.states).toEqual([]);
    expect(snapshot.burgs).toEqual([]);
    expect(expandCultures(snapshot)).toHaveLength(input.cells.i.length);
  } finally {
    vi.unstubAllGlobals();
  }
});
