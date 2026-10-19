// One-entry cache of the CPU-side Scene (buildScene output) so a WebGL context restore can skip the DOM walk when
// nothing the walk reads has changed. Keyed by the renderer's DOM revision, its world epoch (bumped when #map is
// replaced or the renderer is disposed), the curve tolerance and the #viewbox element identity.
//
// prepareFrame mutates scene.layers (native--, compat++, reasons, relief source), so the cache keeps its own copy of
// the layer reports at store time and hands out a fresh copy on every hit. Draws are shared: prepare never mutates them.
// Heap trade-off: the cache keeps the last scene (its draws, flattened subpaths and element references) alive after
// the prepare that built it, even when no restore follows. That is one scene per renderer, never more.
import type { Draw, LayerReport, Scene } from "./scene";

export interface SceneKey {
  revision: number; // renderer DOM revision the walk observed
  worldEpoch: number; // renderer world epoch: changes on #map replacement and dispose
  curveTolerance: number;
  viewbox: object; // the #viewbox element the walk started from (compared by identity)
}

export function sameSceneKey(a: SceneKey, b: SceneKey): boolean {
  return (
    a.revision === b.revision &&
    a.worldEpoch === b.worldEpoch &&
    a.curveTolerance === b.curveTolerance &&
    a.viewbox === b.viewbox
  );
}

// Deep enough for prepare's mutations: each report is new and its reasons array is new.
export function cloneLayers(layers: Record<string, LayerReport>): Record<string, LayerReport> {
  const out: Record<string, LayerReport> = {};
  for (const id of Object.keys(layers)) {
    const layer = layers[id];
    out[id] = { ...layer, reasons: [...layer.reasons] };
  }
  return out;
}

export class SceneCache {
  private entry: { key: SceneKey; draws: Draw[]; layers: Record<string, LayerReport> } | null = null;

  // Stores a snapshot: later mutation of `scene.layers` by the caller does not reach the cache.
  store(key: SceneKey, scene: Scene): void {
    this.entry = { key: { ...key }, draws: scene.draws, layers: cloneLayers(scene.layers) };
  }

  // A hit returns a Scene with fresh layer reports; null on a miss (no entry or any key field differs).
  get(key: SceneKey): Scene | null {
    const entry = this.entry;
    if (!entry || !sameSceneKey(entry.key, key)) return null;
    return { draws: entry.draws, layers: cloneLayers(entry.layers) };
  }

  clear(): void {
    this.entry = null;
  }

  get size(): number {
    return this.entry ? 1 : 0;
  }
}
