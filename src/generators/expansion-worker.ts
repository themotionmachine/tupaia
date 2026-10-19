import { type ExpansionInput, expandCultures, expandStates } from "./expansion-kernel";
export type ExpansionOperation = "expandStates" | "expandCultures";
export function captureExpansionInput(): ExpansionInput {
  const value = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.valueAsNumber || 1;
  return {
    cells: {
      ...pack.cells,
      state: Uint16Array.from(pack.cells.state || new Uint16Array(pack.cells.i.length)),
      culture: Uint16Array.from(pack.cells.culture)
    },
    states: (pack.states || []).map(({ i, center, capital, culture, type, expansionism, lock, removed }) => ({
      i,
      center,
      capital,
      culture,
      type,
      expansionism,
      lock,
      removed
    })),
    cultures: pack.cultures.map(({ i, center, type, expansionism, lock, removed }) => ({
      i,
      center,
      type,
      expansionism,
      lock,
      removed
    })),
    burgs: (pack.burgs || []).map(({ cell }) => ({ cell })),
    features: pack.features.map(({ type }) => ({ type })),
    biomeCosts: biomesData.cost,
    growthRate: value("growthRate"),
    statesGrowthRate: value("statesGrowthRate"),
    neutralRate: value("neutralRate")
  };
}
export async function expandInWorker(operation: ExpansionOperation, input: ExpansionInput): Promise<Uint16Array> {
  const compute = operation === "expandStates" ? expandStates : expandCultures;
  if (typeof Worker === "undefined" || input.cells.i.length < 20000) return compute(input);
  let worker: Worker | undefined;
  try {
    worker = new Worker(new URL("./expansion.worker.ts", import.meta.url), { type: "module" });
    // Own every transferred buffer. The live map remains readable throughout the job.
    const offsets = new Uint32Array(input.cells.c.length + 1);
    for (let i = 0; i < input.cells.c.length; i++) offsets[i + 1] = offsets[i] + input.cells.c[i].length;
    const neighbors = new Uint32Array(offsets[offsets.length - 1]);
    for (let i = 0; i < input.cells.c.length; i++) neighbors.set(input.cells.c[i], offsets[i]);
    const cells = {
      i: Uint32Array.from(input.cells.i),
      c: [],
      h: Uint8Array.from(input.cells.h),
      biome: Uint8Array.from(input.cells.biome),
      f: Uint32Array.from(input.cells.f),
      r: Uint32Array.from(input.cells.r),
      fl: Float64Array.from(input.cells.fl),
      t: Int8Array.from(input.cells.t),
      s: Float64Array.from(input.cells.s),
      area: Float64Array.from(input.cells.area),
      pop: Float64Array.from(input.cells.pop),
      state: input.cells.state.slice(),
      culture: input.cells.culture.slice()
    };
    const transfers = Object.values(cells).flatMap(value => (ArrayBuffer.isView(value) ? [value.buffer] : []));
    return await new Promise<Uint16Array>((resolve, reject) => {
      worker!.onmessage = (event: MessageEvent<{ result?: Uint16Array; error?: string }>) => {
        if (event.data.result) resolve(event.data.result);
        else reject(new Error(event.data.error || "Expansion worker returned no result"));
      };
      worker!.onerror = event => reject(new Error(event.message));
      worker!.postMessage({ operation, input: { ...input, cells }, offsets, neighbors }, [
        ...transfers,
        offsets.buffer,
        neighbors.buffer
      ]);
    });
  } catch (error) {
    console.warn("Expansion worker unavailable; using synchronous expansion", error);
    return compute(input);
  } finally {
    worker?.terminate();
  }
}
