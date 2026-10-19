// @vitest-environment happy-dom
// GpuRenderer lifecycle wiring (rows 5, 25, 28, 33, 39, 41) against a real DOM with the GL side mocked: the device,
// frame graph, prepare pipeline and emblem culling are fakes, so these tests pin what the renderer does with the
// page (hooks, show/hide, which work it schedules), not what it draws. The decisions themselves are in
// lifecycle.test.ts; these prove they are wired to the events that need them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SVG_NS = "http://www.w3.org/2000/svg";

const pipeline = vi.hoisted(() => ({
  prepares: [] as { svg: SVGSVGElement; revision: number }[],
  released: 0,
  overlayRoots: [] as Element[][]
}));

vi.mock("./device", () => ({
  GpuDevice: class {
    gl = { isContextLost: () => false };
    lost = false;
    disposed = false;
    maxTextureSize = 4096;
    memory() {
      return { total: 0 };
    }
    peak() {
      return 0;
    }
    resetPeak() {}
    resize() {}
    dispose() {
      this.disposed = true;
    }
  }
}));

vi.mock("./framegraph", () => ({
  FrameGraph: class {
    drawBatches = { submitted: 0, culled: 0 };
    state = { counts: { issued: 0, skipped: 0 } };
    passes = {};
    render() {}
    dispose() {}
  }
}));

vi.mock("./emblem-culling", () => ({
  HiddenEmblemCulling: class {
    update() {}
    reveal() {}
    reset() {}
    dispose() {}
  }
}));

vi.mock("./compat", () => ({ forgetCompatClone: () => {} }));

vi.mock("./prepare", () => ({
  BudgetError: class extends Error {},
  compatReuseEnabled: () => false,
  hasDetail: () => false,
  releaseDetail: () => {},
  refineCompat: async () => false,
  refreshOverlays: async (_prepared: unknown, _ctx: unknown, roots: Element[]) => {
    pipeline.overlayRoots.push(roots);
    return "full"; // no in-place world-overlay refresh yet: the lane hands it to a full prepare
  },
  prepareFrame: async (svg: SVGSVGElement, ctx: { revision: number; bucket: number }) => {
    pipeline.prepares.push({ svg, revision: ctx.revision });
    return {
      frame: {},
      revision: ctx.revision,
      bucket: ctx.bucket,
      runs: [],
      windows: null,
      relief: null,
      layers: {},
      compat: { runs: 0, elements: 0, reasons: [], resolution: 1 },
      overlays: { pick: () => null },
      pick: { pick: () => null },
      cpuBytes: 0,
      tessellation: null,
      release: () => {
        pipeline.released++;
      }
    };
  }
}));

const { GlyphAtlas } = await import("./text");
const { GpuRenderer } = await import("./renderer");

type Renderer = InstanceType<typeof GpuRenderer>;
const global = globalThis as unknown as { customization?: number };

function mapSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.id = "map";
  svg.innerHTML = `<defs>
      <filter id="filter-sepia"><feColorMatrix values="0.393 0.769 0.189 0 0 0.349 0.686 0.168 0 0 0.272 0.534 0.131 0 0 0 0 0 1 0"/></filter>
      <filter id="blurry"><feGaussianBlur stdDeviation="5"/></filter>
    </defs>
    <g id="viewbox" transform="translate(0 0) scale(1)"><g id="coordinates"><g id="coordinateGrid"></g></g><g id="rivers"></g></g>`;
  return svg;
}

const fonts = new EventTarget() as EventTarget & { check: () => boolean; load: () => Promise<[]> };
fonts.check = () => true;
fonts.load = async () => [];

let renderer: Renderer;
let fallBacks: string[];
const visible = () => renderer.canvas.style.display === "block";
const settled = () => vi.waitFor(() => expect(visible()).toBe(true), { timeout: 2000 });

beforeEach(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ({ clearRect() {}, measureText: () => ({ width: 0 }) }) as unknown as CanvasRenderingContext2D
  );
  Object.defineProperty(document, "fonts", { value: fonts, configurable: true });
  global.customization = 0;
  pipeline.prepares.length = 0;
  pipeline.overlayRoots.length = 0;
  pipeline.released = 0;
  document.body.innerHTML = "";
  document.body.append(mapSvg());
  fallBacks = [];
  renderer = new GpuRenderer(document.getElementById("map") as unknown as SVGSVGElement, reason =>
    fallBacks.push(reason)
  );
  await settled();
});

afterEach(() => {
  renderer.dispose();
  expect(fallBacks).toEqual([]);
  Reflect.deleteProperty(document, "fonts");
  delete global.customization;
  vi.restoreAllMocks();
});

