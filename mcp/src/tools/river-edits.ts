// River structure edits ride on the edit tool: edit river {mainStem, split, merge, reroute} is
// implemented page-side in src/bridge-ext/rivers.js. This module defines no tool; server.ts
// imports every tools/*.ts, so it registers their replay metadata at startup:
// - mainStem holds a river ref, which replay maps when the sketch created that river (a split
//   reports the river it created in its resolved op, like add);
// - river ids are reused (Rivers.getNextId is max id + 1, Rivers.remove splices), and mainStem,
//   split and merge are not idempotent, so replay checks that a river's source is still the one
//   the sketch saw before editing it (a river someone else re-cut, or the same change applied
//   twice, is a conflict instead of a silent second swap).
import { EDIT_REF_FIELDS } from "../ops.ts";
import { REUSED_ID_TYPES } from "../replay.ts";

EDIT_REF_FIELDS.river = { ...(EDIT_REF_FIELDS.river ?? {}), mainStem: "river" };
REUSED_ID_TYPES.river = [...new Set([...(REUSED_ID_TYPES.river ?? []), "source"])];
