// Per-frame shadow of the WebGL state the frame graph sets per batch. Each setter issues its GL call only when the
// value differs from what this frame already set, so the call sequence is the uncached sequence minus no-ops: draw
// order and the effective state at every draw are unchanged. reset() forgets everything (start of each frame, and
// after anything outside the cache may have touched GL), after which every setter issues again.
// Profile basis: P2-DRAW-COST.md (100k full world, ~2900 batches, per-call overhead dominated the frame callback).

type Values = number[];

interface Pointer {
  buffer: WebGLBuffer;
  size: number;
  stride: number;
  offset: number;
  divisor: number;
}

export class GlState {
  readonly counts = { issued: 0, skipped: 0 };
  private program: WebGLProgram | null | undefined;
  private vao: WebGLVertexArrayObject | null | undefined;
  private arrayBuffer: WebGLBuffer | null | undefined;
  private colorWrites: boolean | undefined;
  private writeMask: number | undefined;
  private func: Values | null = null;
  private front: Values | null = null;
  private back: Values | null = null;
  private uniforms = new Map<WebGLUniformLocation, Values>();
  // attribute pointers and enables live in the VAO, keyed by VAO then location
  private pointers = new Map<WebGLVertexArrayObject, Map<number, Pointer>>();

  constructor(private gl: WebGL2RenderingContext) {}

  // `gl` follows the device across context restore.
  reset(gl = this.gl): void {
    this.gl = gl;
    this.program = this.vao = this.arrayBuffer = undefined;
    this.colorWrites = this.writeMask = undefined;
    this.func = this.front = this.back = null;
    this.uniforms.clear();
    this.pointers.clear();
  }

  private changed(same: boolean): boolean {
    if (same) this.counts.skipped++;
    else this.counts.issued++;
    return !same;
  }

  useProgram(program: WebGLProgram): void {
    if (this.changed(this.program === program)) {
      this.program = program;
      this.gl.useProgram(program);
    }
  }

  bindVertexArray(vao: WebGLVertexArrayObject | null): void {
    if (this.changed(this.vao === vao)) {
      this.vao = vao;
      this.gl.bindVertexArray(vao);
    }
  }

  colorMask(on: boolean): void {
    if (this.changed(this.colorWrites === on)) {
      this.colorWrites = on;
      this.gl.colorMask(on, on, on, on);
    }
  }

  stencilMask(mask: number): void {
    if (this.changed(this.writeMask === mask)) {
      this.writeMask = mask;
      this.gl.stencilMask(mask);
    }
  }

  stencilFunc(func: number, ref: number, mask: number): void {
    if (this.changed(same(this.func, func, ref, mask))) {
      this.func = [func, ref, mask];
      this.gl.stencilFunc(func, ref, mask);
    }
  }

  stencilOp(fail: number, zfail: number, zpass: number): void {
    if (this.changed(same(this.front, fail, zfail, zpass) && same(this.back, fail, zfail, zpass))) {
      this.front = [fail, zfail, zpass];
      this.back = [fail, zfail, zpass];
      this.gl.stencilOp(fail, zfail, zpass);
    }
  }

  stencilOpSeparate(face: number, fail: number, zfail: number, zpass: number): void {
    const gl = this.gl;
    const front = face === gl.FRONT || face === gl.FRONT_AND_BACK;
    const back = face === gl.BACK || face === gl.FRONT_AND_BACK;
    const stale = (front && !same(this.front, fail, zfail, zpass)) || (back && !same(this.back, fail, zfail, zpass));
    if (this.changed(!stale)) {
      if (front) this.front = [fail, zfail, zpass];
      if (back) this.back = [fail, zfail, zpass];
      gl.stencilOpSeparate(face, fail, zfail, zpass);
    }
  }

  // Values are compared by content, never by array identity: callers reuse scratch arrays.
  private uniform(location: WebGLUniformLocation | null, values: ArrayLike<number>): boolean {
    if (!location) return false; // inactive uniform: the GL call is a no-op
    const cached = this.uniforms.get(location);
    let equal = !!cached && cached.length === values.length;
    for (let i = 0; equal && i < values.length; i++) equal = Object.is(cached![i], values[i]);
    if (!this.changed(equal)) return false;
    this.uniforms.set(location, Array.from(values));
    return true;
  }

  uniform1i(location: WebGLUniformLocation | null, value: number): void {
    if (this.uniform(location, [value])) this.gl.uniform1i(location, value);
  }

  uniform1f(location: WebGLUniformLocation | null, value: number): void {
    if (this.uniform(location, [value])) this.gl.uniform1f(location, value);
  }

  uniform1fv(location: WebGLUniformLocation | null, values: Float32Array): void {
    if (this.uniform(location, values)) this.gl.uniform1fv(location, values);
  }

  uniform4fv(location: WebGLUniformLocation | null, values: Float32List): void {
    if (this.uniform(location, values)) this.gl.uniform4fv(location, values);
  }

  uniformMatrix3fv(location: WebGLUniformLocation | null, values: Float32Array): void {
    if (this.uniform(location, values)) this.gl.uniformMatrix3fv(location, false, values);
  }

  // Float attribute on the bound VAO. bindBuffer is only needed when the pointer itself is re-specified.
  attribute(
    location: number,
    buffer: WebGLBuffer,
    size: number,
    stride: number,
    offset: number,
    divisor: number
  ): void {
    const gl = this.gl;
    const vao = this.vao;
    let table = vao ? this.pointers.get(vao) : undefined;
    if (vao && !table) {
      table = new Map();
      this.pointers.set(vao, table);
    }
    const cached = table?.get(location);
    if (
      this.changed(
        !!cached &&
          cached.buffer === buffer &&
          cached.size === size &&
          cached.stride === stride &&
          cached.offset === offset &&
          cached.divisor === divisor
      )
    ) {
      if (this.arrayBuffer !== buffer) {
        this.arrayBuffer = buffer;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      }
      if (!cached) gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
      if (!cached || cached.divisor !== divisor) gl.vertexAttribDivisor(location, divisor);
      table?.set(location, { buffer, size, stride, offset, divisor });
    }
  }
}

function same(cached: Values | null, a: number, b: number, c: number): boolean {
  return !!cached && cached[0] === a && cached[1] === b && cached[2] === c;
}