describe("[LIFE] GpuRenderer lifecycle wiring", () => {
  it("shows the first prepared frame with no hidden reason", () => {
    expect(pipeline.prepares).toHaveLength(1);
    expect(renderer.telemetry()).toMatchObject({ state: "active", hiddenReason: "", canvasVisible: true });
  });

  it("row 25: the idle watchdog hides the canvas when a customization mode starts with no other event", async () => {
    global.customization = 1;
    await vi.waitFor(() => expect(visible()).toBe(false), { timeout: 1000 });
    expect(renderer.telemetry()).toMatchObject({
      state: "suspended",
      suspendedReason: "editor customization 1",
      hiddenReason: "editor customization 1"
    });
    global.customization = 0;
    await settled();
    expect(renderer.telemetry().hiddenReason).toBe("");
  });

  it("row 39: beforeprint writes the GPU camera to the SVG and keeps the canvas hidden until afterprint", async () => {
    const viewbox = document.getElementById("viewbox")!;
    expect(renderer.camera({ scale: 2, x: 10, y: 20 })).toBe(true); // motion: the SVG transform write is skipped
    expect(viewbox.getAttribute("transform")).toBe("translate(0 0) scale(1)");
    window.dispatchEvent(new Event("beforeprint"));
    expect(viewbox.getAttribute("transform")).toBe("translate(10 20) scale(2)");
    expect(visible()).toBe(false);
    renderer.camera({ scale: 2, x: 10, y: 20, exact: true });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(visible()).toBe(false);
    expect(renderer.telemetry().hiddenReason).toBe("printing");
    window.dispatchEvent(new Event("afterprint"));
    await settled();
  });

  it("row 28: a root #map filter becomes the canvas CSS filter without a re-prepare, or hides the frame", async () => {
    const svg = document.getElementById("map")!;
    svg.setAttribute("filter", "url(#filter-sepia)");
    svg.setAttribute("data-filter", "sepia");
    await vi.waitFor(() => expect(renderer.telemetry().rootFilter.css).toBe('url("#filter-sepia")'));
    expect(renderer.canvas.style.filter).toContain("#filter-sepia");
    expect(visible()).toBe(true);
    svg.setAttribute("filter", "url(#blurry)");
    await vi.waitFor(() => expect(visible()).toBe(false));
    expect(renderer.telemetry()).toMatchObject({
      hiddenReason: "root filter #blurry <feGaussianBlur>",
      rootFilter: { css: "", refused: "root filter #blurry <feGaussianBlur>" }
    });
    expect(renderer.canvas.style.filter).toBe("");
    svg.removeAttribute("filter");
    svg.removeAttribute("data-filter");
    await settled();
    expect(renderer.telemetry().rootFilter).toEqual({ css: "", refused: "" });
    await new Promise(resolve => setTimeout(resolve, 200)); // past PREPARE_DELAY
    expect(pipeline.prepares).toHaveLength(1);
  });

  it("row 33: a load that replaces #map and fails before map:loaded hides and drops the old world", async () => {
    const old = document.getElementById("map")!;
    // parseLoadedData: svg.remove(); insertAdjacentHTML(new #map); ... throws; map:loaded never fires
    old.remove();
    document.body.prepend(mapSvg());
    await vi.waitFor(() => expect(visible()).toBe(false));
    expect(pipeline.released).toBe(1);
    expect(renderer.telemetry()).toMatchObject({
      state: "waiting",
      sourceCurrent: false,
      hiddenReason: "source replaced"
    });
    // nothing re-prepares the detached world: not a camera settle, a font arrival or a resize
    renderer.camera({ scale: 1.5, x: 0, y: 0, exact: true });
    window.dispatchEvent(new Event("resize"));
    vi.spyOn(GlyphAtlas.prototype, "fontsArrived").mockReturnValue(true);
    fonts.dispatchEvent(new Event("loadingdone")); // schedules a revision prepare
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(pipeline.prepares).toHaveLength(1);
    expect(visible()).toBe(false);
    // the next successful load (map:loaded -> worldReplaced) adopts the new #map
    renderer.worldReplaced(2);
    await settled();
    expect(pipeline.prepares.at(-1)?.svg).toBe(document.getElementById("map"));
    expect(renderer.telemetry().sourceCurrent).toBe(true);
  });

  it("row 41: 'loadingdone' re-prepares only when a face a label was missing has arrived", async () => {
    const arrived = vi.spyOn(GlyphAtlas.prototype, "fontsArrived").mockReturnValue(false);
    fonts.dispatchEvent(new Event("loadingdone"));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(pipeline.prepares).toHaveLength(1);
    arrived.mockReturnValue(true);
    fonts.dispatchEvent(new Event("loadingdone"));
    expect(renderer.telemetry().invalidations.last).toBe("font loaded");
    await vi.waitFor(() => expect(pipeline.prepares).toHaveLength(2));
  });

  it("row 5: #coordinates churn goes to the overlay lane with the layer as its root", async () => {
    const coordinates = document.getElementById("coordinates")!;
    coordinates.replaceChildren(document.createElementNS(SVG_NS, "g"));
    coordinates.setAttribute("font-size", "9");
    await vi.waitFor(() => expect(pipeline.overlayRoots).toEqual([[coordinates]]));
    // the lane cannot refresh a world run in place yet, so it hands the change to one full prepare
    await vi.waitFor(() => expect(pipeline.prepares).toHaveLength(2));
    expect(renderer.telemetry().overlays.fulls).toBe(1);
  });

  it("any other world change is still a static revision", async () => {
    document.getElementById("rivers")!.setAttribute("opacity", "0.5");
    await vi.waitFor(() => expect(pipeline.prepares).toHaveLength(2));
    expect(pipeline.overlayRoots).toEqual([]);
  });
});
