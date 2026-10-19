import assert from "node:assert/strict";
import { test } from "node:test";
import { bootPath } from "../src/browser.ts";

// TUPAIA_RENDERER selects the app's ?renderer= arm for the MCP browser (default: svg, i.e. no parameter).
test("bootPath adds the renderer switch only when TUPAIA_RENDERER names a valid arm", () => {
  assert.equal(bootPath(undefined), "/?local");
  assert.equal(bootPath(""), "/?local");
  assert.equal(bootPath("svg"), "/?local&renderer=svg");
  assert.equal(bootPath(" GPU "), "/?local&renderer=gpu");
  assert.throws(() => bootPath("webgl"), /TUPAIA_RENDERER must be svg or gpu/);
});
