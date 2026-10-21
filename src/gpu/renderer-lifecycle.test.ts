// @vitest-environment happy-dom
// GpuRenderer lifecycle wiring (rows 5, 25, 28, 33, 39, 41) against a real DOM with the GL side mocked: the device,
// frame graph, prepare pipeline and emblem culling are fakes, so these tests pin what the renderer does with the
// page (hooks, show/hide, which work it schedules), not what it draws. The decisions themselves are in
// lifecycle.test.ts; these prove they are wired to the events that need them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  caravanChange,
  caravanChangesHeld,
  caravanDomPaused,
  caravanEnded,
  liveGroups,
  recordPose
} from "../renderers/caravan-poses";
import { EMBLEM_RULES } from "../renderers/emblems/styles";

const SVG_NS = "http://www.w3.org/2000/svg";

const pipeline = vi.hoisted(() => ({
  prepares: [] as { svg: SVGSVGElement; revision: number }[],
  released: 0,
  overlayRoots: [] as Element[][],
  clear: null as number[] | null, // the colour the last frame cleared to

  gate: null as Promise<void> | null, // when set, prepareFrame waits on it, then honours ctx.stale() as the real one does
  // PAN (W4a): the frames drawn ("render" in full, "pan" through the pan cache), pan cache releases, the cameras emblem
  // culling was given, and the bitmap windows the next prepared frame gets (null: none)
  draws: [] as string[],
  panReleases: 0,
  culls: [] as { k: number; x: number; y: number; moving: boolean }[],
  windows: null as null | {
    covered: boolean;
    complete: boolean;
    refreshes: number;
    covers(): boolean;
    refresh(): Promise<boolean>;
    margin: number;
    bytes: number;
  }
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
    panStats = {};
    panBytes = 0;
    render(_frame: unknown, _camera: unknown, _viewport: unknown, clear: number[]) {
      pipeline.clear = [...clear];
      pipeline.draws.push("render");
    }
    pan(_frame: unknown, camera: unknown, _viewport: unknown, clear: number[]) {
      pipeline.clear = [...clear];
      pipeline.draws.push("pan");
      return camera;
    }
    releasePan() {
      pipeline.panReleases++;
    }
    dispose() {}
  }
}));

