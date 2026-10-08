// Minimal static file server over dist/ on 127.0.0.1:<random port>. No SPA fallback: unknown
// paths (including /api/*) are 404, so the app never mistakes index.html for a map file.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { readDistEntry } from "./config.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".glb": "model/gltf-binary"
};

export interface StaticServer {
  origin: string;
  port: number;
  close(): Promise<void>;
}

/** Throws with the fix-it command when dist/ is missing or not a CF_BUILD (base '/') build. */
export function checkDist(distDir: string, repoRoot: string): string {
  const fix = `cd ${repoRoot} && CF_BUILD=1 npx vite build --emptyOutDir`;
  if (!fs.existsSync(path.join(distDir, "index.html"))) {
    throw new Error(`dist not found at ${distDir}. Build it first: ${fix}`);
  }
  const entry = readDistEntry(distDir);
  if (!entry) {
    throw new Error(
      `${distDir}/index.html does not load /index-*.js, so it is not a CF_BUILD=1 build (base '/'). Rebuild: ${fix}`
    );
  }
  if (!fs.existsSync(path.join(distDir, entry))) {
    throw new Error(`${distDir}/index.html references ${entry}, which is missing. Rebuild: ${fix}`);
  }
  return entry;
}

export async function startStaticServer(distDir: string): Promise<StaticServer> {
  const root = path.resolve(distDir);
  const server = http.createServer((req, res) => {
    const notFound = () => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"not_found"}');
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end('{"error":"method_not_allowed"}');
      return;
    }
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      return notFound();
    }
    if (urlPath.endsWith("/")) urlPath += "index.html";
    const file = path.resolve(root, `.${urlPath}`);
    if (file !== root && !file.startsWith(root + path.sep)) return notFound();
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return notFound();
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "content-length": st.size,
        "cache-control": "no-store"
      });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).pipe(res);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  server.unref();
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}
