// Inspect only current emitted entries: old files left in dist must not affect this diagnostic.
import ts from "typescript";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";

const output = process.env.BUNDLE_BOUNDARY_OUTPUT;
if (!output || existsSync(output)) throw new Error("Unique BUNDLE_BOUNDARY_OUTPUT required");
const dist = resolve("dist");
const html = readFileSync(join(dist, "index.html"), "utf8");
const entry = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/)?.[1].replace(/^\//, "");
if (!entry) throw new Error("Current module entry not found");
const parse = (name: string) => ts.createSourceFile(
  name, readFileSync(join(dist, name), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS
);
const serializationEntries = new Set<string>();
const findEntries = (node: ts.Node) => {
  if (ts.isStringLiteralLike(node) && /^(?:\.\/)?(?:save-|export-(?!json-))[^/]+\.js$/.test(node.text))
    serializationEntries.add(node.text.replace(/^\.\//, ""));
  ts.forEachChild(node, findEntries);
};
findEntries(parse(entry));
if (serializationEntries.size !== 2) throw new Error("Expected current save and export entries");

function graph(root: string) {
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length) {
    const name = queue.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const node of parse(name).statements) {
      if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ||
        !node.moduleSpecifier || !ts.isStringLiteralLike(node.moduleSpecifier)) continue;
      const next = node.moduleSpecifier.text;
      if (next.startsWith(".")) queue.push(normalize(join(dirname(name), next)));
    }
  }
  return [...seen].sort().map(name => {
    const bytes = readFileSync(join(dist, name));
    return {
      name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      gpuPresentationImplementation: bytes.includes(Buffer.from("paintSuppressed"))
    };
  });
}

const roots = [entry, ...serializationEntries];
const graphs = roots.map(root => ({ root, chunks: graph(root) }));
const boundaryClean = graphs.every(graph => graph.chunks.every(chunk => !chunk.gpuPresentationImplementation));
const expectedPresent = process.env.BUNDLE_BOUNDARY_EXPECT === "present";
const report = {
  scope: "Static emitted module graph for default boot and current save/export; dynamic GPU imports are excluded",
  boundaryClean, expectation: expectedPresent ? "baseline contains GPU presentation code" : "GPU presentation stays lazy",
  expectationMet: expectedPresent ? !boundaryClean : boundaryClean, graphs
};
writeFileSync(output, JSON.stringify(report, null, 2), { flag: "wx" });
console.log(JSON.stringify({ output, boundaryClean, expectationMet: report.expectationMet }));
if (!report.expectationMet) process.exitCode = 1;
