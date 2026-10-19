export interface ZoomUpdate {
  scale: number;
  x: number;
  y: number;
  scaleChanged: boolean;
  positionChanged: boolean;
  exact?: boolean;
}
interface Clock {
  now(): number;
  request(callback: () => void): number;
  cancel(id: number): void;
}
interface Callbacks {
  valid?(): boolean;
  camera(update: ZoomUpdate): void;
  style(update: ZoomUpdate): void;
  visible?(update: ZoomUpdate): void;
  details(update: ZoomUpdate): void;
}
/** Camera always follows the latest frame; costly decoration settles exactly at gesture end. */
export class ZoomUpdateScheduler {
  private pending: ZoomUpdate | null = null;
  private frame: number | null = null;
  private styledScale: number | null = null;
  private styleAt = -Infinity;
  private detailsAt = -Infinity;
  private dirtyScale = false;
  private dirtyPosition = false;
  private revision = 0;
  private settled = false;
  constructor(
    private callbacks: Callbacks,
    private clock: Clock
  ) {}

  update(update: ZoomUpdate): void {
    this.dirtyScale ||= update.scaleChanged;
    this.dirtyPosition ||= update.positionChanged;
    this.pending = update;
    this.schedule();
  }

  private schedule(): void {
    if (this.frame !== null) return;
    const revision = this.revision;
    this.frame = this.clock.request(() => {
      if (revision !== this.revision) return;
      this.frame = null;
      const settled = this.settled;
      this.settled = false;
      this.paint(settled);
      if (settled) this.pending = null;
    });
  }

  private paint(settled: boolean): void {
    if (!this.pending) return;
    if (this.callbacks.valid && !this.callbacks.valid()) {
      this.cancel();
      return;
    }
    const update = {
      ...this.pending,
      scaleChanged: this.dirtyScale,
      positionChanged: this.dirtyPosition,
      exact: settled || this.pending.exact
    };
    const now = this.clock.now();
    this.callbacks.camera(update);
    const exact = update.exact;
    const changedEnough = this.styledScale === null || Math.abs(Math.log(update.scale / this.styledScale)) >= 0.02;
    if (exact || (this.dirtyScale && changedEnough && now - this.styleAt >= 50)) {
      this.callbacks.style(update);
      this.styledScale = update.scale;
      this.styleAt = now;
    }
    this.callbacks.visible?.(update);
    if (exact || now - this.detailsAt >= 75) {
      this.callbacks.details(update);
      this.detailsAt = now;
      this.dirtyScale = false;
      this.dirtyPosition = false;
    }
  }

  end(): void {
    if (!this.pending) return;
    this.settled = true;
    this.schedule();
  }

  cancel(): void {
    this.revision++;
    if (this.frame !== null) this.clock.cancel(this.frame);
    this.frame = null;
    this.pending = null;
    this.settled = false;
    this.styledScale = null;
    this.styleAt = this.detailsAt = -Infinity;
    this.dirtyScale = this.dirtyPosition = false;
  }
}

declare global {
  interface Window {
    ZoomUpdateScheduler: typeof ZoomUpdateScheduler;
  }
}
window.ZoomUpdateScheduler = ZoomUpdateScheduler;
