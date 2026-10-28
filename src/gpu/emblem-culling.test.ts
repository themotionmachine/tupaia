// @vitest-environment happy-dom
// W5 HiddenEmblemCulling + SvgCover: when the cover applies and when it lifts, against a real (happy-dom) DOM. The
// renderer shows the canvas (display:block) and runs the culling update in the same task (GpuRenderer.draw), so the
// cover must apply in that update, not a frame later; a canvas hidden from anywhere must reveal the model. Native paint
// and hit testing under the cover are browser properties (bench/host/native-recovery.ts, cover-state.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HiddenEmblemCulling } from "./emblem-culling";

const NS = "http://www.w3.org/2000/svg";
const camera = { k: 1, x: 0, y: 0 };
const viewport = { width: 1, height: 1, dpr: 1 };

let svg: SVGSVGElement;
let canvas: HTMLCanvasElement;
let culling: HiddenEmblemCulling;

// "" is happy-dom's initial (visible) value
const viewboxVisibility = () => getComputedStyle(svg.querySelector("#viewbox")!).visibility || "visible";
const coverActive = () => !!culling.status().cover?.active;

beforeEach(() => {
  // happy-dom lacks FontFaceSet and Web Animations on elements: the culling only listens to the one and asks the other
  Object.defineProperty(document, "fonts", { value: new EventTarget(), configurable: true });
  const prototype = Element.prototype as unknown as { getAnimations?: () => Animation[] };
  if (!prototype.getAnimations) prototype.getAnimations = () => [];
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  // nor an initial opacity: the culling requires 1 on the canvas and every ancestor
  for (const element of [document.documentElement, document.body]) element.style.opacity = "1";
  svg = document.createElementNS(NS, "svg") as SVGSVGElement;
  svg.id = "map";
  svg.setAttribute("style", "overflow:hidden");
  svg.innerHTML = `<g id="viewbox"><g id="rivers"><path d="M0 0L10 10"/></g><g id="emblems"></g></g>`;
  document.body.append(svg);
  canvas = document.createElement("canvas");
  // what GpuRenderer gives its canvas: fixed over the svg, click-through, hidden until the first frame (visibility and
  // opacity spelled out: happy-dom computes no initial value for them)
  Object.assign(canvas.style, {
    position: "fixed",
    pointerEvents: "none",
    display: "none",
    visibility: "visible",
    opacity: "1"
  });
  svg.after(canvas);
  culling = new HiddenEmblemCulling(() => svg, canvas);
});

afterEach(() => {
  culling.dispose();
  Reflect.deleteProperty(document, "fonts");
  vi.unstubAllGlobals();
});

describe("[W5] HiddenEmblemCulling and the svg-cover", () => {
  it("never covers while the canvas is hidden, even when the cover is wanted over an opaque frame", () => {
    culling.update(camera, viewport, true, true);
    expect(coverActive()).toBe(false);
    expect(viewboxVisibility()).toBe("visible");
  });

  it("applies the cover in the same update that sees the canvas shown over an opaque frame", () => {
    culling.update(camera, viewport, true, true);
    // GpuRenderer.draw: the frame is painted, the canvas shown and the culling updated in one task
    canvas.style.display = "block";
    culling.update(camera, viewport, true, true);
    expect(coverActive()).toBe(true);
    expect(viewboxVisibility()).toBe("hidden");
    expect(culling.status()).toMatchObject({ enabled: true, cover: { wanted: true, applied: 1 } });
  });

  it("does not cover a translucent frame or when the cover is not wanted", () => {
    canvas.style.display = "block";
    culling.update(camera, viewport, false, true); // a translucent clear: the model shows through
    expect(coverActive()).toBe(false);
    culling.update(camera, viewport, true, false); // not armed
    expect(coverActive()).toBe(false);
  });

  it("reveals the model when the canvas hides, without another update", async () => {
    canvas.style.display = "block";
    culling.update(camera, viewport, true, true);
    expect(coverActive()).toBe(true);
    canvas.style.display = "none"; // a canonical preview, or anything else that hides it from outside
    await Promise.resolve(); // the mutation observer's checkpoint
    expect(coverActive()).toBe(false);
    expect(viewboxVisibility()).toBe("visible");
    expect(culling.status().cover).toMatchObject({ revealed: 1 });
  });

  it("reveals synchronously through reveal() (GpuRenderer.hide) and in an update with an opaque frame lost", () => {
    canvas.style.display = "block";
    culling.update(camera, viewport, true, true);
    culling.reveal();
    expect(coverActive()).toBe(false);
    culling.update(camera, viewport, true, true);
    expect(coverActive()).toBe(true);
    culling.update(camera, viewport, false, true);
    expect(coverActive()).toBe(false);
  });
});
