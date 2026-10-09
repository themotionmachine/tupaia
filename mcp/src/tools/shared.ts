// shared_status, shared_save, shared_restore: the live shared map (map.activationlayer.org).
//
// The live-write gate (DECISIONS.md):
// - writes only when the server was spawned with TUPAIA_MODE=live (never switchable at run time);
// - a call without confirm is a preview that returns a one-time token bound to the live version,
//   the body hash (or restore target) and the override flags; the confirmed call must echo it;
// - lineage (is the page map derived from the shared map?) is separate from the version check;
//   force overrides only version/lock, replaceWithUnrelated only lineage;
// - a local build newer than the deployed one is always blocked; an unverifiable build (verdict
//   'unknown') is refused unless skipBuildCheck:true, a separate flag that force does not imply;
// - the current live blob and the outgoing body are backed up under TUPAIA_OUT/shared-saves/;
// - X-Map-Overwrite is never sent. shared-api.ts re-checks mode and token before any write.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CallScope, ToolContext } from "../context.ts";
import { ToolError } from "../result.ts";
import { compareVersions, type GateFields, type SharedMeta, sha256 } from "../shared-api.ts";
import { loadShared } from "./persist.ts";
import { defineTools } from "./registry.ts";
import { reliefOnLoadRefusal } from "./relief.ts";

interface BuildCheck {
  local: string | null;
  live: string | null;
  localEntry: string | null;
  liveEntry: string | null;
  verdict: "ok" | "warn" | "block" | "unknown" | "skipped";
  message: string;
}

async function buildCheck(ctx: ToolContext): Promise<BuildCheck> {
  const local = ctx.browser.appVersion;
  const localEntry = ctx.browser.distEntry;
  const lb = await ctx.shared.liveBuild();
  const base = { local, live: lb.version, localEntry, liveEntry: lb.entry };
  if (!local || !lb.version) {
    return {
      ...base,
      verdict: "unknown",
      message: `could not compare builds (local ${local ?? "?"}, live ${lb.version ?? "?"}${lb.error ? `: ${lb.error}` : ""})`
    };
  }
  if (compareVersions(local, lb.version) > 0) {
    return {
      ...base,
      verdict: "block",
      message: `local build ${local} is newer than the deployed ${lb.version}: saving would stamp ${local} into the shared map and make it unloadable for live users ('Newer file'). Deploy first.`
    };
  }
  if (localEntry && lb.entry && localEntry !== lb.entry) {
    return {
      ...base,
      verdict: "warn",
      message: `local build differs from the deployed build (entry ${localEntry} vs ${lb.entry}); same VERSION ${local}${compareVersions(local, lb.version) < 0 ? " or older" : ""}`
    };
  }
  return { ...base, verdict: "ok", message: "local and deployed builds match" };
}

export function requireLive(ctx: ToolContext): void {
  if (ctx.config.envMode !== "live") {
    throw new ToolError(
      "MODE",
      "local mode: no network writes. This server was spawned with TUPAIA_MODE=local; only a human can enable shared writes, by adding the tupaia-live server entry (TUPAIA_MODE=live) to .mcp.json and restarting. Reads (shared_status, load_map {source:'shared'}) still work."
    );
  }
  if (ctx.mode.mode !== "live") {
    throw new ToolError(
      "MODE",
      "this server dropped from live to local mode (session set_mode); shared writes are off"
    );
  }
}

function metaView(m: SharedMeta) {
  return {
    version: m.version,
    name: m.name,
    updated_by: m.updated_by,
    updated_at: m.updated_at,
    editing_by: m.editing_by,
    lock_expires: m.lock_expires
  };
}

/**
 * Is the page map derived from the shared map? Provenance alone is not enough: it is bound to
 * the page's window.mapId recorded when it was set, and anything that replaced the map without
 * updating provenance shows up as a different id here.
 */
