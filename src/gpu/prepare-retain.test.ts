// PERF B1 step 1: a frame retained across a context loss is rebuilt with fresh textures for every texture source it
// recorded, fresh bitmap-window and compat-run slots, and a batch tree that points only at the new objects.
import { describe, expect, it, vi } from "vitest";

vi.mock("../io/export", () => ({ prepareMapClone: vi.fn() }));

import type { TrackedTexture } from "./device";
import type { Batch, FillBatch, GroupBatch, ImageBatch, SpriteBatch } from "./framegraph";
import { complete, type Prepared, type RetainedFrame, rehydrate, retainFrame } from "./prepare";

const texture = (label: string) =>
  ({ kind: "texture", label, width: 4, height: 4, bytes: 64 }) as unknown as TrackedTexture;
const image = (rect: [number, number, number, number], screen = false): ImageBatch => ({
  kind: "image",
  texture: texture("dead"),
  rect,
  screen,
  detail: null
});

function frame() {
  const pattern = texture("pattern hatch");
  const reliefAtlas = texture("relief atlas");
  const viewport = texture("canonical relief viewport");
  const fill: FillBatch = {
    kind: "fill",
    first: 0,
    count: 3,
    color: null,
    tile: { texture: pattern, worldToUv: new Float32Array(9) },
    evenOdd: false
  };
  const sprites: SpriteBatch = { kind: "sprites", first: 0, count: 2, texture: reliefAtlas };
  const window = image([0, 0, 10, 10]);
  const run = image([1, 1, 2, 2]);
  const screen = image([0, 0, 5, 5], true);
  const group: GroupBatch = {
    kind: "group",
    opacity: 0.5,
    mask: [{ fill: { ...fill, tile: null, color: [1, 1, 1, 1] }, white: true }],
    children: [fill, run]
  };
  const batches: Batch[] = [screen, window, sprites, group, { kind: "markers" }];
  const element = { id: "e" } as unknown as Element;
  const retained = {
    key: {} as RetainedFrame["key"],
    layers: {},
    reasons: ["text"],
    pick: {} as RetainedFrame["pick"],
    relief: null,
    tessellation: {} as RetainedFrame["tessellation"],
    batches,
    vertices: {
      fans: new Float32Array(6),
      segments: new Float32Array(0),
      caps: new Float32Array(0),
      sprites: new Float32Array(14),
      edges: new Float32Array(0)
    },
    glyphs: new Float32Array(0),
    glyphCount: 0,
    atlasCanvas: null,
    atlasCopy: false,
    atlasGeneration: 0,
    recipes: new Map([
      [pattern, { label: "pattern hatch", source: { width: 4, height: 4 } as never, options: { repeat: true } }],
      [reliefAtlas, { label: "relief atlas", source: { width: 4, height: 4 } as never, options: { mipmap: true } }],
      [viewport, { label: "canonical relief viewport", source: { width: 4, height: 4 } as never, options: {} }]
    ]),
    windows: [
      {
        slot: window,
        image: {} as HTMLImageElement,
        rect: [0, 0, 10, 10] as [number, number, number, number],
        opacity: 0.8,
        detail: {
          texture: viewport,
          rect: [2, 2, 3, 3] as [number, number, number, number],
          covers: [2, 2, 3, 3] as [number, number, number, number]
        }
      }
    ],
    runs: [
      { slot: screen, elements: [element], screen: true, sharp: false, hits: [] },
      { slot: run, elements: [element], screen: false, sharp: true }
    ],
    atlas: null
  } satisfies RetainedFrame;
  return { retained, old: new Set([pattern, reliefAtlas, viewport]), slots: new Set([window, run, screen]) };
}

function rebuild(retained: RetainedFrame) {
  const made: { label: string; options: unknown; texture: TrackedTexture }[] = [];
  const windows: { rect: number[]; opacity?: number; slot: ImageBatch }[] = [];
  const result = rehydrate(
    retained,
    (label, _source, options) => {
      const fresh = texture(`${label} (new)`);
      made.push({ label, options, texture: fresh });
      return fresh;
    },
    (_image, rect, opacity) => {
      const slot: ImageBatch = { kind: "image", opacity, texture: null, rect: [...rect], screen: false, detail: null };
      windows.push({ rect, opacity, slot });
      return slot;
    }
  );
  return { ...result, made, windows };
}

// every texture and image slot the tree reaches
function reach(batches: Batch[]) {
  const textures = new Set<TrackedTexture>();
  const images = new Set<ImageBatch>();
  const visit = (batch: Batch) => {
    if (batch.kind === "fill" && batch.tile) textures.add(batch.tile.texture);
    if (batch.kind === "sprites") textures.add(batch.texture);
    if (batch.kind === "image") {
      images.add(batch);
      if (batch.detail?.texture) textures.add(batch.detail.texture);
    }
    if (batch.kind === "group") {
      for (const item of batch.mask ?? []) visit(item.fill);
      batch.children.forEach(visit);
    }
  };
  batches.forEach(visit);
  return { textures, images };
}

