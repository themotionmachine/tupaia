// Lock-tier self-test: shared slots, exclusive drain, no starvation of exclusive, and hostlock.py interop. Uses a
// private lock path in a temp dir, never the real /tmp/tupaia-host-gates.lock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostLock, type LockMode, slotCount } from "./host-lock.ts";

const dir = mkdtempSync(join(tmpdir(), "tupaia-lock-test-"));
let n = 0;
const fresh = () => join(dir, `lock-${n++}`);
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

// Starts an acquisition and reports when it lands, without awaiting it.
function request(path: string, mode: LockMode, slots = 2) {
  const lock = new HostLock({ path, slots, detectInherited: false });
  const state = { lock, acquired: false, at: 0, done: null as unknown as Promise<void> };
  state.done = lock.acquire(mode).then(() => {
    state.acquired = true;
    state.at = performance.now();
  });
  return state;
}

// An external LOCK_EX holder on the main file, the way scratchpad hostlock.py holds it (no turnstile, no slots).
function hostlockPy(path: string): Promise<ChildProcess> {
  const child = spawn(
    "python3",
    ["-I", "-c", "import fcntl,sys\nf=open(sys.argv[1],'a+')\nfcntl.flock(f,fcntl.LOCK_EX)\nprint('held',flush=True)\nsys.stdin.read()", path],
    { stdio: ["pipe", "pipe", "inherit"] }
  );
  return new Promise(done => child.stdout!.once("data", () => done(child)));
}

test.after(() => rmSync(dir, { recursive: true, force: true }));

test("slotCount defaults to 2 and validates TUPAIA_GATE_SLOTS", () => {
  assert.equal(slotCount(undefined), 2);
  assert.equal(slotCount("3"), 3);
  assert.throws(() => slotCount("0"));
  assert.throws(() => slotCount("x"));
});

test("shared holders run concurrently up to the slot cap; the next one waits for a free slot", async () => {
  const path = fresh();
  const a = request(path, "shared");
  const b = request(path, "shared");
  await Promise.all([a.done, b.done]);
  assert.deepEqual([a.lock.slot, b.lock.slot].sort(), [0, 1]);
  const c = request(path, "shared");
  await sleep(600);
  assert.equal(c.acquired, false, "third shared run must wait: 2 slots");
  await a.lock.release();
  await c.done;
  assert.equal(c.lock.slot, a.lock.slot ?? c.lock.slot);
  await Promise.all([b.lock.release(), c.lock.release()]);
});

test("exclusive waits for every shared holder to drain", async () => {
  const path = fresh();
  const a = request(path, "shared");
  const b = request(path, "shared");
  await Promise.all([a.done, b.done]);
  const x = request(path, "exclusive");
  await sleep(500);
  assert.equal(x.acquired, false);
  await a.lock.release();
  await sleep(400);
  assert.equal(x.acquired, false, "one shared holder still running");
  await b.lock.release();
  await x.done;
  assert.equal(x.lock.mode, "exclusive");
  await x.lock.release();
});

test("no starvation: shared runs that arrive while an exclusive one waits queue behind it", async () => {
  const path = fresh();
  const a = request(path, "shared");
  await a.done;
  const x = request(path, "exclusive");
  await sleep(400);
  const late = request(path, "shared"); // a free slot exists, but an exclusive is waiting
  await sleep(600);
  assert.equal(x.acquired, false);
  assert.equal(late.acquired, false, "late shared must not overtake the waiting exclusive");
  await a.lock.release();
  await x.done;
  await sleep(400);
  assert.equal(late.acquired, false, "shared waits while the exclusive runs");
  await x.lock.release();
  await late.done;
  assert.ok(late.at > x.at);
  await late.lock.release();
});

test("an exclusive holder blocks shared and exclusive requests", async () => {
  const path = fresh();
  const x = request(path, "exclusive");
  await x.done;
  const s = request(path, "shared");
  const y = request(path, "exclusive");
  await sleep(500);
  assert.equal(s.acquired || y.acquired, false);
  await x.lock.release();
  await Promise.race([s.done, y.done]);
  const [first, second] = s.acquired ? [s, y] : [y, s];
  await sleep(400);
  assert.equal(second.acquired, false, "the two never hold at once");
  await first.lock.release();
  await second.done;
  await second.lock.release();
});

test("hostlock.py interop: its LOCK_EX on the same file blocks shared gates, and waits for them", async () => {
  const path = fresh();
  const external = await hostlockPy(path);
  const s = request(path, "shared");
  await sleep(500);
  assert.equal(s.acquired, false);
  external.stdin!.end();
  await s.done;
  // ...and a shared holder makes hostlock.py wait
  let held = false;
  const second = hostlockPy(path).then(child => {
    held = true;
    return child;
  });
  await sleep(500);
  assert.equal(held, false);
  await s.lock.release();
  const child = await second;
  child.stdin!.end();
});

test("a dead gate releases its lock", async () => {
  const path = fresh();
  const a = request(path, "exclusive");
  await a.done;
  a.lock.helper!.kill("SIGKILL");
  const b = request(path, "exclusive");
  await b.done;
  await b.lock.release();
});

test("slots=0 (the dist lock): any number of shared readers, one exclusive writer that is not starved", async () => {
  const path = fresh();
  const readers = [request(path, "shared", 0), request(path, "shared", 0), request(path, "shared", 0)];
  await Promise.all(readers.map(r => r.done));
  assert.ok(readers.every(r => r.lock.slot === -1 || r.lock.slot === null), "no slot is taken");
  const writer = request(path, "exclusive", 0);
  await sleep(500);
  assert.equal(writer.acquired, false, "the writer waits for the readers");
  const late = request(path, "shared", 0);
  await sleep(400);
  assert.equal(late.acquired, false, "a reader that arrives while the writer waits queues behind it");
  await Promise.all(readers.map(r => r.lock.release()));
  await writer.done;
  assert.equal(late.acquired, false, "the writer holds it alone");
  await writer.lock.release();
  await late.done;
  await late.lock.release();
});
