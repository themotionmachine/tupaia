// Opt-in, read-only census of how buildScene routed each element, for the per-layer golden runner
// (bench/host/layer-golden.ts). It is off unless the page sets `globalThis.__gpuSceneCensus` to an object before a
// prepare. Each buildScene then replaces `__gpuSceneCensus.last` with per top-level layer counts of what went native,
// what went to the compat lane and what was skipped (hidden, nothing to paint, non-rendering tags), plus a histogram
// keyed by route, draw kind, tag and reason, so a silent routing change shows up as a changed count.
// It never touches the DOM and never changes what buildScene returns.
import type { Draw } from "./scene";

export interface CensusLayer {
  native: number;
  compat: number;
  skipped: number;
  kinds: Record<string, number>; // e.g. "native shape <path>", "compat <image> image", "skipped display:none <g>"
}

export interface CensusSnapshot {
  build: number; // 1-based count of buildScene calls since the sink was installed
  layers: Record<string, CensusLayer>;
}

export interface CensusSink {
  builds?: number;
  last?: CensusSnapshot | null;
}

const tagOf = (element: Element | null | undefined) => `<${element?.tagName ?? "?"}>`;

export class SceneCensus {
  private layers: Record<string, CensusLayer> = {};

  private constructor(private sink: CensusSink) {}

  // The census for one buildScene, or null (the normal case) when no page installed a sink.
  static open(): SceneCensus | null {
    const sink = (globalThis as { __gpuSceneCensus?: unknown }).__gpuSceneCensus;
    return sink && typeof sink === "object" ? new SceneCensus(sink as CensusSink) : null;
  }

  private entry(layer: string): CensusLayer {
    this.layers[layer] ??= { native: 0, compat: 0, skipped: 0, kinds: {} };
    return this.layers[layer];
  }

  private bump(layer: string, key: string): void {
    const kinds = this.entry(layer).kinds;
    kinds[key] = (kinds[key] ?? 0) + 1;
  }

  // An element (and so its subtree) that buildScene walked past without a draw.
  skip(layer: string, element: Element, why: string): void {
    this.entry(layer).skipped++;
    this.bump(layer, `skipped ${why} ${tagOf(element)}`);
  }

  // Counts the finished draw list and publishes the snapshot as the sink's `last`.
  finish(draws: Draw[]): CensusSnapshot {
    const visit = (list: Draw[]) => {
      for (const draw of list) {
        switch (draw.kind) {
          case "compat":
            for (const element of draw.elements) {
              this.entry(draw.layer).compat++;
              this.bump(draw.layer, `compat ${tagOf(element)} ${draw.reason}`);
            }
            break;
          case "group":
            visit(draw.children);
            break;
          case "trade":
            this.entry(draw.layer).native++;
            this.bump(draw.layer, `native trade${draw.unsupported ? ` (${draw.unsupported})` : ""}`);
            visit(draw.children);
            break;
          default:
            this.entry(draw.layer).native++;
            this.bump(draw.layer, `native ${draw.kind} ${tagOf(draw.element)}`);
        }
      }
    };
    visit(draws);
    const build = (this.sink.builds ?? 0) + 1;
    const snapshot: CensusSnapshot = { build, layers: this.layers };
    this.sink.builds = build;
    this.sink.last = snapshot;
    return snapshot;
  }
}
