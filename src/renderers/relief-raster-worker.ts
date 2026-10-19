interface Glyph {
  x: number;
  y: number;
  radius: number;
}
interface Source {
  key: number;
  upload?: Promise<void>;
}
interface Pending {
  resolve: (blob: Blob | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
}
let worker: Worker | undefined,
  disabled = false,
  reason = "",
  nextKey = 1,
  nextJob = 1,
  completed = 0;
const sourceKeys = new WeakMap<HTMLCanvasElement, Source>(),
  uploaded = new Set<number>(),
  pending = new Map<number, Pending>();
function fail(message: string): void {
  reason = message;
  disabled = true;
  worker?.terminate();
  worker = undefined;
  uploaded.clear();
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    job.resolve(undefined);
  }
  pending.clear();
}
function getWorker(): Worker | undefined {
  if (disabled) return;
  // Retain the proven main backend unless this experimental path is explicitly requested.
  if (typeof location === "undefined" || new URLSearchParams(location.search).get("reliefWorker") !== "1") {
    reason = "Experimental relief worker is disabled; opt in with reliefWorker=1";
    disabled = true;
    return;
  }
  if (
    typeof Worker === "undefined" ||
    typeof OffscreenCanvas === "undefined" ||
    typeof createImageBitmap === "undefined"
  ) {
    reason = "Worker canvas features unavailable";
    disabled = true;
    return;
  }
  if (worker) return worker;
  try {
    const created = new Worker(new URL("./relief-raster.worker.ts", import.meta.url), { type: "module" });
    worker = created;
    created.onmessage = event => {
      if (worker !== created) return;
      const result = event.data;
      if (result.kind === "atlas") {
        for (const key of result.evicted || []) uploaded.delete(key);
        return;
      }
      const job = pending.get(result.id);
      if (!job) return;
      clearTimeout(job.timer);
      pending.delete(result.id);
      if (result.kind === "blob") {
        completed++;
        job.resolve(result.blob);
      } else {
        reason = result.message || "Relief worker job failed";
        uploaded.clear();
        job.resolve(undefined);
      }
    };
    created.onerror = () => fail("Relief worker failed");
    created.onmessageerror = () => fail("Relief worker response invalid");
    return created;
  } catch {
    fail("Relief worker creation failed");
    return;
  }
}
async function upload(source: HTMLCanvasElement, target: Worker): Promise<number> {
  let entry = sourceKeys.get(source);
  if (!entry) {
    entry = { key: nextKey++ };
    sourceKeys.set(source, entry);
  }
  const selected = entry;
  if (!uploaded.has(selected.key) && !selected.upload) {
    selected.upload = (async () => {
      const bitmap = await createImageBitmap(source);
      if (worker !== target) {
        bitmap.close();
        throw new Error("Relief worker replaced");
      }
      try {
        target.postMessage({ kind: "atlas", entries: [{ key: selected.key, bitmap }] }, [bitmap]);
      } catch (error) {
        bitmap.close();
        throw error;
      }
      uploaded.add(selected.key);
    })().finally(() => {
      selected.upload = undefined;
    });
  }
  await selected.upload;
  return selected.key;
}
export function createReliefWorkerPainter() {
  let disposed = false;
  const jobs = new Set<number>();
  return {
    get available() {
      return !!getWorker();
    },
    async paint(
      glyphs: Glyph[],
      sources: HTMLCanvasElement[],
      bounds: [number, number, number, number],
      ratio: number,
      width: number,
      height: number
    ): Promise<Blob | undefined> {
      const target = getWorker();
      if (!target || disposed) return;
      try {
        const unique = [...new Set(sources)];
        if (unique.length > 64) {
          reason = "Relief sprite set exceeds worker atlas budget";
          return;
        }
        const keys = new Map<HTMLCanvasElement, number>();
        const values = await Promise.all(unique.map(source => upload(source, target)));
        unique.forEach((source, index) => {
          keys.set(source, values[index]);
        });
        if (disposed || worker !== target) return;
        const commands = new Float64Array(glyphs.length * 4);
        glyphs.forEach((glyph, index) => {
          const offset = index * 4;
          commands[offset] = keys.get(sources[index])!;
          commands[offset + 1] = glyph.x;
          commands[offset + 2] = glyph.y;
          commands[offset + 3] = glyph.radius;
        });
        const id = nextJob++;
        jobs.add(id);
        const blob = await new Promise<Blob | undefined>(resolve => {
          const timer = setTimeout(() => {
            pending.delete(id);
            target.postMessage({ kind: "cancel", id });
            reason = "Relief worker timed out";
            resolve(undefined);
          }, 15000);
          pending.set(id, { resolve, timer });
          try {
            target.postMessage({ kind: "paint", id, width, height, ratio, x0: bounds[0], y0: bounds[1], commands }, [
              commands.buffer
            ]);
          } catch {
            clearTimeout(timer);
            pending.delete(id);
            reason = "Relief worker request failed";
            resolve(undefined);
          }
        });
        jobs.delete(id);
        return blob;
      } catch {
        reason = "Relief worker atlas unavailable";
        return;
      }
    },
    dispose() {
      disposed = true;
      for (const id of jobs) {
        const job = pending.get(id);
        if (job) {
          clearTimeout(job.timer);
          pending.delete(id);
          job.resolve(undefined);
        }
        worker?.postMessage({ kind: "cancel", id });
      }
      jobs.clear();
    }
  };
}
export function reliefWorkerStatus() {
  return {
    backend: worker && !disabled ? "worker" : "main",
    fallbackReason: reason,
    completed,
    pending: pending.size,
    atlasEntries: uploaded.size
  };
}
declare global {
  interface Window {
    reliefWorkerStatus: typeof reliefWorkerStatus;
  }
}
window.reliefWorkerStatus = reliefWorkerStatus;
