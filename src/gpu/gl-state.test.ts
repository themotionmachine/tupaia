import { describe, expect, it } from "vitest";
import { GlState } from "./gl-state";

// Models the GL state the cache shadows; snapshot() is the effective state a draw would see.
function modelGl() {
  const vaos = new Map<unknown, Map<number, Record<string, unknown>>>();
  const s = {
    program: null as unknown,
    vao: null as unknown,
    arrayBuffer: null as unknown,
    color: [true, true, true, true] as boolean[],
    writeMask: 0xff,
    func: [0, 0, 0xff],
    front: [0, 0, 0],
    back: [0, 0, 0],
    uniforms: new Map<unknown, number[]>(),
  };
  let calls = 0;
  const attrs = () => {
    if (!vaos.has(s.vao)) vaos.set(s.vao, new Map());
    return vaos.get(s.vao)!;
  };
  const attr = (location: number) => {
    const table = attrs();
    if (!table.has(location)) table.set(location, {});
    return table.get(location)!;
  };
  const gl = {
    FRONT: 1028,
    BACK: 1029,
    FRONT_AND_BACK: 1032,
    ARRAY_BUFFER: 34962,
    FLOAT: 5126,
    useProgram: (p: unknown) => (calls++, (s.program = p)),
    bindVertexArray: (v: unknown) => (calls++, (s.vao = v)),
    bindBuffer: (_: number, b: unknown) => (calls++, (s.arrayBuffer = b)),
    colorMask: (...rgba: boolean[]) => (calls++, (s.color = rgba)),
    stencilMask: (m: number) => (calls++, (s.writeMask = m)),
    stencilFunc: (...f: number[]) => (calls++, (s.func = f)),
    stencilOp: (...o: number[]) => (calls++, (s.front = o), (s.back = o)),
    stencilOpSeparate: (face: number, ...o: number[]) => {
      calls++;
      if (face !== 1029) s.front = o;
      if (face !== 1028) s.back = o;
    },
    uniform1i: (l: unknown, v: number) => (calls++, s.uniforms.set(l, [v])),
    uniform1f: (l: unknown, v: number) => (calls++, s.uniforms.set(l, [Math.fround(v)])),
    uniform1fv: (l: unknown, v: Float32Array) => (calls++, s.uniforms.set(l, [...v])),
    uniform4fv: (l: unknown, v: ArrayLike<number>) => (calls++, s.uniforms.set(l, Array.from(v, Math.fround))),
    uniformMatrix3fv: (l: unknown, _: boolean, v: Float32Array) => (calls++, s.uniforms.set(l, [...v])),
    enableVertexAttribArray: (l: number) => (calls++, (attr(l).enabled = true)),
    vertexAttribPointer: (l: number, size: number, _t: number, _n: boolean, stride: number, offset: number) => {
      calls++;
      Object.assign(attr(l), { buffer: s.arrayBuffer, size, stride, offset });
    },
    vertexAttribDivisor: (l: number, divisor: number) => (calls++, (attr(l).divisor = divisor)),
  };
  // ARRAY_BUFFER is left out: draws read the buffer captured by each pointer, not the current binding.
  const snapshot = () =>
    JSON.stringify({
      ...s,
      arrayBuffer: undefined,
      uniforms: [...s.uniforms].filter(([location]) => location !== null), // GL ignores a null location
      attributes: [...attrs()].sort(([a], [b]) => a - b),
    });
  return { gl: gl as unknown as WebGL2RenderingContext, snapshot, calls: () => calls, state: s };
}

// The uncached sequence the frame graph issued before the cache existed.
function direct(gl: WebGL2RenderingContext): Omit<GlState, "counts" | "reset"> {
  const g = gl as unknown as Record<string, (...args: unknown[]) => void>;
  return {
    useProgram: p => g.useProgram(p),
    bindVertexArray: v => g.bindVertexArray(v),
    colorMask: on => g.colorMask(on, on, on, on),
    stencilMask: m => g.stencilMask(m),
    stencilFunc: (...f) => g.stencilFunc(...f),
    stencilOp: (...o) => g.stencilOp(...o),
    stencilOpSeparate: (...o) => g.stencilOpSeparate(...o),
    uniform1i: (l, v) => g.uniform1i(l, v),
    uniform1f: (l, v) => g.uniform1f(l, v),
    uniform1fv: (l, v) => g.uniform1fv(l, v),
    uniform4fv: (l, v) => g.uniform4fv(l, v),
    uniformMatrix3fv: (l, v) => g.uniformMatrix3fv(l, false, v),
    attribute: (location, buffer, size, stride, offset, divisor) => {
      g.bindBuffer(gl.ARRAY_BUFFER, buffer);
      g.enableVertexAttribArray(location);
      g.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
      g.vertexAttribDivisor(location, divisor);
    },
  } as Omit<GlState, "counts" | "reset">;
}

