// [PAN W4a] The pan cache (framegraph.ts FrameGraph.pan): which batches it keeps, the strips a pan uncovers, the camera
// it draws (whole device pixels from the cached one), when it rebuilds or steps aside, the strips' scissor (the id
// clears inside a strip stay inside it), and its memory. GL is a recording fake: these pin the calls, not pixels (the
// golden and navigation gates measure those).
import { describe, expect, it } from "vitest";
import { GpuDevice, type TrackedBuffer, type TrackedTexture } from "./device";
import {
  type Batch,
  exposedStrips,
  type FillBatch,
  type Frame,
  FrameGraph,
  type GroupBatch,
  type ImageBatch,
  panSplit
} from "./framegraph";

const [W, H, DPR] = [2560, 1440, 2];
const VIEWPORT = { width: W / DPR, height: H / DPR, dpr: DPR };
const CLEAR: [number, number, number, number] = [1, 1, 1, 1];

type Call = [string, ...unknown[]];

function setup() {
  const calls: Call[] = [];
  const recorded = new Set([
    "enable",
    "disable",
    "scissor",
    "clear",
    "copyTexSubImage2D",
    "uniform4fv",
    "texParameteri"
  ]);
  // every program reports the image program's uniforms (the quad's rect is what these tests read)
  const uniforms = ["u_matrix", "u_rect", "u_uv", "u_opacity", "u_texture", "u_masked", "u_mask"];
  const gl: Record<string, unknown> = {
    MAX_TEXTURE_SIZE: 1,
    MAX_SAMPLES: 2,
    FRAMEBUFFER_COMPLETE: 30,
    LINK_STATUS: 41,
    ACTIVE_UNIFORMS: 42,
    ACTIVE_ATTRIBUTES: 43,
    drawingBufferWidth: W,
    drawingBufferHeight: H,
    getParameter: (name: number) => ({ 1: 8192, 2: 4 })[name] ?? 0,
    getContextAttributes: () => ({ antialias: false }),
    checkFramebufferStatus: () => 30,
    getShaderParameter: () => true,
    getProgramParameter: (_: unknown, name: number) => (name === 41 ? true : name === 42 ? uniforms.length : 0),
    getActiveUniform: (_: unknown, index: number) => ({ name: uniforms[index] }),
    getUniformLocation: (_: unknown, name: string) => ({ name }),
    getAttribLocation: () => 0
  };
  // constants are their own names; every other entry point is a no-op (create* returns a fresh handle), recorded when
  // it is one of `recorded`
  const fake = new Proxy(gl, {
    get: (target, key: string) => {
      if (key in target) return target[key];
      if (/^[A-Z0-9_]+$/.test(key)) return key;
      if (key.startsWith("create")) return () => ({});
      return (...args: unknown[]) => {
        if (recorded.has(key)) calls.push([key, ...args]);
        return 0;
      };
    }
  });
  const canvas = { width: W, height: H, getContext: () => fake, addEventListener() {}, removeEventListener() {} };
  const device = new GpuDevice(canvas as unknown as HTMLCanvasElement, { lost() {}, restored() {} });
  return { device, graph: new FrameGraph(device), calls };
}

const fill = (bounds: [number, number, number, number] = [0, 0, 1280, 720], edges = 0): FillBatch => ({
  kind: "fill",
  bounds,
  first: 0,
  count: 3,
  color: [1, 0, 0, 1],
  tile: null,
  evenOdd: false,
  ...(edges ? { edgeFirst: 0, edgeCount: edges } : {})
});
const overlay = (): ImageBatch => ({
  kind: "image",
  texture: { handle: {} } as TrackedTexture,
  rect: [0, 0, 10, 10],
  screen: true,
  detail: null
});
const frameOf = (batches: Batch[]): Frame => ({
  batches,
  fans: { kind: "buffer", bytes: 0 } as TrackedBuffer,
  edges: { kind: "buffer", bytes: 0 } as TrackedBuffer,
  caps: null,
  segments: null,
  sprites: null,
  glyphs: null,
  atlas: null
});
const always = () => true;

