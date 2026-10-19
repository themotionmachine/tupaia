import { describe, expect, it } from "vitest";
import { type ZoomUpdate, ZoomUpdateScheduler } from "./zoom-update-scheduler";

function fixture() {
  let time = 0;
  let id = 0;
  let valid = true;
  const frames = new Map<number, () => void>();
  const camera: ZoomUpdate[] = [],
    style: ZoomUpdate[] = [],
    details: ZoomUpdate[] = [];
  const visible: ZoomUpdate[] = [];
  const order: string[] = [];
  const scheduler = new ZoomUpdateScheduler(
    {
      valid: () => valid,
      camera: update => {
        camera.push(update);
        order.push("camera");
      },
      style: update => {
        style.push(update);
        order.push("style");
      },
      visible: update => {
        visible.push(update);
        order.push("visible");
      },
      details: update => details.push(update)
    },
    {
      now: () => time,
      request: callback => {
        frames.set(++id, callback);
        return id;
      },
      cancel: key => {
        frames.delete(key);
      }
    }
  );
  return {
    scheduler,
    camera,
    style,
    details,
    frames,
    visible,
    order,
    invalidate: () => {
      valid = false;
    },
    frame: (at: number) => {
      time = at;
      const jobs = [...frames.values()];
      frames.clear();
      for (const job of jobs) job();
    }
  };
}
function update(scale: number, x = 0, exact = false): ZoomUpdate {
  return { scale, x, y: 0, scaleChanged: true, positionChanged: x !== 0, exact };
}
describe("navigation scheduling", () => {
  it("coalesces burst input to the latest camera while retaining decoration changes", () => {
    const f = fixture();
    f.scheduler.update(update(2));
    f.scheduler.update({ ...update(2, 12), scaleChanged: false });
    f.frame(0);
    expect(f.camera).toHaveLength(1);
    expect(f.camera[0]).toMatchObject({ scale: 2, x: 12, scaleChanged: true, positionChanged: true });
    expect(f.style[0].scale).toBe(2);
    expect(f.order).toEqual(["camera", "style", "visible"]);
  });
  it("keeps camera frames responsive and flushes exact final decoration even below the motion threshold", () => {
    const f = fixture();
    f.scheduler.update(update(2));
    f.frame(0);
    f.scheduler.update(update(2.01, 10));
    f.frame(16);
    f.scheduler.update(update(2.02, 20));
    f.frame(32);
    expect(f.camera).toHaveLength(3);
    expect(f.visible).toHaveLength(3);
    expect(f.style).toHaveLength(1);
    expect(f.details).toHaveLength(1);
    f.scheduler.end();
    f.frame(48);
    expect(f.style.at(-1)?.scale).toBe(2.02);
    expect(f.order.slice(-3)).toEqual(["camera", "style", "visible"]);
    expect(f.details.at(-1)).toMatchObject({ x: 20, scaleChanged: true, positionChanged: true, exact: true });
    expect(f.frames.size).toBe(0);
  });
  it("throttles gesture details but programmatic updates and end bypass time limits", () => {
    const f = fixture();
    f.scheduler.update(update(2));
    f.frame(0);
    f.scheduler.update(update(2.1));
    f.frame(60);
    expect(f.style).toHaveLength(2);
    expect(f.details).toHaveLength(1);
    f.scheduler.update(update(2.2, 10));
    f.frame(76);
    expect(f.details).toHaveLength(2);
    f.scheduler.update(update(2.21, 12, true));
    f.frame(77);
    expect(f.style.at(-1)?.scale).toBe(2.21);
    expect(f.details.at(-1)?.x).toBe(12);
    f.scheduler.update(update(2.22, 14));
    f.scheduler.end();
    f.frame(93);
    expect(f.camera.at(-1)?.x).toBe(14);
    expect(f.frames.size).toBe(0);
  });
  it("defers programmatic zoom end until layers initialized and consumes the latest transform", () => {
    const f = fixture();
    f.scheduler.update(update(2, 5, true));
    f.scheduler.end();
    expect(f.details).toHaveLength(0);
    expect(f.camera).toHaveLength(0);
    f.scheduler.update(update(3, 9, true));
    f.scheduler.end();
    f.frame(16);
    expect(f.camera).toHaveLength(1);
    expect(f.camera[0]).toMatchObject({ scale: 3, x: 9 });
    expect(f.details).toHaveLength(1);
    expect(f.frames.size).toBe(0);
    f.scheduler.end();
    f.frame(32);
    expect(f.details).toHaveLength(1);
  });
  it("requests exact final geometry even when the last motion frame consumed every dirty flag", () => {
    const f = fixture();
    f.scheduler.update(update(8, 20));
    f.frame(0);
    expect(f.details).toHaveLength(1);
    f.scheduler.end();
    f.frame(16);
    expect(f.details).toHaveLength(2);
    expect(f.details.at(-1)).toMatchObject({
      scale: 8,
      x: 20,
      scaleChanged: false,
      positionChanged: false,
      exact: true
    });
  });
  it("cannot apply queued transforms after a new world, including an already captured frame callback", () => {
    const f = fixture();
    f.scheduler.update(update(2));
    const captured = [...f.frames.values()][0];
    f.scheduler.cancel();
    captured();
    expect(f.camera).toHaveLength(0);
    f.scheduler.update(update(3));
    f.invalidate();
    f.frame(16);
    f.scheduler.end();
    expect(f.camera).toHaveLength(0);
    expect(f.style).toHaveLength(0);
    expect(f.details).toHaveLength(0);
  });
});
