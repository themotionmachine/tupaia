// DOM-ordered passes over prepared batches: stencil-then-cover fills, instanced strokes/sprites/glyphs, compat
// images, and opacity/mask groups composited from an offscreen target. Camera changes only touch uniforms.
// Stencil layout (STENCIL below): bit 0x80 = group mask, set where a masked group's content is hidden; bits 0x78 = the
// id of the last batch that marked the pixel (a banded stroke or an anti-aliased fill: first fragment wins within
// the batch); bits 0x07 = fill winding (0x7F for a deepWinding fill, which clears the ids under it first).
// Every test that draws colour requires the mask bit clear, so unmasked targets (bit never set) share the same tests.
import { msaaFlag, TARGET_BUDGET, targetSamples } from "./budget";
import { type Camera, screenToClip, type Viewport, visibleWorld, worldScissor, worldToClip } from "./camera";
import type { GpuDevice, TrackedBuffer, TrackedProgram, TrackedTarget, TrackedTexture } from "./device";
import {
  COVERAGE_SAMPLES,
  discProfile,
  hairlineStroke,
  outsideView,
  radialSegmentsPerRadian,
  squareCapDashes
} from "./geometry";
import { GlState } from "./gl-state";
import { MARKER_FLOATS, type MarkerInstances } from "./markers";
import { hatchUvAtZoom } from "./raster";
import type { Rgba } from "./scene";
import { fill, fringe, glyph, image, marker, sprite, stroke } from "./shaders";
import { GLYPH_ATLAS, GLYPH_FLOATS } from "./text";

export interface FillBatch {
  bounds?: Rect4 | null;
  kind: "fill";
  first: number;
  count: number;
  color: Rgba | null;
  tile: { texture: TrackedTexture; worldToUv: Float32Array; referenceZoom?: number } | null;
  evenOdd: boolean;
  // boundary edges in Frame.edges (geometry.ts appendFillEdges) for the anti-aliasing fringe; absent: no fringe
  edgeFirst?: number;
  edgeCount?: number;
  // nonzero fill with 8 or more subpaths of one orientation: winding may reach 8, past the 3-bit counter
  deepWinding?: boolean;
  // SVG draws this shape with analytic coverage, not 4x MSAA (geometry.ts analyticShape): the fringe box-filters
  analytic?: boolean;
  // SVG draws it without anti-aliasing (geometry.ts aliasedShape): the pixel centre alone
  aliased?: boolean;
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
  sharedSegments?: boolean; // subpaths share segments (geometry.ts hasSharedSegments): draw in coverage bands
  analytic?: boolean; // SVG draws it with analytic coverage, not 4x MSAA (geometry.ts analyticShape): box filter
  aliased?: boolean; // SVG draws it without anti-aliasing (geometry.ts aliasedShape): the pixel centre alone
  // under 1 device px wide SVG draws it as a width-modulated hairline (geometry.ts thinHairline, hairlineStroke)
  hairline?: boolean;
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
  edges?: TrackedBuffer | null; // fill boundary ring points, filled side on the left (geometry.ts appendFillEdges)
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
      // A masked group starts hidden (bit 0x80) and only white items clear it, so with no drawable white item on view every masked
      // child fragment fails the stencil test.
      if (batch.mask?.every(({ fill, white }) => !white || emptyOnView(frame, fill, visible, pad))) return true;
      return batch.children.every(child => emptyOnView(frame, child, visible, pad));
    default:
      return false;
  }
}

const shaders = { fill, fringe, stroke, sprite, glyph, image, marker };
// Stencil bits that count a fill's winding: bit 0x01 for even-odd, else mod 8 in 0x07, or mod 128 in 0x7F (id bits
// borrowed and cleared first, then resolved to bit 0x01 before the fringe) for a nonzero fill whose subpaths might
// stack 8 deep (prepare.ts deepWinding).
export function windingBits(fill: Pick<FillBatch, "evenOdd" | "deepWinding">): number {
  return fill.evenOdd ? 0x01 : fill.deepWinding ? STENCIL.winding | STENCIL.id : STENCIL.winding;
}
type Kind = keyof typeof shaders;
const FLOAT = 4;
const MASK_WHITE: Rgba = [1, 1, 1, 1];
const MASK_BLACK: Rgba = [0, 0, 0, 1];
// Coverage floors of a banded stroke's passes, highest first (framegraph stroke).
export const COVERAGE_BANDS = [1, 0.75, 0.5, 0.25, 0] as const;
export const STENCIL = { hidden: 0x80, id: 0x78, winding: 0x07, idShift: 3, ids: 15 } as const;

