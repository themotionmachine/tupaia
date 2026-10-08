// Cloudflare shared-map provider + Tier-A save/load UX.
//
// Mirrors the Dropbox provider in cloud.ts, but talks to the `fmg-map` Worker's
// `/api/map/:id` control plane over the same origin. This file plus two button
// bindings in index.html and the `base: '/'` build flag are the entire client
// fork surface (PRD cloudflare/PRD-tier-a.md §9).
//
// The Tier-A contract: storage is last-writer-wins, so conflicts must be made
// visible and consensual, never silent (PRD §10). On load we remember the
// version; on save we echo it and the Worker rejects a stale write with 409,
// which we surface as an explicit Overwrite / Reload choice.

import type { CloudFile } from "@/io/cloud";
import { uploadMap } from "@/io/load";
import { prepareMapData } from "@/io/save";

/** The single shared map id (multi-map is additive — the API keys are already `:id`). */
const MAP_ID = "shared";

/** Same-origin in production. A `window.FMG_API_BASE` override eases local dev
 *  (vite on :5173 pointing at `wrangler dev` on :8787). */
function apiBase(): string {
  return (window as unknown as { FMG_API_BASE?: string }).FMG_API_BASE ?? "";
}

const mapUrl = (id: string, suffix = "") => `${apiBase()}/api/map/${encodeURIComponent(id)}${suffix}`;

/** Version the current in-memory map was loaded at — the stale-write guard (FR-7).
 *  `null` means "not loaded from the shared map", so a save creates/overwrites only
 *  after an explicit confirmation. */
let loadedVersion: number | null = null;

// tupaia-mcp: loadedVersion only holds while the page still has the map loaded from `shared`.
// A shared load arms `pendingVersion`; the next completed load (load.ts fires "map:loaded") takes
// it over and any other load clears it. "map:generated" (fired by every generate AND, before
// "map:loaded", by every load) clears it too. So a map opened from a ?maplink sketch, a file or
// a new map never saves over `shared` without a confirmation.
let pendingVersion: number | null = null;
window.addEventListener("map:loaded", () => {
  loadedVersion = pendingVersion;
  pendingVersion = null;
});
window.addEventListener("map:generated", () => {
  loadedVersion = null;
});

