// Unit tests for the legacy corpus (no browser): the manifest matches the files and auto-update.ts, the version helpers
// agree with the loader's own (public/versioning.js, evaluated here), and the migration gates cannot be unreachable by a typo.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { splitKnownGaps, gateCoverage, gatesOf, gatesTriggered, isEmptyGoldenCell, isOlder, type Manifest, parseMapVersion } from "./corpus-lib.ts";

const root = resolve(import.meta.dirname, "../..");
const corpus = join(root, "tests/fixtures/corpus");
const manifest: Manifest = JSON.parse(readFileSync(join(corpus, "manifest.json"), "utf8"));
const autoUpdate = readFileSync(join(root, "src/io/auto-update.ts"), "utf8");
const versioning = readFileSync(join(root, "public/versioning.js"), "utf8");
const gates = gatesOf(autoUpdate);

// the loader's own functions, from the shipped file
const loader = (() => {
  const pick = (name: string) => {
    const start = versioning.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} not found in public/versioning.js`);
    let depth = 0;
    for (let i = versioning.indexOf(") {", start) + 2; i < versioning.length; i++) {
      if (versioning[i] === "{") depth++;
      else if (versioning[i] === "}" && --depth === 0) return versioning.slice(start, i + 1);
    }
    throw new Error(`unterminated ${name}`);
  };
  const sandbox: Record<string, any> = {};
  vm.runInNewContext(`${pick("parseMapVersion")}\n${pick("isValidVersion")}\n${pick("compareVersions")}\nglobalThis.parseMapVersion = parseMapVersion; globalThis.compareVersions = compareVersions;`, sandbox);
  return sandbox as { parseMapVersion(v: string): string; compareVersions(a: string, b: string): { isOlder: boolean; isEqual: boolean; isNewer: boolean } };
})();
const CURRENT = /const VERSION = "([^"]+)"/.exec(versioning)![1];

test("version helpers agree with public/versioning.js on every version and gate involved", () => {
  const versions = [...manifest.entries.map(e => e.version), CURRENT, "1.652", "1.732", "1.0", "0.9b", "1.90.01", "1.99.01", "1.4", "1.11.0"];
  for (const v of versions) assert.equal(parseMapVersion(v), loader.parseMapVersion(v), `parseMapVersion(${v})`);
  for (const v of versions) for (const g of gates) assert.equal(isOlder(parseMapVersion(v), g), loader.compareVersions(loader.parseMapVersion(v), g).isOlder, `${v} older than ${g}`);
});

test("every auto-update.ts gate is older than the current version (a gate newer than VERSION fires for every map)", () => {
  assert.ok(gates.length >= 40, `found ${gates.length} gates`);
  for (const gate of gates) assert.ok(isOlder(gate, CURRENT), `gate ${gate} is not older than ${CURRENT}`);
  assert.ok(!gates.includes("1.652.0"), "the 1.652.0 typo is back; upstream's float 1.652 is 1.65.2");
  assert.ok(gates.includes("1.65.2"));
});

test("the manifest lists real files with the sha256 and size it states, unique ids, and the gates the source implies", () => {
  assert.ok(manifest.entries.length >= 5);
  assert.equal(new Set(manifest.entries.map(e => e.id)).size, manifest.entries.length);
  for (const entry of manifest.entries) {
    const path = join(corpus, entry.file);
    assert.ok(existsSync(path), `${entry.file} missing`);
    const bytes = readFileSync(path);
    assert.equal(statSync(path).size, entry.bytes, `${entry.id} size`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, `${entry.id} sha256`);
    const header = bytes.toString("utf8").split("\r\n", 1)[0];
    assert.equal(header.split("|")[0], entry.version, `${entry.id} header version`);
    assert.deepEqual([...entry.gates].sort(), gatesTriggered(entry.version, gates).sort(), `${entry.id} gate list is stale: regenerate the manifest`);
  }
});

test("every gate is triggered by a map that must load, except the documented unreachable ones", () => {
  const { exercised, unreached } = gateCoverage(gates, manifest.entries);
  assert.deepEqual(unreached.sort(), manifest.knownUnreachable.map(k => k.gate).sort(), "unreached gates differ from the manifest's knownUnreachable list");
  for (const known of manifest.knownUnreachable) {
    assert.ok(known.reason.length > 20, `${known.gate}: say why`);
    assert.ok(!exercised[known.gate]);
  }
});

test("the ancient entry is below the loader's floor and the oldest loadable entry is above it", () => {
  const floor = "0.70.0";
  for (const entry of manifest.entries) {
    const below = isOlder(parseMapVersion(entry.version), floor);
    assert.equal(below, entry.expect === "ancient", `${entry.id}: expect ${entry.expect} but version ${entry.version} is ${below ? "below" : "at or above"} ${floor}`);
  }
});

test("a golden cell with nothing to paint and no drawables is empty; a failing populated cell is not", () => {
  assert.equal(isEmptyGoldenCell({ family: "goods", pass: false, gates: { populated: false }, domDrawables: 0 }), true);
  assert.equal(isEmptyGoldenCell({ family: "rivers", pass: false, gates: { populated: false }, domDrawables: 12 }), false);
  assert.equal(isEmptyGoldenCell({ family: "rivers", pass: false, gates: { populated: true }, domDrawables: 0 }), false);
  assert.equal(isEmptyGoldenCell({ family: "rivers", pass: false }), false);
});

test("known golden gaps excuse metric failures only", () => {
  const cell = (family: string, failures: string[], pass = false) => ({ family, pass, failures });
  const { gating, excused } = splitKnownGaps(
    [cell("cells", ["ssim 0.9 < 0.95"]), cell("cells", ["GPU not active: context lost"]), cell("rivers", ["over16 3% > 1%"]), cell("provinces", [], true), cell("states", ["harness: boom"])],
    ["cells", "provinces", "states"]
  );
  assert.deepEqual(excused.map(c => c.family), ["cells"]);
  assert.deepEqual(gating.map(c => `${c.family}:${c.failures?.[0]}`), ["cells:GPU not active: context lost", "rivers:over16 3% > 1%", "states:harness: boom"]);
  assert.ok(manifest.goldenKnownGaps.every(k => k.reason.length > 20 && (k.maps ?? []).every(id => manifest.entries.some(e => e.id === id))));
});