// Fill edge anti-aliasing is on wherever the target has no MSAA (the DPR >= 2 canvas and every group target there);
// ?gpu-fill-aa=0 turns it off for A/B comparisons.
function fillAaFlag(): boolean {
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").get("gpu-fill-aa") !== "0";
  } catch {
    return true;
  }
}
// Stroke and fill-edge coverage model (shaders.ts coverage models): SVG's 4 samples per pixel, except the batches SVG
// draws analytically; ?gpu-coverage=area box-filters everything (the W2 model) for A/B comparisons.
function sampledCoverageFlag(): boolean {
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").get("gpu-coverage") !== "area";
  } catch {
    return true;
  }
}
const SAMPLE_OFFSETS = new Float32Array(COVERAGE_SAMPLES.flat());

export class FrameGraph {
  readonly drawBatches = { submitted: 0, culled: 0 };
  // full-viewport group composites, scissored stroke stencil clears, and group mask fills drawn / culled as wholly
  // outside the view in the last frame, groups skipped as provably empty on view, and composites whose group was masked
  // at full opacity (pixel-work telemetry)
  readonly passes = {
    composites: 0,
    fringes: 0,
    bandedStrokes: 0,
    idClears: 0,
    deepResolves: 0,
    stencilClears: 0,
    maskFills: 0,
    maskCulled: 0,
    groupsEmpty: 0,
    opaqueMasked: 0
  };
  private visible: Rect4 = [0, 0, 1, 1];
  private programs = {} as Record<Kind, TrackedProgram>;
  private vaos = {} as Record<Kind, WebGLVertexArrayObject>;
  private strip: TrackedBuffer;
  private square: TrackedBuffer;
  private group: TrackedTarget | null = null;
  // a single-sample group's mask coverage (maskCoverage), on the group target's depth/stencil buffer
  private mask: { texture: TrackedTexture; framebuffer: WebGLFramebuffer } | null = null;
  private world = new Float32Array(9);
  private patternMatrix = new Float32Array(9);
  private screen = new Float32Array(9);
  private camera: Camera = { k: 1, x: 0, y: 0 };
  private viewport: Viewport = { width: 1, height: 1, dpr: 1 };
  private masked = false;
  private markerBuffer: TrackedBuffer | null = null;
  private markerInstances: MarkerInstances | null = null;
  // anti-aliased batch ids (STENCIL.id) in the current target, and the device box they touched since the last id clear
  private id = 0;
  private idBox: [number, number, number, number] | null = null;
  private idUnbounded = false;
  // whether the current target is multisampled (fills need no fringe there)
  private multisampled = false;
  private readonly canvasMultisampled: boolean;
  private readonly fillAa = fillAaFlag();
  private readonly sampled = sampledCoverageFlag();
  private readonly hardwareMsaa = msaaFlag();
  private patternMatrixFringe = new Float32Array(9);
  readonly state: GlState;

