// Context-recovery phase timing (diagnostics only). The renderer's lastRestoreMs stays defined as loss -> first restored
// draw() call; these phases split that same span and say nothing about physical presentation (draw() returning only
// means the commands were issued). Each phase is null until its boundary is observed: a missing restore event, a
// stale/failed prepare or a disposal leaves the later phases null rather than inventing a duration.
export type PrepareStep = "scene" | "clone" | "screen" | "windows" | "world" | "buffers" | "detail";

export interface RestoreTiming {
  outcome: "restoring" | "drawn" | "superseded" | "disposed";
  lossToRestoredMs: number | null; // webglcontextlost -> webglcontextrestored handler (includes any injected loss window)
  restoredToGraphMs: number | null; // FrameGraph (programs/VAOs) + timer + resize inside restored()
  graphToPrepareMs: number | null; // scheduling gap until the committed prepare began
  prepareMs: number | null; // the committed prepare job (start -> commit)
  prepareToDrawMs: number | null; // commit -> first draw() completion
  lossToDrawMs: number | null; // equals lastRestoreMs when drawn
  failedPrepares: number; // stale/failed/budget-dropped attempts before the committed one
  // committed prepare's internal steps, each as ms since the previous step (or prepare start)
  steps: Partial<Record<PrepareStep, number>> | null;
}

export class RestoreClock {
  private episode: {
    lost: number;
    restored: number | null;
    graph: number | null;
    start: number | null;
    commit: number | null;
    draw: number | null;
    failed: number;
    steps: Partial<Record<PrepareStep, number>>;
    last: number | null;
    attempt: number; // token of the prepare currently attributed
    outcome: RestoreTiming["outcome"];
  } | null = null;
  private attempts = 0;

  constructor(private readonly now: () => number) {}

  // A loss before the previous recovery drew supersedes it; its timing is replaced, not merged.
  lost(): void {
    if (this.episode?.outcome === "restoring") this.episode.outcome = "superseded";
    this.episode = {
      lost: this.now(),
      restored: null,
      graph: null,
      start: null,
      commit: null,
      draw: null,
      failed: 0,
      steps: {},
      last: null,
      attempt: 0,
      outcome: "restoring"
    };
  }

  restored(): void {
    const e = this.open();
    if (e && e.restored === null) e.restored = this.now();
  }

  graphReady(): void {
    const e = this.open();
    if (e && e.restored !== null && e.graph === null) e.graph = this.now();
  }

  // Returns a token for prepareStep/prepareEnd; 0 when no recovery is waiting for a prepare (ordinary prepares).
  prepareStart(): number {
    const e = this.open();
    if (!e || e.graph === null || e.commit !== null) return 0;
    e.attempt = ++this.attempts;
    e.start = e.last = this.now();
    e.steps = {};
    return e.attempt;
  }

  prepareStep(token: number, step: PrepareStep): void {
    const e = this.current(token);
    if (!e || e.last === null) return;
    const at = this.now();
    e.steps[step] = at - e.last;
    e.last = at;
  }

  prepareEnd(token: number, committed: boolean): void {
    const e = this.current(token);
    if (!e) return;
    if (committed) e.commit = this.now();
    else {
      e.failed++;
      e.start = e.last = null;
      e.steps = {};
    }
    e.attempt = 0;
  }

  // Only a draw after this episode's committed prepare closes it.
  drawn(): void {
    const e = this.open();
    if (e && e.commit !== null) {
      e.draw = this.now();
      e.outcome = "drawn";
    }
  }

  dispose(): void {
    if (this.episode?.outcome === "restoring") this.episode.outcome = "disposed";
  }

  snapshot(): RestoreTiming | null {
    const e = this.episode;
    if (!e) return null;
    const span = (from: number | null, to: number | null) => (from !== null && to !== null ? to - from : null);
    const steps = e.commit !== null ? { ...e.steps } : null;
    return {
      outcome: e.outcome,
      lossToRestoredMs: span(e.lost, e.restored),
      restoredToGraphMs: span(e.restored, e.graph),
      graphToPrepareMs: span(e.graph, e.start),
      prepareMs: span(e.start, e.commit),
      prepareToDrawMs: span(e.commit, e.draw),
      lossToDrawMs: span(e.lost, e.draw),
      failedPrepares: e.failed,
      steps
    };
  }

  private open() {
    return this.episode?.outcome === "restoring" ? this.episode : null;
  }

  private current(token: number) {
    const e = this.open();
    return token && e && e.attempt === token ? e : null;
  }
}
