// DOM-ordered passes over prepared batches: stencil-then-cover fills, instanced strokes/sprites/glyphs, compat
// images, and opacity/mask groups composited from an offscreen target. Camera changes only touch uniforms.
// Stencil layout: bit 0x80 = group mask, bits 0x7F = fill winding (bit 0x01 doubles as per-path stroke coverage).
import { TARGET_BUDGET, targetSamples } from "./budget";
import { type Camera, screenToClip, type Viewport, visibleWorld, worldScissor, worldToClip } from "./camera";
import type { GpuDevice, TrackedBuffer, TrackedProgram, TrackedTarget, TrackedTexture } from "./device";
import { outsideView } from "./geometry";
import { GlState } from "./gl-state";
import { MARKER_FLOATS, type MarkerInstances } from "./markers";
import { hatchUvAtZoom } from "./raster";
import type { Rgba } from "./scene";
import { fill, glyph, image, marker, sprite, stroke } from "./shaders";

export interface FillBatch {
  bounds?: Rect4 | null;
  kind: "fill";
  first: number;
  count: number;
  color: Rgba | null;
  tile: { texture: TrackedTexture; worldToUv: Float32Array; referenceZoom?: number } | null;
  evenOdd: boolean;
}
export interface StrokeBatch {
  bounds?: Rect4 | null;
  kind: "stroke";
  first: number;
  count: number;
  color: Rgba;
  width: number;
  dashes: Float32Array;
  dashCount: number;
  dashPeriod: number;
  dashOffset: number;
  dashCap?: number; // capCode of stroke-linecap, applied to every dash end
}
export interface SpriteBatch {
  kind: "sprites";
  first: number;
  count: number;
  texture: TrackedTexture;
}
export interface GlyphBatch {
  kind: "glyphs";
  first: number;
  count: number;
}
// Compat rasters are cropped to their opaque pixels: `rect` is the drawn (cropped) world rect, texture null when the
// run is fully transparent there.
export interface ImageBatch {
  kind: "image";
  opacity?: number;
  texture: TrackedTexture | null;
  rect: [number, number, number, number];
  screen: boolean;
  // settle-time sharper raster valid for `covers` (the refined visible region), used instead of — never on top of —
  // the base raster while the view stays inside it
  detail: { texture: TrackedTexture | null; rect: [number, number, number, number]; covers: Rect4 } | null;
}
type Rect4 = [number, number, number, number];

// Which raster an image batch draws for the visible world box: detail only when it covers the whole view.
export function imageSource(batch: ImageBatch, view: Rect4): Pick<ImageBatch, "texture" | "rect"> {
  const detail = batch.detail;
  const [x0, y0, x1, y1] = view;
  const covers = detail?.covers;
  const inside =
    !batch.screen &&
    covers &&
    x0 >= covers[0] &&
    y0 >= covers[1] &&
    x1 <= covers[0] + covers[2] &&
    y1 <= covers[1] + covers[3];
  return inside ? detail! : batch;
}
export interface GroupBatch {
  kind: "group";
  opacity: number;
  mask: { fill: FillBatch; white: boolean }[] | null;
  children: Batch[];
}
// Slot for the live trade markers; instances come per frame from render(), not from the prepared frame.
export interface MarkerBatch {
  kind: "markers";
}
export type Batch = FillBatch | StrokeBatch | SpriteBatch | GlyphBatch | ImageBatch | GroupBatch | MarkerBatch;

export interface Frame {
  batches: Batch[];
  fans: TrackedBuffer | null; // vec2 triangles
  caps: TrackedBuffer | null;
  segments: TrackedBuffer | null; // x0 y0 x1 y1 distance
  sprites: TrackedBuffer | null; // x y s u0 v0 u1 v1
  glyphs: TrackedBuffer | null; // GLYPH_FLOATS per instance
  atlas: TrackedTexture | null;
}

// True only when a batch provably writes no on-screen pixel: a fill/stroke with known bounds wholly outside the view
// (the same conservative test batches() culls with) or with nothing to draw, an empty sprite/glyph run, or a group whose
// children are all empty or whose mask sets no on-view bit. Images and markers are never assumed empty.
export function emptyOnView(frame: Frame, batch: Batch, visible: Rect4, pad: number): boolean {
  const off = (b: FillBatch | StrokeBatch) => !!b.bounds && outsideView(b.bounds, visible, pad);
  switch (batch.kind) {
    case "fill":
      return !frame.fans || !batch.count || off(batch);
    case "stroke":
      return !frame.segments || !batch.count || off(batch);
    case "sprites":
      return !frame.sprites || !batch.count;
    case "glyphs":
      return !frame.glyphs || !frame.atlas || !batch.count;
    case "group":
      // Mask bit 0x80 starts clear and only white items set it, so with no drawable white item on view every masked
      // child fragment fails the stencil test.
      if (batch.mask && batch.mask.every(({ fill, white }) => !white || emptyOnView(frame, fill, visible, pad))) return true;
      return batch.children.every((child) => emptyOnView(frame, child, visible, pad));
    default:
      return false;
  }
}

