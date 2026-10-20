// Raw WebGL2 device: owns the context, tracks every allocation for memory telemetry and survives context loss.
// memory() is an allocation estimate from tracked uploads (mipmaps and MSAA included), not measured GPU usage.
import { targetBytes } from "./budget";

export interface DeviceEvents {
  lost(): void;
  restored(): void;
}
export interface TrackedBuffer {
  kind: "buffer";
  label: string;
  handle: WebGLBuffer;
  bytes: number;
  target: number;
}
export interface TrackedTexture {
  kind: "texture";
  label: string;
  handle: WebGLTexture;
  bytes: number;
  width: number;
  height: number;
}
export interface TrackedTarget {
  kind: "target";
  label: string;
  framebuffer: WebGLFramebuffer;
  color: WebGLRenderbuffer | null;
  depthStencil: WebGLRenderbuffer;
  resolve: WebGLFramebuffer;
  texture: WebGLTexture;
  bytes: number;
  width: number;
  height: number;
  samples: number;
}
export interface TrackedProgram {
  kind: "program";
  label: string;
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
  attributes: Record<string, number>;
  bytes: 0;
}
export type Tracked = TrackedBuffer | TrackedTexture | TrackedTarget | TrackedProgram;
export type TextureSource = TexImageSource | { width: number; height: number; data: ArrayBufferView | null };

const defaults: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: true,
  stencil: true,
  depth: false,
  preserveDrawingBuffer: false,
  powerPreference: "high-performance"
};

export class GpuDevice {
  gl: WebGL2RenderingContext;
  maxTextureSize = 4096;
  maxSamples = 0;
  lost = false;
  disposed = false;
  private tracked = new Set<Tracked>();
  private high = 0;
  private attributes: WebGLContextAttributes;
  private onLost = (event: Event) => {
    if (this.disposed) return;
    event.preventDefault();
    this.lost = true;
    this.tracked.clear();
    this.events.lost();
  };
  private onRestored = () => {
    if (this.disposed) return;
    const gl = this.canvas.getContext("webgl2", this.attributes) as WebGL2RenderingContext | null;
    if (!gl) return;
    this.gl = gl;
    this.lost = false;
    this.limits();
    this.events.restored();
  };

