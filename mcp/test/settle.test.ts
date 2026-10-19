import assert from "node:assert/strict";
import fs from "node:fs";
import {test} from "node:test";
const source = fs.readFileSync(new URL("../src/bridge.js", import.meta.url), "utf8");
const start = source.indexOf("  async function settle() {");
const end = source.indexOf("\n  /**", start);
function make(root: object) {
  const timers = new Map<number, {callback: () => void; delay: number}>();
  let id = 0, frames = 0;
  const settle = new Function("root", "document", "sleep", "raf2", "setTimeout", "clearTimeout", `${source.slice(start,end)}; return settle;`)(
    root, {}, async () => {}, async () => {frames++;},
    (callback: () => void, delay: number) => {timers.set(++id,{callback,delay}); return id;},
    (timer: number) => {timers.delete(timer);});
  return {settle, timers, frames: () => frames};
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
test("settle awaits both dense image promises before final frame and clears its budget timer", async () => {
  let relief!: () => void, burgs!: () => void;
  const root = {reliefRenderReady: new Promise<void>(resolve => {relief=resolve;}), burgRenderReady: new Promise<void>(resolve => {burgs=resolve;})};
  const f = make(root); let finished = false;
  const pending = f.settle().then(() => {finished=true;});
  await turn(); assert.equal(finished,false); assert.equal(f.timers.size,1);
  relief(); await turn(); assert.equal(finished,false);
  burgs(); await pending;
  assert.equal(finished,true); assert.equal(f.timers.size,0); assert.equal(f.frames(),2);
});
test("settle obeys its existing three-second budget without dangling timers", async () => {
  const f = make({reliefRenderReady: new Promise(() => {})});
  const pending = f.settle(); await turn();
  const timer = [...f.timers.values()][0];
  assert.ok(timer.delay <= 3000 && timer.delay >= 0);
  timer.callback(); await pending;
  assert.equal(f.timers.size,0); assert.equal(f.frames(),2);
});
