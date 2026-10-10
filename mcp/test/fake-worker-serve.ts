// Run the in-process fake Worker (fake-worker.ts) on its own, for trying the CLI by hand against
// a local origin instead of the live site:
//   node mcp/test/fake-worker-serve.ts [seed.map] [--version N]
// prints its origin (use it as TUPAIA_LIVE_ORIGIN) and serves until Ctrl-C. Not a test.
import path from "node:path";
import { FakeWorker } from "./fake-worker.ts";
import { DEMO_MAP } from "./helpers.ts";

const args = process.argv.slice(2);
const at = args.indexOf("--version");
const version = at >= 0 ? Number(args[at + 1]) : 1;
const seed = args.find((a, k) => !a.startsWith("--") && args[k - 1] !== "--version") ?? DEMO_MAP;
const fake = new FakeWorker({ seedFile: path.resolve(seed), version: Number.isInteger(version) ? version : 1 });
const origin = await fake.start();
process.stdout.write(`${origin}\n`);
process.stderr.write(`fake Worker: shared map v${fake.row.version} from ${seed}; Ctrl-C stops it\n`);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void fake.stop().then(() => process.exit(0)));
