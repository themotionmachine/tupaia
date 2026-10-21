// Page chrome kept out of every screenshot a host compares (GPU arm vs SVG arm, a blank vs a layer, shot vs shot).
// Pass it as page.screenshot({ style: HIDE_CHROME }): Playwright applies it for that capture only, so the app's own
// layout and the renderer never see it.
//   - #tooltip, the bottom tip bar ("Map is successfully loaded", cleared a few seconds later): ~77K px of "ink" between
//     a GPU blank captured while it showed and an SVG blank after it cleared;
//   - #renderModeIndicator, the Navigate/Edit pill (src/controllers/render-mode.ts), which can still read "Updating" for
//     a moment after the renderer reports a current frame: ~2.5K px between two captures of one frame;
//   - the first-visit glow (public/index.css): button.glow::after and #finalizeHeightmap::after carry a static 10px
//     box-shadow under an opacity pulse, and animations: "disabled" leaves that shadow at full strength. Chromium
//     rasterizes the blur's tail with +-1 noise from one capture to the next (~774 px of SVG-arm ink in the d1 ice
//     cells, #optionsTrigger). Selects keep the older box-shadow pulse on .glow itself.
export const HIDE_CHROME = [
  "#tooltip, #renderModeIndicator { visibility: hidden !important; }",
  "button.glow::after, #finalizeHeightmap::after { display: none !important; }",
  ".glow { animation: none !important; box-shadow: none !important; }"
].join("\n");
