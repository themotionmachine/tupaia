import "./view-3d";

import { rendererStatus, renderModeWanted } from "../renderers/renderer-mode";
import { initializeCommandPalette } from "./command-palette";

initializeCommandPalette();

// Navigate/Edit mode (D10: the mode chip, its poll and the palette commands) exists only where the GPU renderer
// actually started: requested (the default since W5) and not fallen back at start. The router decided that
// synchronously when renderer-mode.ts was evaluated (the WebGL2 probe and backend construction; only the GPU module
// itself loads later), so a page without (hardware) WebGL2 never shows an "SVG / GPU rendering is off" chip and
// ?renderer=svg never loads it. A runtime fallback after this point (load, prepare, restore) keeps the chip, which
// then reports it.
if (renderModeWanted(rendererStatus()))
  void import("./render-mode")
    .then(module => module.installForPage())
    .catch(error => console.warn("Render mode controller failed to load:", error));
