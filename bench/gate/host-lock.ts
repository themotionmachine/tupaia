// Host lock tiers for bench/gate/gate.ts (GATE.md "Host lock").
//
// Correctness checks take a SHARED slot: at most `slots` (TUPAIA_GATE_SLOTS, default 2) run at once. Timing checks
// take the EXCLUSIVE lock: nothing else in a browser. Everything is fcntl.flock, held by a small python3 helper:
//   <path>          the main lock. Shared holders hold LOCK_SH, exclusive holders LOCK_EX. hostlock.py takes LOCK_EX
//                   on this same file, so a hand-wrapped hostlock.py job is exclusive and interoperates as before.
//   <path>.intent   a turnstile. Every gate takes it (LOCK_EX) before asking for the main lock and drops it once the
//                   main lock is granted. An exclusive request blocked on the main lock keeps holding the turnstile,
//                   so later shared requests queue behind it instead of overtaking it: exclusive is never starved
//                   by a stream of shared runs. (A raw hostlock.py does not use the turnstile; it can still wait
//                   behind a long stream of shared runs. It never runs concurrently with one.)
//   <path>.slot<i>  i = 0..slots-1, the shared cap. A shared holder also holds one slot file LOCK_EX, polling until
//                   one is free. With slots = 0 there is no cap (the per-worktree dist lock: any number of readers,
//                   one writer, writer never starved).
// The helper prints "locked <mode> <slot>" once it owns the lock and keeps it until its stdin closes, which also
// happens if the gate dies, so a lock can never outlive its gate.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";

export type LockMode = "shared" | "exclusive";

export const LOCK_HELPER = [
  "import fcntl, sys, time",
  "mode, path, slots = sys.argv[1], sys.argv[2], int(sys.argv[3])",
  "main = open(path, 'a+')",
  "turnstile = open(path + '.intent', 'a+')",
  "fcntl.flock(turnstile, fcntl.LOCK_EX)",
  "fcntl.flock(main, fcntl.LOCK_EX if mode == 'exclusive' else fcntl.LOCK_SH)",
  "fcntl.flock(turnstile, fcntl.LOCK_UN)",
  "slot, held = -1, None",
  "while mode == 'shared' and slots > 0 and held is None:",
  "    for i in range(slots):",
  "        f = open('%s.slot%d' % (path, i), 'a+')",
  "        try:",
  "            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)",
  "            slot, held = i, f",
  "            break",
  "        except OSError:",
  "            f.close()",
  "    else:",
  "        time.sleep(0.2)",
  "sys.stdout.write('locked %s %d\\n' % (mode, slot)); sys.stdout.flush()",
  "sys.stdin.read()"
].join("\n");

export function slotCount(raw = process.env.TUPAIA_GATE_SLOTS): number {
  if (raw === undefined || raw === "") return 2;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error(`TUPAIA_GATE_SLOTS must be an integer 1..16, got "${raw}"`);
  return n;
}

export interface HostLockOptions {
  path: string;
  slots: number;
  log?: (message: string) => void;
  // false in tests: do not look for a hostlock.py ancestor or TUPAIA_GATE_LOCK_HELD
  detectInherited?: boolean;
  // what the lock is called in the progress lines (default "host lock")
  label?: string;
}

export class HostLock {
  helper: ChildProcess | null = null;
  inherited: string | null = null;
  mode: LockMode | null = null;
  slot: number | null = null;
  waitSeconds = 0;
  readonly options: HostLockOptions;

  constructor(options: HostLockOptions) {
    this.options = options;
  }

  get held(): boolean {
    return !!this.helper || !!this.inherited;
  }

  async acquire(mode: LockMode): Promise<void> {
    if (this.held) return;
    const log = this.options.log ?? (() => {});
    const holder = this.options.detectInherited === false ? null : inheritedLockHolder();
    if (holder) {
      this.inherited = holder;
      log(`host lock already held by ${holder}; not re-locking`);
      return;
    }
    const started = Date.now();
    const helper = spawn("python3", ["-I", "-c", LOCK_HELPER, mode, this.options.path, String(this.options.slots)], {
      stdio: ["pipe", "pipe", "inherit"]
    });
    this.helper = helper;
    const notice = setTimeout(
      () =>
        log(
          `waiting for the ${mode} ${this.options.label ?? "host lock"} ${this.options.path} (${
            this.options.label ? (mode === "exclusive" ? "checks are reading it" : "a rebuild holds or awaits it") : mode === "exclusive" ? "browser jobs are running" : "an exclusive job is running or waiting, or all shared slots are busy"
          })`
        ),
      1500
    );
    try {
      const line = await new Promise<string>((done, fail) => {
        let buffer = "";
        helper.stdout!.on("data", chunk => {
          buffer += chunk;
          const match = /locked \S+ (-?\d+)\n/.exec(buffer);
          if (match) done(match[1]);
        });
        helper.on("error", fail);
        helper.on("exit", code => fail(new Error(`host lock helper exited (${code}) before locking ${this.options.path}`)));
      });
      this.mode = mode;
      this.slot = mode === "shared" ? Number(line) : null;
    } catch (error) {
      this.helper = null;
      throw error;
    } finally {
      clearTimeout(notice);
    }
    this.waitSeconds = (Date.now() - started) / 1000;
    if (this.waitSeconds > 1.5) log(`${mode} ${this.options.label ?? "host lock"} acquired after ${this.waitSeconds.toFixed(0)}s`);
  }

  async release(): Promise<void> {
    const helper = this.helper;
    this.helper = null;
    this.mode = null;
    this.slot = null;
    if (!helper || helper.exitCode !== null || helper.signalCode !== null) return;
    const gone = new Promise(done => helper.once("exit", done));
    helper.stdin!.end();
    await gone;
  }
}

// hostlock.py (or a parent gate) already owns the lock: re-locking from here would deadlock against our own parent.
export function inheritedLockHolder(): string | null {
  const held = process.env.TUPAIA_GATE_LOCK_HELD;
  if (held && held !== "0") return `parent gate (TUPAIA_GATE_LOCK_HELD=${held})`;
  let pid = process.ppid;
  for (let depth = 0; depth < 12 && pid > 1; depth++) {
    const ps = spawnSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8" });
    const line = ps.stdout?.trim();
    if (!line) break;
    const match = /^(\d+)\s+(.*)$/.exec(line);
    if (!match) break;
    // Only a python process actually executing hostlock.py counts, not a shell whose command line mentions it.
    if (/^\S*python[\d.]*\s+(-\S+\s+)*\S*hostlock\.py(\s|$)/i.test(match[2])) return `ancestor pid ${pid} (hostlock.py)`;
    pid = Number(match[1]);
  }
  return null;
}
