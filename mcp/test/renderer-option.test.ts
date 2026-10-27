import assert from "node:assert/strict";
import { test } from "node:test";
import { bootPath } from "../src/browser.ts";

// TUPAIA_RENDERER selects the app's ?renderer= arm for the MCP browser (default: svg, pinned explicitly since the
// app's own default became gpu in W5).
test("bootPath always names the renderer: svg unless TUPAIA_RENDERER names a valid arm", () => {
  assert.equal(bootPath(undefined), "/?local&renderer=svg");
  assert.equal(bootPath(""), "/?local&renderer=svg");
  assert.equal(bootPath("svg"), "/?local&renderer=svg");
  assert.equal(bootPath(" GPU "), "/?local&renderer=gpu");
  assert.throws(() => bootPath("webgl"), /TUPAIA_RENDERER must be svg or gpu/);
});