  constructor(
    private canvas: HTMLCanvasElement,
    private events: DeviceEvents,
    attributes?: WebGLContextAttributes
  ) {
    this.attributes = { ...defaults, ...attributes };
    const gl = canvas.getContext("webgl2", this.attributes) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 context unavailable");
    this.gl = gl;
    this.limits();
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.onRestored);
  }

  private limits(): void {
    this.maxTextureSize = Number(this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE)) || 4096;
    this.maxSamples = Number(this.gl.getParameter(this.gl.MAX_SAMPLES)) || 0;
  }

  private usable(): void {
    if (this.disposed) throw new Error("GpuDevice disposed");
    if (this.lost) throw new Error("GPU context lost");
  }

  buffer(label: string, data: ArrayBufferView, target?: number, usage?: number): TrackedBuffer {
    this.usable();
    const gl = this.gl;
    const bufferTarget = target ?? gl.ARRAY_BUFFER;
    const handle = gl.createBuffer()!;
    gl.bindBuffer(bufferTarget, handle);
    gl.bufferData(bufferTarget, data, usage ?? gl.STATIC_DRAW);
    const buffer: TrackedBuffer = { kind: "buffer", label, handle, bytes: data.byteLength, target: bufferTarget };
    this.track(buffer);
    return buffer;
  }

  updateBuffer(buffer: TrackedBuffer, data: ArrayBufferView): void {
    this.usable();
    this.gl.bindBuffer(buffer.target, buffer.handle);
    this.gl.bufferData(buffer.target, data, this.gl.DYNAMIC_DRAW);
    buffer.bytes = data.byteLength;
    this.high = Math.max(this.high, this.memory().total);
  }

  texture(
    label: string,
    source: TextureSource,
    // rows: upload only the source's top rows (a WebGL2 sub-rectangle upload; the texture is that tall)
    options: { repeat?: boolean; mipmap?: boolean; premultiply?: boolean; rows?: number } = {}
  ): TrackedTexture {
    this.usable();
    const gl = this.gl;
    const sized = source as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number };
    const width = sized.width || sized.naturalWidth || 0;
    const full = sized.height || sized.naturalHeight || 0;
    const height = options.rows !== undefined ? Math.max(1, Math.min(full, Math.ceil(options.rows))) : full;
    const handle = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, handle);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, options.premultiply ?? true);
    try {
      if ("data" in source)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, source.data);
      else if (height < full)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch (error) {
      gl.deleteTexture(handle);
      throw error; // tainted canvas/image SecurityError: caller falls back
    } finally {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
    const wrap = options.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, options.mipmap ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (options.mipmap) gl.generateMipmap(gl.TEXTURE_2D);
    const bytes = Math.round(width * height * 4 * (options.mipmap ? 4 / 3 : 1));
    const texture: TrackedTexture = { kind: "texture", label, handle, bytes, width, height };
    this.track(texture);
    return texture;
  }

  // Multisampled colour + depth/stencil framebuffer, resolved into a sampleable texture by blitFramebuffer.
  target(label: string, width: number, height: number, sampleCount = 4): TrackedTarget {
    this.usable();
    const gl = this.gl;
    const samples = Math.max(0, Math.min(sampleCount, this.maxSamples));
    const framebuffer = gl.createFramebuffer()!;
    const color = samples ? gl.createRenderbuffer()! : null;
    const depthStencil = gl.createRenderbuffer()!;
    const resolve = samples ? gl.createFramebuffer()! : framebuffer;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthStencil);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH24_STENCIL8, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depthStencil);
    if (color) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, color);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    } else {
      // A single-sample target is already sampleable: draw into the texture, without another colour buffer or blit.
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    }
    const drawComplete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    if (samples) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, resolve);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    }
    const resolveComplete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const result: TrackedTarget = {
      kind: "target",
      label,
      framebuffer,
      color,
      depthStencil,
      resolve,
      texture,
      width,
      height,
      samples,
      bytes: targetBytes(width, height, samples)
    };
    if (!drawComplete || !resolveComplete) {
      this.destroy(result);
      throw new Error(`Incomplete framebuffer ${label}`);
    }
    this.track(result);
    return result;
  }

  program(label: string, vertex: string, fragment: string): TrackedProgram {
    this.usable();
    const gl = this.gl;
    const shaders: WebGLShader[] = [];
    const cleanup = () => {
      for (const shader of shaders) gl.deleteShader(shader);
    };
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment]
    ] as const) {
      const shader = gl.createShader(type)!;
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        cleanup();
        throw new Error(`${label} shader: ${log}`);
      }
    }
    const program = gl.createProgram()!;
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      cleanup();
      throw new Error(`${label} link: ${log}`);
    }
    for (const shader of shaders) gl.detachShader(program, shader);
    cleanup();
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    const attributes: Record<string, number> = {};
    const uniformCount = Number(gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS));
    for (let i = 0; i < uniformCount; i++) {
      const name = gl.getActiveUniform(program, i)?.name.replace(/\[0\]$/, "");
      if (name) uniforms[name] = gl.getUniformLocation(program, name);
    }
    const attributeCount = Number(gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES));
    for (let i = 0; i < attributeCount; i++) {
      const name = gl.getActiveAttrib(program, i)?.name;
      if (name) attributes[name] = gl.getAttribLocation(program, name);
    }
    const result: TrackedProgram = { kind: "program", label, program, uniforms, attributes, bytes: 0 };
    this.tracked.add(result);
    return result;
  }

  release(resource: Tracked | null | undefined): void {
    if (!resource || !this.tracked.delete(resource)) return;
    if (!this.lost) this.destroy(resource);
  }

  private destroy(resource: Tracked): void {
    const gl = this.gl;
    if (resource.kind === "buffer") gl.deleteBuffer(resource.handle);
    else if (resource.kind === "texture") gl.deleteTexture(resource.handle);
    else if (resource.kind === "program") gl.deleteProgram(resource.program);
    else {
      gl.deleteFramebuffer(resource.framebuffer);
      if (resource.resolve !== resource.framebuffer) gl.deleteFramebuffer(resource.resolve);
      if (resource.color) gl.deleteRenderbuffer(resource.color);
      gl.deleteRenderbuffer(resource.depthStencil);
      gl.deleteTexture(resource.texture);
    }
  }

  memory(): { buffers: number; textures: number; targets: number; total: number; count: number } {
    const sums = { buffers: 0, textures: 0, targets: 0, total: 0, count: this.tracked.size };
    for (const resource of this.tracked) {
      if (resource.kind === "buffer") sums.buffers += resource.bytes;
      else if (resource.kind === "texture") sums.textures += resource.bytes;
      else if (resource.kind === "target") sums.targets += resource.bytes;
      sums.total += resource.bytes;
    }
    return sums;
  }

  // Highest tracked total since creation (or the last resetPeak), including transient old+new frame overlap.
  peak(): number {
    return Math.max(this.high, this.memory().total);
  }

  resetPeak(): void {
    this.high = this.memory().total;
  }

  private track(resource: Tracked): void {
    this.tracked.add(resource);
    this.high = Math.max(this.high, this.memory().total);
  }

  // Backing store follows CSS size × DPR (capped at 2 and at MAX_TEXTURE_SIZE). Returns true when it changed.
  resize(cssWidth: number, cssHeight: number, dpr: number): boolean {
    const ratio = Math.min(dpr > 0 ? dpr : 1, 2);
    const width = Math.max(1, Math.min(this.maxTextureSize, Math.round(cssWidth * ratio)));
    const height = Math.max(1, Math.min(this.maxTextureSize, Math.round(cssHeight * ratio)));
    if (this.canvas.width === width && this.canvas.height === height) return false;
    this.canvas.width = width;
    this.canvas.height = height;
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    for (const resource of [...this.tracked]) this.release(resource);
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    if (!this.lost) this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.disposed = true;
  }
}
