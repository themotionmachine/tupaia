import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { acquireBrowser } from "../src/browser-pool.ts";

// No FMG boot: this verifies the process boundary and the isolation relied on by every daemon.
test("different processes share Chromium but keep context state and lifetime isolated", {
  timeout: 30_000
}, async () => {
  const browser = await acquireBrowser();
  const session = await browser.newBrowserCDPSession();
  const info = (await session.send("SystemInfo.getProcessInfo")) as {
    processInfo: Array<{ type: string; id: number }>;
  };
  const pid = info.processInfo.find(p => p.type === "browser")?.id;
  assert.ok(pid);
  const context = await browser.newContext();
  await context.route("https://pool.test/**", route => route.fulfill({ status: 403, body: "blocked" }));
  await context.addCookies([{ name: "owner", value: "first", url: "http://localhost" }]);
  const moduleUrl = new URL("../src/browser-pool.ts", import.meta.url).href;
  const script = `
    import { acquireBrowser } from ${JSON.stringify(moduleUrl)};
    const browser = await acquireBrowser();
    const session = await browser.newBrowserCDPSession();
    const info = await session.send("SystemInfo.getProcessInfo");
    const context = await browser.newContext();
    await context.route("https://pool.test/**", route => route.fulfill({ status: 200, body: "isolated" }));
    const page = await context.newPage();
    const response = await page.goto("https://pool.test/");
    console.log(JSON.stringify({ status: response.status(), pid: info.processInfo.find(p => p.type === "browser").id, cookies: await context.cookies() }));
    process.stdin.once("data", async () => { await context.close(); await browser.close(); process.stdin.pause(); });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => {
    stderr += String(chunk);
  });
  try {
    const [data] = await once(child.stdout, "data");
    const other = JSON.parse(String(data)) as { pid: number; cookies: unknown[]; status: number };
    assert.equal(other.pid, pid, "same OS Chromium process across independent Node clients");
    assert.equal(other.status, 200, "route firewall is scoped to its owning context");
    assert.deepEqual(other.cookies, [], "cookies never cross context ownership");
    const exited = once(child, "exit");
    child.stdin.end("close");
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    assert.equal(browser.isConnected(), true, "one client disconnect does not kill the shared browser");
    assert.equal((await context.cookies())[0].value, "first");
    const page = await context.newPage();
    assert.equal((await page.goto("https://pool.test/"))?.status(), 403);
    assert.equal(await page.evaluate(() => 2 + 2), 4);
  } finally {
    if (child.exitCode === null) child.kill();
    await context.close();
    await browser.close();
  }
});
