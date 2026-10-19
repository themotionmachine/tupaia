// Browser launch configurations for the host checks, and the adapter probe that proves which one a run got.
//
// Playwright's default `chromium.launch({headless: true})` starts chrome-headless-shell, whose WebGL is SwiftShader
// (CPU rasterization): ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device ...)). On the M1 Max a bare 2560x1440 clear runs
// at about 25 ms per frame there against 8 ms under Metal (~/.tupaia-gates/w1-replay/launcher-probe/result.json). The
// GPU renderer's frames, prepares and refines are all slower by more than that, which (a) roughly doubles the wall
// time of a browser check and (b) changes what a timing-sensitive correctness check observes: the integration
// harness's stale-camera clicks land after the d3 zoom "end" (150 ms after the wheel), so the canonical camera is no
// longer stale and the route and marker cohorts go UNTESTED.
//
// `metal` is new-headless full Chromium with ANGLE on Metal: the host's real GPU, the configuration every other host
// check (golden, smoke, palette, canonical, navigation) already uses. Correctness checks use it under a shared slot;
// timing checks use it (or headful Metal, `paired`) under the exclusive lock. `swiftshader` is kept only to reproduce
// the old behaviour on purpose.
import type { LaunchOptions } from "playwright";

export const LAUNCHERS = ["metal", "swiftshader"] as const;
export type Launcher = (typeof LAUNCHERS)[number];

export function launcherFrom(value: string | undefined): Launcher {
  const name = (value ?? "").trim() || "metal";
  if ((LAUNCHERS as readonly string[]).includes(name)) return name as Launcher;
  throw new Error(`launcher must be one of ${LAUNCHERS.join(", ")}, got ${JSON.stringify(value)}`);
}

export function launchOptions(launcher: Launcher): LaunchOptions {
  return launcher === "metal"
    ? { headless: true, channel: "chromium", args: ["--use-angle=metal", "--enable-gpu"] }
    : { headless: true };
}

// What the launcher's WebGL adapter must look like; a mismatch means the run did not get the configuration it asked for.
export function adapterMatches(launcher: Launcher, renderer: string | null): boolean {
  if (!renderer) return false;
  return launcher === "metal" ? /Metal/i.test(renderer) && !/SwiftShader/i.test(renderer) : /SwiftShader/i.test(renderer);
}

// Page function: the unmasked WebGL renderer string of a throwaway webgl2 canvas (the GPU renderer's own canvas may
// not exist yet, or may have fallen back).
export function probeAdapter(): { renderer: string | null; vendor: string | null } {
  const gl = document.createElement("canvas").getContext("webgl2");
  const ext = gl?.getExtension("WEBGL_debug_renderer_info");
  return {
    renderer: gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : null,
    vendor: gl && ext ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) : null
  };
}
