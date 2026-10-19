import { describe, expect, it } from "vitest";
import { GpuDevice } from "./device";

function fakeGl(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const params: Record<number, unknown> = { 1: 4096, 2: 4 };
  const gl: Record<string, unknown> = {
    MAX_TEXTURE_SIZE: 1,
    MAX_SAMPLES: 2,
    ARRAY_BUFFER: 10,
    STATIC_DRAW: 11,
    DYNAMIC_DRAW: 12,
    TEXTURE_2D: 20,
    REPEAT: 21,
    CLAMP_TO_EDGE: 22,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 23,
    FRAMEBUFFER_COMPLETE: 30,
    COMPILE_STATUS: 40,
    LINK_STATUS: 41,
    ACTIVE_UNIFORMS: 42,
    ACTIVE_ATTRIBUTES: 43,
    calls,
    status: 30,
    compiled: true,
    getParameter: (name: number) => params[name],
    getExtension: () => ({ loseContext: () => calls.push("loseContext") }),
    checkFramebufferStatus: () => gl.status,
    getShaderParameter: () => gl.compiled,
    getShaderInfoLog: () => "bad token",
    getProgramParameter: (_: unknown, name: number) => (name === 41 ? true : name === 42 ? 2 : 1),
    getActiveUniform: (_: unknown, i: number) => ({ name: ["u_matrix", "u_dash[0]"][i] }),
    getActiveAttrib: () => ({ name: "a_position" }),
    getUniformLocation: (_: unknown, name: string) => ({ name }),
    getAttribLocation: () => 0,
    ...overrides
  };
  return new Proxy(gl, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        calls.push(key);
        return key.startsWith("create") ? { args } : undefined;
      };
    }
  }) as Record<string, unknown> & { calls: string[]; status: number; compiled: boolean };
}

function fakeCanvas(gl: unknown) {
  const listeners = new Map<string, (event: Event) => void>();
  const canvas = {
    width: 300,
    height: 150,
    context: gl,
    getContext: () => canvas.context,
    addEventListener: (type: string, listener: (event: Event) => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
    fire(type: string) {
      const event = new Event(type, { cancelable: true });
      listeners.get(type)?.(event);
      return event.defaultPrevented;
    }
  };
  return canvas;
}

function setup(overrides?: Record<string, unknown>) {
  const gl = fakeGl(overrides);
  const canvas = fakeCanvas(gl);
  const log: string[] = [];
  const device = new GpuDevice(canvas as unknown as HTMLCanvasElement, {
    lost: () => log.push("lost"),
    restored: () => log.push("restored")
  });
  return { gl, canvas, log, device };
}

describe("GpuDevice", () => {
  it("throws when WebGL2 is unavailable", () => {
    const canvas = fakeCanvas(null);
    expect(() => new GpuDevice(canvas as unknown as HTMLCanvasElement, { lost() {}, restored() {} })).toThrow(
      "WebGL2 context unavailable"
    );
  });

  it("tracks buffer, texture and target memory", () => {
    const { device } = setup();
    const buffer = device.buffer("fills", new Float32Array(10));
    device.updateBuffer(buffer, new Float32Array(25));
    device.texture("tile", { width: 8, height: 8, data: null }, { mipmap: true, repeat: true });
    device.target("group", 10, 10);
    expect(device.memory()).toEqual({
      buffers: 100,
      textures: 341,
      targets: 10 * 10 * 4 * 4 * 2 + 400,
      total: 100 + 341 + 3600,
      count: 3
    });
  });

  it("resets premultiply and deletes the texture when upload is tainted", () => {
    const { gl, device } = setup({
      texImage2D: () => {
        throw new DOMException("tainted", "SecurityError");
      }
    });
    expect(() => device.texture("image", { width: 4, height: 4, data: null })).toThrow("tainted");
    expect(gl.calls).toContain("deleteTexture");
    expect(gl.calls.filter(call => call === "pixelStorei")).toHaveLength(2);
    expect(device.memory().count).toBe(0);
  });

  it("rejects incomplete framebuffers and failed shaders without leaking", () => {
    const { gl, device } = setup();
    gl.status = 0;
    expect(() => device.target("group", 4, 4)).toThrow("Incomplete framebuffer group");
    expect(gl.calls.filter(call => call === "deleteFramebuffer")).toHaveLength(2);
    gl.compiled = false;
    expect(() => device.program("fill", "v", "f")).toThrow("fill shader: bad token");
    expect(gl.calls).toContain("deleteShader");
    expect(device.memory().count).toBe(0);
  });

  it("maps uniforms without array suffixes", () => {
    const { device } = setup();
    const program = device.program("stroke", "v", "f");
    expect(Object.keys(program.uniforms)).toEqual(["u_matrix", "u_dash"]);
    expect(program.attributes).toEqual({ a_position: 0 });
  });

  it("releases idempotently", () => {
    const { gl, device } = setup();
    const buffer = device.buffer("b", new Uint8Array(4));
    device.release(buffer);
    device.release(buffer);
    device.release(null);
    expect(gl.calls.filter(call => call === "deleteBuffer")).toHaveLength(1);
  });

  it("forgets resources on context loss and recovers on restore", () => {
    const { gl, canvas, log, device } = setup();
    device.buffer("b", new Uint8Array(4));
    expect(canvas.fire("webglcontextlost")).toBe(true);
    expect(device.memory()).toMatchObject({ total: 0, count: 0 });
    expect(() => device.buffer("b", new Uint8Array(4))).toThrow("GPU context lost");
    expect(gl.calls).not.toContain("deleteBuffer");
    canvas.fire("webglcontextrestored");
    expect(log).toEqual(["lost", "restored"]);
    expect(device.buffer("b", new Uint8Array(4)).bytes).toBe(4);
  });

  it("caps DPR and texture size on resize", () => {
    const { canvas, device } = setup();
    expect(device.resize(1000, 500, 3)).toBe(true);
    expect([canvas.width, canvas.height]).toEqual([2000, 1000]);
    expect(device.resize(1000, 500, 2)).toBe(false);
    device.resize(3000, 10, 2);
    expect(canvas.width).toBe(4096);
  });

  it("disposes once and ignores later context events", () => {
    const { gl, canvas, log, device } = setup();
    device.dispose();
    device.dispose();
    expect(gl.calls.filter(call => call === "loseContext")).toHaveLength(1);
    expect(canvas.fire("webglcontextlost")).toBe(false);
    expect(log).toEqual([]);
    expect(() => device.texture("t", { width: 1, height: 1, data: null })).toThrow("GpuDevice disposed");
  });
});

it("single-sample targets share their draw/resolve texture and release each allocation once", () => {
  const { gl, device } = setup();
  const target = device.target("direct", 10, 20, 0);
  expect(target.framebuffer).toBe(target.resolve);
  expect(target.color).toBeNull();
  expect(target.bytes).toBe(10 * 20 * 8);
  expect(gl.calls.filter(call => call === "createFramebuffer")).toHaveLength(1);
  device.release(target);
  expect(gl.calls.filter(call => call === "deleteFramebuffer")).toHaveLength(1);
  expect(gl.calls.filter(call => call === "deleteRenderbuffer")).toHaveLength(1);
  expect(device.memory().total).toBe(0);
});
