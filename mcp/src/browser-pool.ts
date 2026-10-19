// A shared Chromium process; each client owns isolated contexts and routing.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";

const modulePath = fileURLToPath(import.meta.url);
const IDLE_MS = 60_000;
interface Endpoint {
  pid: number;
  endpoint: string;
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function readEndpoint(dir: string): Promise<Endpoint | null> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(dir, "endpoint.json"), "utf8")) as Endpoint;
    return alive(value.pid) ? value : null;
  } catch {
    return null;
  }
}

/** Browser.close disconnects this client and closes only its own contexts. */
export async function acquireBrowser(headed = false): Promise<Browser> {
  if (process.env.TUPAIA_BROWSER_POOL === "0")
    return chromium.launch({ headless: !headed, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  const key = createHash("sha256")
    .update(`${modulePath}:${chromium.executablePath()}:${headed}`)
    .digest("hex")
    .slice(0, 20);
  const dir = path.join(
    process.platform === "win32" ? os.tmpdir() : "/tmp",
    `tupaia-browser-${process.getuid?.() ?? "user"}-${key}`
  );
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const lease = path.join(dir, `lease-${process.pid}-${randomUUID()}`);
  await fs.writeFile(lease, String(process.pid), { mode: 0o600 });
  const deadline = Date.now() + 30_000;
  try {
    while (Date.now() < deadline) {
      const current = await readEndpoint(dir);
      if (current) {
        try {
          const browser = await chromium.connect(current.endpoint, { timeout: 3000 });
          browser.once("disconnected", () => void fs.unlink(lease).catch(() => {}));
          return browser;
        } catch {
          if (alive(current.pid)) throw new Error("shared browser owner is alive but its endpoint is unavailable");
        }
      }
      const lock = path.join(dir, "starting");
      let acquired = false;
      try {
        await fs.mkdir(lock);
        acquired = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const stat = await fs.stat(lock).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > 30_000) await fs.rm(lock, { recursive: true, force: true });
      }
      if (acquired) {
        if (await readEndpoint(dir)) await fs.rm(lock, { recursive: true, force: true });
        else {
          const child = spawn(process.execPath, [modulePath, "--broker", dir, String(headed)], {
            detached: true,
            stdio: "ignore",
            env: process.env
          });
          child.unref();
          child.once("error", () => void fs.rm(lock, { recursive: true, force: true }));
        }
      }
      await sleep(100);
    }
    throw new Error("shared browser did not start within 30 seconds");
  } catch (e) {
    await fs.unlink(lease).catch(() => {});
    throw e;
  }
}

async function runBroker(dir: string, headed: boolean): Promise<void> {
  const server = await chromium.launchServer({
    headless: !headed,
    host: "127.0.0.1",
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false
  });
  const endpoint = path.join(dir, "endpoint.json");
  const temp = path.join(dir, `endpoint-${process.pid}.tmp`);
  await fs.writeFile(temp, JSON.stringify({ pid: process.pid, endpoint: server.wsEndpoint() }), { mode: 0o600 });
  await fs.rename(temp, endpoint);
  await fs.rm(path.join(dir, "starting"), { recursive: true, force: true });
  let lastUsed = Date.now();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    if ((await readEndpoint(dir))?.pid === process.pid) await fs.unlink(endpoint).catch(() => {});
    await server.close().catch(() => {});
  };
  const timer = setInterval(
    () =>
      void (async () => {
        let active = false;
        for (const name of await fs.readdir(dir)) {
          if (!name.startsWith("lease-")) continue;
          if (alive(Number(name.split("-")[1]))) active = true;
          else await fs.unlink(path.join(dir, name)).catch(() => {});
        }
        if (active) lastUsed = Date.now();
        else if (Date.now() - lastUsed >= IDLE_MS) await stop();
      })().catch(() => {}),
    5000
  );
  server.once("close", () => {
    clearInterval(timer);
    process.exit(0);
  });
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}
if (process.argv[1] && path.resolve(process.argv[1]) === modulePath && process.argv[2] === "--broker") {
  runBroker(process.argv[3], process.argv[4] === "true").catch(async () => {
    await fs.rm(path.join(process.argv[3], "starting"), { recursive: true, force: true });
    process.exit(1);
  });
}