interface MapMeta {
  id: string;
  name: string;
  version: number;
  updated_at: string;
  updated_by: string;
  editing_by: string | null;
  lock_expires: string | null;
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Load the shared map and rehydrate it through FMG's existing upload path (FR-3). */
export async function loadSharedMap(): Promise<void> {
  try {
    const response = await fetch(mapUrl(MAP_ID), { method: "GET" });
    if (response.status === 404) {
      tip("No shared map saved yet — use “Save to shared map” to create it", true, "warn", 5000);
      return;
    }
    if (!response.ok) throw new Error(`Server returned ${response.status}`);

    const version = Number(response.headers.get("X-Map-Version"));
    const updatedBy = response.headers.get("X-Map-Updated-By") ?? "unknown";
    const updatedAt = response.headers.get("X-Map-Updated-At") ?? "";
    const blob = await response.blob();

    uploadMap(blob, () => {
      pendingVersion = Number.isFinite(version) ? version : null; // tupaia-mcp: set on map:loaded
    });
    tip(`Loaded shared map · v${version} · last saved by ${updatedBy} at ${when(updatedAt)}`, true, "success", 6000);
  } catch (error) {
    ERROR && console.error(error);
    tip("Cannot load shared map. Check your connection and try again", true, "error", 4000);
  }
}

/** Boot-time variant of {@link loadSharedMap} (FR-3): loads the shared map as the
 *  default on page load. Returns `true` if it loaded, or `false` so the caller can
 *  fall through to normal boot (random / last-saved) when there's no shared map yet
 *  or the network is unreachable. Stays quiet on the no-map case — it's not an error
 *  during boot. */
export async function loadSharedMapOnBoot(): Promise<boolean> {
  try {
    const response = await fetch(mapUrl(MAP_ID), { method: "GET" });
    if (!response.ok) return false; // 404 (no shared map yet) or transient — fall through
    const version = Number(response.headers.get("X-Map-Version"));
    const updatedBy = response.headers.get("X-Map-Updated-By") ?? "unknown";
    const updatedAt = response.headers.get("X-Map-Updated-At") ?? "";
    const blob = await response.blob();
    uploadMap(blob, () => {
      pendingVersion = Number.isFinite(version) ? version : null; // tupaia-mcp: set on map:loaded
    });
    tip(`Loaded shared map · v${version} · last saved by ${updatedBy} at ${when(updatedAt)}`, true, "success", 6000);
    return true;
  } catch (error) {
    ERROR && console.error(error);
    return false;
  }
}

/** Serialize the current map and save it to the shared cloud slot (FR-4).
 *  On a stale-write 409 the user must consciously choose overwrite or reload (FR-7). */
export async function saveSharedMap(force = false, replaceVersion: number | null = null): Promise<void> {
  if (customization) {
    tip("Map cannot be saved in EDIT mode, please complete the edit and retry", false, "error");
    return;
  }
  // tupaia-mcp: a map that did not come from `shared` asks before it replaces it
  if (!force && loadedVersion === null && replaceVersion === null) return confirmReplaceShared();

  try {
    const mapData = prepareMapData();
    const headers: Record<string, string> = {
      "content-type": "text/plain; charset=utf-8",
      "X-Map-Name": encodeURIComponent(getFileName())
    };
    if (force) headers["X-Map-Overwrite"] = "true";
    const version = loadedVersion ?? replaceVersion; // tupaia-mcp: the version the user agreed to replace
    if (version !== null) headers["X-Map-Version"] = String(version);

    const response = await fetch(mapUrl(MAP_ID), { method: "PUT", headers, body: mapData });

    if (response.status === 409) {
      const conflict = (await response.json()) as Pick<MapMeta, "version" | "updated_by" | "updated_at">;
      promptConflict(conflict);
      return;
    }
    if (!response.ok) throw new Error(`Server returned ${response.status}`);

    const result = (await response.json()) as { version: number };
    loadedVersion = result.version;
    tip(`Saved to shared map · v${result.version}`, true, "success", 5000);
  } catch (error) {
    ERROR && console.error(error);
    tip("Cannot save shared map. Check your connection and try again", true, "error", 4000);
  }
}

/** tupaia-mcp: the page map was not loaded from `shared` (a ?maplink sketch, a file, a new
 *  map). Saving it replaces the shared map, so name the version it replaces and ask. The PUT
 *  then carries that version, so a save by someone else in between still answers 409. */
async function confirmReplaceShared(): Promise<void> {
  let meta: MapMeta | null = null;
  try {
    const response = await fetch(mapUrl(MAP_ID, "/meta"), { method: "GET" });
    if (response.status === 404) return saveSharedMap(false, 0); // no shared map yet: create it
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    meta = (await response.json()) as MapMeta;
  } catch (error) {
    ERROR && console.error(error);
    tip("Cannot reach the shared map. Check your connection and try again", true, "error", 4000);
    return;
  }
  const current = meta;
  alertMessage.innerHTML = /* html */ `The map in this page was <b>not loaded from the shared map</b>
    (it was opened from a link such as a sketch, loaded from a file, or generated here).<br /><br />
    Saving it <b>replaces the shared map v${current.version}</b> (saved by <b>${current.updated_by}</b>,
    ${when(current.updated_at)}) for everyone. Edits made there that this map does not have are lost
    from the current version; v${current.version} stays recoverable from history.`;
  $("#alert").dialog({
    resizable: false,
    title: "Replace the shared map?",
    width: "32em",
    buttons: {
      [`Replace v${current.version}`]: function (this: HTMLElement) {
        $(this).dialog("close");
        saveSharedMap(false, current.version);
      },
      Cancel: function (this: HTMLElement) {
        $(this).dialog("close");
      }
    },
    position: { my: "center", at: "center", of: "svg" }
  });
}

/** The lost-edits guard made visible (PRD §10): someone saved since we opened. */
function promptConflict(conflict: Pick<MapMeta, "version" | "updated_by" | "updated_at">): void {
  alertMessage.innerHTML = /* html */ `This map was saved by <b>${conflict.updated_by}</b> since you opened it
    (now <b>v${conflict.version}</b>, ${when(conflict.updated_at)}).<br /><br />
    <b>Reload</b> to take their version (your unsaved changes are lost), or
    <b>Overwrite</b> to replace it with yours. The previous version stays recoverable
    from history either way.`;
  $("#alert").dialog({
    resizable: false,
    title: "Shared map changed",
    width: "30em",
    buttons: {
      Reload: function (this: HTMLElement) {
        $(this).dialog("close");
        loadSharedMap();
      },
      Overwrite: function (this: HTMLElement) {
        $(this).dialog("close");
        saveSharedMap(true);
      },
      Cancel: function (this: HTMLElement) {
        $(this).dialog("close");
      }
    },
    position: { my: "center", at: "center", of: "svg" }
  });
}

/** List retained versions and offer one-click restore (FR-5). */
export async function showSharedMapVersions(): Promise<void> {
  try {
    const response = await fetch(mapUrl(MAP_ID, "/versions"), { method: "GET" });
    if (response.status === 404) {
      tip("No shared map saved yet", true, "warn", 4000);
      return;
    }
    if (!response.ok) throw new Error(`Server returned ${response.status}`);

    const { current, snapshots } = (await response.json()) as {
      current: number;
      snapshots: { version: number; size: number; saved_at: string }[];
    };

    const rows = snapshots.length
      ? snapshots
          .map(
            s => /* html */ `<tr>
              <td>v${s.version}</td>
              <td>${when(s.saved_at)}</td>
              <td>${(s.size / 1e6).toFixed(1)} MB</td>
              <td><button onclick="window.lazy.sharedMap().then(m => m.restoreSharedMap(${s.version}))">restore</button></td>
            </tr>`
          )
          .join("")
      : /* html */ `<tr><td colspan="4">No earlier versions retained yet.</td></tr>`;

    alertMessage.innerHTML = /* html */ `Shared map is at <b>v${current}</b>. Up to 20 prior versions are kept:
      <table class="table" style="margin-top:.5em"><tbody>${rows}</tbody></table>`;
    $("#alert").dialog({ resizable: false, title: "Shared map history", width: "32em" });
  } catch (error) {
    ERROR && console.error(error);
    tip("Cannot list shared map versions", true, "error", 4000);
  }
}

/** Restore a prior version, then reload it into the editor (FR-5). */
export async function restoreSharedMap(version: number): Promise<void> {
  try {
    const response = await fetch(mapUrl(MAP_ID, `/restore?v=${version}`), { method: "POST" });
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    closeDialogs("#alert");
    tip(`Restored v${version} — loading…`, true, "success", 4000);
    await loadSharedMap();
  } catch (error) {
    ERROR && console.error(error);
    tip("Cannot restore that version", true, "error", 4000);
  }
}

// --- provider-interface parity (mirrors cloud.ts's Dropbox provider) ---------
// Auth is handled at the edge by Cloudflare Access, so `auth` is a no-op here.

export const cloudflare = {
  name: "cloudflare",

  async auth(): Promise<void> {
    /* Cloudflare Access gates the origin; nothing to do client-side. */
  },

  async save(_fileName: string, contents: string): Promise<boolean> {
    const response = await fetch(mapUrl(MAP_ID), {
      method: "PUT",
      headers: { "content-type": "text/plain; charset=utf-8", "X-Map-Overwrite": "true" },
      body: contents
    });
    return response.ok;
  },

  async load(path: string): Promise<Blob> {
    const response = await fetch(`${apiBase()}${path}`, { method: "GET" });
    if (!response.ok) throw new Error(`Cannot load map (${response.status})`);
    return response.blob();
  },

  async list(): Promise<CloudFile[]> {
    const response = await fetch(`${apiBase()}/api/maps`, { method: "GET" });
    if (!response.ok) throw new Error(`Cannot list maps (${response.status})`);
    const maps = (await response.json()) as MapMeta[];
    return maps.map(m => ({ name: m.name, updated: m.updated_at, size: 0, path: mapUrl(m.id) }));
  },

  async getLink(path: string): Promise<string> {
    return `${location.origin}${path}`;
  }
};
