// Texture ownership for compat runs, kept free of DOM/raster imports so it can be unit-tested directly. A screen
// overlay's texture is owned by its slot (the overlay lane swaps it in place); world-run textures are owned by the
// prepared frame's texture list. Detail textures are always owned by their slot.
import type { GpuDevice, TrackedTexture } from "./device";
import type { ImageBatch } from "./framegraph";
import { type HitShape, PickIndex } from "./pick";

export interface OwnedRun {
  slot: ImageBatch;
  screen: boolean;
}

// Screen-space index of the root overlays painted above the world (runs carrying `hits`, SVG-local CSS px), in DOM
// order so the last root is topmost. Overlays below #viewbox are not indexed: whatever the world index finds there
// is above them, and a miss routes to the same clicked() fallbacks an overlay hit does.
export function indexOverlays(runs: { hits?: HitShape[] }[], screen: { width: number; height: number }): PickIndex {
  const index = new PickIndex(screen.width, screen.height);
  for (const run of runs) for (const shape of run.hits ?? []) index.addShape("screen", shape);
  return index;
}

type Releaser = Pick<GpuDevice, "release">;
type Rect = [number, number, number, number];

// Frees slot-owned textures once: the slots are nulled, so a second call (or a later swap) releases nothing again.
export function releaseRuns(runs: OwnedRun[], device: Releaser): void {
  for (const run of runs) {
    device.release(run.slot.detail?.texture);
    run.slot.detail = null;
    if (!run.screen) continue;
    device.release(run.slot.texture);
    run.slot.texture = null;
  }
}

// Uploads every new texture before any old one is released; a failed upload frees the ones already made and rethrows,
// leaving the slots (and the frame) untouched.
export function uploadAll<T>(items: T[], upload: (item: T) => TrackedTexture | null, device: Releaser) {
  const textures: (TrackedTexture | null)[] = [];
  try {
    for (const item of items) textures.push(upload(item));
  } catch (error) {
    for (const texture of textures) device.release(texture);
    throw error;
  }
  return textures;
}

// Commits new overlay textures: each old slot texture is released exactly once and replaced. A null texture (fully
// transparent overlay) keeps the previous rect, which then draws nothing.
export function swapOverlays(
  entries: { run: OwnedRun; texture: TrackedTexture | null; rect: Rect | null }[],
  device: Releaser
): void {
  for (const { run, texture, rect } of entries) {
    device.release(run.slot.texture);
    run.slot.texture = texture;
    if (rect) run.slot.rect = rect;
  }
}
