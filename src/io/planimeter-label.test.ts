// Upstream FMG bug (W3 LIFE3): the planimeter (area ruler) label hung the page on a horizontal, vertical or collinear
// stroke, inside libs/polylabel.min.js (polylabel 1.0, which never returns for a degenerate ring). The shipped classic
// scripts run here in a VM context with a time limit, so a hang fails the test instead of the run.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { polygonArea } from "d3";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(__dirname, "../../public", path), "utf8");

function sandbox() {
  const context = createContext({ d3: { polygonArea }, console });
  runInContext(read("libs/polylabel.min.js"), context); // UMD: sets the polylabel global
  runInContext(read("modules/ui/measurers.js"), context);
  return (code: string) => runInContext(code, context, { timeout: 2000 }) as [number, number];
}

const DEGENERATE: Record<string, number[][]> = {
  horizontal: [
    [300, 300],
    [320, 300],
    [350, 300]
  ],
  vertical: [
    [300, 300],
    [300, 320],
    [300, 350]
  ],
  collinear: [
    [300, 300],
    [320, 320],
    [340, 340]
  ],
  "one point": [
    [300, 300],
    [300, 300],
    [300, 300]
  ]
};

describe("[LIFE3] planimeter label on degenerate rings (upstream FMG bug)", () => {
  it("polylabel 1.0 itself never returns on a horizontal stroke (the bug the guard avoids)", () => {
    const run = sandbox();
    expect(() => run(`polylabel([${JSON.stringify(DEGENERATE.horizontal)}], 1.0)`)).toThrow(/timed out/);
  });

  for (const [name, points] of Object.entries(DEGENERATE))
    it(`a ${name} ring gets its bounding-box center at once`, () => {
      const [x, y] = sandbox()(`planimeterLabelPoint(${JSON.stringify(points)})`);
      const xs = points.map(p => p[0]);
      const ys = points.map(p => p[1]);
      expect([x, y]).toEqual([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]);
    });

  it("a proper ring is still labelled by polylabel (its pole of inaccessibility)", () => {
    const square = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100]
    ];
    const [x, y] = sandbox()(`planimeterLabelPoint(${JSON.stringify(square)})`);
    expect(x).toBeCloseTo(50, 0);
    expect(y).toBeCloseTo(50, 0);
  });
});
