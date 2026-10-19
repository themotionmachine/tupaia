import { describe, expect, it } from "vitest";
import {
  GPU_UNAVAILABLE_REASON,
  parseRendererPreference,
  probeWebGL2,
  type RendererBackend,
  RendererRouter,
  rendererStatus
} from "./renderer-mode";

const webgl2 = () => ({ webgl2: true });
function fakeBackend(log: string[], failOn?: "worldReplaced" | "dispose"): RendererBackend {
  return {
    kind: "gpu",
    worldReplaced(world) {
      log.push(`world:${world}`);
      if (failOn === "worldReplaced") throw new Error("lost context");
    },
    dispose() {
      log.push("dispose");
      if (failOn === "dispose") throw new Error("dispose boom");
    }
  };
}

describe("parseRendererPreference", () => {
  it("defaults to svg without a flag", () => {
    expect(parseRendererPreference("")).toEqual({ requested: "svg", source: "default", raw: null });
    expect(parseRendererPreference("?seed=1&reliefWorker=1")).toMatchObject({ requested: "svg", source: "default" });
  });

  it("accepts svg and gpu with surrounding whitespace and any case", () => {
    expect(parseRendererPreference("?renderer=gpu")).toEqual({ requested: "gpu", source: "query", raw: "gpu" });
    expect(parseRendererPreference("renderer=%20GPU%20").requested).toBe("gpu");
    expect(parseRendererPreference("?renderer=svg").requested).toBe("svg");
  });

  it.each([
    "?renderer=",
    "?renderer=webgl",
    "?renderer=gpu2",
    "?renderer",
    "?renderer=1"
  ])("falls back to svg with a warning for %s", search => {
    const preference = parseRendererPreference(search);
    expect(preference.requested).toBe("svg");
    expect(preference.source).toBe("query");
    expect(preference.warning).toMatch(/Unknown renderer/);
  });

  it("treats conflicting duplicates as svg but tolerates repeated identical values", () => {
    expect(parseRendererPreference("?renderer=gpu&renderer=svg")).toMatchObject({
      requested: "svg",
      warning: expect.stringMatching(/Conflicting/)
    });
    expect(parseRendererPreference("?renderer=gpu&renderer=GPU").requested).toBe("gpu");
  });
});

describe("probeWebGL2", () => {
  it("reports missing WebGL2 and releases a successful probe context", () => {
    expect(probeWebGL2(() => ({ getContext: () => null }) as unknown as HTMLCanvasElement)).toEqual({
      webgl2: false,
      reason: "WebGL2 context unavailable"
    });
    let lost = false;
    const gl = {
      getExtension: () => ({
        loseContext: () => {
          lost = true;
        }
      })
    };
    expect(probeWebGL2(() => ({ getContext: () => gl }) as unknown as HTMLCanvasElement)).toEqual({ webgl2: true });
    expect(lost).toBe(true);
  });

  it("turns probe exceptions into a reason instead of throwing", () => {
    const result = probeWebGL2(() => {
      throw new Error("blocked");
    });
    expect(result).toEqual({ webgl2: false, reason: "WebGL2 probe failed: blocked" });
  });
});

describe("RendererRouter", () => {
  it("never probes or builds a GPU backend for the default svg path", () => {
    const calls: string[] = [];
    const router = new RendererRouter({
      search: "",
      probe: () => {
        calls.push("probe");
        return { webgl2: true };
      },
      gpuBackend: () => {
        calls.push("build");
        return fakeBackend([]);
      }
    });
    expect(router.start()).toMatchObject({ requested: "svg", active: "svg", fallbackReason: "", capabilities: null });
    expect(calls).toEqual([]);
  });

  it("keeps svg active when WebGL2 is missing", () => {
    const router = new RendererRouter({ search: "?renderer=gpu", probe: () => ({ webgl2: false, reason: "no gl" }) });
    expect(router.start()).toMatchObject({ requested: "gpu", active: "svg", fallbackReason: "no gl" });
  });

  it("keeps svg active in P0 even with WebGL2 because no GPU backend is registered", () => {
    const router = new RendererRouter({ search: "?renderer=gpu", probe: webgl2 });
    expect(router.start()).toMatchObject({ active: "svg", fallbackReason: GPU_UNAVAILABLE_REASON });
  });

  it("falls back to svg and disposes a backend whose init fails", () => {
    const log: string[] = [];
    const wrongKind = { ...fakeBackend(log), kind: "svg" as const };
    const router = new RendererRouter({ search: "?renderer=gpu", probe: webgl2, gpuBackend: () => wrongKind });
    expect(router.start()).toMatchObject({ active: "svg", fallbackReason: "GPU init failed: Backend reported svg" });
    expect(log).toEqual(["dispose"]);
    const throwing = new RendererRouter({
      search: "?renderer=gpu",
      probe: webgl2,
      gpuBackend: () => {
        throw new Error("shader compile");
      }
    });
    expect(throwing.start().fallbackReason).toBe("GPU init failed: shader compile");
  });

  it("routes world replacement to the active backend and falls back on failure", () => {
    const log: string[] = [];
    const router = new RendererRouter({
      search: "?renderer=gpu",
      probe: webgl2,
      gpuBackend: () => fakeBackend(log, "worldReplaced")
    });
    expect(router.worldReplaced()).toBe(0);
    expect(router.start().active).toBe("gpu");
    expect(router.worldReplaced()).toBe(1);
    expect(router.snapshot()).toMatchObject({ active: "svg", fallbackReason: "World replace failed: lost context" });
    expect(router.worldReplaced()).toBe(2);
    expect(log).toEqual(["world:1", "dispose"]);
  });

  it("disposes once, ignores later lifecycle calls and records dispose errors", () => {
    const log: string[] = [];
    const router = new RendererRouter({
      search: "?renderer=gpu",
      probe: webgl2,
      gpuBackend: () => fakeBackend(log, "dispose")
    });
    router.start();
    router.dispose();
    router.dispose();
    expect(router.worldReplaced()).toBe(0);
    expect(router.start()).toMatchObject({ disposed: true, warnings: ["Dispose failed: dispose boom"] });
    expect(log).toEqual(["dispose"]);
  });

  it("does not leak mutable status through snapshots", () => {
    const router = new RendererRouter({ search: "?renderer=bogus" });
    const first = router.start();
    first.warnings.push("tampered");
    expect(router.snapshot().warnings).toEqual(['Unknown renderer "bogus"; using svg']);
  });
});

describe("module wiring", () => {
  it("exposes an svg status for the page without a renderer flag", () => {
    expect(rendererStatus()).toMatchObject({ requested: "svg", active: "svg", started: true, disposed: false });
    expect(window.rendererStatus).toBe(rendererStatus);
  });
});
