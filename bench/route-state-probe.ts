// Pure summaries for the route-state diagnosis (bench/renderer-integration.ts, INTEGRATION_PREAMBLE): a CDP CPU profile
// split into busy script/GC/native time vs idle wait with the top self-time callsites, and CDP Performance.getMetrics
// deltas. No browser access here, so it is unit-tested directly.

export interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber?: number };
  children?: number[];
}
export interface CpuProfile {
  nodes: ProfileNode[];
  startTime: number; // µs
  endTime: number; // µs
  samples?: number[];
  timeDeltas?: number[]; // µs, one per sample
}

const SPECIAL = new Set(["(idle)", "(program)", "(garbage collector)", "(root)"]);

const site = (frame: ProfileNode["callFrame"]) => {
  const name = frame.functionName || "(anonymous)";
  if (SPECIAL.has(name)) return name;
  const file = frame.url ? frame.url.slice(frame.url.lastIndexOf("/") + 1).replace(/\?.*$/, "") : "native";
  return name + " " + file + ":" + (frame.lineNumber + 1);
};

// self time per callsite (ms) from samples × timeDeltas; idle = "(idle)", busy = everything else
export function summarizeCpuProfile(profile: CpuProfile, top = 15) {
  const byId = new Map(profile.nodes.map(node => [node.id, node]));
  const self = new Map<string, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  // the delta of sample i+1 is the time spent in sample i (CDP convention: delta precedes its sample)
  for (let i = 0; i < samples.length; i++) {
    const node = byId.get(samples[i]);
    if (!node) continue;
    const ms = (deltas[i + 1] ?? 0) / 1000;
    const key = site(node.callFrame);
    self.set(key, (self.get(key) ?? 0) + ms);
  }
  const wallMs = (profile.endTime - profile.startTime) / 1000;
  const idleMs = self.get("(idle)") ?? 0;
  const gcMs = self.get("(garbage collector)") ?? 0;
  const programMs = self.get("(program)") ?? 0;
  let sampledMs = 0;
  for (const ms of self.values()) sampledMs += ms;
  const scriptMs = sampledMs - idleMs - gcMs - programMs - (self.get("(root)") ?? 0);
  const round = (ms: number) => Math.round(ms * 10) / 10;
  return {
    wallMs: round(wallMs),
    sampledMs: round(sampledMs),
    idleMs: round(idleMs),
    busyMs: round(sampledMs - idleMs),
    scriptMs: round(scriptMs),
    gcMs: round(gcMs),
    programMs: round(programMs),
    busyFraction: sampledMs > 0 ? Math.round(((sampledMs - idleMs) / sampledMs) * 1000) / 1000 : null,
    top: [...self.entries()]
      .filter(([key]) => key !== "(idle)")
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([key, ms]) => [key, round(ms)] as [string, number])
  };
}

export type Metrics = { name: string; value: number }[];

// selected CDP Performance.getMetrics values; the *Duration metrics are seconds (converted to ms)
const KEPT = ["Documents", "Frames", "JSEventListeners", "Nodes", "LayoutCount", "RecalcStyleCount", "LayoutDuration",
  "RecalcStyleDuration", "ScriptDuration", "TaskDuration", "JSHeapUsedSize", "JSHeapTotalSize"];

export function pickMetrics(metrics: Metrics) {
  const out: Record<string, number> = {};
  for (const { name, value } of metrics) {
    if (!KEPT.includes(name)) continue;
    if (name.endsWith("Duration")) out[name.replace("Duration", "Ms")] = Math.round(value * 10000) / 10;
    else if (name.startsWith("JSHeap")) out[name.replace("Size", "MB")] = Math.round(value / 1048576 * 10) / 10;
    else out[name] = value;
  }
  return out;
}

export function diffMetrics(before: Record<string, number>, after: Record<string, number>) {
  const out: Record<string, number> = {};
  for (const key of Object.keys(after)) if (key in before) out[key] = Math.round((after[key] - before[key]) * 10) / 10;
  return out;
}

// main-thread CPU vs wait over a wall window, from the TaskDuration delta (ms of main-thread tasks)
export function cpuVsWait(wallMs: number, delta: Record<string, number>) {
  const taskMs = delta.TaskMs ?? 0;
  return {
    wallMs: Math.round(wallMs),
    taskMs: Math.round(taskMs),
    scriptMs: Math.round(delta.ScriptMs ?? 0),
    layoutMs: Math.round(delta.LayoutMs ?? 0),
    styleMs: Math.round(delta.RecalcStyleMs ?? 0),
    waitMs: Math.max(0, Math.round(wallMs - taskMs)),
    taskFraction: wallMs > 0 ? Math.round((taskMs / wallMs) * 1000) / 1000 : null
  };
}