async function lineageOf(ctx: ToolContext) {
  const p = ctx.snapshots.provenance;
  // a sketch opened from the Worker is derived from the shared version it is based on
  const claimsShared = (p.kind === "shared" || p.kind === "sketch") && typeof p.sharedVersion === "number";
  const via = p.kind === "sketch" ? ` via sketch '${p.sketchSlug ?? "?"}' (its v${p.sketchVersion ?? "?"})` : "";
  const pageId = claimsShared ? await ctx.pageMapId() : null;
  const idMatches = pageId !== null && p.mapId !== undefined && p.mapId !== null && pageId === p.mapId;
  const related = claimsShared && idMatches;
  const origin = ctx.provenanceView();
  let note: string;
  if (claimsShared && !related) {
    note =
      pageId === null
        ? `NOT verifiably derived from the shared map: the origin says shared v${p.sharedVersion}${via}, but the page's map id cannot be read (browser not running), so the map that will be in the page is unknown`
        : `NOT verifiably derived from the shared map: the origin says shared v${p.sharedVersion}${via}, but the page's map id ${pageId} differs from the one recorded then (${p.mapId ?? "none"}); something replaced the map since (eval, a failed generate_map, a relaunch)`;
  } else if (related) {
    note = `derived from the shared map v${p.sharedVersion}${via}${p.restoredFrom ? ` (via ${p.restoredFrom})` : ""}, ${p.opsSince} op(s) since`;
  } else if (p.kind === "generated") {
    note = `NOT derived from the shared map: generated here from seed ${p.seed ?? "?"}`;
  } else if (p.kind === "file") {
    note = `NOT derived from the shared map: loaded from the file ${p.path ?? "?"}`;
  } else {
    note = `NOT derived from the shared map (origin: ${p.kind}${p.seed ? `, seed ${p.seed}` : ""})`;
  }
  return { related, sharedVersion: related ? (p.sharedVersion as number) : null, origin, note };
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** Back up the current live blob (and, for a save, the outgoing body) before a write. */
async function backup(
  ctx: ToolContext,
  expectVersion: number,
  outgoing: Buffer | null
): Promise<{ live: string; outgoing?: string }> {
  const dir = path.join(ctx.config.outDir, "shared-saves");
  fs.mkdirSync(dir, { recursive: true });
  const blob = await ctx.shared.getMap();
  if (blob.version !== null && blob.version !== expectVersion) {
    throw new ToolError(
      "STALE",
      `the shared map moved to v${blob.version} (by ${blob.updatedBy ?? "?"}) while preparing the write; nothing was written. Preview again.`
    );
  }
  const s = stamp();
  const live = path.join(dir, `v${expectVersion}-live-${s}.map`);
  fs.writeFileSync(live, blob.bytes);
  const out: { live: string; outgoing?: string } = { live };
  if (outgoing) {
    out.outgoing = path.join(dir, `v${expectVersion}-outgoing-${s}.map`);
    fs.writeFileSync(out.outgoing, outgoing);
  }
  return out;
}

interface Refusal {
  code: string;
  message: string;
}

export function register(ctx: ToolContext): void {
  ctx.tool(
    "shared_status",
    {
      title: "Shared map status",
      description:
        "Read-only: the live shared map's metadata (version, name, who saved it and when, lock holder) compared with the map in the page: lineage (is it derived from the shared map?), stale (has the shared map moved on since it was loaded?), opsSince, and the build check (local app VERSION vs the deployed one: a newer local build blocks shared_save). versions:true adds the retained versions (targets for shared_restore). Works in local mode (GETs from Node to the live origin; session shows which). By default it sends exactly one GET (/api/map/shared/meta) in local mode; the build check (GET /versioning.js and /) runs by default only in live mode, or with build:true. Does not launch the browser.",
      inputSchema: z.object({
        versions: z.boolean().optional().describe("Also list the retained versions (one more GET)"),
        build: z
          .boolean()
          .optional()
          .describe("Run the build check (GET /versioning.js and /). Default: true in live mode, false in local mode")
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      kind: "read",
      launch: false
    },
    async args => {
      const origin = ctx.shared.origin();
      const meta = await ctx.shared.meta();
      const writesEnabled = ctx.config.envMode === "live" && ctx.mode.mode === "live";
      const build: BuildCheck =
        (args.build ?? writesEnabled)
          ? await buildCheck(ctx)
          : {
              local: ctx.browser.appVersion,
              live: null,
              localEntry: ctx.browser.distEntry,
              liveEntry: null,
              verdict: "skipped",
              message: "build check not run (local mode default); pass build:true to compare with the deployed build"
            };
      const lin = await lineageOf(ctx);
      const p = ctx.snapshots.provenance;
      const out: Record<string, unknown> = {
        liveOrigin: origin,
        mode: ctx.mode.mode,
        writesEnabled,
        meta: meta ? metaView(meta) : null,
        local: {
          browser: ctx.browser.state,
          originKind: p.kind,
          origin: lin.origin,
          lineage: lin.related ? "shared" : "unrelated",
          lineageNote: lin.note,
          sharedVersion: lin.sharedVersion,
          stale: meta && lin.related ? lin.sharedVersion !== meta.version : null,
          opsSince: p.opsSince
        },
        buildMatch: build.verdict === "skipped" ? null : build.verdict === "ok",
        build
      };
      if (!meta) out.note = "the shared map does not exist yet (404)";
      if (args.versions) out.versions = await ctx.shared.versions();
      return out;
    }
  );

  ctx.tool(
    "shared_save",
    {
      title: "Save over the LIVE shared map",
      description:
        "OUTWARD WRITE: replaces the live shared map (map.activationlayer.org, used by other people) with the map in the page. Only when the human explicitly asked in this conversation, and only in a server spawned with TUPAIA_MODE=live. Step 1: call without confirm: returns a preview {wouldOverwrite {version, updated_by, updated_at, editing_by}, lineage, stale, buildCheck, bytes, token, refusalReason?}. Step 2: tell the human what would be overwritten. Step 3: call again with confirm:true and the preview's token (valid 10 min, one use) and the SAME flags. Refusals: STALE when the shared map moved on since it was loaded (force:true overrides, only after the human agreed to that overwrite); LOCKED when someone holds the edit lock (force overrides); LINEAGE when the page map is not derived from the shared map (replaceWithUnrelated:true overrides; force does not); BUILD when the local app VERSION is newer than the deployed one (never overridable), or when the builds cannot be compared (skipBuildCheck:true overrides that case only; force does not); expectVersion:n refuses unless the live version is n. Backs up the current live blob and the outgoing body under TUPAIA_OUT/shared-saves/ first, PUTs with X-Map-Version (never an overwrite header); a 409 from the Worker returns CONFLICT with its body.",
      inputSchema: z.object({
        confirm: z.boolean().optional().describe("true = perform the write (needs token); absent = preview"),
        token: z.string().optional().describe("The token from the preview"),
        force: z.boolean().optional().describe("Override a stale version or someone else's lock (human-approved only)"),
        replaceWithUnrelated: z
          .boolean()
          .optional()
          .describe("Allow replacing the shared map with a map not derived from it (human-approved only)"),
        expectVersion: z.number().int().min(1).optional().describe("Refuse unless the live version is exactly this"),
        skipBuildCheck: z
          .boolean()
          .optional()
          .describe(
            "Proceed when the deployed build cannot be verified (human-approved only; never overrides a newer local build)"
          )
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      kind: "heavy"
    },
    async (args, scope) => sharedSave(ctx, scope, args)
  );

  ctx.tool(
    "shared_restore",
    {
      title: "Roll the LIVE shared map back",
      description:
        "OUTWARD WRITE: rolls the live shared map back to a retained version (shared_status {versions:true} lists them); the restore is itself a new version. Only when the human explicitly asked, and only in a server spawned with TUPAIA_MODE=live. Call without confirm for a preview {current, target, token}; tell the human; then call with confirm:true, the token and expectCurrent (the live version you told the human about; refused if it moved). The Worker has no version guard on restore, so these checks are the only ones. LOCKED when someone holds the edit lock (force overrides). The current live blob is backed up first. reload (default true) loads the restored shared map into the page.",
      inputSchema: z.object({
        version: z.number().int().min(1).describe("Retained version to restore"),
        confirm: z.boolean().optional(),
        token: z.string().optional(),
        expectCurrent: z.number().int().min(1).optional().describe("Required with confirm: the live version now"),
        force: z.boolean().optional().describe("Override someone else's lock (human-approved only)"),
        reload: z.boolean().optional().describe("Load the restored shared map into the page (default true)")
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      kind: "heavy"
    },
    async (args, scope) => sharedRestore(ctx, scope, args)
  );
}

/** The shared_save gate end to end (preview -> token -> confirm); sketch_promote reuses it. */
export async function sharedSave(
  ctx: ToolContext,
  scope: CallScope,
  args: {
    confirm?: boolean;
    token?: string;
    force?: boolean;
    replaceWithUnrelated?: boolean;
    expectVersion?: number;
    skipBuildCheck?: boolean;
    /** Internal (sketch_promote): the call publishes the active sketch itself. */
    viaSketch?: boolean;
  }
): Promise<Record<string, unknown>> {
  requireLive(ctx);
  const sk = ctx.sketches.current;
  const data = await scope.call<{ text: string; customization: number; fileName: string | null }>(
    "mapData",
    {},
    { noAlerts: true }
  );
  if (data.customization) {
    throw new ToolError(
      "REFUSED",
      `an app editor is active (customization=${data.customization}); close it first (eval: closeDialogs(); customization = 0)`
    );
  }
  const body = Buffer.from(data.text, "utf8");
  const bodySha = sha256(body);
  const meta = await ctx.shared.meta();
  if (!meta) throw new ToolError("NOT_FOUND", "the shared map does not exist yet; this tool does not create it");
  const lin = await lineageOf(ctx);
  const stale = lin.related ? lin.sharedVersion !== meta.version : false;
  const lockHeld = !!meta.editing_by;
  const build = await buildCheck(ctx);
  const force = !!args.force;
  const unrelatedOk = !!args.replaceWithUnrelated;
  const skipBuild = !!args.skipBuildCheck;

  const refusals: Refusal[] = [];
  if (!lin.related && !unrelatedOk) {
    refusals.push({
      code: "LINEAGE",
      message: `the map in the page is ${lin.note}; saving would replace the shared map v${meta.version} with an unrelated map. Pass replaceWithUnrelated:true only if the human asked for exactly that (force does not override this).`
    });
  }
  if (args.expectVersion !== undefined && args.expectVersion !== meta.version) {
    refusals.push({
      code: "STALE",
      message: `expectVersion ${args.expectVersion} but the live shared map is v${meta.version} (saved by ${meta.updated_by} at ${meta.updated_at})`
    });
  }
  if (stale && !force) {
    refusals.push({
      code: "STALE",
      message: `the shared map moved on: the page map came from v${lin.sharedVersion}, the live map is v${meta.version} saved by ${meta.updated_by} at ${meta.updated_at}. Tell the human; force:true overwrites it only if they agree.`
    });
  }
  if (lockHeld && !force) {
    refusals.push({
      code: "LOCKED",
      message: `${meta.editing_by} holds the edit lock until ${meta.lock_expires}; force:true overrides only if the human agrees`
    });
  }
  if (sk?.suspended && !args.viaSketch) {
    refusals.push({
      code: "SKETCH",
      message: `the page holds a stopped sketch rebase (a partial replay of sketch '${sk.slug}'), not a finished map: ${sk.suspended.reason}. Undo it (snapshot {action:'undo', n:${sk.suspended.entries.length}}) or finish the rebase (sketch {action:'rebase', onConflict:'skip'}) first.`
    });
  }
  if (build.verdict === "block") refusals.push({ code: "BUILD", message: build.message });
  const relief = await reliefOnLoadRefusal(ctx, data.text, build, skipBuild); // track 'relief'
  if (relief) refusals.push(relief);
  if (build.verdict === "unknown" && !skipBuild) {
    refusals.push({
      code: "BUILD",
      message: `${build.message}. A newer local build would make the shared map unloadable for live users; pass skipBuildCheck:true only if the human agrees to save without that check (force does not override this).`
    });
  }

  const fields: GateFields = {
    kind: "save",
    liveVersion: meta.version,
    subject: bodySha,
    target: ctx.shared.target,
    mode: ctx.mode.mode,
    flags: JSON.stringify({ force, replaceWithUnrelated: unrelatedOk, skipBuildCheck: skipBuild })
  };
  const overrides: string[] = [];
  if (force && stale)
    overrides.push(`force: overwrites v${meta.version} although the page map came from v${lin.sharedVersion}`);
  if (force && lockHeld) overrides.push(`force: ignores ${meta.editing_by}'s lock`);
  if (skipBuild && build.verdict === "unknown")
    overrides.push("skipBuildCheck: saves although the deployed build could not be compared with the local one");
  if (unrelatedOk && !lin.related)
    overrides.push("replaceWithUnrelated: replaces the shared map with an unrelated map");
  const preview = {
    wouldOverwrite: metaView(meta),
    base: lin.sharedVersion,
    lineage: { related: lin.related, note: lin.note, origin: lin.origin },
    stale,
    buildCheck: build,
    bytes: body.length,
    sha256: bodySha,
    name: data.fileName,
    sends: {
      method: "PUT",
      url: ctx.shared.target,
      headers: { "X-Map-Version": String(meta.version), "X-Map-Name": data.fileName },
      overwriteHeader: "never sent"
    },
    overrides: overrides.length ? overrides : undefined,
    activeSketch:
      sk && !args.viaSketch
        ? `sketch '${sk.slug}' is active (base v${sk.base.version ?? "?"}, ${sk.ops.length} ops): shared_save publishes the page map, sketch changes included, and ends the sketch (its changes would otherwise be applied twice by a later rebase or promote). To publish a sketch, use sketch_promote.`
        : undefined
  };

  if (!args.confirm) {
    if (refusals.length) {
      return {
        preview: true,
        ...preview,
        refusalReason: refusals.map(r => `${r.code}: ${r.message}`).join(" | "),
        token: null,
        next: "Nothing can be saved as is. Tell the human why; do not retry with overrides unless they ask."
      };
    }
    const { token, expiresAt } = ctx.shared.issueToken(fields);
    return {
      preview: true,
      ...preview,
      token,
      tokenExpiresAt: expiresAt,
      next: `Tell the human: this overwrites live v${meta.version} (${meta.name}, saved by ${meta.updated_by} at ${meta.updated_at}). Only after they say yes: shared_save {confirm:true, token:'${token}'${force ? ", force:true" : ""}${unrelatedOk ? ", replaceWithUnrelated:true" : ""}${skipBuild ? ", skipBuildCheck:true" : ""}}.`
    };
  }

  if (refusals.length) {
    const r = refusals[0];
    throw new ToolError(r.code, refusals.map(x => `${x.code}: ${x.message}`).join(" | "), {
      details: { wouldOverwrite: preview.wouldOverwrite, lineage: preview.lineage, buildCheck: build }
    });
  }
  ctx.shared.checkToken(args.token, fields, false);
  const backups = await backup(ctx, meta.version, body);
  let saved: Awaited<ReturnType<typeof ctx.shared.putMap>>;
  try {
    saved = await ctx.shared.putMap({
      mode: ctx.mode.mode,
      token: args.token as string,
      fields,
      body,
      version: meta.version,
      name: data.fileName
    });
  } catch (e) {
    if (e instanceof ToolError) {
      const d = typeof e.details === "object" && e.details ? e.details : {};
      e.details = { ...d, backup: backups };
    }
    throw e;
  }
  const p = ctx.snapshots.provenance;
  ctx.snapshots.setProvenance({
    kind: "shared",
    seed: p.seed ?? null,
    mapId: await ctx.pageMapId(),
    sharedVersion: saved.version,
    sharedUpdatedBy: saved.updated_by,
    sharedUpdatedAt: saved.updated_at,
    fetchedAt: new Date().toISOString()
  });
  // a sketch whose changes went live this way is done: a later rebase or promote would apply
  // its adds and paints a second time on top of themselves
  let sketchEnded: string | undefined;
  if (sk && !args.viaSketch && ctx.sketches.current === sk) {
    ctx.sketches.current = null;
    sketchEnded = `sketch '${sk.slug}' ended: its changes are on the shared map as v${saved.version} through shared_save${sk.saved ? "; its saved copy stays on the Worker (sketch {action:'discard'} removes it)" : ""}`;
    scope.notes.push(sketchEnded);
  }
  return {
    saved,
    ...(sketchEnded ? { sketchEnded } : {}),
    overwrote: preview.wouldOverwrite,
    overrides: preview.overrides,
    backup: backups,
    buildCheck: build.verdict === "ok" ? undefined : build,
    origin: ctx.provenanceView()
  };
}

async function sharedRestore(
  ctx: ToolContext,
  scope: CallScope,
  args: {
    version: number;
    confirm?: boolean;
    token?: string;
    expectCurrent?: number;
    force?: boolean;
    reload?: boolean;
  }
): Promise<Record<string, unknown>> {
  requireLive(ctx);
  const meta = await ctx.shared.meta();
  if (!meta) throw new ToolError("NOT_FOUND", "the shared map does not exist yet");
  const versions = await ctx.shared.versions();
  const target = versions?.snapshots.find(s => s.version === args.version);
  if (!target) {
    throw new ToolError("NOT_FOUND", `version ${args.version} is not retained`, {
      candidates: (versions?.snapshots ?? [])
        .slice(0, 8)
        .map(s => ({ i: s.version, name: `v${s.version} ${s.saved_at}` }))
    });
  }
  const force = !!args.force;
  const lockHeld = !!meta.editing_by;
  const refusals: Refusal[] = [];
  if (args.expectCurrent !== undefined && args.expectCurrent !== meta.version) {
    refusals.push({
      code: "STALE",
      message: `expectCurrent ${args.expectCurrent} but the live shared map is v${meta.version} (saved by ${meta.updated_by} at ${meta.updated_at})`
    });
  }
  if (lockHeld && !force) {
    refusals.push({
      code: "LOCKED",
      message: `${meta.editing_by} holds the edit lock until ${meta.lock_expires}; force:true overrides only if the human agrees`
    });
  }
  const fields: GateFields = {
    kind: "restore",
    liveVersion: meta.version,
    subject: `v${args.version}`,
    target: ctx.shared.target,
    mode: ctx.mode.mode,
    flags: JSON.stringify({ force })
  };
  const preview = {
    current: metaView(meta),
    target,
    result: `a new version v${meta.version + 1} holding the bytes of v${args.version}; v${meta.version} stays retained`,
    reload: args.reload !== false,
    sends: { method: "POST", url: `${ctx.shared.target}/restore?v=${args.version}` }
  };
  if (!args.confirm) {
    if (refusals.length) {
      return {
        preview: true,
        ...preview,
        refusalReason: refusals.map(r => `${r.code}: ${r.message}`).join(" | "),
        token: null
      };
    }
    const { token, expiresAt } = ctx.shared.issueToken(fields);
    return {
      preview: true,
      ...preview,
      token,
      tokenExpiresAt: expiresAt,
      next: `Tell the human: this rolls live v${meta.version} (saved by ${meta.updated_by} at ${meta.updated_at}) back to v${args.version}. Only after they say yes: shared_restore {version:${args.version}, confirm:true, token:'${token}', expectCurrent:${meta.version}${force ? ", force:true" : ""}}.`
    };
  }
  if (args.expectCurrent === undefined) {
    throw new ToolError(
      "BAD_ARGS",
      "a confirmed shared_restore needs expectCurrent (the live version you told the human about)"
    );
  }
  if (refusals.length) {
    throw new ToolError(refusals[0].code, refusals.map(x => `${x.code}: ${x.message}`).join(" | "), {
      details: { current: preview.current, target }
    });
  }
  ctx.shared.checkToken(args.token, fields, false);
  const backups = await backup(ctx, meta.version, null);
  const restored = await ctx.shared.restore({
    mode: ctx.mode.mode,
    token: args.token as string,
    fields,
    version: args.version
  });
  const out: Record<string, unknown> = { restored, replaced: preview.current, backup: backups };
  if (args.reload !== false) {
    const { summary, version } = await loadShared(ctx, scope, "shared_restore reload");
    out.reloaded = { name: summary.name, seed: summary.seed, counts: summary.counts, sharedVersion: version };
    out.origin = ctx.provenanceView();
  }
  return out;
}

defineTools("shared", register);
