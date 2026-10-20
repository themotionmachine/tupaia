// [W3c BUDGET] The framegraph's per-screen allocations must be what the steady share reserves for them. W3b STROKE3 drew
// a masked group's coverage into an RGBA8 texture tracked as a plain texture: the prepare reserved the group target
// alone (targetReserve) and residentBytes found the mask only once a frame had drawn it, so the first frame after a
// prepare that planned to the budget held 14.06 MiB more (1280x720 DPR 2; the parity replay at 163-165 MiB of 160).
import { describe, expect, it } from "vitest";
import { GPU_BUDGET, MASK_BYTES_PER_PIXEL, STEADY_SLACK, steadyReserve, targetBytes, targetReserve } from "./budget";
import { GpuDevice, type TrackedBuffer, type TrackedTexture } from "./device";
import { type Batch, type FillBatch, type Frame, FrameGraph, type GroupBatch, hasMaskedGroup } from "./framegraph";

const [W, H, DPR] = [2560, 1440, 2]; // the parity replay's backing store: 1280x720 CSS px at DPR 2

function fakeGl() {
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
    getProgramParameter: (_: unknown, name: number) => (name === 41 ? true : 0),
    getUniformLocation: (_: unknown, name: string) => ({ name }),
    getAttribLocation: () => 0
  };
  // every other GL entry point is a no-op; create* returns a fresh handle
  return new Proxy(gl, {
    get: (target, key: string) => (key in target ? target[key] : key.startsWith("create") ? () => ({}) : () => 0)
  });
}

function setup() {
  const canvas = {
    width: W,
    height: H,
    getContext: () => fakeGl(),
    addEventListener() {},
    removeEventListener() {}
  };
  const device = new GpuDevice(canvas as unknown as HTMLCanvasElement, { lost() {}, restored() {} });
  return { device, graph: new FrameGraph(device) };
}

const fill = (): FillBatch => ({
  kind: "fill",
  bounds: [10, 10, 20, 20],
  first: 0,
  count: 3,
  color: [1, 0, 0, 1],
  tile: null,
  evenOdd: false
});
const group = (mask: GroupBatch["mask"], opacity = 1): GroupBatch => ({
  kind: "group",
  opacity,
  mask,
  children: [fill()]
});
const frameOf = (batches: Batch[]): Frame => ({
  batches,
  fans: { kind: "buffer", bytes: 0 } as TrackedBuffer,
  caps: null,
  segments: null,
  sprites: null,
  glyphs: null,
  atlas: null as TrackedTexture | null
});
const draw = (graph: FrameGraph, frame: Frame) =>
  graph.render(frame, { k: 1, x: 0, y: 0 }, { width: W / DPR, height: H / DPR, dpr: DPR }, [0, 0, 0, 0]);
// what the prepare reserves for the frame's per-screen targets (prepare.ts: targetReserve with hasMaskedGroup)
const reserveFor = (frame: Frame) => targetReserve(W, H, 4, DPR, hasMaskedGroup(frame.batches), false);

describe("framegraph per-screen memory (W3c BUDGET)", () => {
  it("finds masked groups anywhere in the tree", () => {
    expect(hasMaskedGroup([fill()])).toBe(false);
    expect(hasMaskedGroup([group(null, 0.5)])).toBe(false);
    expect(hasMaskedGroup([group([{ fill: fill(), white: true }])])).toBe(true);
    expect(hasMaskedGroup([{ ...group(null, 0.5), children: [group([{ fill: fill(), white: true }])] }])).toBe(true);
  });

  it("allocates for a masked frame exactly the targets the steady share reserved, and nothing outside them", () => {
    const { device, graph } = setup();
    const idle = device.memory(); // the framegraph's own unit buffers: resident, outside any frame
    const masked = frameOf([group([{ fill: fill(), white: true }])]);
    draw(graph, masked);
    const memory = device.memory();
    // group target (8 B/px) and the R8 mask coverage beside it (1 B/px), both tracked as targets
    expect(memory.targets).toBe(targetBytes(W, H, 0) + W * H * MASK_BYTES_PER_PIXEL);
    expect(memory.targets).toBe(reserveFor(masked));
    // nothing else appeared: what the next prepare counts as resident (prepare.ts residentBytes: total - targets - the
    // frame) is still the unit buffers alone
    expect(memory.total - memory.targets).toBe(idle.total);
  });

  it("keeps a frame planned to the steady budget within it once the masked group draws", () => {
    const { device, graph } = setup();
    const masked = frameOf([group([{ fill: fill(), white: true }])]);
    const resident = device.memory().total; // residentBytes with no frame yet: the unit buffers
    // a prepare spends its whole steady share: everything the budget leaves past the reserve
    const own = GPU_BUDGET - steadyReserve(reserveFor(masked), resident);
    draw(graph, masked);
    const steady = device.memory().total + own;
    // W3b's accounting (the group target alone reserved, the mask a 4 B/px texture) ended 12.06 MiB over it here
    expect(steady).toBe(GPU_BUDGET - STEADY_SLACK);
  });

  it("gives the mask back once a frame without masked groups is on screen", () => {
    const { device, graph } = setup();
    draw(graph, frameOf([group([{ fill: fill(), white: true }])]));
    const plain = frameOf([group(null, 0.5)]);
    draw(graph, plain);
    expect(device.memory().targets).toBe(targetBytes(W, H, 0));
    expect(device.memory().targets).toBe(reserveFor(plain));
    draw(graph, frameOf([group([{ fill: fill(), white: true }])])); // a new masked frame takes it again
    expect(device.memory().targets).toBe(targetBytes(W, H, 0) + W * H * MASK_BYTES_PER_PIXEL);
    graph.dispose();
    expect(device.memory().targets).toBe(0);
  });
});
