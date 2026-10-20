// @vitest-environment happy-dom
// What a map load resets outside the replaced svg#map (W3 LIFE3): main.js's camera globals, the relief editor's mode
// and a heightmap edit mode left open. Found by the editor replay harness loading fixtures in one page.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetCameraGlobals, resetEditorsOnLoad } from "./editor-reset";

const camera = globalThis as unknown as { scale?: number; viewX?: number; viewY?: number; edits?: unknown };

beforeEach(() => {
  document.body.innerHTML = `
    <div id="options"><div class="tab"><button id="styleTab"></button><button id="toolsTab" class="active"></button></div>
      <div id="toolsContent" style="display: none"></div><div id="customizationMenu" style="display: block"></div></div>
    <select id="layersPreset" disabled></select>
    <button id="undo"></button><button id="redo"></button><button id="templateUndo"></button><button id="templateRedo"></button>
    <div id="exitCustomization" style="display: block"></div>
    <div id="preview"></div>
    <div id="reliefTools"><button id="reliefIndividual"></button><button id="reliefBulkAdd" class="pressed"></button>
      <button id="reliefBulkRemove"></button></div>`;
});

afterEach(() => {
  delete camera.scale;
  delete camera.viewX;
  delete camera.viewY;
  delete camera.edits;
});

describe("[LIFE3] map load resets", () => {
  it("the camera globals go to identity with the new #map, so zoomRaf sees a zoom to the old camera as a change", () => {
    Object.assign(camera, { scale: 8, viewX: -4000, viewY: -1200 });
    resetCameraGlobals();
    expect([camera.scale, camera.viewX, camera.viewY]).toEqual([1, 0, 0]);
    // main.js zoomRaf drops an event whose transform equals the globals: k=8 at the old position is not dropped now
    const dropped = (k: number, x: number, y: number) => camera.scale === k && camera.viewX === x && camera.viewY === y;
    expect(dropped(8, -4000, -1200)).toBe(false);
  });

  it("parseLoadedData resets the camera right after it reselects the new #map, and the editors before customization 0", () => {
    const source = readFileSync(resolve(__dirname, "load.ts"), "utf8");
    const reselect = source.indexOf('svg = (window as any).d3.select("#map")');
    expect(reselect).toBeGreaterThan(0);
    expect(source.indexOf("resetCameraGlobals();", reselect)).toBeGreaterThan(reselect);
    expect(source.indexOf("resetCameraGlobals();", reselect)).toBeLessThan(source.indexOf("\n", reselect + 80));
    const editors = source.indexOf("resetEditorsOnLoad(document, customization === 1)");
    expect(editors).toBeGreaterThan(0);
    expect(editors).toBeLessThan(source.indexOf("customization = 0;"));
  });

  it("the relief editor reopens in its default mode, not the bulk mode chosen on the previous map", () => {
    resetEditorsOnLoad(document, false);
    expect([...document.querySelectorAll("#reliefTools button.pressed")].map(b => b.id)).toEqual(["reliefIndividual"]);
    // no heightmap edit was open: its controls are left alone
    expect(document.getElementById("exitCustomization")!.style.display).toBe("block");
  });

  it("a heightmap edit open during the load is left without applying it: no armed Exit Customization", () => {
    camera.edits = [[1, 2, 3]];
    resetEditorsOnLoad(document, true);
    expect(document.getElementById("exitCustomization")!.style.display).toBe("none");
    expect(document.getElementById("customizationMenu")!.style.display).toBe("none");
    expect(document.getElementById("toolsContent")!.style.display).toBe("block");
    expect((document.getElementById("layersPreset") as HTMLSelectElement).disabled).toBe(false);
    for (const id of ["undo", "redo", "templateUndo", "templateRedo"])
      expect((document.getElementById(id) as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById("preview")).toBeNull();
    expect("edits" in globalThis).toBe(false);
  });

  it("the heightmap editor inserts its #heights layer only on entering the edit mode, not before the mode dialog", () => {
    const source = readFileSync(resolve(__dirname, "../../public/modules/ui/heightmap-editor.js"), "utf8");
    const insert = source.indexOf('viewbox.insert("g", "#terrs").attr("id", "heights")');
    const enter = source.indexOf("function enterHeightmapEditMode(mode)");
    expect(source.indexOf('viewbox.insert("g", "#terrs").attr("id", "heights")', insert + 1)).toBe(-1);
    expect(insert).toBeGreaterThan(enter);
    expect(insert).toBeLessThan(source.indexOf("editHeightmap.layers =", enter));
  });
});
