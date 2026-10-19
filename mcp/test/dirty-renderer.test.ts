import assert from "node:assert/strict";
import {test} from "node:test";
import {sharedDemoFixture} from "./helpers.ts";

test("territory patches match full geometry and preserve existing label nodes", {timeout: 120000}, async () => {
  const fixture = await sharedDemoFixture();
  try {
    const page = await fixture.browser.getPage();
    const result = await page.evaluate(() => {
      const w = globalThis as any;
      const {cells, states, provinces} = w.pack;
      w.drawStates(); w.drawProvinces(); w.drawBorders(); w.drawStateLabels();
      const stateLabels = Array.from(document.querySelectorAll('#labels #states text')).map(el => [el, el.outerHTML]);
      const provinceLabels = Array.from(document.querySelectorAll('#provinceLabels text')).map(el => [el, el.outerHTML]);
      if (!stateLabels.length || !provinceLabels.length) throw Error(`demo labels absent states=${stateLabels.length} provinces=${provinceLabels.length}`);
      const cell = Array.from(cells.i as number[]).find((id: number) => cells.h[id] >= 20 && cells.state[id] &&
        !cells.burg[id] && states[cells.state[id]].center !== id && cells.c[id].some((n: number) =>
          cells.h[n] >= 20 && cells.state[n] && cells.state[n] !== cells.state[id]));
      if (cell === undefined) throw Error("demo lacks editable state border cell");
      const old = cells.state[cell], targetCell = cells.c[cell].find((n: number) =>
        cells.h[n] >= 20 && cells.state[n] && cells.state[n] !== old), target = cells.state[targetCell];
      const untouched = states.find((state: any) => state.i && state.i !== old && state.i !== target &&
        document.getElementById(`state${state.i}`));
      const untouchedPath = untouched ? document.getElementById(`state${untouched.i}`) : null;
      cells.state[cell] = target;
      w.drawStates([old,target]); w.drawBorders([old,target]);
      const geometry = (selector: string) => Array.from(document.querySelectorAll(selector)).map(el =>
        [el.getAttribute("id") || el.getAttribute("data-border-key"), el.getAttribute("d")]).sort((a,b) => String(a[0]).localeCompare(String(b[0])));
      const patchedStates = geometry('#statesBody path,#statesHalo path,#statesBody clipPath path');
      const patchedBorders = geometry('#stateBorders path,#provinceBorders path');
      const stateLabelsPreserved = stateLabels.every(([el, html]) => (el as Element).isConnected && (el as Element).outerHTML === html);
      const untouchedPreserved = !untouched || document.getElementById(`state${untouched.i}`) === untouchedPath;
      w.drawStates(); w.drawBorders();
      const fullStates = geometry('#statesBody path,#statesHalo path,#statesBody clipPath path');
      const fullBorders = geometry('#stateBorders path,#provinceBorders path');
      const provinceCell = Array.from(cells.i as number[]).find((id: number) => cells.h[id] >= 20 && cells.province[id] &&
        provinces[cells.province[id]].center !== id && cells.c[id].some((n: number) => cells.state[n] === cells.state[id] &&
          cells.province[n] && cells.province[n] !== cells.province[id]));
      let provinceParity = true, provinceLabelsPreserved = true;
      if (provinceCell !== undefined) {
        const previous = cells.province[provinceCell], nextCell = cells.c[provinceCell].find((n: number) =>
          cells.state[n] === cells.state[provinceCell] && cells.province[n] && cells.province[n] !== previous);
        const next = cells.province[nextCell];
        cells.province[provinceCell] = next;
        w.drawProvinces([previous,next]);
        const patched = geometry('#provincesBody path');
        provinceLabelsPreserved = provinceLabels.every(([el, html]) => (el as Element).isConnected && (el as Element).outerHTML === html);
        w.drawProvinces();
        provinceParity = JSON.stringify(patched) === JSON.stringify(geometry('#provincesBody path'));
      }
      return {patchedStates,fullStates,patchedBorders,fullBorders,stateLabelsPreserved,untouchedPreserved,provinceParity,provinceLabelsPreserved};
    });
    assert.deepEqual(result.patchedStates, result.fullStates);
    assert.deepEqual(result.patchedBorders, result.fullBorders);
    assert.equal(result.stateLabelsPreserved, true);
    assert.equal(result.untouchedPreserved, true);
    assert.equal(result.provinceParity, true);
    assert.equal(result.provinceLabelsPreserved, true);
  } finally {await fixture.close();}
});
