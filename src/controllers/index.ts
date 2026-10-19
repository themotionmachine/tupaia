import "./view-3d";

import { parseRendererPreference } from "../renderers/renderer-mode";
import { initializeCommandPalette } from "./command-palette";

initializeCommandPalette();

// Navigate/Edit mode (D10) exists only under ?renderer=gpu; the default SVG renderer never loads it.
if (parseRendererPreference(location.search).requested === "gpu")
  void import("./render-mode").then(module => module.installForPage());
