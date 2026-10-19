# Production deployment — 2026-10-11

Deployed the tested working tree from mgm1 using `./cloudflare/deploy.sh` (`CF_BUILD=1` build and Wrangler deploy). Worker: `fmg-map`; live site: https://map.activationlayer.org.

- Current Worker version: `692b44b5-9740-4f91-9f7a-5d0cdb9fbb10`.
- Previous rollback version: `e2fc809d-9599-471b-9fdf-ce59d3d730b5`.
- Live entry: `/index-BJKgk-gZ.js`; entry and all five worker asset SHA-256 hashes match the build.
- A fresh production browser generates 7,747 packed cells, renders nine burg raster groups and emits native binary magic when preparing a save.
- Shared-map read-only load succeeds: 47,885 packed cells and 27 active burgs. Metadata remains version 8, updated `2026-10-10T00:36:37.565Z`.
- Browser page errors: zero. API writes were blocked during verification; no shared-map save, restoration or database change occurred.

Existing client-owned MCP processes were not forcibly restarted; they load server code when their sessions restart. Changes remain uncommitted. CI has not been executed for this working tree.

## Navigation update — 2026-10-11

Current production Worker version: `96603d0c-2785-4406-a5cb-432a3550a954`; rollback version: `692b44b5-9740-4f91-9f7a-5d0cdb9fbb10`. Live `/index-ByNVIW-T.js` and `main.js` match the build. Production read-only verification confirms stable deep-zoom nodes, exact final camera, binary saving with transient overlays stripped and zero page errors. Shared map remains version 8. See [navigation.md](navigation.md) for measurements and limitations.

## Zone hatch fix — 2026-10-11

Current Worker version: `3363d6de-a866-43bb-9402-c4ade2fa35c7`; rollback: `96603d0c-2785-4406-a5cb-432a3550a954`. Production entry `/index-ewavl04_.js` and both modified public scripts match the build. Live checks confirm constant hatch density at four zoom levels, clean saves and zero page errors; shared version 8 remains unchanged. Details: [hatch-scaling.md](hatch-scaling.md).
