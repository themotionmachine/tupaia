// In-page API for bench/picking-cost.ts: the hit-geometry builders the prepare runs, so their cost can be timed in
// isolation on a live world (read-only: nothing here mutates the scene).
import { compatShapes, PICK_TOLERANCE, pickTolerance } from "../src/gpu/compat-pick";
import { PickIndex } from "../src/gpu/pick";
import { flattenPath } from "../src/gpu/svg-path";

Object.assign(window, { __pickCost: { compatShapes, flattenPath, pickTolerance, PickIndex, PICK_TOLERANCE } });
