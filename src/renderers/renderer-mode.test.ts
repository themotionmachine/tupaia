import { describe, expect, it } from "vitest";
import {
  GPU_UNAVAILABLE_REASON,
  parseRendererPreference,
  probeWebGL2,
  type RendererBackend,
  type RendererHost,
  RendererRouter,
  rendererStatus,
  renderModeWanted
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
  it("defaults to gpu without a flag (W5), with no warning", () => {
    expect(parseRendererPreference("")).toEqual({ requested: "gpu", source: "default", raw: null });
    const plain = { requested: "gpu", source: "default", raw: null };
    expect(parseRendererPreference("?seed=1&reliefWorker=1")).toEqual(plain);
    expect(parseRendererPreference("?gpu-select")).toMatchObject({ requested: "gpu", source: "default" });
  });

  it("opts out to svg with ?renderer=svg", () => {
    expect(parseRendererPreference("?renderer=svg")).toEqual({ requested: "svg", source: "query", raw: "svg" });
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

  // a context whose debug extension names `renderer` (null: the extension is absent); records the attributes asked for
  const glNamed = (renderer: string | null, log: { attributes?: unknown; lost?: boolean } = {}) =>
    (() => ({
      getContext: (_id: string, attributes?: unknown) => {
        log.attributes = attributes;
        return {
          getExtension: (name: string) =>
            name === "WEBGL_lose_context"
              ? {
                  loseContext: () => {
                    log.lost = true;
                  }
                }
              : name === "WEBGL_debug_renderer_info" && renderer !== null
                ? { UNMASKED_RENDERER_WEBGL: 0x9246 }
                : null,
          getParameter: (pname: number) => (pname === 0x9246 ? renderer : null)
        };
      }
    })) as unknown as () => HTMLCanvasElement;

  it.each([
    "Google SwiftShader",
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
    "llvmpipe (LLVM 15.0.7, 256 bits)",
    "softpipe",
    "Microsoft Basic Render Driver",
    "Software Rasterizer"
  ])("hardwareOnly refuses the software renderer %s, and still releases the probe context", name => {
    const log: { attributes?: unknown; lost?: boolean } = {};
    const result = probeWebGL2(glNamed(name, log), { hardwareOnly: true });
    expect(result.webgl2).toBe(false);
    expect(result.reason).toMatch(/^Software WebGL renderer/);
    expect(result.reason).toContain(name);
    expect(log).toEqual({ attributes: { failIfMajorPerformanceCaveat: true }, lost: true });
  });

  it("hardwareOnly accepts a hardware renderer, or one it cannot name (no debug extension)", () => {
    const log: { attributes?: unknown } = {};
    expect(
      probeWebGL2(glNamed("ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)", log), {
        hardwareOnly: true
      })
    ).toEqual({ webgl2: true });
    expect(log.attributes).toEqual({ failIfMajorPerformanceCaveat: true });
    expect(probeWebGL2(glNamed(null), { hardwareOnly: true })).toEqual({ webgl2: true });
  });

  it("hardwareOnly reports a context refused for a major performance caveat", () => {
    const result = probeWebGL2(() => ({ getContext: () => null }) as unknown as HTMLCanvasElement, {
      hardwareOnly: true
    });
    expect(result).toEqual({ webgl2: false, reason: expect.stringMatching(/major performance caveat/) });
  });

  it("without hardwareOnly (an explicit ?renderer=gpu) takes software WebGL2 and asks for no caveat check", () => {
    const log: { attributes?: unknown } = {};
    expect(probeWebGL2(glNamed("Google SwiftShader", log))).toEqual({ webgl2: true });
    expect(log.attributes).toBeUndefined();
  });

  it("turns probe exceptions into a reason instead of throwing", () => {
    const result = probeWebGL2(() => {
      throw new Error("blocked");
    });
    expect(result).toEqual({ webgl2: false, reason: "WebGL2 probe failed: blocked" });
  });
});

describe("RendererRouter", () => {
  it("never probes or builds a GPU backend for the ?renderer=svg opt-out", () => {
    const calls: string[] = [];
    const router = new RendererRouter({
      search: "?renderer=svg",
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

  it("probes and builds the GPU backend by default", () => {
    const router = new RendererRouter({ search: "", probe: webgl2, gpuBackend: () => fakeBackend([]) });
    expect(router.start()).toMatchObject({ requested: "gpu", active: "gpu", fallbackReason: "", warnings: [] });
  });

  it("asks the probe for hardware only by default; an explicit ?renderer=gpu skips that guard", () => {
    const asked: unknown[] = [];
    const probe = (options: unknown) => {
      asked.push(options);
      return { webgl2: true };
    };
    new RendererRouter({ search: "", probe, gpuBackend: () => fakeBackend([]) }).start();
    new RendererRouter({ search: "?renderer=gpu", probe, gpuBackend: () => fakeBackend([]) }).start();
    expect(asked).toEqual([{ hardwareOnly: true }, { hardwareOnly: false }]);
  });

  it("falls back to svg by default on a software renderer, with the probe's reason", () => {
    const router = new RendererRouter({
      search: "",
      probe: ({ hardwareOnly }) =>
        hardwareOnly ? { webgl2: false, reason: "Software WebGL renderer (Google SwiftShader)" } : { webgl2: true },
      gpuBackend: () => fakeBackend([])
    });
    expect(router.start()).toMatchObject({
      requested: "gpu",
      active: "svg",
      fallbackReason: "Software WebGL renderer (Google SwiftShader)"
    });
  });

  it("falls back to svg by default when WebGL2 is missing", () => {
    const router = new RendererRouter({ search: "", probe: () => ({ webgl2: false, reason: "no gl" }) });
    expect(router.start()).toMatchObject({ requested: "gpu", active: "svg", fallbackReason: "no gl" });
  });

  it.each(["?renderer=webgl", "?renderer=gpu&renderer=svg"])("never probes for %s (svg with a warning)", search => {
    const calls: string[] = [];
    const router = new RendererRouter({
      search,
      probe: () => {
        calls.push("probe");
        return { webgl2: true };
      },
      gpuBackend: () => fakeBackend([])
    });
    const status = router.start();
    expect(status).toMatchObject({ requested: "svg", active: "svg" });
    expect(status.warnings).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it("keeps svg active when WebGL2 is missing", () => {
    const router = new RendererRouter({ search: "?renderer=gpu", probe: () => ({ webgl2: false, reason: "no gl" }) });
    expect(router.start()).toMatchObject({ requested: "gpu", active: "svg", fallbackReason: "no gl" });
  });

  it("keeps svg active with WebGL2 when no GPU backend is registered", () => {
    const router = new RendererRouter({ search: "?renderer=gpu", probe: webgl2 });
    expect(router.start()).toMatchObject({ active: "svg", fallbackReason: GPU_UNAVAILABLE_REASON });
  });

  it("lets the active backend fall back asynchronously and ignores stale hosts", () => {
    const log: string[] = [];
    const hosts: RendererHost[] = [];
    const router = new RendererRouter({
      search: "?renderer=gpu",
      probe: webgl2,
      gpuBackend: host => {
        hosts.push(host);
        return { ...fakeBackend(log), telemetry: () => ({ state: "active" }) };
      }
    });
    expect(router.start()).toMatchObject({ active: "gpu", gpu: { state: "active" } });
    hosts[0].fallBack("GPU prepare failed: oom");
    expect(router.snapshot()).toMatchObject({ active: "svg", fallbackReason: "GPU prepare failed: oom" });
    expect(router.snapshot().gpu).toBeUndefined();
    hosts[0].fallBack("GPU restore failed: late");
    expect(router.snapshot().fallbackReason).toBe("GPU prepare failed: oom");
    expect(log).toEqual(["dispose"]);
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

describe("renderModeWanted", () => {
  it("installs the mode controller only where the GPU renderer started", () => {
    expect(renderModeWanted({ requested: "gpu", active: "gpu" })).toBe(true);
    expect(renderModeWanted({ requested: "gpu", active: "svg" })).toBe(false); // no (hardware) WebGL2 at start
    expect(renderModeWanted({ requested: "svg", active: "svg" })).toBe(false);
  });
});

describe("module wiring", () => {
  it("requests gpu for the page without a renderer flag, and falls back to svg where WebGL2 is missing", () => {
    // the node test environment has no canvas: the default GPU request falls back at start
    expect(rendererStatus()).toMatchObject({ requested: "gpu", active: "svg", started: true, disposed: false });
    expect(rendererStatus().fallbackReason).not.toBe("");
    expect(window.rendererStatus).toBe(rendererStatus);
    expect(renderModeWanted(rendererStatus())).toBe(false); // so no mode chip either
  });
});
