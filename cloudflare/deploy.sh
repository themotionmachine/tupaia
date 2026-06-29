#!/usr/bin/env bash
# Build the FMG SPA at root base and deploy the fmg-map Worker (assets + R2 + D1
# + custom-domain route). Reproducible from the repo (NFR-1). Run from repo root:
#   ./cloudflare/deploy.sh
#
# Prereqs (one-time, see cloudflare/README.md):
#   - R2 bucket `fmg-maps` and D1 `fmg-meta` created (D1 via Cloudflare MCP),
#     the D1 id pasted into cloudflare/wrangler.jsonc, schema applied.
#   - A NON-expired CLOUDFLARE_API_TOKEN (Workers Scripts:Edit, D1:Edit,
#     Zone Workers Routes:Edit) exported, OR `wrangler login`.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Building SPA (base '/')"
CF_BUILD=1 npm run build

echo "==> Deploying fmg-map Worker"
npx wrangler deploy -c cloudflare/wrangler.jsonc

echo "==> Done. https://map.activationlayer.org"