vi.mock("./emblem-culling", () => ({
  HiddenEmblemCulling: class {
    update(camera: { k: number; x: number; y: number }, _viewport: unknown, _opaque: boolean, moving: boolean) {
      pipeline.culls.push({ ...camera, moving });
    }
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
  refineView: () => ({ visible: { x: 0, y: 0, width: 1, height: 1 }, pixels: { width: 1, height: 1 } }),
  refineRequest: () => "",
  refreshOverlays: async (_prepared: unknown, _ctx: unknown, roots: Element[]) => {
    pipeline.overlayRoots.push(roots);
    return "full"; // no in-place world-overlay refresh yet: the lane hands it to a full prepare
  },
  prepareFrame: async (svg: SVGSVGElement, ctx: { revision: number; bucket: number; stale: () => boolean }) => {
    pipeline.prepares.push({ svg, revision: ctx.revision });
    if (pipeline.gate) {
      await pipeline.gate;
      if (ctx.stale()) return null;
    }
    return {
      frame: {},
      revision: ctx.revision,
      bucket: ctx.bucket,
      runs: [],
      windows: pipeline.windows,
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

// the app's #map paints its own background (index.css #map, the style presets' "#map" background-color)
function mapSvg(background = "rgb(0, 0, 0)"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.id = "map";
  svg.style.backgroundColor = background;
  svg.innerHTML = `<defs>
      <filter id="filter-sepia"><feColorMatrix values="0.393 0.769 0.189 0 0 0.349 0.686 0.168 0 0 0.272 0.534 0.131 0 0 0 0 0 1 0"/></filter>
      <filter id="blurry"><feGaussianBlur stdDeviation="5"/></filter>
    </defs>
    <g id="viewbox" transform="translate(0 0) scale(1)"><g id="coordinates"><g id="coordinateGrid"></g></g><g id="rivers"></g><g id="tradeAnimation"></g></g>`;
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
  pipeline.gate = null;
  pipeline.draws.length = 0;
  pipeline.panReleases = 0;
  pipeline.culls.length = 0;
  pipeline.windows = null;
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

  it("row 28 (W3c): over an ancestor's backdrop the canvas takes the renderer's copy of the filter, which ends over it", async () => {
    expect(pipeline.clear).toEqual([0, 0, 0, 1]); // #map's own black
    renderer.dispose();
    // the golden's isolation: a transparent #map over a white parent, which the root filter never grades
    document.body.innerHTML = "";
    const page = document.createElement("div");
    page.style.backgroundColor = "rgb(255, 255, 255)";
    const svg = mapSvg("rgba(0, 0, 0, 0)");
    page.append(svg);
    document.body.append(page);
    renderer = new GpuRenderer(svg, reason => fallBacks.push(reason));
    await settled();
    expect(pipeline.clear).toEqual([1, 1, 1, 1]);
    expect(renderer.canvas.style.filter).toBe("");
    svg.setAttribute("filter", "url(#filter-sepia)");
    await vi.waitFor(() => expect(renderer.canvas.style.filter).toBe('url("#gpu-root-filter-backdrop")'));
    expect(renderer.telemetry().rootFilter).toEqual({ css: 'url("#filter-sepia")', refused: "" });
    expect(visible()).toBe(true);
    const copy = document.getElementById("gpu-root-filter-backdrop")!;
    expect([...copy.children].map(c => c.tagName.toLowerCase())).toEqual([
      "fecomponenttransfer",
      "fecolormatrix",
      "fecomponenttransfer",
      "feflood",
      "fecomposite",
      "fecomposite"
    ]);
    expect(copy.getAttribute("width")).toBe("1");
    expect(copy.querySelector("feFlood, feflood")!.getAttribute("flood-color")).toBe("rgb(255, 255, 255)");
    // the model's own filter is never written
    expect(document.getElementById("filter-sepia")!.firstElementChild!.getAttribute("result")).toBeNull();
    // the backdrop's own colour, faintly: what it mixes into a translucent pixel is the backdrop, not black
    await vi.waitFor(() => expect(pipeline.clear![3]).toBeCloseTo(1 / 255));
    expect(pipeline.clear!.slice(0, 3)).toEqual([1, 1, 1]);
    svg.removeAttribute("filter");
    await vi.waitFor(() => expect(renderer.canvas.style.filter).toBe(""));
    await vi.waitFor(() => expect(pipeline.clear).toEqual([1, 1, 1, 1]));
    expect(pipeline.prepares).toHaveLength(2); // one per renderer: a filter change never re-prepares
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

  it("row 5: #coordinates churn is a revision at once (no in-place world-overlay refresh yet), not a lane hop", async () => {
    const coordinates = document.getElementById("coordinates")!;
    coordinates.replaceChildren(document.createElementNS(SVG_NS, "g"));
    coordinates.setAttribute("font-size", "9");
    await vi.waitFor(() => expect(renderer.telemetry().revision).toBe(1));
    expect(renderer.telemetry().invalidations.last).toBe("view overlay #coordinates");
    await vi.waitFor(() => expect(pipeline.prepares).toHaveLength(2));
    expect(pipeline.overlayRoots).toEqual([]);
    expect(renderer.telemetry().overlays.fulls).toBe(0);
  });

  it("row 5: a #coordinates redraw during a prepare makes that prepare stale (it never commits the old grid)", async () => {
    let open = () => {};
    pipeline.gate = new Promise(resolve => (open = resolve));
    document.getElementById("rivers")!.setAttribute("opacity", "0.5");
    await vi.waitFor(() => expect(pipeline.prepares).toHaveLength(2));
    document.getElementById("coordinates")!.setAttribute("font-size", "9");
    await vi.waitFor(() => expect(renderer.telemetry().revision).toBe(2));
    open();
    pipeline.gate = null;
    await vi.waitFor(() => expect(pipeline.prepares.at(-1)?.revision).toBe(2));
    await vi.waitFor(() => expect(renderer.telemetry().frameRevision).toBe(2));
  });

  it("any other world change is still a static revision", async () => {
    document.getElementById("rivers")!.setAttribute("opacity", "0.5");
    await vi.waitFor(() => expect(pipeline.prepares).toHaveLength(2));
    expect(pipeline.overlayRoots).toEqual([]);
  });
});

// Decision D13 (W2 LIFE2): after a suspension that changed the model, the SVG stays on screen until the GPU frame
// is current; after one that changed nothing, the last GPU frame returns at once.
describe("[LIFE2] resume hold (D13)", () => {
  const openDialog = () => {
    const dialog = document.createElement("div");
    dialog.className = "ui-dialog";
    document.body.append(dialog);
    return dialog;
  };
  const closeDialog = (dialog: HTMLElement) => (dialog.style.display = "none");
  const nextFrames = () => new Promise(resolve => setTimeout(resolve, 60));
  let open: () => void;
  const gate = () => (pipeline.gate = new Promise(resolve => (open = resolve)));

  it("an editor opened from Navigate that changed the map holds the SVG until the frame is current", async () => {
    const dialog = openDialog();
    await vi.waitFor(() => expect(visible()).toBe(false));
    document.getElementById("rivers")!.setAttribute("opacity", "0.5"); // the edit
    await nextFrames();
    expect(pipeline.prepares).toHaveLength(1); // suspended: deferred to the close
    gate();
    closeDialog(dialog);
    await vi.waitFor(() => expect(pipeline.prepares).toHaveLength(2));
    await nextFrames();
    expect(visible()).toBe(false); // never the frame from before the edit
    expect(renderer.telemetry()).toMatchObject({ hiddenReason: "", hold: { active: true, holds: 1 } });
    expect(renderer.intentProbe()).toMatchObject({ ready: false, current: false });
    open();
    await settled();
    expect(renderer.telemetry()).toMatchObject({ frameRevision: 1, hold: { active: false, holds: 1 } });
  });

  it("an editor that changed nothing returns to the last GPU frame at once, with no prepare", async () => {
    const dialog = openDialog();
    await vi.waitFor(() => expect(visible()).toBe(false));
    closeDialog(dialog);
    await settled();
    expect(pipeline.prepares).toHaveLength(1);
    expect(renderer.telemetry().hold).toMatchObject({ active: false, holds: 0, skipped: 1 });
  });

  it("an edit applied in the same task as the close counts as made inside the editor", async () => {
    const dialog = openDialog();
    await vi.waitFor(() => expect(visible()).toBe(false));
    gate();
    document.getElementById("rivers")!.setAttribute("opacity", "0.5");
    closeDialog(dialog);
    await vi.waitFor(() => expect(pipeline.prepares).toHaveLength(2));
    await nextFrames();
    expect(visible()).toBe(false);
    open();
    await settled();
  });

  it("leaving a chosen Edit without changes returns at once; with changes it holds", async () => {
    renderer.setIntent(true);
    expect(visible()).toBe(false);
    renderer.setIntent(false);
    await settled();
    expect(pipeline.prepares).toHaveLength(1);
    renderer.setIntent(true);
    document.getElementById("rivers")!.setAttribute("opacity", "0.5");
    gate();
    renderer.setIntent(false);
    await vi.waitFor(() => expect(pipeline.prepares).toHaveLength(2));
    await nextFrames();
    expect(visible()).toBe(false);
    open();
    await settled();
  });

  it("motion during the hold does not abort the resume prepare (the SVG is what moves)", async () => {
    const dialog = openDialog();
    await vi.waitFor(() => expect(visible()).toBe(false));
    document.getElementById("rivers")!.setAttribute("opacity", "0.5");
    gate();
    closeDialog(dialog);
    await vi.waitFor(() => expect(pipeline.prepares).toHaveLength(2));
    expect(renderer.camera({ scale: 1.2, x: 5, y: 5 })).toBe(false); // held: the SVG takes the camera
    expect(renderer.telemetry().moving).toBe(true);
    open();
    await settled(); // committed and shown mid-gesture, no second prepare
    expect(pipeline.prepares).toHaveLength(2);
    expect(renderer.telemetry()).toMatchObject({ motionDeferrals: 0, frameRevision: 1 });
    expect(renderer.camera({ scale: 1.3, x: 5, y: 5 })).toBe(true); // the GPU now takes the gesture
    renderer.camera({ scale: 1.3, x: 5, y: 5, exact: true });
  });

  it("without a hold, motion still aborts a prepare that would replace the drawn frame", async () => {
    gate();
    document.getElementById("rivers")!.setAttribute("opacity", "0.5");
    await vi.waitFor(() => expect(pipeline.prepares).toHaveLength(2));
    renderer.camera({ scale: 1.2, x: 5, y: 5 });
    open();
    pipeline.gate = null;
    await vi.waitFor(() => expect(renderer.telemetry().motionDeferrals).toBe(1));
    expect(renderer.telemetry().frameRevision).toBe(0);
    renderer.camera({ scale: 1.2, x: 5, y: 5, exact: true });
    await vi.waitFor(() => expect(renderer.telemetry().frameRevision).toBe(1));
  });

  it("a change arriving during the hold extends it to the newer revision", async () => {
    const dialog = openDialog();
    await vi.waitFor(() => expect(visible()).toBe(false));
    document.getElementById("rivers")!.setAttribute("opacity", "0.5");
    gate();
    closeDialog(dialog);
    await vi.waitFor(() => expect(pipeline.prepares).toHaveLength(2));
    document.getElementById("rivers")!.setAttribute("opacity", "0.6"); // supersedes the in-flight prepare
    await vi.waitFor(() => expect(renderer.telemetry().revision).toBe(2));
    expect(renderer.intentProbe().holdRevisions).toBe(1);
    open();
    pipeline.gate = null;
    await settled();
    expect(renderer.telemetry().frameRevision).toBe(2);
  });
});

// W3 LIFE3: "changed" is the net change of the model DOM (net-change.ts), the suspension starts with the records of
// the task that opened it, and definitions outside svg#map that the map references re-prepare (definitions.ts).
describe("[LIFE3] net change and definitions", () => {
  const openDialog = () => {
    const dialog = document.createElement("div");
    dialog.className = "ui-dialog";
    document.body.append(dialog);
    return dialog;
  };
  const closeDialog = (dialog: HTMLElement) => (dialog.style.display = "none");
  const nextFrames = () => new Promise(resolve => setTimeout(resolve, 60));
  let open: () => void;
  const gate = () => (pipeline.gate = new Promise(resolve => (open = resolve)));

  it("an editor whose edits left the map as it was returns to the last frame at once (Updating), no hold", async () => {
    const rivers = document.getElementById("rivers")!;
    const dialog = openDialog();
    await vi.waitFor(() => expect(visible()).toBe(false));
    rivers.setAttribute("opacity", "0.5"); // an editor preview...
    await nextFrames();
    rivers.removeAttribute("opacity"); // ...undone before the close
    await nextFrames();
    expect(renderer.telemetry().revision).toBe(2);
    gate();
    closeDialog(dialog);
    await vi.waitFor(() => expect(visible()).toBe(true)); // the frame from before the session, while it re-prepares
    expect(renderer.telemetry()).toMatchObject({
      frameRevision: 0,
      hold: { active: false, holds: 0, netUnchanged: 1, net: { verdict: "unchanged" } }
    });
    expect(renderer.intentProbe()).toMatchObject({ ready: true, current: false });
    open();
    await vi.waitFor(() => expect(renderer.telemetry().frameRevision).toBe(2));
  });

  it("an edit made in the same task that opened the editor counts as made inside it (holds)", async () => {
    const dialog = openDialog();
    document.getElementById("rivers")!.setAttribute("opacity", "0.5"); // same task as the open
    await vi.waitFor(() => expect(visible()).toBe(false));
    gate();
    closeDialog(dialog);
    await vi.waitFor(() => expect(pipeline.prepares).toHaveLength(2));
    await nextFrames();
    expect(visible()).toBe(false); // never the frame from before the edit
    expect(renderer.telemetry().hold).toMatchObject({ active: true, holds: 1, skipped: 0, netUnchanged: 0 });
    open();
    await settled();
  });

  it("a customization mode set with its first DOM write in one task counts that write", async () => {
    global.customization = 1;
    document.getElementById("rivers")!.setAttribute("opacity", "0.5");
    await vi.waitFor(() => expect(visible()).toBe(false));
    gate();
    global.customization = 0;
    await vi.waitFor(() => expect(pipeline.prepares).toHaveLength(2), { timeout: 1000 });
    await nextFrames();
    expect(visible()).toBe(false);
    expect(renderer.telemetry().hold).toMatchObject({ active: true, holds: 1 });
    open();
    await settled();
  });

  describe("definitions outside svg#map", () => {
    let coas: Element;
    beforeEach(async () => {
      const definitions = document.createElementNS(SVG_NS, "svg");
      definitions.id = "defElements";
      definitions.innerHTML = `<defs><g id="coas"></g><g id="defs-relief"><symbol id="relief-hill-1"/></g></defs>`;
      document.body.append(definitions);
      coas = definitions.querySelector("#coas")!;
      renderer.worldReplaced(1); // a load: the renderer (re)attaches to svg#defElements
      const emblems = document.createElementNS(SVG_NS, "g");
      emblems.id = "emblems";
      emblems.innerHTML = `<g id="burgEmblems"><use data-i="1" href="#burgCOA1" x="5" y="5"/></g>`;
      document.getElementById("viewbox")!.append(emblems);
      await vi.waitFor(() => expect(renderer.telemetry().frameRevision).toBe(renderer.telemetry().revision));
      await settled();
    });
    const coa = (id: string) => {
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.id = id;
      svg.innerHTML = `<g clip-path="url(#heater_${id})"><rect width="200" height="200" fill="#fff"/></g>`;
      return svg;
    };

    it("a lazily rendered COA the map's emblems name re-prepares; one they do not name is ignored", async () => {
      const { revision, prepares } = renderer.telemetry();
      coas.append(coa("burgCOA2")); // a dialog preview with no emblem on the map
      await nextFrames();
      expect(renderer.telemetry()).toMatchObject({ revision, definitions: { revisions: 0, ignored: 1 } });
      coas.append(coa("burgCOA1")); // the emblem's COA arrives after the frame was prepared without it
      await vi.waitFor(() => expect(renderer.telemetry().revision).toBe(revision + 1));
      expect(renderer.telemetry()).toMatchObject({
        definitions: { revisions: 1, last: "definition #burgCOA1" },
        invalidations: { last: "definition #burgCOA1" }
      });
      await vi.waitFor(() => expect(renderer.telemetry().prepares).toBe(prepares + 1));
      // a change inside it (the emblem editor re-rendering it) is a revision too
      coas.querySelector("#burgCOA1 rect")!.setAttribute("fill", "#f00");
      await vi.waitFor(() => expect(renderer.telemetry().revision).toBe(revision + 2));
    });

    it("an editor preview's COA moving the shared emblem sheet is not a change; a different emblem sheet is", async () => {
      const shared = document.createElementNS(SVG_NS, "style");
      shared.setAttribute("data-emblem-shared-style", "");
      shared.textContent = EMBLEM_RULES;
      coas.append(shared);
      await nextFrames();
      const { revision } = renderer.telemetry();
      const ignored = renderer.telemetry().definitions.ignored;
      // COArenderer.draw for a burg editor's preview: the COA carries its own copy of the rules, the sheet moves after it
      const preview = coa("burgCOA2");
      preview.insertAdjacentHTML("afterbegin", `<defs><style>${EMBLEM_RULES}</style></defs>`);
      coas.append(preview);
      preview.after(shared);
      await nextFrames();
      expect(renderer.telemetry()).toMatchObject({ revision, definitions: { revisions: 0, ignored: ignored + 1 } });
      const other = coa("burgCOA3");
      other.insertAdjacentHTML("afterbegin", "<defs><style>g.secondary {fill: red}</style></defs>");
      coas.append(other);
      await vi.waitFor(() => expect(renderer.telemetry().revision).toBe(revision + 1));
      expect(renderer.telemetry().definitions).toMatchObject({ revisions: 1, last: "definition emblem <style>" });
    });

    it("a referenced definition changed during an editor holds (the net test cannot see it)", async () => {
      const dialog = openDialog();
      await vi.waitFor(() => expect(visible()).toBe(false));
      coas.append(coa("burgCOA1"));
      await nextFrames();
      gate();
      closeDialog(dialog);
      await vi.waitFor(() => expect(renderer.telemetry().hold.active).toBe(true));
      expect(renderer.telemetry().hold).toMatchObject({
        netUnsure: 1,
        net: { verdict: "unsure", detail: "definition #burgCOA1" }
      });
      await nextFrames();
      expect(visible()).toBe(false);
      open();
      await settled();
    });
  });
});

// W3b PAINT: a caravan tick written to the SVG re-layerizes the whole visible document in Chrome, under the canvas or
// not; the poses stay in caravan-poses.ts while the frame covers the SVG, and are written back whenever it is shown.
describe("[PAINT] trade caravan poses under the canvas", () => {
  let group: SVGGElement;
  const tick = (x: number) => recordPose(group, `translate(${x}, 0) rotate(0)`);
  const pose = (x: number) => `translate(${x}, 0) rotate(0)`;
  const openDialog = () => {
    const dialog = document.createElement("div");
    dialog.className = "ui-dialog";
    document.body.append(dialog);
    return dialog;
  };
  let open: () => void = () => {};
  const gate = () => (pipeline.gate = new Promise(resolve => (open = resolve)));

  beforeEach(() => {
    group = document.createElementNS(SVG_NS, "g") as SVGGElement;
    group.setAttribute("transform", "translate(0, 0)");
    liveGroups.add(group);
  });
  afterEach(() => liveGroups.clear());

  it("stay off the SVG while the frame shows, and the GPU redraws them", async () => {
    expect(caravanDomPaused()).toBe(true);
    const frames = renderer.telemetry().frames;
    tick(1);
    tick(2);
    expect(group.getAttribute("transform")).toBe("translate(0, 0)");
    await vi.waitFor(() => expect(renderer.telemetry().frames).toBeGreaterThan(frames));
    expect(renderer.telemetry().caravans).toMatchObject({ paused: true, retargets: 0 });
  });

  it("an editor shows the SVG with every caravan at its pose, then live; closing it pauses them again", async () => {
    tick(2);
    const dialog = openDialog();
    await vi.waitFor(() => expect(visible()).toBe(false));
    expect(caravanDomPaused()).toBe(false);
    expect(group.getAttribute("transform")).toBe(pose(2));
    tick(3);
    expect(group.getAttribute("transform")).toBe(pose(3));
    dialog.style.display = "none";
    await settled();
    expect(caravanDomPaused()).toBe(true);
  });

  it("print and a canvas hidden from outside (a canonical preview) show live caravans at once", async () => {
    tick(4);
    window.dispatchEvent(new Event("beforeprint"));
    expect(caravanDomPaused()).toBe(false);
    expect(group.getAttribute("transform")).toBe(pose(4));
    window.dispatchEvent(new Event("afterprint"));
    await settled();
    expect(caravanDomPaused()).toBe(true);
    tick(5);
    renderer.canvas.style.visibility = "hidden";
    await Promise.resolve(); // the observer checkpoint, as HiddenEmblemCulling reveals at
    expect(caravanDomPaused()).toBe(false);
    expect(group.getAttribute("transform")).toBe(pose(5));
    renderer.canvas.style.removeProperty("visibility");
    await vi.waitFor(() => expect(caravanDomPaused()).toBe(true));
  });

  it("a hidden canvas waiting for its frame (resume hold) keeps them paused, for at most the stand-in time", async () => {
    const dialog = openDialog();
    await vi.waitFor(() => expect(visible()).toBe(false));
    document.getElementById("rivers")!.setAttribute("opacity", "0.5"); // the edit
    gate();
    dialog.style.display = "none";
    await vi.waitFor(() => expect(pipeline.prepares).toHaveLength(2));
    expect(renderer.telemetry().hold.active).toBe(true);
    expect(caravanDomPaused()).toBe(true); // the prepare that ends the hold runs without caravan writes
    tick(7);
    expect(group.getAttribute("transform")).toBe("translate(0, 0)");
    const now = performance.now.bind(performance);
    vi.spyOn(performance, "now").mockImplementation(() => now() + 16000);
    await vi.waitFor(() => expect(caravanDomPaused()).toBe(false), { timeout: 1000 }); // the idle watch: expired
    expect(group.getAttribute("transform")).toBe(pose(7));
    vi.mocked(performance.now).mockRestore();
    open();
    await settled();
    expect(caravanDomPaused()).toBe(true);
  });

  it("a replaced world keeps them paused until its first frame", async () => {
    gate();
    document.getElementById("map")!.remove();
    document.body.prepend(mapSvg());
    await vi.waitFor(() => expect(renderer.telemetry().hiddenReason).toBe("source replaced"));
    expect(visible()).toBe(false);
    expect(caravanDomPaused()).toBe(true);
    renderer.worldReplaced(2);
    await vi.waitFor(() => expect(pipeline.prepares).toHaveLength(2));
    expect(renderer.telemetry().hiddenReason).toBe("not prepared");
    expect(caravanDomPaused()).toBe(true);
    open();
    await settled();
    expect(caravanDomPaused()).toBe(true);
  });

  it("caravans that moved, spawned and ended during an editor session are no change of the map (D13 net test)", async () => {
    const nextFrames = () => new Promise(resolve => setTimeout(resolve, 60));
    const layer = document.getElementById("tradeAnimation")!;
    const spawn = (x: number) => {
      const caravan = document.createElementNS(SVG_NS, "g");
      caravan.setAttribute("transform", `translate(${x}, 0)`);
      layer.append(caravan);
      return caravan;
    };
    const ending = spawn(1);
    const moving = spawn(2);
    await nextFrames();
    const rivers = document.getElementById("rivers")!;
    const dialog = openDialog();
    await vi.waitFor(() => expect(visible()).toBe(false));
    rivers.setAttribute("opacity", "0.5"); // an editor preview, undone before the close: a revision, net nothing
    moving.setAttribute("transform", "translate(3, 0) rotate(10)"); // the SVG animates while the editor is open
    ending.remove();
    spawn(4);
    await nextFrames();
    rivers.removeAttribute("opacity");
    await nextFrames();
    gate();
    dialog.style.display = "none";
    await vi.waitFor(() => expect(visible()).toBe(true)); // the last frame at once, no hold
    expect(renderer.telemetry().hold).toMatchObject({
      active: false,
      holds: 0,
      netUnchanged: 1,
      net: { verdict: "unchanged" }
    });
    open();
    await vi.waitFor(() => expect(renderer.telemetry().frameRevision).toBe(renderer.telemetry().revision));
  });

  it("dispose (SVG fallback) leaves every caravan at its pose, then live", () => {
    tick(8);
    renderer.dispose();
    expect(caravanDomPaused()).toBe(false);
    expect(group.getAttribute("transform")).toBe(pose(8));
    tick(9);
    expect(group.getAttribute("transform")).toBe(pose(9));
    renderer = new GpuRenderer(document.getElementById("map") as unknown as SVGSVGElement, reason =>
      fallBacks.push(reason)
    );
  });
});

// PAN (W4a): while the canvas covers the model SVG during a gesture, nothing writes the SVG (each write re-layerized the
// whole document, ~150 ms a frame on the parity world), the camera stays on the canvas, and moving frames draw
// through the pan cache.
describe("[PAN] gestures leave the model SVG alone", () => {
  const frames = () => new Promise(resolve => setTimeout(resolve, 60));
  const windows = (covered: boolean, complete: boolean) => ({
    covered,
    complete,
    refreshes: 0,
    covers() {
      return this.covered;
    },
    async refresh() {
      this.refreshes++;
      return true;
    },
    margin: 640,
    bytes: 0
  });
  const prepareWith = async (bitmaps: NonNullable<typeof pipeline.windows>) => {
    pipeline.windows = bitmaps;
    document.getElementById("rivers")!.setAttribute("opacity", "0.5"); // a revision: the next frame has the windows
    await vi.waitFor(() => expect(pipeline.prepares).toHaveLength(2));
    await settled();
  };

  it("emblem culling follows the camera at rest only: the gesture's end culls once, for its last camera", async () => {
    pipeline.culls.length = 0;
    for (let x = 1; x <= 5; x++) {
      expect(renderer.camera({ scale: 2, x: x * 10, y: 0 })).toBe(true);
      await frames();
    }
    expect(pipeline.culls.filter(cull => cull.x !== 0)).toEqual([]);
    renderer.camera({ scale: 2, x: 60, y: 0, exact: true });
    expect(pipeline.culls.at(-1)).toEqual({ k: 2, x: 60, y: 0, moving: false });
    expect(pipeline.culls.every(cull => !cull.moving)).toBe(true);
  });

  it("a gesture that never gets its exact update is culled and redrawn in full once the watchdog ends it", async () => {
    renderer.camera({ scale: 2, x: 30, y: 0 });
    await frames();
    expect(pipeline.culls.some(cull => cull.x === 30)).toBe(false);
    expect(pipeline.draws.at(-1)).toBe("pan");
    await vi.waitFor(() => expect(pipeline.culls.some(cull => cull.x === 30)).toBe(true), { timeout: 2000 });
    await vi.waitFor(() => expect(pipeline.draws.at(-1)).toBe("render"));
    expect(renderer.telemetry().moving).toBe(false);
  });

  it("moving frames draw through the pan cache; the exact update releases it and draws the frame in full", async () => {
    pipeline.draws.length = 0;
    renderer.camera({ scale: 1, x: 5, y: 5 });
    await frames();
    renderer.camera({ scale: 1, x: 9, y: 7 });
    await frames();
    expect(pipeline.draws).toEqual(["pan", "pan"]);
    const releases = pipeline.panReleases;
    renderer.camera({ scale: 1, x: 9, y: 7, exact: true });
    expect(pipeline.panReleases).toBeGreaterThan(releases);
    await vi.waitFor(() => expect(pipeline.draws.at(-1)).toBe("render"));
  });

  it("outside cropped bitmap windows a moving canvas keeps the camera; at rest the SVG takes it until the refresh", async () => {
    const bitmaps = windows(true, false);
    await prepareWith(bitmaps);
    const viewbox = document.getElementById("viewbox")!;
    bitmaps.covered = false;
    expect(renderer.camera({ scale: 1, x: 40, y: 0 })).toBe(true); // handled by the canvas, the SVG unwritten
    await frames();
    expect(visible()).toBe(true);
    expect(viewbox.getAttribute("transform")).toBe("translate(0 0) scale(1)");
    expect(renderer.telemetry().windows.gaps).toBeGreaterThan(0);
    await vi.waitFor(() => expect(bitmaps.refreshes).toBeGreaterThan(0)); // the refresh starts mid-gesture
    expect(renderer.camera({ scale: 1, x: 40, y: 0, exact: true })).toBe(false);
    expect(visible()).toBe(false); // at rest the SVG shows the view until crops cover it
    expect(viewbox.getAttribute("transform")).toBe("translate(40 0) scale(1)");
    bitmaps.covered = true;
    renderer.camera({ scale: 1, x: 40, y: 0, exact: true });
    await settled();
  });

  it("caravans neither start nor end in the DOM under a moving canvas: held to the exact update, or until it hides", async () => {
    const group = document.createElementNS(SVG_NS, "g");
    const ran: string[] = [];
    expect(caravanChangesHeld()).toBe(false);
    renderer.camera({ scale: 1, x: 3, y: 0 });
    expect(caravanChangesHeld()).toBe(true);
    caravanChange(() => ran.push("end"), group);
    caravanChange(() => ran.push("start"));
    expect(ran).toEqual([]);
    expect(caravanEnded(group)).toBe(true);
    await frames();
    expect(ran).toEqual([]);
    expect(renderer.telemetry().caravans).toMatchObject({ held: true, heldChanges: expect.any(Number) });
    renderer.camera({ scale: 1, x: 3, y: 0, exact: true });
    expect(ran).toEqual(["end", "start"]); // in the exact update's task
    expect(caravanChangesHeld()).toBe(false);
    caravanChange(() => ran.push("at rest"));
    expect(ran.at(-1)).toBe("at rest");

    // a canonical preview hides the canvas from outside mid-gesture: the SVG it reveals gets them at once
    renderer.camera({ scale: 1, x: 4, y: 0 });
    caravanChange(() => ran.push("preview"));
    renderer.canvas.style.visibility = "hidden";
    await Promise.resolve(); // the observer checkpoint
    expect(ran.at(-1)).toBe("preview");
    renderer.camera({ scale: 1, x: 5, y: 0 });
    expect(caravanChangesHeld()).toBe(false);
    renderer.canvas.style.removeProperty("visibility");
    await vi.waitFor(() => expect(caravanDomPaused()).toBe(true));

    renderer.camera({ scale: 1, x: 6, y: 0 });
    caravanChange(() => ran.push("before the SVG shows"));
    const dialog = document.createElement("div");
    dialog.className = "ui-dialog";
    document.body.append(dialog);
    await vi.waitFor(() => expect(visible()).toBe(false));
    expect(ran.at(-1)).toBe("before the SVG shows");
    expect(caravanChangesHeld()).toBe(false);
    renderer.camera({ scale: 1, x: 9, y: 0 }); // the SVG is the map: nothing is held
    expect(caravanChangesHeld()).toBe(false);
    dialog.remove();
    renderer.camera({ scale: 1, x: 9, y: 0, exact: true });
    await settled();
  });

  it("whole bitmaps keep the canvas outside the capture box, and re-crop at rest only", async () => {
    const bitmaps = windows(true, true);
    await prepareWith(bitmaps);
    bitmaps.covered = false;
    expect(renderer.camera({ scale: 1, x: 40, y: 0 })).toBe(true);
    await frames();
    expect(bitmaps.refreshes).toBe(0);
    expect(renderer.telemetry().windows.gaps).toBe(0);
    expect(renderer.camera({ scale: 1, x: 40, y: 0, exact: true })).toBe(false);
    expect(visible()).toBe(true);
    await vi.waitFor(() => expect(bitmaps.refreshes).toBeGreaterThan(0));
    expect(visible()).toBe(true);
  });
});
