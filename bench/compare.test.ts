import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const fixture = JSON.parse(readFileSync(new URL("./results/mgm1-final-base.json", import.meta.url), "utf8"));
function compare(mutate: (base: any, current: any) => void): number | null {
  const directory = mkdtempSync(join(tmpdir(), "tupaia-gate-"));
  try {
    const base = structuredClone(fixture), current = structuredClone(fixture);
    mutate(base, current);
    const basePath = join(directory, "base.json"), currentPath = join(directory, "current.json");
    writeFileSync(basePath, JSON.stringify(base));
    writeFileSync(currentPath, JSON.stringify(current));
    return spawnSync(process.execPath, [new URL("./compare.ts", import.meta.url).pathname, basePath, currentPath], {encoding:"utf8"}).status;
  } finally { rmSync(directory, {recursive:true, force:true}); }
}
test("identical complete paired runs pass", () => assert.equal(compare(() => {}), 0));
test("material regressions fail without tightening small timing noise", () => {
  assert.equal(compare((_, current) => { current.measurements[0].medianMs *= 2; }), 1);
  assert.equal(compare((_, current) => { current.measurements[0].medianMs += 99; }), 0);
});
test("missing, duplicate and invalid measurements on either side fail", () => {
  for (const side of ["base", "current"]) for (const defect of ["missing", "duplicate", "invalid"]) {
    assert.equal(compare((base, current) => {
      const result = side === "base" ? base : current;
      if (defect === "missing") result.measurements.pop();
      if (defect === "duplicate") result.measurements.push(result.measurements[0]);
      if (defect === "invalid") result.measurements[0].medianMs = 0;
    }), 1);
  }
});
test("mismatched environments and unsupported schemas fail", () => {
  assert.equal(compare((_, current) => { current.cpu = "different host"; }), 1);
  assert.equal(compare((base, current) => { base.schema = current.schema = 99; }), 1);
});
