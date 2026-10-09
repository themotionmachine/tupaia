// Integration round 2: small message fixes found while reconciling the docs. Pure: no browser.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { NOT_REPLAYABLE } from "../src/ops.ts";
import { ToolError } from "../src/result.ts";
import { liveHowTo, requireLive } from "../src/tools/shared.ts";
import "../src/tools/relief.ts";

const fakeCtx = (transport: "stdio" | "http") =>
  ({
    config: { envMode: "local", outDir: "/tmp/out-x" },
    mode: { mode: "local" },
    serving: transport === "http" ? { transport, url: "http://127.0.0.1:1/mcp", pid: 1 } : { transport }
  }) as never;

describe("integrate-2: MODE tells the human the fix for this transport", () => {
  test("stdio: the tupaia-live .mcp.json entry and a restart", () => {
    assert.throws(
      () => requireLive(fakeCtx("stdio")),
      (e: unknown) =>
        e instanceof ToolError && e.code === "MODE" && /tupaia-live/.test(e.message) && !/tupaia stop/.test(e.message)
    );
  });

  test("--http daemon: stop it and start it again with TUPAIA_MODE=live (no .mcp.json advice)", () => {
    assert.throws(
      () => requireLive(fakeCtx("http")),
      (e: unknown) =>
        e instanceof ToolError &&
        e.code === "MODE" &&
        /tupaia stop/.test(e.message) &&
        /TUPAIA_MODE=live/.test(e.message) &&
        /\/tmp\/out-x/.test(e.message) &&
        !/\.mcp\.json/.test(e.message)
    );
    assert.match(liveHowTo(fakeCtx("http")), /does not reconnect/);
  });
});

describe("integrate-2: the regenerate blob-only reason names every replayable part", () => {
  test("biomes, provinces, emblems and relief", () => {
    const why = NOT_REPLAYABLE.regenerate;
    for (const part of ["biomes", "provinces", "emblems", "relief"]) assert.match(why, new RegExp(part));
    assert.doesNotMatch(why, /on its own/);
  });
});
