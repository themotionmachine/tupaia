interface TraceEvent {
  name: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: { name?: string; data?: { name?: string } };
}
interface Trace {
  traceEvents: TraceEvent[];
}
export function attributeTrace(trace: Trace) {
  const events = trace.traceEvents;
  const main = events.find(
    event => event.ph === "M" && event.name === "thread_name" && event.args?.name === "CrRendererMain"
  );
  if (!main) throw new Error("Navigation trace lacks renderer main-thread metadata");
  const marker = (name: string) => events.find(event => event.name === name)?.ts;
  const start = marker("navigation:gesture:start");
  const end = marker("navigation:gesture:end");
  if (start === undefined || end === undefined || end <= start) throw new Error("Navigation trace lacks gesture marks");
  const gesture = events.filter(
    event => event.ph === "X" && event.ts >= start && event.ts < end && Number.isFinite(event.dur)
  );
  const mainEvents = gesture.filter(event => event.pid === main?.pid && event.tid === main?.tid);
  const metric = (rows: TraceEvent[]) => ({
    count: rows.length,
    totalMs: rows.reduce((sum, event) => sum + (event.dur || 0) / 1000, 0),
    maxMs: Math.max(0, ...rows.map(event => (event.dur || 0) / 1000))
  });
  const inputMarkers = events
    .filter(
      event =>
        event.ts >= start && event.ts < end && ["navigation:input:start", "navigation:input:end"].includes(event.name)
    )
    .sort((a, b) => a.ts - b.ts);
  const syntheticInput: TraceEvent[] = [];
  let inputStart: number | undefined;
  for (const event of inputMarkers) {
    if (event.name === "navigation:input:start") inputStart = event.ts;
    else if (inputStart !== undefined) {
      syntheticInput.push({
        name: "SyntheticInputDispatch",
        ph: "X",
        ts: inputStart,
        dur: event.ts - inputStart,
        pid: main.pid,
        tid: main.tid
      });
      inputStart = undefined;
    }
  }
  const input = mainEvents.filter(event => event.name === "EventDispatch");
  const javascript = mainEvents.filter(event =>
    ["EventDispatch", "FunctionCall", "FireAnimationFrame", "TimerFire"].includes(event.name)
  );
  const layout = mainEvents.filter(event => event.name === "Layout");
  const inside = (event: TraceEvent, parents: TraceEvent[]) =>
    parents.some(parent => parent.ts <= event.ts && parent.ts + (parent.dur || 0) >= event.ts + (event.dur || 0));
  return {
    gestureDurationMs: (end - start) / 1000,
    input: metric(input),
    syntheticInput: metric(syntheticInput),
    layoutInsideSyntheticInput: metric(layout.filter(event => inside(event, syntheticInput))),
    javascriptByEvent: Object.fromEntries(
      ["EventDispatch", "FunctionCall", "FireAnimationFrame", "TimerFire"].map(name => [
        name,
        metric(mainEvents.filter(event => event.name === name))
      ])
    ),
    layout: metric(layout),
    layoutInsideInput: metric(layout.filter(event => inside(event, input))),
    layoutInsideJavascript: metric(layout.filter(event => inside(event, javascript))),
    style: metric(mainEvents.filter(event => event.name === "UpdateLayoutTree")),
    paint: metric(mainEvents.filter(event => event.name === "Paint")),
    raster: metric(gesture.filter(event => event.name === "RasterTask")),
    notes:
      "Native EventDispatch may omit synthetic DOM events; syntheticInput marks instrument the dispatch wrapper. Event duration totals may overlap and must not be summed. Layout nested in an input/JS event is forced-layout evidence; raster totals span worker threads, not main-thread wall time."
  };
}
