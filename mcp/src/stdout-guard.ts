// stdout is the JSON-RPC channel. This module must be imported FIRST by server.ts: it gives
// the transport its own writer bound to the real fd-1 stream, then points
// process.stdout.write (used by console.log/dir/table and any chatty dependency) at stderr.
import { Writable } from "node:stream";

const realStdout = process.stdout;
const realWrite = realStdout.write.bind(realStdout) as (
  chunk: unknown,
  encoding: BufferEncoding,
  cb: (err?: Error | null) => void
) => boolean;

/** The only writer that reaches fd 1. Pass it to StdioServerTransport. */
export const protocolOut = new Writable({
  write(chunk, encoding, cb) {
    realWrite(chunk, encoding, err => cb(err ?? null));
  }
});

realStdout.on("error", err => protocolOut.destroy(err));

const toStderr = ((chunk: unknown, encoding?: unknown, cb?: unknown) =>
  (process.stderr.write as (...a: unknown[]) => boolean)(chunk, encoding, cb)) as typeof process.stdout.write;
process.stdout.write = toStderr;
