export type PaletteEntityKey = { kind: "burg" | "state" | "route"; id: number };
export type PaletteActionId = "add-label" | "draw-route" | "whole-map";
export type PaletteKey = PaletteEntityKey | { kind: "action"; id: PaletteActionId };

interface SearchBurg {
  i: number;
  name?: string;
  x?: number;
  y?: number;
  state?: number;
  removed?: boolean;
}

interface SearchState {
  i: number;
  name?: string;
  fullName?: string;
  pole?: readonly number[];
  center?: number;
  capital?: number;
  removed?: boolean;
}

interface SearchRoute {
  i: number;
  name?: string;
  group: string;
  points: readonly (readonly number[])[];
  removed?: boolean;
}

/** Narrow read-only view also accepts the removed stubs present in loaded worlds. */
export interface PaletteWorld {
  burgs: readonly SearchBurg[];
  states: readonly SearchState[];
  routes: readonly SearchRoute[];
  cells: { p: readonly (readonly number[])[] };
}

export interface PaletteCandidate {
  key: PaletteKey;
  label: string;
  detail: string;
  name: string;
  search: string;
  disabled?: string;
}

export interface PaletteLocation {
  x: number;
  y: number;
  scale: number;
}

export function normalizePaletteText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function paletteCandidate(
  key: PaletteKey,
  label: string,
  detail: string,
  aliases = ""
): PaletteCandidate {
  return { key, label, detail, name: normalizePaletteText(label), search: normalizePaletteText(`${label} ${detail} ${aliases}`) };
}

function validPoint(point: readonly number[] | undefined): point is readonly number[] {
  return !!point && Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

function burgPoint(burg: SearchBurg | undefined): [number, number] | null {
  return burg && !burg.removed && Number.isFinite(burg.x) && Number.isFinite(burg.y)
    ? [burg.x!, burg.y!]
    : null;
}

function statePoint(world: PaletteWorld, state: SearchState): readonly number[] | null {
  if (validPoint(state.pole)) return state.pole;
  const center = state.center === undefined ? undefined : world.cells.p[state.center];
  if (validPoint(center)) return center;
  if (!state.capital || state.capital < 0) return null;
  return burgPoint(world.burgs.find(burg => burg?.i === state.capital && burg.i > 0));
}

const routeGroups: Record<string, string> = { roads: "Road", trails: "Trail", searoutes: "Sea route" };

/** Never generates names, reads SVG geometry, or changes the world. */
export function buildPaletteIndex(world: PaletteWorld): PaletteCandidate[] {
  const entries: PaletteCandidate[] = [];
  const stateNames = new Map(world.states.filter(state => state?.i && !state.removed).map(state => [state.i, state.fullName || state.name]));
  for (const burg of world.burgs) {
    if (!burg?.i || !burg.name || !burgPoint(burg)) continue;
    const state = stateNames.get(burg.state ?? 0);
    const detail = state ? `Settlement · ${state}` : "Settlement";
    entries.push(paletteCandidate({ kind: "burg", id: burg.i }, burg.name, detail, `town city burg ${burg.i}`));
  }
  for (const state of world.states) {
    if (!state?.i || state.removed || !(state.fullName || state.name) || !statePoint(world, state)) continue;
    entries.push(paletteCandidate({ kind: "state", id: state.i }, state.fullName || state.name!, "State", `${state.name || ""} ${state.i}`));
  }
  for (const route of world.routes) {
    if (!route || route.removed || !Number.isFinite(route.i) || !Array.isArray(route.points) || route.points.length < 2) continue;
    const group = routeGroups[route.group] || "Route";
    entries.push(paletteCandidate({ kind: "route", id: route.i }, route.name || `${group} ${route.i}`, `Route · ${group}`, `${route.group} ${route.i}`));
  }
  return entries;
}

const kindOrder = { burg: 0, state: 1, route: 2, action: 3 };
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function searchPalette(
  candidates: readonly PaletteCandidate[],
  query: string,
  limit = 8
): { results: PaletteCandidate[]; total: number } {
  const normalized = normalizePaletteText(query);
  if (!normalized) return { results: [], total: 0 };
  const tokens = normalized.split(" ");
  const ranked = candidates.filter(candidate => tokens.every(token => candidate.search.includes(token))).map(candidate => {
    const words = candidate.name.split(" ");
    const rank = candidate.name === normalized ? 0
      : candidate.name.startsWith(normalized) ? 1
      : tokens.every(token => words.some(word => word.startsWith(token))) ? 2
      : candidate.name.includes(normalized) ? 3 : 4;
    return { candidate, rank };
  });
  ranked.sort((a, b) => a.rank - b.rank
    || kindOrder[a.candidate.key.kind] - kindOrder[b.candidate.key.kind]
    || compareText(a.candidate.name, b.candidate.name)
    || (typeof a.candidate.key.id === "number" && typeof b.candidate.key.id === "number"
      ? a.candidate.key.id - b.candidate.key.id
      : compareText(String(a.candidate.key.id), String(b.candidate.key.id))));
  return { results: ranked.slice(0, Math.max(0, limit)).map(item => item.candidate), total: ranked.length };
}

/** Resolve the current entity, not a captured object or a rendered element. */
export function resolvePaletteLocation(
  world: PaletteWorld,
  key: PaletteEntityKey,
  viewport: { width: number; height: number },
  extent: readonly number[] = [1, 20]
): PaletteLocation | null {
  const minimum = Number.isFinite(extent[0]) && extent[0] > 0 ? extent[0] : 1;
  const maximum = Number.isFinite(extent[1]) && extent[1] >= minimum ? extent[1] : Math.max(minimum, 20);
  const clamp = (value: number): number => Math.max(minimum, Math.min(maximum, value));
  if (key.kind === "burg") {
    const point = key.id > 0 ? burgPoint(world.burgs.find(burg => burg?.i === key.id)) : null;
    return point ? { x: point[0], y: point[1], scale: clamp(6) } : null;
  }
  if (key.kind === "state") {
    const state = world.states.find(state => state?.i === key.id);
    const point = state && state.i > 0 && !state.removed ? statePoint(world, state) : null;
    return point ? { x: point[0], y: point[1], scale: clamp(2.5) } : null;
  }
  const route = world.routes.find(route => route?.i === key.id);
  if (!route || route.removed || !Array.isArray(route.points) || route.points.length < 2) return null;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const point of route.points) {
    if (!validPoint(point)) return null;
    left = Math.min(left, point[0]);
    right = Math.max(right, point[0]);
    top = Math.min(top, point[1]);
    bottom = Math.max(bottom, point[1]);
  }
  const fit = Math.min(viewport.width / Math.max(40, (right - left) * 1.3), viewport.height / Math.max(40, (bottom - top) * 1.3));
  if (!Number.isFinite(fit) || fit <= 0) return null;
  return { x: left + (right - left) / 2, y: top + (bottom - top) / 2, scale: clamp(fit) };
}
