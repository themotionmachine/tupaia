// Fixture registry for the GPU renderer gates. Node-only, no browser imports, so gate.ts and the golden runner can
// import it cheaply.
//
//   import { resolveFixture } from "./fixtures/index.ts";
//   const fx = resolveFixture("parity");   // { name, path, sha256, text(), manifest, cameras, ... }
//
// `shared` is the live-map snapshot kept outside git (docs/performance/webgl-rewrite/GATE.md "Fixture"): resolving it
// returns the path the gate already looks for. `parity` is the deterministic fixture in tests/fixtures/parity/.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");
export const PARITY_DIR = resolve(REPO_ROOT, "tests/fixtures/parity");
export const PARITY_MAP = resolve(PARITY_DIR, "parity-v1.map");
export const PARITY_MANIFEST = resolve(PARITY_DIR, "parity-v1.json");
export const PAGE_SCRIPT = resolve(import.meta.dirname, "parity-page.js");

/** The generator inputs. Changing any of them changes the fixture: bump the version in the file names too. */
export const PARITY_CONFIG = {
  version: "parity-v1",
  seed: "parity10",
  template: "continents",
  cells: Number(process.env.PARITY_CELLS ?? 5000),
  states: 8,
  burgs: Number(process.env.PARITY_BURGS ?? 80),
  /** Relief icon density (1 = the style default). Lowered to keep the file under 3 MB. */
  reliefDensity: Number(process.env.PARITY_RELIEF ?? 0.4),
  width: 1280,
  height: 720,
  /** The date and map id the app stamps into the header of a saved map; both are rewritten so the file is stable. */
  normalizedDate: "2026-01-01",
  normalizedMapId: 1767225600000
} as const;

/** Layers the builder turns on (names of the MCP `display` tool). `cells` is left to the preamble: see parity-page.js. */
export const PARITY_LAYERS_ON = [
  "texture", "heightmap", "biomes", "grid", "coordinates", "compass", "rivers", "relief", "religions", "cultures",
  "states", "provinces", "zones", "borders", "routes", "temperature", "ice", "goods", "markets", "trade",
  "precipitation", "population", "emblems", "burgs", "labels", "military", "markers", "rulers", "scaleBar",
  "vignette", "lakes"
] as const;

export interface CameraPreset {
  /** Stable id, e.g. "k4-showcase". */
  id: string;
  k: number;
  /** d3 zoom state for a 1280x720 viewport (`translate(x, y) scale(k)`). */
  x: number;
  y: number;
  /** World-space centre the preset frames. */
  cx: number;
  cy: number;
  covers: string[];
}

/**
 * Which golden family (bench/host/golden-families.ts names) each camera `covers` tag frames. layer-golden.ts picks a
 * family's cameras with it, and `build-parity-fixture.ts --verify` asserts that every covered family has ink in each
 * preset's frame. Families without an entry are framed by the world view (k 1) or the showcase (k > 1).
 */
export const COVERS_BY_FAMILY: Record<string, string[]> = {
  ice: ["ice"],
  zones: ["zones-stock-hatch"],
  labels: ["labels"],
  emblems: ["emblems"],
  compass: ["compass"],
  markers: ["markers"],
  military: ["regiments"],
  rulers: ["measurers"],
  grid: ["grid-dashed"],
  coordinates: ["coordinates"],
  landmass: ["coastline-filter"],
  lakes: ["lakes"],
  coastline: ["coastline-filter"],
  states: ["halo"]
};

export interface Expectation {
  /** Dotted path into `census` (see parity-page.js). */
  path: string;
  /** The census value must be >= min, or deep-equal `equals`. */
  min?: number;
  equals?: unknown;
}

export interface FeatureEntry {
  id: string;
  /** REWRITE-PLAN §5 matrix rows this feature exercises. */
  rows: number[];
  what: string;
  expect: Expectation[];
  /** True when the saved file does not carry it and a run must apply `__parity.preamble()` first. */
  preamble?: boolean;
}

export interface ParityManifest {
  fixture: string;
  file: string;
  sha256: string;
  bytes: number;
  generator: Record<string, unknown>;
  config: typeof PARITY_CONFIG;
  build: Record<string, unknown>;
  layersOn: string[];
  /** Whole census (parity-page.js `census()`) at three moments: in the building page, after loading the saved file, and after the preamble. */
  census: {
    afterBuild: unknown;
    afterReload: unknown;
    afterReloadPreamble: unknown;
  };
  /** Per layer family, what a golden's layer-census assertion should require (after loading and the preamble). */
  layerCensus: Record<string, { elements: number; min: number; tags: Record<string, number> }>;
  features: FeatureEntry[];
  rowsCovered: Record<string, string[]>;
  cameras: CameraPreset[];
  /** Frames either side of the coastline filter switch points (k 1.5 and 2.6); `expect` is the #sea_island filter there. */
  coastlineSwitch: (CameraPreset & { expect: string })[];
  preamble: string;
  notes: string[];
}

export interface ResolvedFixture {
  name: string;
  path: string;
  sha256: string;
  text(): string;
  /** Present for `parity`. */
  manifest?: ParityManifest;
  cameras?: CameraPreset[];
  /** JS source to inject into a page (addInitScript) before calling `__parity.census()` / `__parity.preamble()`. */
  pageScript?: string;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function loadParityManifest(): ParityManifest {
  return JSON.parse(readFileSync(PARITY_MANIFEST, "utf8")) as ParityManifest;
}

export function resolveFixture(name: string): ResolvedFixture {
  if (name === "parity") {
    if (!existsSync(PARITY_MAP)) throw new Error(`parity fixture missing: ${PARITY_MAP} (npm run fixture:parity or node bench/host/fixtures/build-parity-fixture.ts)`);
    const manifest = loadParityManifest();
    const sha256 = sha256File(PARITY_MAP);
    if (sha256 !== manifest.sha256) throw new Error(`parity fixture sha256 ${sha256} does not match the manifest ${manifest.sha256}`);
    return {
      name,
      path: PARITY_MAP,
      sha256,
      text: () => readFileSync(PARITY_MAP, "utf8"),
      manifest,
      cameras: manifest.cameras,
      pageScript: readFileSync(PAGE_SCRIPT, "utf8")
    };
  }
  if (name === "shared") {
    const candidates = [
      process.env.TUPAIA_GATE_MAP,
      resolve(homedir(), ".tupaia-gates/fixtures/shared-v8-f5c0d703.map"),
      "/tmp/tupaia-navigation-shared-v8.map"
    ].filter((p): p is string => !!p);
    const path = candidates.find(p => existsSync(p));
    if (!path) throw new Error(`shared fixture not found (looked in ${candidates.join(", ")})`);
    return { name, path, sha256: sha256File(path), text: () => readFileSync(path, "utf8") };
  }
  throw new Error(`unknown fixture '${name}' (parity | shared)`);
}
