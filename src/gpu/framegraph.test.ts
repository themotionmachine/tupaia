import { describe, expect, it } from "vitest";
import type { TrackedBuffer, TrackedTexture } from "./device";
import {
  type Batch,
  emptyOnView,
  type FillBatch,
  type Frame,
  type GroupBatch,
  STENCIL,
  type StrokeBatch,
  strokeDashes
} from "./framegraph";

const buffer = {} as TrackedBuffer;
const frame: Frame = {
  batches: [],
  fans: buffer,
  caps: buffer,
  segments: buffer,
  sprites: buffer,
  glyphs: buffer,
  atlas: {} as TrackedTexture
};
const view: [number, number, number, number] = [0, 0, 100, 100];
const on: [number, number, number, number] = [10, 10, 20, 20];
const off: [number, number, number, number] = [200, 200, 210, 210];

const fill = (bounds: FillBatch["bounds"], count = 3): FillBatch => ({
  kind: "fill",
  bounds,
  first: 0,
  count,
  color: [1, 0, 0, 1],
  tile: null,
  evenOdd: false
});
const stroke = (bounds: StrokeBatch["bounds"]): StrokeBatch => ({
  kind: "stroke",
  bounds,
  first: 0,
  count: 2,
  color: [0, 0, 0, 0.5],
  width: 1,
  dashes: new Float32Array(8),
  dashCount: 0,
  dashPeriod: 0,
  dashOffset: 0
});
const group = (children: Batch[], mask: GroupBatch["mask"] = null, opacity = 0.5): GroupBatch => ({
  kind: "group",
  opacity,
  mask,
  children
});
const empty = (batch: Batch, f = frame) => emptyOnView(f, batch, view, 1);

describe("emptyOnView", () => {
  it("treats only provably off-view or zero-count geometry as empty", () => {
    expect(empty(fill(off))).toBe(true);
    expect(empty(fill(on, 0))).toBe(true);
    expect(empty(fill(on))).toBe(false);
    expect(empty(stroke(off))).toBe(true);
    expect(empty(stroke(on))).toBe(false);
    // bounds straddling the edge, or within the cull pad, still draw
    expect(empty(fill([95, 95, 150, 150]))).toBe(false);
    expect(empty(fill([100.5, 0, 120, 10]))).toBe(false);
  });

  it("falls back to non-empty when bounds are unknown", () => {
    expect(empty(fill(null))).toBe(false);
    expect(empty(fill(undefined))).toBe(false);
    expect(empty(stroke(null))).toBe(false);
    expect(empty(group([fill(off), stroke(null)]))).toBe(false);
  });

  it("never assumes images, markers or non-empty sprite/glyph runs are empty", () => {
    const image: Batch = { kind: "image", texture: null, rect: [500, 500, 600, 600], screen: false, detail: null };
    expect(empty(image)).toBe(false);
    expect(empty({ kind: "markers" })).toBe(false);
    expect(empty({ kind: "sprites", first: 0, count: 1, texture: {} as TrackedTexture })).toBe(false);
    expect(empty({ kind: "glyphs", first: 0, count: 1 })).toBe(false);
    expect(empty({ kind: "glyphs", first: 0, count: 0 })).toBe(true);
    expect(empty(group([fill(off), { kind: "markers" }]))).toBe(false);
  });

  it("is empty only when every descendant is, through nested groups", () => {
    expect(empty(group([fill(off), stroke(off), group([fill(off, 9), fill(on, 0)])]))).toBe(true);
    expect(empty(group([fill(off), group([group([stroke(on)])])]))).toBe(false);
    expect(empty(group([]))).toBe(true);
  });

  it("treats a mask with no on-view white item as hiding every child", () => {
    const children = [fill(on), stroke(on)];
    // black items only clear bit 0x80, which starts clear
    expect(empty(group(children, [{ fill: fill(on), white: false }], 1))).toBe(true);
    expect(empty(group(children, [{ fill: fill(off), white: true }], 1))).toBe(true);
    expect(empty(group(children, [{ fill: fill(on, 0), white: true }], 1))).toBe(true);
    expect(empty(group(children, [{ fill: fill(on), white: true }], 1))).toBe(false);
    expect(empty(group(children, [{ fill: fill(null), white: true }], 1))).toBe(false);
    // an on-view white item still needs some on-view child
    expect(empty(group([fill(off)], [{ fill: fill(on), white: true }], 1))).toBe(true);
    // a later black item may clear the white one, but that is not proven here: stays non-empty
    expect(
      empty(
        group(
          children,
          [
            { fill: fill(on), white: true },
            { fill: fill(on), white: false }
          ],
          1
        )
      )
    ).toBe(false);
  });

  it("treats geometry as empty when its buffer is absent, as the draw paths do", () => {
    expect(empty(fill(on), { ...frame, fans: null })).toBe(true);
    expect(empty(stroke(on), { ...frame, segments: null })).toBe(true);
    expect(empty(group([fill(on)], [{ fill: fill(on), white: true }]), { ...frame, fans: null })).toBe(true);
  });
});

describe("strokeDashes", () => {
  const dashed = (pattern: number[], cap: number, width = 1, offset = 0): StrokeBatch => {
    const dashes = new Float32Array(8);
    dashes.set(pattern);
    return {
      ...stroke(null),
      width,
      dashes,
      dashCount: pattern.length,
      dashPeriod: 0,
      dashOffset: offset,
      dashCap: cap
    };
  };

  it("passes butt and round patterns through with their on-length", () => {
    const butt = strokeDashes(dashed([2, 2], 1));
    expect([butt.count, butt.period, butt.on, butt.cap, butt.offset]).toEqual([2, 4, 2, 1, 0]);
    const dots = strokeDashes(dashed([0, 2, 0, 2], 2, 0.5));
    expect([dots.count, dots.period, dots.on, dots.cap]).toEqual([4, 4, 0, 2]);
  });

  it("draws square dash caps as extended butt dashes, solid when the gaps close", () => {
    const square = strokeDashes(dashed([2, 2], 0, 0.7, 1));
    expect(square.cap).toBe(1);
    expect(square.period).toBeCloseTo(4, 6);
    expect(square.on).toBeCloseTo(2.7, 6);
    expect(square.offset).toBeCloseTo(1 + 0.35, 6);
    expect(strokeDashes(dashed([1, 0.5], 0, 1)).count).toBe(0);
  });

  it("is solid without a pattern", () => {
    expect(strokeDashes(stroke(null)).count).toBe(0);
  });
});

describe("stencil layout", () => {
  it("keeps the mask bit, the batch ids and the winding apart, ids above winding so one GREATER test reads both", () => {
    expect(STENCIL.hidden & STENCIL.id).toBe(0);
    expect(STENCIL.id & STENCIL.winding).toBe(0);
    expect(STENCIL.hidden | STENCIL.id | STENCIL.winding).toBe(0xff);
    expect(STENCIL.ids << STENCIL.idShift).toBe(STENCIL.id);
    // first-wins: a pixel passes GREATER(id << shift, hidden | id) only when visible and drawn by an earlier id
    const passes = (value: number, id: number) => {
      const ref = id << STENCIL.idShift;
      return ref > (value & (STENCIL.hidden | STENCIL.id));
    };
    expect(passes(0, 1)).toBe(true);
    expect(passes(1 << STENCIL.idShift, 1)).toBe(false);
    expect(passes((3 << STENCIL.idShift) | 5, 4)).toBe(true);
    expect(passes(STENCIL.hidden, STENCIL.ids)).toBe(false);
  });
});
