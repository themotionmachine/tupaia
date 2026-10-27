import "./view-3d";

import { parseRendererPreference } from "../renderers/renderer-mode";
import { initializeCommandPalette } from "./command-palette";

initializeCommandPalette();

// Navigate/Edit mode (D10) exists whenever the GPU renderer is requested (the default since W5); ?renderer=svg never
// loads it.
if (parseRendererPreference(location.search).requested === "gpu")
  void import("./render-mode").then(module => module.installForPage());