  constructor(private device: GpuDevice) {
    const gl = device.gl;
    this.state = new GlState(gl);
    this.canvasMultisampled = !!gl.getContextAttributes()?.antialias && Number(gl.getParameter(gl.SAMPLES)) > 0;
    for (const kind of ["fill", "fringe", "stroke", "sprite", "glyph", "image", "marker"] as Kind[]) {
      this.programs[kind] = device.program(kind, shaders[kind].vs, shaders[kind].fs);
      this.vaos[kind] = gl.createVertexArray()!;
    }
    // constant per program: set once here, before render() resets the cached GL state
    for (const kind of ["fringe", "stroke"] as Kind[]) {
      gl.useProgram(this.programs[kind].program);
      gl.uniform2fv(this.programs[kind].uniforms.u_sampleOffsets, SAMPLE_OFFSETS);
    }
    gl.useProgram(null);
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
    this.id = 0;
    this.idBox = null;
    this.idUnbounded = false;
    this.multisampled = this.canvasMultisampled;
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

  // Winding into windingBits (mod 8 in 0x07; even-odd: bit 0x01) with color writes off; the caller then covers the same
  // triangles. Hidden pixels of a masked group keep winding 0 unless the fan builds the mask itself.
  private stencilFan(frame: Frame, fill: FillBatch, everywhere = false): TrackedProgram {
    const gl = this.device.gl;
    const state = this.state;
    const program = this.use("fill");
    this.attribute(program, "a_position", frame.fans!, 2, 2, 0, 0);
    state.colorMask(false);
    if (everywhere) state.stencilFunc(gl.ALWAYS, 0, 0xff);
    else state.stencilFunc(gl.EQUAL, 0, STENCIL.hidden);
    if (fill.evenOdd) {
      state.stencilMask(0x01);
      state.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    } else {
      state.stencilMask(windingBits(fill));
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
    const deep = !fill.evenOdd && !!fill.deepWinding;
    if (deep) this.clearIds(fill.bounds);
    this.stencilFan(frame, fill);
    let winding = windingBits(fill);
    if (this.fillAa && !this.multisampled && frame.edges && fill.edgeCount) {
      // a deep fill's winding borrows the id bits the fringe marks with: resolve it to bit 0x01 first (ids zeroed)
      if (deep) winding = this.resolveDeepWinding(frame, fill);
      this.antialiasedFill(frame, fill, winding);
      return;
    }
    const program = this.use("fill");
    this.attribute(program, "a_position", frame.fans, 2, 2, 0, 0);
    // pixel centres inside the fill (winding set: visible ones only, see stencilFan); every covered fragment, drawn or
    // not, resets its winding bits
    state.stencilFunc(gl.NOTEQUAL, 0, winding);
    state.stencilMask(winding);
    state.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
    this.paint(program, fill, this.patternMatrix);
    gl.drawArrays(gl.TRIANGLES, fill.first, fill.count);
  }

  // Nonzero winding mod 128 (deepWinding, 0x7F) into bit 0x01 with the id bits zeroed, colour writes off, so the fill
  // can take the fringe like any other: hidden pixels kept winding 0 in stencilFan and stay 0.
  private resolveDeepWinding(frame: Frame, fill: FillBatch): number {
    const gl = this.device.gl;
    const state = this.state;
    const program = this.use("fill");
    this.attribute(program, "a_position", frame.fans!, 2, 2, 0, 0);
    state.colorMask(false);
    // passes where 1 <= winding (any nonzero winding mod 128) and REPLACE writes that ref, 1, over all seven bits
    state.stencilFunc(gl.LEQUAL, 0x01, STENCIL.winding | STENCIL.id);
    state.stencilMask(STENCIL.winding | STENCIL.id);
    state.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    gl.drawArrays(gl.TRIANGLES, fill.first, fill.count);
    state.colorMask(true);
    this.passes.deepResolves++;
    return 0x01;
  }

  // Zero the batch-id bits under a fill whose winding borrows them (deepWinding), keeping the mask bit.
  private clearIds(bounds: Rect4 | null | undefined): void {
    const gl = this.device.gl;
    const scissor = bounds
      ? worldScissor(bounds, this.camera, this.viewport, gl.drawingBufferWidth, gl.drawingBufferHeight)
      : null;
    if (bounds && !scissor) return;
    if (scissor) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(scissor[0], scissor[1], scissor[2], scissor[3]);
    }
    this.state.stencilMask(STENCIL.id);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    if (scissor) gl.disable(gl.SCISSOR_TEST);
    this.passes.idClears++;
  }

  private paint(program: TrackedProgram, fill: FillBatch, matrix: Float32Array): void {
    const gl = this.device.gl;
    const state = this.state;
    state.uniform1i(program.uniforms.u_patterned, fill.tile ? 1 : 0);
    if (fill.tile) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fill.tile.texture.handle);
      state.uniform1i(program.uniforms.u_tile, 0);
      state.uniformMatrix3fv(
        program.uniforms.u_worldToUv,
        hatchUvAtZoom(fill.tile.worldToUv, fill.tile.referenceZoom, this.camera.k, matrix)
      );
    } else state.uniform4fv(program.uniforms.u_color, this.premultiplied(fill.color ?? [0, 0, 0, 0]));
  }

  private pxPerWorld(): number {
    const gl = this.device.gl;
    return (
      this.camera.k *
      Math.min(gl.drawingBufferWidth / this.viewport.width, gl.drawingBufferHeight / this.viewport.height)
    );
  }

  // A new anti-aliasing batch id; when the ids run out, the id bits are cleared where earlier batches drew them.
  private nextId(bounds: Rect4 | null | undefined): number {
    const gl = this.device.gl;
    if (this.id >= STENCIL.ids) {
      const box = this.idUnbounded ? null : this.idBox;
      if (box) {
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(box[0], box[1], box[2] - box[0], box[3] - box[1]);
      }
      this.state.stencilMask(STENCIL.id);
      gl.clearStencil(0);
      gl.clear(gl.STENCIL_BUFFER_BIT);
      if (box) gl.disable(gl.SCISSOR_TEST);
      this.passes.idClears++;
      this.id = 0;
      this.idBox = null;
      this.idUnbounded = false;
    }
    const scissor = bounds
      ? worldScissor(bounds, this.camera, this.viewport, gl.drawingBufferWidth, gl.drawingBufferHeight)
      : null;
    if (!bounds) this.idUnbounded = true;
    else if (scissor) {
      const [x, y, w, h] = scissor;
      const box = this.idBox;
      this.idBox = box
        ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x + w), Math.max(box[3], y + h)]
        : [x, y, x + w, y + h];
    }
    return ++this.id;
  }

  // A fill with its anti-aliasing fringe (shaders.ts `fringe`), after the stencil pass. Every pixel centre the fill
  // draws is marked with this batch's id: first the inside fringe (centres inside the fill within half a pixel of an
  // edge take that edge's coverage, the first edge winning by clearing the winding), then the cover (the rest of the
  // inside at full coverage), then the outside fringe, which draws only centres this batch has not marked (so none
  // inside the fill, whatever the edge orientation near reflex vertices or touching rings), again first edge wins.
  private antialiasedFill(frame: Frame, fill: FillBatch, winding: number): void {
    const gl = this.device.gl;
    const state = this.state;
    const id = this.nextId(fill.bounds) << STENCIL.idShift;
    const fringe = this.use("fringe");
    this.attribute(fringe, "a_corner", this.strip, 2, 2, 0, 0);
    // four consecutive ring points per instance (geometry.ts appendFillEdges): previous, edge start and end, next
    const base = fill.edgeFirst! * 2;
    this.attribute(fringe, "a_prev", frame.edges!, 2, 2, base, 1);
    this.attribute(fringe, "a_edge", frame.edges!, 4, 2, base + 2, 1);
    this.attribute(fringe, "a_next", frame.edges!, 2, 2, base + 6, 1);
    const px = this.pxPerWorld();
    state.uniform1f(fringe.uniforms.u_pad, 1 / px);
    state.uniform1f(fringe.uniforms.u_pxPerWorld, px);
    this.coverage(fringe, fill.analytic, fill.aliased);
    this.paint(fringe, fill, this.patternMatrixFringe);
    // inside (winding set, hence visible): REPLACE writes the id and zeroes the winding
    state.stencilFunc(gl.NOTEQUAL, id, winding);
    state.stencilMask(STENCIL.id | winding);
    state.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    state.uniform1i(fringe.uniforms.u_inside, 1);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, fill.edgeCount!);
    const cover = this.use("fill");
    this.attribute(cover, "a_position", frame.fans!, 2, 2, 0, 0);
    this.paint(cover, fill, this.patternMatrix);
    gl.drawArrays(gl.TRIANGLES, fill.first, fill.count);
    // outside: visible (mask bit clear) and not drawn by this batch (id below the current one); winding untouched
    this.use("fringe");
    state.stencilFunc(gl.GREATER, id, STENCIL.hidden | STENCIL.id);
    state.stencilMask(STENCIL.id);
    state.uniform1i(fringe.uniforms.u_inside, 0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, fill.edgeCount!);
    this.passes.fringes++;
  }

  private stroke(frame: Frame, stroke: StrokeBatch): void {
    if (!frame.segments || !stroke.count) return;
    const gl = this.device.gl;
    const program = this.use("stroke");
    this.attribute(program, "a_corner", this.strip, 2, 2, 0, 0);
    this.attribute(program, "a_segment", frame.segments, 4, 5, stroke.first * 5, 1);
    this.attribute(program, "a_distance", frame.segments, 1, 5, stroke.first * 5 + 4, 1);
    if (frame.caps) this.attribute(program, "a_caps", frame.caps, 2, 2, stroke.first * 2, 1);
    const state = this.state;
    const px = this.pxPerWorld();
    // a hairline batch under 1 device px: the 1 px stroke at width/1px of its colour (geometry.ts thinHairline)
    const { half, scale } = hairlineStroke(stroke.width, px, stroke.hairline);
    state.uniform1f(program.uniforms.u_halfWidth, half);
    state.uniform1f(program.uniforms.u_pad, 1 / px);
    state.uniform1f(program.uniforms.u_pxPerWorld, px);
    const disc = this.disc(half * px);
    state.uniform1f(program.uniforms.u_discRadius, disc.radius);
    state.uniform1f(program.uniforms.u_discScale, disc.scale);
    state.uniform1f(program.uniforms.u_radialPerRadian, radialSegmentsPerRadian(half * px));
    state.uniform4fv(program.uniforms.u_color, this.premultiplied(stroke.color, scale));
    const dash = strokeDashes(stroke);
    state.uniform1fv(program.uniforms.u_dashes, dash.dashes);
    state.uniform1i(program.uniforms.u_dashCount, dash.count);
    state.uniform1f(program.uniforms.u_dashPeriod, dash.period);
    state.uniform1f(program.uniforms.u_dashOn, dash.on);
    state.uniform1f(program.uniforms.u_dashOffset, dash.offset);
    state.uniform1f(program.uniforms.u_dashCap, dash.cap);
    this.coverage(program, stroke.analytic, stroke.aliased);
    // Joins are split at their bisectors in the shader, so a path overlaps itself only where it crosses itself or its
    // subpaths cross or coincide. Opaque, crossings blend: src-over of two opaque partial coverages a and b gives
    // 1 - (1 - a)(1 - b), the union for crossing edges, and a full-coverage pixel stays full. A translucent stroke, or
    // one whose subpaths share segments (the cell grid's neighbouring polygons), must not blend twice: SVG fills one
    // coverage mask per path. Each pixel then keeps one fragment, marked with this batch's id, drawn in bands of
    // decreasing coverage (COVERAGE_BANDS) so the one kept is within 0.25 of the largest: a faint edge pixel of one
    // segment never blocks the body of a crossing one, and coincident edges draw once.
    if (stroke.color[3] * scale >= 1 && !stroke.sharedSegments) {
      state.uniform1f(program.uniforms.u_minCoverage, -1); // blended: no floor, split the bisector sliver
      this.plain();
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, stroke.count);
      return;
    }
    const id = this.nextId(stroke.bounds) << STENCIL.idShift;
    state.stencilFunc(gl.GREATER, id, STENCIL.hidden | STENCIL.id);
    state.stencilMask(STENCIL.id);
    state.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    for (const band of COVERAGE_BANDS) {
      state.uniform1f(program.uniforms.u_minCoverage, band);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, stroke.count);
    }
    this.passes.bandedStrokes++;
  }

  // u_samples / u_sampleOffsets of the stroke and fringe programs (shaders.ts coverage models)
  private coverage(program: TrackedProgram, analytic: boolean | undefined, aliased?: boolean): void {
    const samples = aliased && this.sampled ? 1 : this.sampled && !analytic ? 4 : 0;
    this.state.uniform1i(program.uniforms.u_samples, samples);
  }

  private discs = new Map<number, { radius: number; scale: number }>();
  private disc(h: number): { radius: number; scale: number } {
    let profile = this.discs.get(h);
    if (!profile) {
      if (this.discs.size > 256) this.discs.clear();
      profile = discProfile(h);
      this.discs.set(h, profile);
    }
    return profile;
  }

  private plain(): void {
    const gl = this.device.gl;
    this.state.stencilMask(0);
    if (this.masked) this.state.stencilFunc(gl.EQUAL, 0, STENCIL.hidden);
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
    const stride = GLYPH_FLOATS;
    const first = batch.first * stride;
    this.attribute(program, "a_corner", this.square, 2, 2, 0, 0);
    this.attribute(program, "a_anchor", frame.glyphs, 3, stride, first, 1);
    this.attribute(program, "a_box", frame.glyphs, 4, stride, first + 3, 1);
    this.attribute(program, "a_uv", frame.glyphs, 4, stride, first + 7, 1);
    this.attribute(program, "a_color", frame.glyphs, 4, stride, first + 11, 1);
    this.attribute(program, "a_baseline", frame.glyphs, 3, stride, first + 15, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, frame.atlas.handle);
    this.state.uniform1i(program.uniforms.u_atlas, 0);
    // the atlas texture holds only the rows the instances use (prepare.ts); their uvs are normalized by the full atlas
    this.state.uniform1f(program.uniforms.u_atlasScale, GLYPH_ATLAS / frame.atlas.height);
    // GLYPH2: central baselines and text-shadows follow the zoom per frame (shaders.ts glyph)
    this.state.uniform1f(program.uniforms.u_k, this.camera.k);
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

  // mask: a coverage texture over the same rect and uv whose red channel multiplies the colour (maskCoverage)
  private quad(
    texture: WebGLTexture,
    matrix: Float32Array,
    rect: Float32List,
    uv: Float32List,
    opacity: number,
    mask: WebGLTexture | null = null
  ): void {
    const gl = this.device.gl;
    const state = this.state;
    const program = this.use("image");
    state.uniformMatrix3fv(program.uniforms.u_matrix, matrix);
    this.attribute(program, "a_corner", this.square, 2, 2, 0, 0);
    state.uniform1i(program.uniforms.u_masked, mask ? 1 : 0);
    if (mask) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, mask);
      state.uniform1i(program.uniforms.u_mask, 1);
    }
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
    const samples = this.hardwareMsaa
      ? targetSamples(width, height, this.device.maxSamples, TARGET_BUDGET, this.viewport.dpr)
      : 0;
    let target = this.group;
    if (!target || target.width !== width || target.height !== height || target.samples !== samples) {
      this.device.release(target);
      this.releaseMask();
      target = this.group = this.device.target("group", width, height, samples);
      this.state.reset(); // allocation binds outside the cache
    }
    // The previous composite sampled these textures on units 0 and 1. Unbind them before attaching them for direct
    // rendering: WebGL validates feedback loops even when the fill shader's texture branch is disabled.
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    // the group target has its own stencil: fresh ids there, the outer target's ids resume afterwards
    const outer = { id: this.id, idBox: this.idBox, idUnbounded: this.idUnbounded, multisampled: this.multisampled };
    this.multisampled = target.samples > 0;
    // A single-sample group takes its mask as coverage (maskCoverage); a multisampled one (?gpu-msaa=1) as the stencil.
    const coverage = batch.mask && !target.samples ? this.maskCoverage(frame, batch.mask, target) : null;
    this.id = 0;
    this.idBox = null;
    this.idUnbounded = false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    this.state.stencilMask(0xff);
    // a stencil-masked group starts hidden everywhere (bit 0x80); its content draws only where white items cleared it
    gl.clearStencil(batch.mask && !coverage ? STENCIL.hidden : 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.clearStencil(0);
    if (batch.mask && !coverage) {
      // binary luminance mask: white items clear the hidden bit, black items set it, in document order
      for (const { fill, white } of batch.mask) {
        if (!frame.fans || !fill.count || this.maskCulled(fill)) continue;
        this.stencilFan(frame, fill, true);
        this.state.colorMask(false);
        // passes where the winding is set (ref & mask is 0) and replaces the whole value: 0 visible, 0x80 hidden
        this.state.stencilFunc(gl.NOTEQUAL, white ? 0 : STENCIL.hidden, windingBits(fill));
        this.state.stencilMask(0xff);
        this.state.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        gl.drawArrays(gl.TRIANGLES, fill.first, fill.count);
        this.state.colorMask(true);
      }
      this.masked = true;
    }
    this.batches(frame, batch.children);
    this.masked = false;
    ({ id: this.id, idBox: this.idBox, idUnbounded: this.idUnbounded, multisampled: this.multisampled } = outer);
    if (target.samples) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.resolve);
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const { width: w, height: h } = this.viewport;
    this.quad(target.texture, this.screen, [0, 0, w, h], [0, 1, 1, 0], batch.opacity, coverage);
  }

  // Same conservative cull as fill batches: every mask triangle lies inside its path bounds, so an item wholly outside
  // the view writes nothing on screen and skipping it leaves the mask, and the order of the rest, exact.
  private maskCulled(fill: FillBatch): boolean {
    if (fill.bounds && outsideView(fill.bounds, this.visible, 1 / this.camera.k)) {
      this.passes.maskCulled++;
      return true;
    }
    this.passes.maskFills++;
    return false;
  }

  // A luminance mask drawn as SVG draws it: its white and black items, in document order, as anti-aliased fills (fringe
  // and all) over transparent black, into a colour texture the composite multiplies the group by (red = luminance). A
  // stencil mask is binary, so without hardware samples its edges were aliased, and hardware samples sit off SVG's
  // (budget.ts canvasAntialias). The texture shares the group target's depth/stencil buffer (cleared after it), so it
  // costs one RGBA8 texture.
  private maskCoverage(frame: Frame, mask: NonNullable<GroupBatch["mask"]>, group: TrackedTarget): WebGLTexture {
    const gl = this.device.gl;
    if (!this.mask || this.mask.texture.width !== group.width || this.mask.texture.height !== group.height) {
      this.releaseMask();
      const texture = this.device.texture("group mask", { width: group.width, height: group.height, data: null });
      gl.bindTexture(gl.TEXTURE_2D, null); // texture() leaves it bound on unit 0: a feedback loop once attached
      const framebuffer = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture.handle, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, group.depthStencil);
      this.mask = { texture, framebuffer };
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.releaseMask();
        throw new Error("Incomplete framebuffer group mask");
      }
      this.state.reset();
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mask.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    this.state.stencilMask(0xff);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    this.id = 0;
    this.idBox = null;
    this.idUnbounded = false;
    for (const { fill, white } of mask) {
      if (!frame.fans || !fill.count || this.maskCulled(fill)) continue;
      this.fill(frame, { ...fill, color: white ? MASK_WHITE : MASK_BLACK, tile: null });
    }
    return this.mask.texture.handle;
  }

  private releaseMask(): void {
    if (!this.mask) return;
    if (!this.device.lost) this.device.gl.deleteFramebuffer(this.mask.framebuffer);
    this.device.release(this.mask.texture);
    this.mask = null;
  }

  dispose(): void {
    if (!this.device.lost) for (const vao of Object.values(this.vaos)) this.device.gl.deleteVertexArray(vao);
    for (const program of Object.values(this.programs)) this.device.release(program);
    this.device.release(this.strip);
    this.device.release(this.square);
    this.device.release(this.group);
    this.releaseMask();
    this.device.release(this.markerBuffer);
    this.group = null;
    this.markerBuffer = null;
    this.markerInstances = null;
  }
}

// The dash uniforms of a stroke batch: square caps become butt dashes over the extended intervals (geometry.ts
// squareCapDashes), and a pattern that closes up entirely draws solid.
export function strokeDashes(stroke: StrokeBatch): {
  dashes: Float32Array;
  count: number;
  period: number;
  on: number;
  offset: number;
  cap: number;
} {
  const cap = stroke.dashCap ?? 1;
  let dashes = stroke.dashes;
  let count = stroke.dashCount;
  let offset = stroke.dashOffset;
  if (count && cap === 0) {
    const square = squareCapDashes(Array.from(stroke.dashes.subarray(0, count)), Math.max(0, stroke.width) / 2);
    if (square.solid) count = 0;
    else if (square.dashes.length <= 8) {
      dashes = new Float32Array(8);
      dashes.set(square.dashes);
      count = square.dashes.length;
      offset += square.shift;
    }
  }
  let period = 0,
    on = 0;
  for (let i = 0; i < count; i++) {
    period += dashes[i];
    if (!(i & 1)) on += dashes[i];
  }
  return { dashes, count: period > 0 ? count : 0, period, on, offset, cap: cap === 0 ? 1 : cap };
}
