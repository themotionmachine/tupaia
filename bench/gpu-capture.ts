// P1 GpuCaptureAdapter: a composited Playwright screenshot plus in-page provenance. The pixels are what the page
// shows; activeRenderer is "gpu" only when the router reports gpu AND the GPU canvas is displayed and active, so a
// gpu arm that fell back or is suspended is reported as svg, never relabeled.
import type { Page } from "playwright";
import type { GpuCaptureAdapter, GpuCaptureResult, RendererKind } from "./renderer-ab.ts";

const NAME = "playwright-composited";

interface PageState {
  active: RendererKind;
  gpuState: string | null;
  canvasVisible: boolean;
  vendor: string;
  renderer: string;
}

export function playwrightGpuCapture(page: Page): GpuCaptureAdapter {
  return {
    name: NAME,
    async capture(request): Promise<GpuCaptureResult> {
      const state: PageState = await page.evaluate(() => {
        const w = globalThis as any;
        const status = w.rendererStatus?.();
        const canvas = document.querySelector("#map + canvas") as HTMLCanvasElement | null;
        const canvasVisible = !!canvas && canvas.style.display !== "none";
        const gpuState = status?.gpu?.state ?? null;
        const probe = document.createElement("canvas").getContext("webgl2");
        const info = probe?.getExtension("WEBGL_debug_renderer_info");
        const vendor = probe ? String(probe.getParameter(info ? info.UNMASKED_VENDOR_WEBGL : probe.VENDOR)) : "";
        const renderer = probe ? String(probe.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : probe.RENDERER)) : "";
        probe?.getExtension("WEBGL_lose_context")?.loseContext();
        const gpu = status?.active === "gpu" && gpuState === "active" && canvasVisible;
        return { active: gpu ? "gpu" : "svg", gpuState, canvasVisible, vendor, renderer };
      });
      if (request.renderer === "gpu" && state.active !== "gpu")
        return {
          supported: false,
          adapter: NAME,
          reason: `GPU arm not presenting (state ${state.gpuState}, canvas ${state.canvasVisible ? "shown" : "hidden"})`
        };
      const png = (await page.screenshot({ type: "png", animations: "disabled", caret: "hide" })).toString("base64");
      const raw = await page.evaluate(async data => {
        const image = new Image();
        image.src = "data:image/png;base64," + data;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const bytes = context.getImageData(0, 0, image.width, image.height).data;
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000)
          binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
        return { width: image.width, height: image.height, data: btoa(binary) };
      }, png);
      return {
        supported: true,
        adapter: NAME,
        image: { width: raw.width, height: raw.height, data: new Uint8Array(Buffer.from(raw.data, "base64")) },
        gpu: { vendor: state.vendor, renderer: state.renderer },
        activeRenderer: state.active
      };
    }
  };
}
