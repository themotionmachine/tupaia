// Write-path policy (paths.ts) without a browser: repo root, build/test folders, git-tracked
// files and case-folded spellings are refused; TUPAIA_OUT is allowed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import type { Config } from "../src/config.ts";
import { resolveWritePath } from "../src/paths.ts";
import { ToolError } from "../src/result.ts";
import { REPO_ROOT } from "./helpers.ts";

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "tupaia-paths-"));
const cfg = { repoRoot: REPO_ROOT, outDir } as unknown as Config;

function refused(p: string, opts: Parameters<typeof resolveWritePath>[2] = {}, re?: RegExp): void {
  assert.throws(
    () => resolveWritePath(cfg, p, opts),
    (e: unknown) => e instanceof ToolError && e.code === "REFUSED" && (!re || re.test(e.message)),
    p
  );
}

/** A variant of an absolute repo path with the case of every letter after the repo root flipped. */
function flipCase(rel: string): string {
  return path.join(
    REPO_ROOT,
    rel.replace(/[a-z]/gi, ch => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()))
  );
}

describe("write path policy", () => {
  after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  test("TUPAIA_OUT is allowed; relative paths resolve there", () => {
    const f = resolveWritePath(cfg, "maps/a.map");
    assert.equal(f, path.join(fs.realpathSync.native(outDir), "maps", "a.map"));
  });

  test("repo root files are refused even with overwrite", () => {
    refused(path.join(REPO_ROOT, "package.json"), { overwrite: true }, /repo root/);
    refused(path.join(REPO_ROOT, "tsconfig.json"), { overwrite: true }, /repo root/);
    refused(path.join(REPO_ROOT, "new-file.svg"), {}, /repo root/);
  });

  test("dist/, tests/ and source folders are refused", () => {
    for (const rel of ["dist/x.svg", "tests/out.png", "src/x.svg", "docs/a.png", "mcp/x.json"])
      refused(path.join(REPO_ROOT, rel), { overwrite: true }, /source\/config\/build/);
  });

  test("tests/fixtures is refused even with allowOutside, in any letter case", () => {
    refused("tests/fixtures/x.map", { allowOutside: true, overwrite: true }, /tests\/fixtures/);
    refused("Tests/Fixtures/x.map", { allowOutside: true, overwrite: true }, /tests\/fixtures/);
    if (process.platform === "darwin" || process.platform === "win32") {
      refused(flipCase("tests/fixtures/demo.map"), { allowOutside: true, overwrite: true }, /tests\/fixtures/);
      refused(flipCase("src/x.svg"), { overwrite: true }, /source\/config\/build/);
    }
  });

  test("a git-tracked file outside the denylist is not replaced; an untracked one is", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tupaia-paths-repo-"));
    try {
      execFileSync("git", ["init", "-q", repo]);
      fs.mkdirSync(path.join(repo, "maps"));
      fs.writeFileSync(path.join(repo, "maps", "tracked.json"), "{}");
      fs.writeFileSync(path.join(repo, "maps", "loose.json"), "{}");
      execFileSync("git", ["-C", repo, "add", "maps/tracked.json"]);
      const c = { repoRoot: repo, outDir } as unknown as Config;
      assert.throws(
        () => resolveWritePath(c, path.join(repo, "maps", "tracked.json"), { overwrite: true }),
        (e: unknown) => e instanceof ToolError && /tracked by git/.test(e.message)
      );
      const ok = resolveWritePath(c, path.join(repo, "maps", "loose.json"), { overwrite: true });
      assert.equal(path.basename(ok), "loose.json");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