describe("retained frame (context-loss restore without a scene walk)", () => {
  it("re-uploads each recorded texture source once, with its options", () => {
    const { retained } = frame();
    const { made } = rebuild(retained);
    expect(made.map(item => [item.label, item.options])).toEqual([
      ["pattern hatch", { repeat: true }],
      ["relief atlas", { mipmap: true }],
      ["canonical relief viewport", {}]
    ]);
  });

  it("copies the batch tree onto the new textures and slots only", () => {
    const { retained, old, slots } = frame();
    const { batches, made, windows, runs } = rebuild(retained);
    const { textures, images } = reach(batches);
    for (const dead of old) expect(textures.has(dead)).toBe(false);
    for (const dead of slots) expect(images.has(dead)).toBe(false);
    expect(textures).toEqual(new Set(made.map(item => item.texture)));
    // the window slot came from the bitmap windows again, with its relief viewport detail on the new texture
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ rect: [0, 0, 10, 10], opacity: 0.8 });
    expect(windows[0].slot.detail?.texture).toBe(made[2].texture);
    expect(windows[0].slot.detail?.covers).toEqual([2, 2, 3, 3]);
    // the same object appears where the old one was, in DOM order, and the group keeps its mask and opacity
    expect(batches[1]).toBe(windows[0].slot);
    const group = batches[3] as GroupBatch;
    expect(group.opacity).toBe(0.5);
    expect(group.mask?.[0].white).toBe(true);
    expect(group.children[1]).toBe(runs[1].slot);
    expect(batches[0]).toBe(runs[0].slot);
    expect(batches[4]).toEqual({ kind: "markers" });
  });

  it("gives compat runs empty slots for the world loop to fill, keeping their elements and flags", () => {
    const { retained } = frame();
    const { runs } = rebuild(retained);
    expect(runs.map(run => [run.screen, run.sharp, run.slot.texture, run.slot.detail, run.stamp, run.key])).toEqual([
      [true, false, null, null, 0, ""],
      [false, true, null, null, 0, ""]
    ]);
    expect(runs[0].hits).toEqual([]);
    expect(runs[0].elements).not.toBe(retained.runs[0].elements);
  });

  it("is complete only when every texture has a source and every image slot is a window or a run", () => {
    const { retained } = frame();
    expect(complete(retained)).toBe(true);
    const missing = frame().retained;
    missing.recipes.delete([...missing.recipes.keys()][1]);
    expect(complete(missing)).toBe(false);
    const stray = frame().retained;
    stray.batches = [...stray.batches, image([0, 0, 1, 1])];
    expect(complete(stray)).toBe(false);
    const detail = frame().retained;
    detail.recipes.delete([...detail.recipes.keys()][2]);
    expect(complete(detail)).toBe(false);
  });

  it("retains on loss only while the glyph atlas still holds the frame's glyphs", () => {
    const { retained } = frame();
    const { runs, atlas: _atlas, ...payload } = retained;
    const live = { canvas: { width: 8, height: 8 } as HTMLCanvasElement, generation: 3 };
    const copies: { drawn: unknown[] }[] = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const copy = { width: 0, height: 0, drawn: [] as unknown[] };
        copies.push(copy);
        return { ...copy, getContext: () => ({ drawImage: (source: unknown) => copy.drawn.push(source) }) };
      }
    });
    // a frame laid out in the live atlas at `generation`, or restored from a payload that owns its copy
    const prepared = (glyphCount: number, atlasCopy: boolean, atlasGeneration = live.generation) =>
      ({
        payload: {
          ...payload,
          glyphCount,
          atlasCanvas: glyphCount ? (atlasCopy ? ({} as HTMLCanvasElement) : live.canvas) : null,
          atlasCopy,
          atlasGeneration
        },
        runs
      }) as unknown as Prepared;
    try {
      expect(retainFrame(null, live)).toBeNull();
      // no glyphs: nothing to copy, retained whatever the atlas holds
      expect(retainFrame(prepared(0, false, 1), live)?.atlas).toBeNull();
      // the live atlas still holds the frame's glyphs: copied
      const kept = retainFrame(prepared(5, false), live);
      expect(kept?.atlas).not.toBeNull();
      expect(copies.at(-1)?.drawn).toEqual([live.canvas]);
      // a prepare cleared the atlas since the frame, in flight or aborted on motion (its result never committed):
      // the frame stays, the atlas holds another job's glyphs, so nothing is retained
      expect(retainFrame(prepared(5, false, live.generation - 1), live)).toBeNull();
      // a clear during the frame's own prepare (recorded as -1) never matches
      expect(retainFrame(prepared(5, false, -1), live)).toBeNull();
      // another atlas canvas than the renderer's
      expect(retainFrame(prepared(5, false), { ...live, canvas: {} as HTMLCanvasElement })).toBeNull();
      // a frame restored from a payload indexes that payload's own copy: kept as is, whatever the live atlas holds
      const owned = prepared(5, true, 0);
      expect(retainFrame(owned, live)?.atlas).toBe(owned.payload.atlasCanvas);
      expect(retainFrame(owned, live)?.runs.map(run => run.slot)).toEqual(runs.map(run => run.slot));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