describe("pan cache split (PAN W4a)", () => {
  it("keeps the world below the batch that holds the live marker slot", () => {
    expect(panSplit([fill(), fill(), { kind: "markers" }, fill(), overlay()])).toEqual({ slot: 2 });
    const trade: GroupBatch = { kind: "group", opacity: 0.5, mask: null, children: [fill(), { kind: "markers" }] };
    expect(panSplit([fill(), trade, fill(), overlay(), overlay()])).toEqual({ slot: 1 });
  });

  it("keeps the whole world without a marker slot, never the screen overlays after it", () => {
    expect(panSplit([fill(), fill(), overlay()])).toEqual({ slot: 2 });
    expect(panSplit([fill()])).toEqual({ slot: 1 });
  });

  it("keeps nothing when nothing sits below the slot or a screen overlay is under the world", () => {
    expect(panSplit([{ kind: "markers" }, fill()])).toBeNull();
    expect(panSplit([overlay(), fill()])).toBeNull();
    expect(panSplit([fill(), overlay(), fill()])).toBeNull();
    expect(panSplit([overlay()])).toBeNull();
    expect(panSplit([])).toBeNull();
  });
});

describe("pan cache strips (PAN W4a)", () => {
  const area = (strips: number[][]) => strips.reduce((sum, [, , w, h]) => sum + w * h, 0);

  it("uncovers the columns the pan left, then the rows beside them, disjoint", () => {
    expect(exposedStrips(0, 0, 100, 50)).toEqual([]);
    expect(exposedStrips(10, 0, 100, 50)).toEqual([[0, 0, 10, 50]]);
    expect(exposedStrips(-10, 0, 100, 50)).toEqual([[90, 0, 10, 50]]);
    expect(exposedStrips(0, 7, 100, 50)).toEqual([[0, 0, 100, 7]]);
    expect(exposedStrips(0, -7, 100, 50)).toEqual([[0, 43, 100, 7]]);
    expect(exposedStrips(10, -7, 100, 50)).toEqual([
      [0, 0, 10, 50],
      [10, 43, 90, 7]
    ]);
    expect(exposedStrips(-10, 7, 100, 50)).toEqual([
      [90, 0, 10, 50],
      [0, 0, 90, 7]
    ]);
  });

  it("covers exactly what the moved frame no longer covers", () => {
    for (const [dx, dy] of [
      [13, 0],
      [-4, 9],
      [30, -20],
      [-99, -49],
      [150, 3]
    ]) {
      const [cw, ch] = [Math.max(0, 100 - Math.abs(dx)), Math.max(0, 50 - Math.abs(dy))];
      expect(area(exposedStrips(dx, dy, 100, 50))).toBe(100 * 50 - cw * ch);
    }
  });
});

