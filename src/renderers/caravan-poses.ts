// Live trade caravan poses: draw-trade-animation.ts animates them; gpu/markers.ts and gpu/renderer.ts read them. GPU
// renderer (W3b PAINT; the default display since W5): while the GPU canvas presents the map, a caravan's per-frame pose
// stays here instead of being written to its SVG group. Chrome re-paints and re-layerizes the whole visible document
// for any SVG attribute write, even under the canvas: on the parity world with every layer on that is ~115 ms a frame
// (9 fps with the default 30 caravans) for a copy no one sees. The GPU mirrors these poses; the SVG is brought up to
// date whenever it is shown (setCaravanDomPaused(false)), clicked (syncCaravans), interrupted (settlePose) or exported
// (export clones copy the live poses). Only the GPU renderer pauses: in SVG mode every tick is written, exactly as
// before.

// Every caravan group still in flight, wherever it was appended: a load replaces the container, so clear() cannot
// reach groups drawn into the previous world through the current `tradeAnimation` selection
export const liveGroups = new Set<SVGGElement>();

const poses = new WeakMap<Element, string>();
let paused = false;
let moved: (() => void) | null = null;
const stats = { pauses: 0, syncs: 0, written: 0 };

// A caravan group's current transform: its live pose while writes are paused, else its attribute
export function caravanTransform(group: Element): string | null {
  return poses.get(group) ?? group.getAttribute("transform");
}

// The last pose drawn for a caravan group (undefined before its first tick)
export function livePose(group: Element): string | undefined {
  return poses.get(group);
}

export function caravanDomPaused(): boolean {
  return paused;
}

// Pausing keeps poses out of the DOM; resuming writes every live caravan's pose at once
export function setCaravanDomPaused(value: boolean): void {
  if (value === paused) return;
  paused = value;
  if (paused) stats.pauses++;
  else syncCaravans();
}

// Called on every paused tick instead of an attribute write (the GPU redraws on it); returns a detach function that
// leaves a newer listener in place
export function onCaravansMoved(listener: () => void): () => void {
  moved = listener;
  return () => {
    if (moved === listener) moved = null;
  };
}

// One animation tick: kept for the GPU, and written to the group unless paused
export function recordPose(group: Element, value: string): void {
  poses.set(group, value);
  if (paused) moved?.();
  else group.setAttribute("transform", value);
}

// A caravan whose transition was interrupted (stop, a harness freeze) keeps the pose it was last drawn at
export function settlePose(group: Element): void {
  const value = poses.get(group);
  if (value !== undefined && group.getAttribute("transform") !== value) group.setAttribute("transform", value);
}

// Writes each live caravan's pose to its group where the attribute lags; returns how many were written
export function syncCaravans(): number {
  let written = 0;
  for (const group of liveGroups) {
    const pose = poses.get(group);
    if (pose === undefined || group.getAttribute("transform") === pose) continue;
    group.setAttribute("transform", pose);
    written++;
  }
  if (written) {
    stats.syncs++;
    stats.written += written;
  }
  return written;
}

const TRANSLATE = /^translate\(\s*([-+\d.e]+)[\s,]+([-+\d.e]+)\s*\)/;

// Whether a live caravan's pose is within `radius` (world units) of x, y: a click there must see current poses
export function caravanNear(x: number, y: number, radius: number): boolean {
  for (const group of liveGroups) {
    const match = TRANSLATE.exec(poses.get(group) ?? "");
    if (match && Math.hypot(Number(match[1]) - x, Number(match[2]) - y) <= radius) return true;
  }
  return false;
}

export function caravanPauseStats(): {
  paused: boolean;
  pauses: number;
  syncs: number;
  written: number;
  held: boolean;
  heldChanges: number;
} {
  return { paused, ...stats, held, heldChanges };
}

// ---- PAN (W4a): a GPU gesture holds the caravan layer's structure. A caravan group appended (a route segment starts)
// or removed (it ends) under the canvas re-layerizes the whole visible document as a pose write did (~155 ms on the
// parity world with every layer on): with the default 30 caravans, a hitch in about every other pan. While the GPU
// renderer moves the map with its canvas on screen, such changes wait. An ending caravan stays in the DOM, marked
// ended (the GPU stops drawing it, as it would have vanished); a starting one waits. The renderer releases them when
// the gesture ends, in the task that writes the SVG camera anyway (one layerize for all of it), and before the SVG is
// shown. SVG mode never holds.
let held = false;
let heldChanges = 0;
const ended = new WeakSet<Element>();
const waiting: (() => void)[] = [];

export function caravanChangesHeld(): boolean {
  return held;
}

// Ended while held: still in the DOM until the hold is released, no longer drawn
export function caravanEnded(group: Element): boolean {
  return ended.has(group);
}

// Holds (true) or releases (false) structural changes; releasing runs the held ones in the order they came
export function holdCaravanChanges(value: boolean): void {
  if (value === held) return;
  held = value;
  if (held) return;
  for (const change of waiting.splice(0)) change();
}

// A structural change of the caravan layer: run now, or once the hold is released. `removes`: the group the change
// takes out of the DOM, marked ended meanwhile.
export function caravanChange(change: () => void, removes?: Element | null): void {
  if (!held) {
    change();
    return;
  }
  if (removes) ended.add(removes);
  waiting.push(change);
  heldChanges++;
}