const shaders = { fill, stroke, sprite, glyph, image, marker };
type Kind = keyof typeof shaders;
const FLOAT = 4;

export class FrameGraph {
  readonly drawBatches = { submitted: 0, culled: 0 };
  // full-viewport group composites, scissored stroke stencil clears, and group mask fills drawn / culled as wholly
  // outside the view in the last frame, groups skipped as provably empty on view, and composites whose group was masked
  // at full opacity (pixel-work telemetry)
  readonly passes = {
    composites: 0,
    stencilClears: 0,
    maskFills: 0,
    maskCulled: 0,
    groupsEmpty: 0,
    opaqueMasked: 0,
  };
  private visible: Rect4 = [0, 0, 1, 1];
  private programs = {} as Record<Kind, TrackedProgram>;
  private vaos = {} as Record<Kind, WebGLVertexArrayObject>;
  private strip: TrackedBuffer;
  private square: TrackedBuffer;
  private group: TrackedTarget | null = null;
  private world = new Float32Array(9);
  private patternMatrix = new Float32Array(9);
  private screen = new Float32Array(9);
  private camera: Camera = { k: 1, x: 0, y: 0 };
  private viewport: Viewport = { width: 1, height: 1, dpr: 1 };
  private masked = false;
  private markerBuffer: TrackedBuffer | null = null;
  private markerInstances: MarkerInstances | null = null;
  readonly state: GlState;

