// PANEND (W4b): PickIndex.replaceRange, the in-place hit update of a view overlay's labels (view-overlay.ts).
import { describe, expect, it } from "vitest";
import { PickIndex } from "./pick";

const square = (x: number, y: number, s = 10) => [x, y, x + s, y, x + s, y + s, x, y + s];

describe("[PANEND] PickIndex.replaceRange", () => {
  it("moves items in place: same indices (paint order), old area free, new area hit, bytes kept", () => {
    const index = new PickIndex(1000, 1000);
    index.addFill("ocean", "ocean", [square(0, 0, 1000)], false);
    index.addFill("labels", "a", [square(100, 100)], false);
    index.addFill("labels", "b", [square(300, 300)], false);
    index.addFill("rivers", "top", [square(500, 500, 40)], false);
    const bytes = index.bytes();
    const layers: string[] = [];
    const ok = index.replaceRange(1, 2, (scratch, layer) => {
      layers.push(layer);
      scratch.addFill(layer, "a", [square(520, 520)], false); // now under "top" (one bucket cell, as before)
      scratch.addFill(layer, "b", [square(705, 705)], false);
    });
    expect(ok).toBe(true);
    expect(layers).toEqual(["labels"]);
    expect(index.size).toBe(4);
    expect(index.pick(105, 105)?.id).toBe("ocean");
    expect(index.pick(708, 708)?.id).toBe("b");
    expect(index.pick(525, 525)?.id).toBe("top"); // still painted after: the replaced item keeps its order
    expect(index.pickAll(525, 525).map(hit => hit.id)).toEqual(["top", "a", "ocean"]);
    expect(index.bytes()).toBe(bytes);
  });

  it("changes nothing when the new items do not match the range", () => {
    const index = new PickIndex(1000, 1000);
    index.addFill("labels", "a", [square(100, 100)], false);
    expect(index.replaceRange(0, 1, () => {})).toBe(false);
    expect(index.replaceRange(0, 2, () => {})).toBe(false);
    expect(
      index.replaceRange(0, 1, (scratch, layer) => {
        scratch.addFill(layer, "a", [square(500, 500)], false);
        scratch.addFill(layer, "a", [square(600, 600)], false);
      })
    ).toBe(false);
    expect(index.pick(105, 105)?.id).toBe("a");
    expect(index.pick(505, 505)).toBe(null);
  });
});
