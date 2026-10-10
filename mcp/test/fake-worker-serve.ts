// Run the in-process fake Worker (fake-worker.ts) on its own, for trying the CLI by hand against
// a local origin instead of the live site:
//   node mcp/test/fake-worker-serve.ts [seed.map] [--version N] [--port N] [--assets [dir]]
// prints its origin (use it as TUPAIA_LIVE_ORIGIN) and serves until Ctrl-C. Not a test.
//   --port N      listen on that port (default: any free one), e.g. to restart it on the same origin
//   --assets dir  serve that built app (default <repo>/dist) for every non-/api path, like the
//                 Worker's ASSETS binding: the build check then sees the local build's entry chunk,
//                 so shared_save/sketch_promote of a reliefOnLoad map passes the relief load hook
//                 check. Without it '/' names a stub entry (index-FAKE.js) that answers 404.
import fs from "node:fs";
import path from "node:path";
import { FakeWorker } from "./fake-worker.ts";
import { DEMO_MAP, REPO_ROOT } from "./helpers.ts";

const args = process.argv.slice(2);
const isDir = (p: string | undefined) => !!p && fs.existsSync(p) && fs.statSync(p).isDirectory();
let version = 1;
let port = 0;
let assetsDir: string | undefined;
let seed: string | undefined;
for (let k = 0; k < args.length; k++) {
  const a = args[k];
  if (a === "--version") version = Number(args[++k]);
  else if (a === "--port") port = Number(args[++k]);
  // the directory is optional: `--assets` alone serves <repo>/dist
  else if (a === "--assets") assetsDir = path.resolve(isDir(args[k + 1]) ? args[++k] : path.join(REPO_ROOT, "dist"));
  else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
  else seed = a;
}
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port ${port}: not a port`);
if (assetsDir && !fs.existsSync(path.join(assetsDir, "index.html")))
  throw new Error(`--assets ${assetsDir}: no index.html (build it: CF_BUILD=1 npx vite build --emptyOutDir)`);
seed ??= DEMO_MAP;
const fake = new FakeWorker({
  seedFile: path.resolve(seed),
  version: Number.isInteger(version) && version >= 1 ? version : 1,
  ...(assetsDir ? { assetsDir } : {})
});
const origin = await fake.start(port);
process.stdout.write(`${origin}\n`);
process.stderr.write(
  `fake Worker: shared map v${fake.row.version} from ${seed}${assetsDir ? `; serving the app from ${assetsDir}` : "; stub app (--assets serves dist/)"}; Ctrl-C stops it\n`
);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void fake.stop().then(() => process.exit(0)));
