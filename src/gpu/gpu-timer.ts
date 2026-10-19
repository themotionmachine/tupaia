// Opt-in frame timing diagnostics (P2-FRAME-PACING.md). Off unless globalThis.__tupaiaGpuTiming === true, which only the
// host-owned gpu-timing bench sets; ordinary app and acceptance runs never construct a timer.
// GPU time comes from EXT_disjoint_timer_query_webgl2 TIME_ELAPSED queries around one whole frame: at most
// MAX_IN_FLIGHT queries, availability polled on later frames (or when telemetry is read), never waited on, and every
// result in flight is discarded when the GPU reports a disjoint operation. It is GPU execution time of the canvas draw
// commands only: not the compositor, not presentation latency. Without the extension the status is "unsupported" and
// the GPU summary is null, never zero.

const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;
export const MAX_IN_FLIGHT = 4;
export const RING_SIZE = 128;

export function timingRequested(): boolean {
  return (globalThis as { __tupaiaGpuTiming?: unknown }).__tupaiaGpuTiming === true;
}

export interface Summary {
  n: number; // samples in the ring (most recent RING_SIZE)
  total: number; // samples ever recorded
  sum: number;
  p50: number;
  p95: number;
  max: number;
}

// Fixed-size ring of the most recent samples.
export class Ring {
  private values: Float64Array;
  private next = 0;
  private count = 0;
  private total = 0;

  constructor(capacity = RING_SIZE) {
    this.values = new Float64Array(capacity);
  }

  push(value: number): void {
    this.values[this.next] = value;
    this.next = (this.next + 1) % this.values.length;
    this.count = Math.min(this.count + 1, this.values.length);
    this.total++;
  }

  summary(): Summary | null {
    if (!this.count) return null;
    const sorted = this.values.slice(0, this.count).sort();
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
    let sum = 0;
    for (const value of sorted) sum += value;
    return { n: this.count, total: this.total, sum, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
  }
}

export type TimerStatus = "active" | "unsupported" | "lost" | "disposed";

export interface TimingTelemetry {
  status: TimerStatus;
  gpuMs: Summary | null; // GPU execution of the whole frame's commands
  cpuMs: Summary | null; // main-thread FrameGraph.render() call
  stateIssued: Summary | null; // GL state setters issued per frame (delta around render)
  composites: Summary | null; // full-viewport group composites per frame
  stencilClears: Summary | null; // scissored translucent-stroke stencil clears per frame
  maskFills: Summary | null; // group mask fills drawn per frame
  maskCulled: Summary | null; // group mask fills skipped as wholly outside the view
  pending: number;
  dropped: number; // frames not timed because MAX_IN_FLIGHT queries were outstanding
  disjoint: number; // disjoint events; their in-flight results were discarded
}

export class GpuFrameTimer {
  status: TimerStatus = "unsupported";
  readonly gpu = new Ring();
  readonly cpu = new Ring();
  readonly stateIssued = new Ring();
  readonly composites = new Ring();
  readonly stencilClears = new Ring();
  readonly maskFills = new Ring();
  readonly maskCulled = new Ring();
  private free: WebGLQuery[] = [];
  private pending: WebGLQuery[] = [];
  private current: WebGLQuery | null = null;
  private dropped = 0;
  private disjoint = 0;

  constructor(private gl: WebGL2RenderingContext) {
    this.attach(gl);
  }

  private attach(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    this.status = gl.getExtension("EXT_disjoint_timer_query_webgl2") ? "active" : "unsupported";
  }

  begin(): void {
    if (this.status !== "active") return;
    this.poll();
    if (this.pending.length >= MAX_IN_FLIGHT) {
      this.dropped++;
      return;
    }
    const query = this.free.pop() ?? this.gl.createQuery();
    if (!query) {
      this.dropped++;
      return;
    }
    this.gl.beginQuery(TIME_ELAPSED_EXT, query);
    this.current = query;
  }

  end(frame: {
    cpuMs: number;
    stateIssued: number;
    composites: number;
    stencilClears: number;
    maskFills?: number;
    maskCulled?: number;
  }): void {
    this.cpu.push(frame.cpuMs);
    this.stateIssued.push(frame.stateIssued);
    this.composites.push(frame.composites);
    this.stencilClears.push(frame.stencilClears);
    this.maskFills.push(frame.maskFills ?? 0);
    this.maskCulled.push(frame.maskCulled ?? 0);
    if (!this.current) return;
    this.gl.endQuery(TIME_ELAPSED_EXT);
    this.pending.push(this.current);
    this.current = null;
  }

  // Non-blocking: reads only results the GPU already reports available, oldest first.
  poll(): void {
    if (this.status !== "active") return;
    const gl = this.gl;
    while (this.pending.length && gl.getQueryParameter(this.pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      if (gl.getParameter(GPU_DISJOINT_EXT)) {
        this.disjoint++;
        this.free.push(...this.pending);
        this.pending.length = 0;
        return;
      }
      const query = this.pending.shift()!;
      this.gpu.push(Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / 1e6);
      this.free.push(query);
    }
  }

  // Queries died with the context: forget them without deleting through the lost context.
  lose(): void {
    if (this.status === "disposed") return;
    this.free = [];
    this.pending = [];
    this.current = null;
    if (this.status === "active") this.status = "lost";
  }

  restore(gl: WebGL2RenderingContext): void {
    if (this.status !== "disposed") this.attach(gl);
  }

  dispose(lost: boolean): void {
    if (!lost && this.status === "active") {
      if (this.current) this.gl.endQuery(TIME_ELAPSED_EXT);
      for (const query of [...this.free, ...this.pending, ...(this.current ? [this.current] : [])])
        this.gl.deleteQuery(query);
    }
    this.free = [];
    this.pending = [];
    this.current = null;
    this.status = "disposed";
  }

  telemetry(): TimingTelemetry {
    this.poll();
    return {
      status: this.status,
      gpuMs: this.status === "unsupported" ? null : this.gpu.summary(),
      cpuMs: this.cpu.summary(),
      stateIssued: this.stateIssued.summary(),
      composites: this.composites.summary(),
      stencilClears: this.stencilClears.summary(),
      maskFills: this.maskFills.summary(),
      maskCulled: this.maskCulled.summary(),
      pending: this.pending.length,
      dropped: this.dropped,
      disjoint: this.disjoint
    };
  }
}
