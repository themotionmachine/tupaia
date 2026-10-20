// What a map load must reset outside the replaced svg#map (W3 LIFE3; found by the editor replay harness, which used
// to load one fixture after another in a single page). parseLoadedData closes the dialogs and zeroes `customization`;
// these are the pieces of state that survived it anyway. Each affects plain SVG mode too.

// main.js's camera globals. The loaded #map is a new element (d3 zoom state: identity) and a saved map has no #viewbox
// transform (save.ts removes it), but `scale`/`viewX`/`viewY` kept the previous map's camera. zoomRaf compares the
// next zoom with them and drops one that matches, so zooming the new map to the camera the old one ended at left
// #viewbox unzoomed (the replay's k=8 relief-icons step then clicked the wrong element).
export function resetCameraGlobals(): void {
  scale = 1;
  viewX = 0;
  viewY = 0;
}

export interface EditorResetDocument {
  getElementById(id: string): HTMLElement | null;
  querySelectorAll(selectors: string): ArrayLike<Element>;
}

// `heightmap`: the heightmap editor was in its edit mode (customization 1) when the load began.
export function resetEditorsOnLoad(doc: EditorResetDocument, heightmap: boolean): void {
  // The relief editor reopens in the mode whose button is pressed (relief-editor.js restoreEditMode): a bulk mode
  // chosen on the previous map stayed armed, so a click on an icon type only marked the button. Back to the default.
  const individual = doc.getElementById("reliefIndividual");
  if (individual) {
    for (const button of Array.from(doc.querySelectorAll("#reliefTools button.pressed")))
      button.classList.remove("pressed");
    individual.classList.add("pressed");
  }
  if (!heightmap) return;
  // A load while the heightmap editor is open abandons the edit (closeDialogs closed its panels, the old svg and its
  // #heights layer go with the map). Its exit stayed armed: "Exit Customization" still showed and would have run
  // finalizeHeightmap (Erase mode: regenerate every layer) on the loaded map. Leave the edit mode the way
  // finalizeHeightmap does, without applying it.
  const exit = doc.getElementById("exitCustomization");
  if (exit) exit.style.display = "none";
  const menu = doc.getElementById("customizationMenu");
  if (menu) menu.style.display = "none";
  const active = doc.querySelectorAll("#options .tab > button.active")[0];
  const tools = doc.getElementById("toolsContent");
  if (active?.id === "toolsTab" && tools) tools.style.display = "block";
  const preset = doc.getElementById("layersPreset") as HTMLSelectElement | null;
  if (preset) preset.disabled = false;
  for (const id of ["undo", "redo", "templateUndo", "templateRedo"]) {
    const button = doc.getElementById(id) as HTMLButtonElement | null;
    if (button) button.disabled = true;
  }
  doc.getElementById("preview")?.remove(); // the heightmap preview window
  delete (globalThis as { edits?: unknown }).edits; // the editor's history
}
