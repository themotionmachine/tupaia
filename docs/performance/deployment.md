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


# Deployment — October 15, 2026

Published the frozen P1 navigation reliability build to https://map.activationlayer.org.

- Worker: fmg-map
- Current version: ad4f0bf6-2b07-4142-ac9f-a585a645fb98
- Rollback version: 3363d6de-a866-43bb-9402-c4ade2fa35c7
- Frozen archive SHA-256: 42d8d22b72c8d20f675a62e407d287b35ddd02896bb84efed7226447458891c5
- Live entry: /index-DImK7cuH.js; entry and /main.js hashes match the frozen build.
- Default SVG browser check: 47,885-cell live shared map loaded; zero page errors.
- Opt-in GPU browser check: actual GPU active, canvas visible, source current, viewport covered, 30 moving markers; zero page errors.
- Targeted GPU tracked allocation: 165,711,973 bytes (~158.04 MiB). This single viewport is below 160 MiB; other known navigation cases remain above budget.
- Targeted Retina 2x fidelity: 1.0118% of pixels differ from SVG by more than 16 in at least one channel. Not a parity claim.
- Shared metadata remained version 8, updated 2026-10-10T00:36:37.565Z; verification blocked browser writes.
- SVG remains default. GPU test link: https://map.activationlayer.org/?renderer=gpu
- Original checkout remained unchanged; Cloudflare API/backend source was unchanged.
- Known P1 limitations remain: post-gesture pause, occasional larger frame delays, memory headroom, context restoration and unresolved heap growth.
- Later P2 edits in the isolated implementation are not included in this deployment.

Deployment used the existing local Wrangler login after the user renewed Cloudflare sign-in. No credentials included in these artifacts.


# Deployment — October 16, 2026

Published the frozen P2 checkpoint to https://map.activationlayer.org.

- Worker fmg-map version: 71dd4740-4b1b-4652-932c-d2855ce07fe8.
- Rollback version: ad4f0bf6-2b07-4142-ac9f-a585a645fb98.
- Frozen archive SHA-256: daa83ccd364c4152bc21dff94b1ec030592083b4cf9efe3926e4d6bbdcd1e8b4.
- Dist fingerprint: f91b5a5d03651eb502757637faeef6ea7b3ef54a88df6a3c5cfe4d4ed11961a9.
- Production HTML, /index-_SYo5NyR.js, and /main.js hashes match the frozen package.
- Default SVG: current live shared map loaded, 47,885 cells, no page errors.
- Opt-in GPU at DPR2, zoom2: active, visible, source current, window covered, zero window misses, 30 moving trade markers. No page errors or GL validation warnings. Expected blocked-resource and blocked-service-worker warnings were present in the read-only harness.
- GPU tracked allocations159,372,253B (~151.99MiB), within160MiB steady target for this viewport.
- Pixel over16 fraction0.009938693576388888, identical to the checkpoint's same fixture/camera baseline. This single passing view does not close overall visual parity.
- Shared metadata stayed version8, updated2026-10-10T00:36:37.565Z, before and after both browser checks. Browser writes were blocked.
- Worker/API source and Wrangler config are byte-identical to the prior release package.
- SVG remains default. GPU link: https://map.activationlayer.org/?renderer=gpu.
- Remaining fidelity, picking/editor, context recovery and Windows gaps remain as documented. No default flip or claim of full rewrite completion.

The source/dist used for this deployment was frozen before resuming isolated parity work. Later edits are not automatically deployed.