describe("FrameGraph.pan (PAN W4a)", () => {
  const world = [fill(), fill([100, 100, 200, 200]), { kind: "markers" } as Batch, fill(), overlay()];

  it("builds the cache at the exact camera, then shifts it by whole device pixels and renders the strips", () => {
    const { device, graph, calls } = setup();
    const frame = frameOf(world);
    const before = device.memory().total;
    expect(graph.pan(frame, { k: 2, x: 10, y: 20 }, VIEWPORT, CLEAR, null, 0, always)).toEqual({ k: 2, x: 10, y: 20 });
    expect(graph.panBytes).toBe(W * H * 4);
    expect(device.memory().total - before).toBe(W * H * 4);
    expect(graph.panStats).toMatchObject({ rebuilds: 1, shifts: 0 });
    expect(calls.filter(([name]) => name === "copyTexSubImage2D")).toEqual([
      ["copyTexSubImage2D", "TEXTURE_2D", 0, 0, 0, 0, 0, W, H]
    ]);
    calls.length = 0;
    // 3.3 CSS px right, 1.2 up at DPR 2: 6.6 and -2.4 device px, drawn at 7 and -2
    const drawn = graph.pan(frame, { k: 2, x: 13.3, y: 18.8 }, VIEWPORT, CLEAR, null, 0, always);
    expect(drawn).toEqual({ k: 2, x: 13.5, y: 19 });
    expect(graph.panStats).toMatchObject({ rebuilds: 1, shifts: 1, strips: 2, stripPixels: 7 * H + (W - 7) * 2 });
    // the cached world moved 1:1 (CSS px rect of the whole buffer at the shift)
    expect(calls).toContainEqual(["uniform4fv", { name: "u_rect" }, [3.5, -1, W / DPR, H / DPR]]);
    // strips in GL origin (bottom-left): the 7 left columns, then the 2 bottom rows beside them
    expect(calls.filter(([name]) => name === "scissor")).toEqual([
      ["scissor", 0, 0, 7, H],
      ["scissor", 7, 0, W - 7, 2]
    ]);
    expect(calls.filter(([name]) => name === "copyTexSubImage2D")).toHaveLength(1);
    graph.releasePan();
    expect(graph.panBytes).toBe(0);
    expect(device.memory().total).toBe(before);
  });

  it("steps aside while the zoom changes and rebuilds once it holds still", () => {
    const { graph } = setup();
    const frame = frameOf(world);
    expect(graph.pan(frame, { k: 2, x: 0, y: 0 }, VIEWPORT, CLEAR, null, 0, always)).not.toBeNull();
    expect(graph.pan(frame, { k: 2.1, x: 0, y: 0 }, VIEWPORT, CLEAR, null, 0, always)).toBeNull();
    expect(graph.pan(frame, { k: 2.2, x: 0, y: 0 }, VIEWPORT, CLEAR, null, 0, always)).toBeNull();
    expect(graph.pan(frame, { k: 2.2, x: 1, y: 0 }, VIEWPORT, CLEAR, null, 0, always)).toEqual({ k: 2.2, x: 1, y: 0 });
    expect(graph.panStats).toMatchObject({ zooms: 2, rebuilds: 2, shifts: 0 });
  });

  it("rebuilds for another frame, epoch or clear colour, and past half the view uncovered", () => {
    const { graph } = setup();
    const frame = frameOf(world);
    const pan = (x: number, epoch = 0, target = frame, clear = CLEAR) =>
      graph.pan(target, { k: 1, x, y: 0 }, VIEWPORT, clear, null, epoch, always);
    pan(0);
    pan(1);
    expect(graph.panStats).toMatchObject({ rebuilds: 1, shifts: 1 });
    pan(2, 1);
    pan(3, 1, frameOf([...world]));
    pan(4, 1, frameOf(world), [0, 0, 0, 1]);
    expect(graph.panStats).toMatchObject({ rebuilds: 4, shifts: 1 });
    pan(4 + W / DPR / 2 + 1, 1, frameOf(world), [0, 0, 0, 1]); // more than half the columns uncovered
    expect(graph.panStats.rebuilds).toBe(5);
  });

  it("draws nothing when the cache has no room or nothing to keep", () => {
    const { device, graph } = setup();
    const before = device.memory().total;
    expect(graph.pan(frameOf(world), { k: 1, x: 0, y: 0 }, VIEWPORT, CLEAR, null, 0, () => false)).toBeNull();
    expect(graph.panStats.refused).toBe(1);
    expect(device.memory().total).toBe(before);
    expect(
      graph.pan(frameOf([{ kind: "markers" }, fill()]), { k: 1, x: 0, y: 0 }, VIEWPORT, CLEAR, null, 0, always)
    ).toBeNull();
    expect(graph.panBytes).toBe(0);
  });

  it("keeps the anti-aliasing id clears of a strip inside the strip", () => {
    const { graph, calls } = setup();
    // 16 anti-aliased fills over the whole view: the 16th runs the ids out and clears them where earlier ones drew
    const frame = frameOf([...Array.from({ length: 16 }, () => fill([0, 0, 1280, 720], 4)), { kind: "markers" }]);
    graph.pan(frame, { k: 1, x: 0, y: 0 }, VIEWPORT, CLEAR, null, 0, always);
    calls.length = 0;
    graph.pan(frame, { k: 1, x: 5, y: 0 }, VIEWPORT, CLEAR, null, 0, always);
    const scissors = calls.filter(([name]) => name === "scissor");
    expect(scissors.length).toBeGreaterThan(1);
    for (const [, x, y, w, h] of scissors as [string, number, number, number, number][]) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(10);
      expect([y, h]).toEqual([0, H]);
    }
    // the scissor stays on for the strip until it ends
    const toggles = calls.filter(
      ([name, what]) => (name === "enable" || name === "disable") && what === "SCISSOR_TEST"
    );
    expect(toggles.at(-1)).toEqual(["disable", "SCISSOR_TEST"]);
    expect(toggles.filter(([name]) => name === "disable")).toHaveLength(1);
  });
});
