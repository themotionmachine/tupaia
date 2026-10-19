import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());
async function setup(enabled = true) {
  vi.resetModules();
  vi.stubGlobal("location", { search: enabled ? "?reliefWorker=1" : "" });
  const instances: FakeWorker[] = [];
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    sent: { message: any; transfer: Transferable[] }[] = [];
    terminate = vi.fn();
    constructor() {
      instances.push(this);
    }
    postMessage(message: any, transfer: Transferable[] = []) {
      this.sent.push({ message, transfer });
      if (message.kind === "atlas") this.emit({ kind: "atlas", evicted: [] });
    }
    emit(data: unknown) {
      this.onmessage?.({ data });
    }
  }
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("OffscreenCanvas", class {});
  const bitmap = { close: vi.fn() };
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => bitmap)
  );
  const module = await import("./relief-raster-worker");
  return { instances, bitmap, ...module };
}
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
it("transfers an owned atlas once and exact commands while retaining fallback input", async () => {
  const { instances, bitmap, createReliefWorkerPainter, reliefWorkerStatus } = await setup();
  const source = { original: true } as unknown as HTMLCanvasElement,
    painter = createReliefWorkerPainter();
  const glyphs = [{ x: 1.123456789012345, y: 2.987654321098765, radius: 4 }];
  const pending = painter.paint(glyphs, [source], [0, 0, 20, 20], 8, 160, 160);
  await flush();
  const worker = instances[0],
    upload = worker.sent.find(item => item.message.kind === "atlas")!,
    job = worker.sent.find(item => item.message.kind === "paint")!;
  expect(upload.transfer).toEqual([bitmap]);
  expect(job.message.commands).toBeInstanceOf(Float64Array);
  expect(Array.from(job.message.commands).slice(1)).toEqual([glyphs[0].x, glyphs[0].y, 4]);
  expect(job.transfer).toEqual([job.message.commands.buffer]);
  const blob = new Blob();
  worker.emit({ kind: "blob", id: job.message.id, blob });
  expect(await pending).toBe(blob);
  const next = painter.paint(glyphs, [source], [0, 0, 20, 20], 8, 160, 160);
  await flush();
  expect(worker.sent.filter(item => item.message.kind === "atlas")).toHaveLength(1);
  const jobs = worker.sent.filter(item => item.message.kind === "paint");
  worker.emit({ kind: "blob", id: jobs[1].message.id, blob });
  await next;
  expect((source as unknown as { original: boolean }).original).toBe(true);
  expect(reliefWorkerStatus().completed).toBe(2);
  painter.dispose();
});
it("cancels disposed jobs and ignores late responses", async () => {
  const { instances, createReliefWorkerPainter, reliefWorkerStatus } = await setup();
  const painter = createReliefWorkerPainter(),
    source = {} as HTMLCanvasElement;
  const pending = painter.paint([{ x: 0, y: 0, radius: 4 }], [source], [0, 0, 20, 20], 8, 160, 160);
  await flush();
  const worker = instances[0],
    job = worker.sent.find(item => item.message.kind === "paint")!;
  painter.dispose();
  expect(await pending).toBeUndefined();
  expect(worker.sent.some(item => item.message.kind === "cancel" && item.message.id === job.message.id)).toBe(true);
  worker.emit({ kind: "blob", id: job.message.id, blob: new Blob() });
  expect(reliefWorkerStatus().completed).toBe(0);
  expect(reliefWorkerStatus().pending).toBe(0);
});
it("returns to the retained main backend when features or worker processing fail", async () => {
  const { instances, createReliefWorkerPainter, reliefWorkerStatus } = await setup();
  const painter = createReliefWorkerPainter(),
    source = {} as HTMLCanvasElement;
  const pending = painter.paint([{ x: 0, y: 0, radius: 4 }], [source], [0, 0, 20, 20], 8, 160, 160);
  await flush();
  const worker = instances[0],
    job = worker.sent.find(item => item.message.kind === "paint")!;
  worker.emit({ kind: "error", id: job.message.id, message: "unsupported atlas" });
  expect(await pending).toBeUndefined();
  expect(reliefWorkerStatus().fallbackReason).toBe("unsupported atlas");
  painter.dispose();
  vi.resetModules();
  vi.stubGlobal("Worker", undefined);
  const fallback = await import("./relief-raster-worker"),
    main = fallback.createReliefWorkerPainter();
  expect(main.available).toBe(false);
  expect(await main.paint([{ x: 0, y: 0, radius: 4 }], [source], [0, 0, 20, 20], 8, 160, 160)).toBeUndefined();
  expect(fallback.reliefWorkerStatus().backend).toBe("main");
  main.dispose();
});

it("does not allocate a worker or bitmap without an explicit URL opt-in", async () => {
  const { instances, createReliefWorkerPainter, reliefWorkerStatus } = await setup(false);
  const painter = createReliefWorkerPainter();
  expect(painter.available).toBe(false);
  expect(
    await painter.paint([{ x: 0, y: 0, radius: 4 }], [{} as HTMLCanvasElement], [0, 0, 20, 20], 8, 160, 160)
  ).toBeUndefined();
  expect(instances).toHaveLength(0);
  expect(createImageBitmap).not.toHaveBeenCalled();
  expect(reliefWorkerStatus().backend).toBe("main");
  expect(reliefWorkerStatus().fallbackReason.includes("reliefWorker=1")).toBe(true);
  painter.dispose();
});
