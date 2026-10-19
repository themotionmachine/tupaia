import { drawReliefCommands } from "./relief-raster-kernel";

type Paint = {
  kind: "paint";
  id: number;
  width: number;
  height: number;
  ratio: number;
  x0: number;
  y0: number;
  commands: Float64Array;
};
type Message =
  | Paint
  | { kind: "atlas"; entries: { key: number; bitmap: ImageBitmap }[] }
  | { kind: "cancel"; id: number };
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Message>) => void) | null;
  postMessage: (value: unknown) => void;
};
const atlas = new Map<number, ImageBitmap>(),
  queue: Paint[] = [];
const canceled = new Set<number>();
let runningKeys = new Set<number>();
let running = false,
  runningID = 0;
function trimAtlas(): void {
  const evicted: number[] = [];
  const pinned = new Set(runningKeys);
  for (const job of queue)
    for (let offset = 0; offset < job.commands.length; offset += 4) pinned.add(job.commands[offset]);
  while (atlas.size > 64) {
    const key = [...atlas.keys()].find(key => !pinned.has(key));
    if (key === undefined) break;
    atlas.get(key)!.close();
    atlas.delete(key);
    evicted.push(key);
  }
  scope.postMessage({ kind: "atlas", evicted });
}
async function drain(): Promise<void> {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift()!;
    runningID = job.id;
    runningKeys = new Set();
    for (let offset = 0; offset < job.commands.length; offset += 4) runningKeys.add(job.commands[offset]);
    if (canceled.delete(job.id)) continue;
    try {
      if (
        !Number.isInteger(job.width) ||
        !Number.isInteger(job.height) ||
        job.width < 1 ||
        job.height < 1 ||
        job.width > 4096 ||
        job.height > 4096
      )
        throw new Error("Relief viewport exceeds pixel budget");
      const canvas = new OffscreenCanvas(job.width, job.height),
        context = canvas.getContext("2d");
      if (!context) throw new Error("Relief worker canvas unavailable");
      drawReliefCommands(context, atlas, job.commands, job.ratio, job.x0, job.y0);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      canvas.width = canvas.height = 0;
      if (!canceled.delete(job.id)) scope.postMessage({ kind: "blob", id: job.id, blob });
    } catch (error) {
      if (!canceled.delete(job.id)) scope.postMessage({ kind: "error", id: job.id, message: String(error) });
    } finally {
      runningKeys.clear();
      trimAtlas();
    }
  }
  running = false;
  runningID = 0;
  runningKeys.clear();
}
scope.onmessage = event => {
  const message = event.data;
  if (message.kind === "atlas") {
    for (const { key, bitmap } of message.entries) {
      atlas.get(key)?.close();
      atlas.delete(key);
      atlas.set(key, bitmap);
    }
    trimAtlas();
    return;
  }
  if (message.kind === "cancel") {
    const index = queue.findIndex(job => job.id === message.id);
    if (index >= 0) queue.splice(index, 1);
    else if (runningID === message.id) canceled.add(message.id);
    trimAtlas();
    return;
  }
  if (queue.length >= 8) {
    const dropped = queue.shift()!;
    scope.postMessage({ kind: "error", id: dropped.id, message: "Relief worker queue full" });
    trimAtlas();
  }
  queue.push(message);
  void drain();
};
