// @vitest-environment happy-dom
// TradeMarkers.collect (live D3 groups -> instance runs) and the scene trade branch, tested through buildScene.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GpuDevice, TrackedTexture } from "./device";
import { MARKER_FLOATS, TradeMarkers } from "./markers";
import { applyStylePreset, createMapEnv, flatten, layerRouting, type MapEnv } from "./test/dom-env";

let env: MapEnv;
beforeEach(() => {
  env = createMapEnv();
});
afterEach(() => env.dispose());

const tex = (name: string) => ({ name }) as unknown as TrackedTexture;
const land = tex("land");
const water = tex("water");

// Textures are decoded asynchronously from <symbol>s; seed the cache so collect() runs synchronously.
function markers(seed: Record<string, TrackedTexture> = { land, water }) {
  const m = new TradeMarkers({} as GpuDevice, vi.fn(), vi.fn());
  const cache = (m as unknown as { textures: Map<string, TrackedTexture | "loading"> }).textures;
  for (const [k, v] of Object.entries(seed)) cache.set(k, v);
  return m;
}

const group = (kind: string, transform: string, extra = "") =>
  `<g transform="${transform}"><use href="#trade-marker-${kind}" x="-5" y="-5" width="10" height="10" transform="rotate(0)"${extra}/><circle r="6" fill="none" stroke="none"/></g>`;
const layer = () => env.layer("tradeAnimation");

describe("TradeMarkers.collect", () => {
  it("returns null and no issue without a layer or markers", () => {
    const m = markers();
    expect(m.collect(null)).toBeNull();
    env.fill("tradeAnimation", "");
    expect(m.collect(layer())).toBeNull();
    expect(m.count).toBe(0);
    expect(m.issue).toBeNull();
  });

  it("writes one instance per <use> in DOM order, with the D3 translate in the geometry", () => {
    const m = markers();
    env.fill("tradeAnimation", group("land", "translate(10, 20)") + group("land", "translate(30, 40)"));
    const out = m.collect(layer())!;
    expect(out.count).toBe(2);
    expect(m.count).toBe(2);
    // origin = box top-left after the group translate
    expect([out.data[0], out.data[1]]).toEqual([5, 15]);
    expect([out.data[MARKER_FLOATS], out.data[MARKER_FLOATS + 1]]).toEqual([25, 35]);
  });

  it("batches consecutive markers of one kind into a run and starts a new run per texture change", () => {
    const m = markers();
    env.fill(
      "tradeAnimation",
      group("land", "translate(1,1)") +
        group("land", "translate(2,2)") +
        group("water", "translate(3,3)") +
        group("land", "translate(4,4)")
    );
    const { runs } = m.collect(layer())!;
    expect(runs.map(r => [r.first, r.count, (r.texture as unknown as { name: string }).name])).toEqual([
      [0, 2, "land"],
      [2, 1, "water"],
      [3, 1, "land"]
    ]);
  });

  it("skips display:none groups and non-group children", () => {
    const m = markers();
    env.fill(
      "tradeAnimation",
      `<rect width="1" height="1"/>${group("land", "translate(1,1)").replace("<g ", '<g display="none" ')}${group("water", "translate(2,2)")}`
    );
    const out = m.collect(layer())!;
    expect(out.count).toBe(1);
    expect(out.runs).toHaveLength(1);
  });

  it("applies the layer's own transform to every marker", () => {
    const m = markers();
    env.fill("tradeAnimation", group("land", "translate(10, 20)"));
    env.set("tradeAnimation", { transform: "translate(100, 200)" });
    const out = m.collect(layer())!;
    expect([out.data[0], out.data[1]]).toEqual([105, 215]);
  });

  it("refuses with an issue (not a silent drop) for a marker it cannot mirror", () => {
    const m = markers();
    env.fill("tradeAnimation", group("land", "translate(1,1)", ' opacity="0.5"'));
    expect(m.collect(layer())).toBeNull();
    expect(m.issue).toMatch(/opacity/);
    env.fill("tradeAnimation", group("pirate", "translate(1,1)"));
    expect(m.collect(layer())).toBeNull();
    expect(m.issue).toMatch(/marker symbol/);
  });

  it("refuses an unparsable layer transform", () => {
    const m = markers();
    env.fill("tradeAnimation", group("land", "translate(1,1)"));
    env.set("tradeAnimation", { transform: "matrix(garbage)" });
    expect(m.collect(layer())).toBeNull();
    expect(m.issue).toBe("trade layer transform unparsable");
  });

  it("emits nothing while the texture is still loading, and the retry is not a failure", () => {
    const m = markers({});
    (m as unknown as { textures: Map<string, string> }).textures.set("land", "loading");
    env.fill("tradeAnimation", group("land", "translate(1,1)"));
    expect(m.collect(layer())).toBeNull();
    expect(m.count).toBe(0);
    expect(m.issue).toBeNull();
    expect(m.pending).toBe(true);
  });

  it("grows its buffer past the initial capacity", () => {
    const m = markers();
    env.fill("tradeAnimation", Array.from({ length: 130 }, (_, i) => group("land", `translate(${i},0)`)).join(""));
    const out = m.collect(layer())!;
    expect(out.count).toBe(130);
    expect(out.runs).toEqual([{ first: 0, count: 130, texture: land }]);
    expect(out.data[129 * MARKER_FLOATS]).toBe(129 - 5);
  });

  it("drops degenerate boxes without counting them", () => {
    const m = markers();
    env.fill(
      "tradeAnimation",
      group("land", "translate(1,1)").replace('width="10"', 'width="0"') + group("land", "translate(2,2)")
    );
    expect(m.collect(layer())!.count).toBe(1);
  });
});

describe("scene trade branch", () => {
  const trade = (scene: ReturnType<MapEnv["build"]>) => scene.draws.find(d => d.kind === "trade")!;

  it("always emits a trade draw and never prepares the live marker groups", () => {
    env.fill("tradeAnimation", group("land", "translate(1,1)"));
    applyStylePreset(env);
    const scene = env.build();
    const t = trade(scene) as Extract<ReturnType<typeof trade>, { kind: "trade" }>;
    expect(t.unsupported).toBe("");
    expect(t.children).toEqual([]);
    expect(layerRouting(scene, "tradeAnimation")).toEqual(["trade[]"]);
  });

  it("prepares static (non-<g>) siblings such as the highlight", () => {
    env.fill(
      "tradeAnimation",
      `${group("land", "translate(1,1)")}<path id="tradeHighlight" d="M0,0 L10,10" stroke="#ff0000" fill="none"/>`
    );
    applyStylePreset(env);
    const t = trade(env.build()) as { children: unknown[] };
    expect(flatten(t.children as never).length).toBeGreaterThan(0);
  });

  it.each(["filter", "clip-path", "mask"])("flags a layer %s as unsupported so the frame shows SVG", prop => {
    env.fill("tradeAnimation", group("land", "translate(1,1)"));
    applyStylePreset(env);
    env.layer("tradeAnimation").setAttribute("style", `${prop}: url(#x)`);
    const t = trade(env.build()) as { unsupported: string };
    expect(t.unsupported).toBe(prop);
  });
});