  constructor(private device: GpuDevice) {
    const gl = device.gl;
    this.state = new GlState(gl);
    for (const kind of ["fill", "stroke", "sprite", "glyph", "image", "marker"] as Kind[]) {
      this.programs[kind] = device.program(kind, shaders[kind].vs, shaders[kind].fs);
      this.vaos[kind] = gl.createVertexArray()!;
    }
    this.strip = device.buffer("stroke corners", new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]));
    this.square = device.buffer("unit square", new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]));
  }

  render(
    frame: Frame | null,
    camera: Camera,
    viewport: Viewport,
    clear: Rgba,
    markers: MarkerInstances | null = null
  ): void {
    const gl = this.device.gl;
    this.camera = camera;
    this.viewport = viewport;
    this.visible = visibleWorld(camera, viewport);
    this.drawBatches.submitted = this.drawBatches.culled = 0;
    for (const key of Object.keys(this.passes) as (keyof FrameGraph["passes"])[]) this.passes[key] = 0;
    this.markerInstances = markers;
    if (markers) {
      const data = markers.data.subarray(0, markers.count * MARKER_FLOATS);
      if (this.markerBuffer) this.device.updateBuffer(this.markerBuffer, data);
      else this.markerBuffer = this.device.buffer("trade markers", data, undefined, gl.DYNAMIC_DRAW);
    }
    worldToClip(camera, viewport, this.world);
    screenToClip(viewport, this.screen);
    const state = this.state;
    state.reset(gl);
    state.counts.issued = state.counts.skipped = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(clear[0] * clear[3], clear[1] * clear[3], clear[2] * clear[3], clear[3]);
    gl.clearStencil(0);
    state.colorMask(true);
    state.stencilMask(0xff);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.STENCIL_TEST);
    if (frame) this.batches(frame, frame.batches);
    gl.disable(gl.STENCIL_TEST);
    state.bindVertexArray(null);
  }

  private batches(frame: Frame, list: Batch[]): void {
    for (const batch of list) {
      if (
        (batch.kind === "fill" || batch.kind === "stroke") &&
        batch.bounds &&
        outsideView(batch.bounds, this.visible, 1 / this.camera.k)
      ) {
        this.drawBatches.culled++;
        continue;
      }
      this.drawBatches.submitted++;
      if (batch.kind === "fill") this.fill(frame, batch);
      else if (batch.kind === "stroke") this.stroke(frame, batch);
      else if (batch.kind === "sprites") this.sprites(frame, batch);
      else if (batch.kind === "glyphs") this.glyphs(frame, batch);
      else if (batch.kind === "image") this.image(batch);
      else if (batch.kind === "markers") this.markers();
      else this.composite(frame, batch);
    }
  }

  private use(kind: Kind): TrackedProgram {
    const program = this.programs[kind];
    this.state.useProgram(program.program);
    this.state.bindVertexArray(this.vaos[kind]);
    this.state.uniformMatrix3fv(program.uniforms.u_matrix, kind === "image" ? this.screen : this.world);
    return program;
  }

  private attribute(
    program: TrackedProgram,
    name: string,
    buffer: TrackedBuffer,
    size: number,
    stride: number,
    offset: number,
    divisor: number
  ): void {
    const location = program.attributes[name];
    if (location === undefined || location < 0) return;
    this.state.attribute(location, buffer.handle, size, stride * FLOAT, offset * FLOAT, divisor);
  }

  private premultiplied(color: Rgba, alpha = 1): [number, number, number, number] {
    const a = color[3] * alpha;
    return [color[0] * a, color[1] * a, color[2] * a, a];
  }

  // Winding into bits 0x7F with color writes off; the caller then covers the same triangles.
  private stencilFan(frame: Frame, fill: FillBatch): TrackedProgram {
    const gl = this.device.gl;
    const state = this.state;
    const program = this.use("fill");
    this.attribute(program, "a_position", frame.fans!, 2, 2, 0, 0);
    state.colorMask(false);
    state.stencilFunc(gl.ALWAYS, 0, 0xff);
    if (fill.evenOdd) {
      state.stencilMask(0x01);
      state.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    } else {
      state.stencilMask(0x7f);
      state.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
      state.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.DECR_WRAP);
    }
    gl.drawArrays(gl.TRIANGLES, fill.first, fill.count);
    state.colorMask(true);
    return program;
  }

  private fill(frame: Frame, fill: FillBatch): void {
    if (!frame.fans || !fill.count) return;
    const gl = this.device.gl;
    const state = this.state;
    const program = this.stencilFan(frame, fill);
    if (this.masked)
      state.stencilFunc(fill.evenOdd ? gl.EQUAL : gl.LESS, fill.evenOdd ? 0x81 : 0x80, fill.evenOdd ? 0x81 : 0xff);
    else state.stencilFunc(gl.NOTEQUAL, 0, fill.evenOdd ? 0x01 : 0x7f);
    // every covered fragment, drawn or not, resets its winding bits
    state.stencilMask(0x7f);
    state.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
    state.uniform1i(program.uniforms.u_patterned, fill.tile ? 1 : 0);
    if (fill.tile) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fill.tile.texture.handle);
      state.uniform1i(program.uniforms.u_tile, 0);
      state.uniformMatrix3fv(
        program.uniforms.u_worldToUv,
        hatchUvAtZoom(fill.tile.worldToUv, fill.tile.referenceZoom, this.camera.k, this.patternMatrix)
      );
    } else state.uniform4fv(program.uniforms.u_color, this.premultiplied(fill.color ?? [0, 0, 0, 0]));
    gl.drawArrays(gl.TRIANGLES, fill.first, fill.count);
  }

  private stroke(frame: Frame, stroke: StrokeBatch): void {
    if (!frame.segments || !stroke.count) return;
    const gl = this.device.gl;
    const program = this.use("stroke");
    this.attribute(program, "a_corner", this.strip, 2, 2, 0, 0);
    this.attribute(program, "a_segment", frame.segments, 4, 5, stroke.first * 5, 1);
    this.attribute(program, "a_distance", frame.segments, 1, 5, stroke.first * 5 + 4, 1);
    if (frame.caps) this.attribute(program, "a_caps", frame.caps, 2, 2, stroke.first * 2, 1);
    // hairlines: at least one device-independent pixel wide, coverage folded into alpha
    const screenWidth = stroke.width * this.camera.k;
    const pixelRatio = Math.min(
      gl.drawingBufferWidth / this.viewport.width,
      gl.drawingBufferHeight / this.viewport.height
    );
    const physicalWidth = screenWidth * pixelRatio;
    const thin = physicalWidth < 1;
    const color = this.premultiplied(stroke.color, thin ? Math.max(physicalWidth, 0) : 1);
    const state = this.state;
    state.uniform1f(program.uniforms.u_halfWidth, thin ? 0.5 / (this.camera.k * pixelRatio) : stroke.width / 2);
    // opaque, non-hairline strokes take analytic edge coverage over a one-device-pixel fringe (no stencil involved)
    const opaque = color[3] >= 1 && !thin;
    const pxPerWorld = this.camera.k * pixelRatio;
    state.uniform1f(program.uniforms.u_aaPad, opaque ? 1 / pxPerWorld : 0);
    state.uniform1f(program.uniforms.u_pxPerWorld, pxPerWorld);
    state.uniform4fv(program.uniforms.u_color, color);
    state.uniform1fv(program.uniforms.u_dashes, stroke.dashes);
    state.uniform1i(program.uniforms.u_dashCount, stroke.dashCount);
    state.uniform1f(program.uniforms.u_dashPeriod, stroke.dashPeriod);
    state.uniform1f(program.uniforms.u_dashOffset, stroke.dashOffset);
    // Hairline coverage is folded into alpha across the widened quad, so a round dash cap becomes a linear extension
    // of equal area (pi/4 of the half width) instead of a disc test against the widened half width.
    const dashCap = stroke.dashCap ?? 1;
    const round = thin && dashCap === 2;
    state.uniform1f(program.uniforms.u_dashCap, round ? 0 : dashCap);
    state.uniform1f(program.uniforms.u_capReach, (round ? Math.PI / 4 : 1) * (stroke.width / 2));
    const base = this.masked ? 0x80 : 0;
    if (color[3] >= 1) {
      this.plain();
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, stroke.count);
      return;
    }
    // translucent: segment overlaps at joins blend once via per-path coverage bit, then the bit is cleared
    state.stencilMask(0x01);
    state.stencilFunc(gl.EQUAL, base, base | 0x01);
    state.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, stroke.count);
    // Clear just the per-path coverage bit; glClear honours the stencil write mask, preserving the group mask.
    // This avoids rasterizing every translucent/hairline segment a second time.
    if (stroke.bounds) {
      const box = worldScissor(
        stroke.bounds,
        this.camera,
        this.viewport,
        gl.drawingBufferWidth,
        gl.drawingBufferHeight
      );
      if (box) {
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(...box);
        state.stencilMask(0x01);
        gl.clearStencil(0);
        gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.disable(gl.SCISSOR_TEST);
        this.passes.stencilClears++;
      }
    } else {
      // Unknown bounds retain the localized geometry cleanup instead of an expensive full-viewport masked clear.
      state.colorMask(false);
      state.stencilFunc(gl.ALWAYS, 0, 0xff);
      state.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, stroke.count);
      state.colorMask(true);
    }
  }

  private plain(): void {
    const gl = this.device.gl;
    this.state.stencilMask(0);
    if (this.masked) this.state.stencilFunc(gl.EQUAL, 0x80, 0x80);
    else this.state.stencilFunc(gl.ALWAYS, 0, 0xff);
  }

  private sprites(frame: Frame, batch: SpriteBatch): void {
    if (!frame.sprites || !batch.count) return;
    const gl = this.device.gl;
    const program = this.use("sprite");
    this.attribute(program, "a_corner", this.square, 2, 2, 0, 0);
    this.attribute(program, "a_place", frame.sprites, 3, 7, batch.first * 7, 1);
    this.attribute(program, "a_uv", frame.sprites, 4, 7, batch.first * 7 + 3, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, batch.texture.handle);
    this.state.uniform1i(program.uniforms.u_texture, 0);
    this.plain();
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
  }

  private glyphs(frame: Frame, batch: GlyphBatch): void {
    if (!frame.glyphs || !frame.atlas || !batch.count) return;
    const gl = this.device.gl;
    const program = this.use("glyph");
    const stride = 15;
    const first = batch.first * stride;
    this.attribute(program, "a_corner", this.square, 2, 2, 0, 0);
    this.attribute(program, "a_anchor", frame.glyphs, 3, stride, first, 1);
    this.attribute(program, "a_box", frame.glyphs, 4, stride, first + 3, 1);
    this.attribute(program, "a_uv", frame.glyphs, 4, stride, first + 7, 1);
    this.attribute(program, "a_color", frame.glyphs, 4, stride, first + 11, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, frame.atlas.handle);
    this.state.uniform1i(program.uniforms.u_atlas, 0);
    this.plain();
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
  }

  private markers(): void {
    const instances = this.markerInstances;
    if (!instances || !this.markerBuffer) return;
    const gl = this.device.gl;
    const program = this.use("marker");
    this.attribute(program, "a_corner", this.square, 2, 2, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    this.state.uniform1i(program.uniforms.u_texture, 0);
    this.plain();
    for (const run of instances.runs) {
      const first = run.first * MARKER_FLOATS;
      this.attribute(program, "a_origin", this.markerBuffer, 2, MARKER_FLOATS, first, 1);
      this.attribute(program, "a_axes", this.markerBuffer, 4, MARKER_FLOATS, first + 2, 1);
      gl.bindTexture(gl.TEXTURE_2D, run.texture.handle);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, run.count);
    }
  }

  private quad(texture: WebGLTexture, matrix: Float32Array, rect: Float32List, uv: Float32List, opacity: number): void {
    const gl = this.device.gl;
    const state = this.state;
    const program = this.use("image");
    state.uniformMatrix3fv(program.uniforms.u_matrix, matrix);
    this.attribute(program, "a_corner", this.square, 2, 2, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    state.uniform1i(program.uniforms.u_texture, 0);
    state.uniform4fv(program.uniforms.u_rect, rect);
    state.uniform4fv(program.uniforms.u_uv, uv);
    state.uniform1f(program.uniforms.u_opacity, opacity);
    this.plain();
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private image(batch: ImageBatch): void {
    const source = imageSource(batch, visibleWorld(this.camera, this.viewport));
    if (!source.texture) return;
    this.quad(
      source.texture.handle,
      batch.screen ? this.screen : this.world,
      source.rect,
      [0, 0, 1, 1],
      batch.opacity ?? 1
    );
  }

  private composite(frame: Frame, batch: GroupBatch): void {
    const gl = this.device.gl;
    const [width, height] = [gl.drawingBufferWidth, gl.drawingBufferHeight];
    // A group with no on-view output composites a fully transparent layer, which leaves the framebuffer unchanged under
    // premultiplied src-over: skipping the FBO switch, clear and full-viewport quad is exact.
    if (emptyOnView(frame, batch, this.visible, 1 / this.camera.k)) {
      this.passes.groupsEmpty++;
      return;
    }
    this.passes.composites++;
    if (batch.mask && batch.opacity >= 1) this.passes.opaqueMasked++;
    if (!this.group || this.group.width !== width || this.group.height !== height) {
      this.device.release(this.group);
      const samples = targetSamples(width, height, this.device.maxSamples, TARGET_BUDGET, this.viewport.dpr);
      this.group = this.device.target("group", width, height, samples);
      this.state.reset(); // allocation binds outside the cache
    }
    // The previous composite sampled this texture on unit 0. Unbind it before attaching it for direct rendering:
    // WebGL validates feedback loops even when the fill shader's texture branch is disabled.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.group.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    this.state.stencilMask(0xff);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    if (batch.mask) {
      // binary luminance mask: white items set bit 0x80, black items clear it, in document order
      for (const { fill, white } of batch.mask) {
        if (!frame.fans || !fill.count) continue;
        // Same conservative cull as fill batches: every mask triangle lies inside its path bounds, so an item wholly
        // outside the view writes no on-screen stencil and skipping it leaves the mask, and the order of the rest, exact.
        if (fill.bounds && outsideView(fill.bounds, this.visible, 1 / this.camera.k)) {
          this.passes.maskCulled++;
          continue;
        }
        this.passes.maskFills++;
        this.stencilFan(frame, fill);
        this.state.colorMask(false);
        this.state.stencilFunc(gl.NOTEQUAL, white ? 0x80 : 0, fill.evenOdd ? 0x01 : 0x7f);
        this.state.stencilMask(0xff);
        this.state.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        gl.drawArrays(gl.TRIANGLES, fill.first, fill.count);
        this.state.colorMask(true);
      }
      this.masked = true;
    }
    this.batches(frame, batch.children);
    this.masked = false;
    if (this.group.samples) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.group.framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.group.resolve);
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const { width: w, height: h } = this.viewport;
    this.quad(this.group.texture, this.screen, [0, 0, w, h], [0, 1, 1, 0], batch.opacity);
  }

  dispose(): void {
    if (!this.device.lost) for (const vao of Object.values(this.vaos)) this.device.gl.deleteVertexArray(vao);
    for (const program of Object.values(this.programs)) this.device.release(program);
    this.device.release(this.strip);
    this.device.release(this.square);
    this.device.release(this.group);
    this.device.release(this.markerBuffer);
    this.group = null;
    this.markerBuffer = null;
    this.markerInstances = null;
  }
}