function random(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

describe("GlState", () => {
  it("leaves the effective state at every draw identical to the uncached sequence, with fewer calls", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rand = random(seed);
      const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)];
      const cached = modelGl();
      const plain = modelGl();
      const state = new GlState(cached.gl);
      state.reset();
      const reference = direct(plain.gl);
      const programs = [{ p: 1 }, { p: 2 }];
      const vaos = [{ v: 1 }, { v: 2 }];
      const buffers = [{ b: 1 }, { b: 2 }];
      const locations = [{ u: 1 }, { u: 2 }, null];
      const scratch = new Float32Array(9);
      const ops = ["KEEP", "INCR", "ZERO"].map((_, i) => 7680 + i);
      for (let step = 0; step < 400; step++) {
        const choice = Math.floor(rand() * 11);
        const apply = (target: Omit<GlState, "counts" | "reset">) => (args: unknown[]) =>
          (target[["useProgram", "bindVertexArray", "colorMask", "stencilMask", "stencilFunc", "stencilOp",
            "stencilOpSeparate", "uniform1f", "uniform4fv", "uniformMatrix3fv", "attribute"][choice] as keyof typeof target] as
            (...a: unknown[]) => void)(...args);
        let args: unknown[];
        if (choice === 0) args = [pick(programs)];
        else if (choice === 1) args = [pick(vaos)];
        else if (choice === 2) args = [rand() < 0.5];
        else if (choice === 3) args = [pick([0, 0x01, 0x7f, 0xff])];
        else if (choice === 4) args = [pick([519, 514]), pick([0, 0x80]), pick([0x7f, 0xff])];
        else if (choice === 5) args = [pick(ops), pick(ops), pick(ops)];
        else if (choice === 6) args = [pick([1028, 1029, 1032]), pick(ops), pick(ops), pick(ops)];
        else if (choice === 7) args = [pick(locations), pick([0.5, 1, 2])];
        else if (choice === 8) args = [pick(locations), [pick([0, 1]), 0, 0, pick([0.5, 1])]];
        else if (choice === 9) {
          scratch[0] = pick([1, 2]); // the same scratch array, mutated between calls
          args = [pick(locations), scratch];
        } else args = [pick([0, 1, 2]), pick(buffers), 2, pick([8, 20]), pick([0, 16, 40]), pick([0, 1])];
        apply(state)(args);
        apply(reference)(args);
        if (rand() < 0.3) expect(cached.snapshot()).toBe(plain.snapshot()); // a draw here sees the same state
      }
      expect(cached.snapshot()).toBe(plain.snapshot());
      expect(cached.calls()).toBeLessThan(plain.calls());
      expect(state.counts.skipped).toBeGreaterThan(0);
    }
  });

  it("re-uploads a reused scratch matrix when its content changes", () => {
    const model = modelGl();
    const state = new GlState(model.gl);
    const location = { u: 1 };
    const matrix = new Float32Array(9);
    state.uniformMatrix3fv(location, matrix);
    matrix[4] = 3;
    state.uniformMatrix3fv(location, matrix);
    expect(model.state.uniforms.get(location)![4]).toBe(3);
    state.uniformMatrix3fv(location, matrix);
    expect(state.counts).toEqual({ issued: 2, skipped: 1 });
  });

  it("re-issues everything after reset, so state changed outside the cache is overwritten", () => {
    const model = modelGl();
    const state = new GlState(model.gl);
    state.stencilMask(0);
    state.useProgram({ p: 1 });
    model.gl.stencilMask(0xff); // e.g. another renderer between frames
    model.gl.useProgram(null);
    state.reset();
    state.stencilMask(0);
    state.useProgram({ p: 1 });
    expect(model.state.writeMask).toBe(0);
    expect(model.state.program).toEqual({ p: 1 });
  });

  it("tracks attribute pointers per VAO", () => {
    const model = modelGl();
    const state = new GlState(model.gl);
    const buffer = { b: 1 };
    const before = model.calls();
    state.bindVertexArray({ v: 1 });
    state.attribute(0, buffer, 2, 8, 0, 0);
    state.bindVertexArray({ v: 2 });
    state.attribute(0, buffer, 2, 8, 0, 0); // a different VAO has no pointer yet
    expect(model.calls() - before).toBe(2 + 1 + 3 + 3); // binds, one bindBuffer, then enable+pointer+divisor twice
    state.attribute(0, buffer, 2, 8, 0, 0);
    expect(model.calls() - before).toBe(9);
  });
});
