// Legacy corpus generator (REWRITE-PLAN §5 row 33; tests/fixtures/corpus/CORPUS.md). NOT part of any gate: it is how
// the committed maps in tests/fixtures/corpus/ were made, kept so they can be remade or extended.
//
// For each requested git tag of THIS repository (the upstream history, so nothing is downloaded from outside) it
// extracts the tag's tree with `git archive` into <work>/<tag>/, serves that directory, opens it in headless
// Chromium with every request except loopback aborted, generates a map with a fixed seed and a small cell count, and
// saves it through the old version's own saveMap() (the download is captured). The result is a real map file as that
// version of the app wrote it. Old versions are plain static pages (v0.9b..v1.99, no build). Vite-era tags (>= v1.110)
// are served from their own `vite build --base=/` output when <work>/<tag>/dist exists (see tests/fixtures/corpus/CORPUS.md).
//
//   node bench/host/corpus-generate.ts <tag>[,<tag>...] [--out <dir>] [--work <dir>] [--seed <s>] [--cells <n>]
// Defaults: --work ~/.tupaia-gates/w2-corpus/old, --out ~/.tupaia-gates/w2-corpus/maps, --seed 7319, --cells 0 (the version's default density; a number regenerates at that many grid cells).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const tags = (args[0] && !args[0].startsWith("--") ? args[0] : "").split(",").filter(Boolean);
const work = resolve(opt("work", join(homedir(), ".tupaia-gates/w2-corpus/old")));
const outDir = resolve(opt("out", join(homedir(), ".tupaia-gates/w2-corpus/maps")));
const seed = opt("seed", "7319");
const cells = Number(opt("cells", "0")); // 0 = keep the first generation (the version's default density)
if (!tags.length) throw Error("usage: corpus-generate.ts <tag>[,<tag>...] [--out dir] [--work dir] [--seed s] [--cells n]");
mkdirSync(outDir, { recursive: true });

const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff" };
// tags that predate cells-per-input: v0.9b..v1.4 size the map by densityInput (x10K cells), later ones by pointsInput steps
const POINT_STEPS: Record<number, number> = { 1000: 1, 2000: 2, 5000: 3, 10000: 4, 20000: 5 };

const browser = await chromium.launch({ headless: true, channel: "chromium" });
try {
  for (const tag of tags) {
    const tree = join(work, tag);
    if (!existsSync(join(tree, "index.html")) && !existsSync(join(tree, "src/index.html"))) {
      mkdirSync(tree, { recursive: true });
      const tar = execFileSync("git", ["-C", root, "archive", tag], { maxBuffer: 1 << 30 });
      execFileSync("tar", ["-x", "-C", tree], { input: tar });
    }
    // Vite-era tags (v1.110+) are served from their own `vite build --base=/` output: build it first with
    //   ln -s <this repo>/node_modules <work>/<tag>/node_modules && (cd <work>/<tag> && npx vite build --base=/)
    const dir = existsSync(join(tree, "dist/index.html")) ? join(tree, "dist") : tree;
    const server = createServer((request, response) => {
      const path = resolve(dir, `.${decodeURIComponent(new URL(request.url || "/", "http://x").pathname)}`);
      if (!path.startsWith(dir)) return void response.writeHead(403).end();
      try {
        const file = path === dir || path === `${dir}/` ? join(dir, "index.html") : path;
        response.setHeader("content-type", mime[extname(file)] || "application/octet-stream");
        response.end(readFileSync(file));
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    // Chrome version is part of the output (text metrics), so record it next to the map
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, acceptDownloads: true });
    await context.route("**/*", route => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("dialog", d => d.dismiss());
    await page.goto(`${origin}/?seed=${seed}&renderer=svg`); // generated as before W5 made GPU the default display
    await page.waitForFunction(() => (0, eval)("typeof pack !== 'undefined' && pack?.cells?.i?.length > 0"), null, { timeout: 120000 });
    const info = await page.evaluate(
      async ([wantCells, stepFor]) => {
        const g = globalThis as any;
        const density = document.getElementById("densityInput") as HTMLInputElement | null;
        const points = document.getElementById("pointsInput") as HTMLInputElement | null;
        const read = (name: string) => (0, eval)(name);
        if (!wantCells) {
          // keep the first generation
        } else if (points) {
          points.value = String(stepFor);
          g.changeCellsDensity(stepFor);
        } else if (density) {
          density.min = "0.05";
          density.value = String(wantCells / 10000);
        }
        // top-level let/const of the old scripts are not window properties: read them with an indirect eval
        if (wantCells) {
          (document.getElementById("optionsSeed") as HTMLInputElement).value = read("seed");
          await g.generate();
        }
        const pack = read("pack");
        return { version: read(read("typeof VERSION") === "string" ? "VERSION" : "version"), seed: read("seed"), cells: pack.cells.i.length, width: read("graphWidth"), height: read("graphHeight"), burgs: pack.burgs.length - 1, states: pack.states.length - 1 };
      },
      [cells, POINT_STEPS[cells] ?? 2] as const
    );
    // v1.7+ expose the serializer (getMapData, later prepareMapData) whose text is exactly what the download holds; the
    // oldest versions only have saveMap(), which writes the file as a download
    const path = join(outDir, `${tag}.map`);
    const serialized: string | null = await page.evaluate(() => {
      const g = globalThis as any;
      return typeof g.prepareMapData === "function" ? g.prepareMapData() : typeof g.getMapData === "function" ? g.getMapData() : null;
    });
    if (serialized !== null) writeFileSync(path, serialized);
    else {
      const download = page.waitForEvent("download", { timeout: 120000 });
      await page.evaluate(() => (globalThis as any).saveMap("machine"));
      await (await download).saveAs(path);
    }
    const size = readFileSync(path).length;
    console.log(JSON.stringify({ tag, path, size, header: readFileSync(path, "utf8").split("\n", 1)[0].slice(0, 160), ...info, errors: errors.slice(0, 3) }));
    writeFileSync(`${path}.json`, `${JSON.stringify({ tag, chromium: browser.version(), ...info }, null, 1)}\n`);
    await context.close();
    server.close();
  }
} finally {
  await browser.close();
}
