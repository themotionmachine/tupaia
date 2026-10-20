import { afterEach, expect, it, vi } from "vitest";
import {
  caravanNear,
  caravanPauseStats,
  caravanTransform,
  liveGroups,
  onCaravansMoved,
  recordPose,
  setCaravanDomPaused,
  settlePose,
  syncCaravans
} from "./caravan-poses";

// just the attribute surface the module touches, counting writes
class Group {
  attrs = new Map<string, string>();
  writes = 0;
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    this.writes++;
  }
}

function caravan(transform = "translate(0, 0)"): Group & SVGGElement {
  const group = new Group() as Group & SVGGElement;
  group.attrs.set("transform", transform);
  liveGroups.add(group);
  return group;
}

afterEach(() => {
  setCaravanDomPaused(false);
  liveGroups.clear();
});

it("SVG mode: every tick is written to the group, as attrTween did", () => {
  const group = caravan();
  const moved = vi.fn();
  const detach = onCaravansMoved(moved);
  recordPose(group, "translate(1, 2) rotate(30)");
  recordPose(group, "translate(2, 2) rotate(30)");
  expect(group.writes).toBe(2);
  expect(group.getAttribute("transform")).toBe("translate(2, 2) rotate(30)");
  expect(moved).not.toHaveBeenCalled();
  expect(syncCaravans()).toBe(0);
  detach();
});

it("paused: ticks stay off the DOM, the GPU reads them and is told; resuming writes each pose once", () => {
  const a = caravan();
  const b = caravan();
  const moved = vi.fn();
  const detach = onCaravansMoved(moved);
  setCaravanDomPaused(true);
  for (let i = 1; i <= 5; i++) {
    recordPose(a, `translate(${i}, 0) rotate(0)`);
    recordPose(b, `translate(0, ${i}) rotate(90)`);
  }
  expect(a.writes + b.writes).toBe(0);
  expect(moved).toHaveBeenCalledTimes(10);
  expect(caravanTransform(a)).toBe("translate(5, 0) rotate(0)");
  expect(a.getAttribute("transform")).toBe("translate(0, 0)");
  const before = caravanPauseStats();
  expect(before.paused).toBe(true);
  setCaravanDomPaused(false);
  expect([a.writes, b.writes]).toEqual([1, 1]);
  expect(b.getAttribute("transform")).toBe("translate(0, 5) rotate(90)");
  expect(caravanPauseStats()).toMatchObject({ paused: false, syncs: before.syncs + 1, written: before.written + 2 });
  detach();
});

it("a click sync writes only lagging caravans; an interrupted caravan settles at its last pose", () => {
  const a = caravan();
  const b = caravan();
  setCaravanDomPaused(true);
  recordPose(a, "translate(3, 4) rotate(0)");
  expect(syncCaravans()).toBe(1);
  expect(syncCaravans()).toBe(0);
  expect(b.writes).toBe(0);
  recordPose(a, "translate(4, 4) rotate(0)");
  settlePose(a);
  expect(a.getAttribute("transform")).toBe("translate(4, 4) rotate(0)");
  settlePose(b); // never ticked: its spawn pose stays
  expect(b.getAttribute("transform")).toBe("translate(0, 0)");
});

it("caravanNear reads live poses, not the lagging attributes", () => {
  const group = caravan("translate(100, 100)");
  setCaravanDomPaused(true);
  recordPose(group, "translate(10.5, -20) rotate(45)");
  expect(caravanNear(12, -21, 3)).toBe(true);
  expect(caravanNear(100, 100, 3)).toBe(false);
  expect(caravanNear(20, -20, 3)).toBe(false);
});

it("a detached listener leaves a newer one in place", () => {
  const first = vi.fn();
  const second = vi.fn();
  const detachFirst = onCaravansMoved(first);
  const detachSecond = onCaravansMoved(second);
  detachFirst();
  setCaravanDomPaused(true);
  recordPose(caravan(), "translate(1, 1) rotate(0)");
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);
  detachSecond();
  recordPose(caravan(), "translate(2, 2) rotate(0)");
  expect(second).toHaveBeenCalledTimes(1);
});
