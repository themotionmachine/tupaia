import assert from "node:assert/strict";
import fs from "node:fs";
import {test} from "node:test";
const settings = fs.readFileSync(new URL("../src/bridge-ext/settings.js", import.meta.url), "utf8");
const helper = settings.slice(settings.indexOf("  async function seededRandom("), settings.indexOf("  /** Cells of the biomes"));
const reportSource = settings.slice(settings.indexOf("  async function replacesReport("), settings.indexOf("  /**\n   * The app's own"));

test("seeded RNG remains scoped until asynchronous generation settles and restores after rejection", async () => {
  const original = () => 0.5;
  const math = {imul: Math.imul, random: original};
  const scoped = new Function("seed", "Math", `${helper}; return seededRandom;`)("7319", math);
  let complete!: () => void;
  const values: number[] = [];
  const pending = scoped("recalc", async () => {
    values.push(math.random());
    await new Promise<void>(resolve => {complete = resolve;});
    values.push(math.random());
  });
  assert.notEqual(math.random, original);
  complete(); await pending;
  assert.equal(math.random, original);
  const repeated: number[] = [];
  await scoped("recalc", async () => {repeated.push(math.random()); await Promise.resolve(); repeated.push(math.random());});
  assert.deepEqual(repeated, values);
  await assert.rejects(scoped("recalc", async () => {await Promise.resolve(); throw Error("worker failed");}), /worker failed/);
  assert.equal(math.random, original);
});
test("biome report awaits derivation and always restores live biome ownership", async () => {
  const saved = new Uint8Array([2, 4, 1]);
  const pack = {cells: {biome: saved, h: [30,30,30]}, features: [], rivers: []};
  let finish!: () => void;
  const Biomes = {
    defineAsync: async () => {await new Promise<void>(resolve => {finish = resolve;}); pack.cells.biome = new Uint8Array([1,4,1]);},
    getDefault: () => ({i: [0,1,2]})
  };
  const report = new Function("STAGES", "pack", "Biomes", `${reportSource}; return replacesReport;`)(
    {biomes: ["biomes"]}, pack, Biomes);
  const pending = report("biomes");
  assert.equal(pack.cells.biome, saved);
  finish();
  assert.deepEqual(await pending, {replaces: {biomeCellsEdited: 1}, keeps: {customBiomeCells: 1}});
  assert.equal(pack.cells.biome, saved);
  Biomes.defineAsync = async () => {pack.cells.biome = new Uint8Array([1]); throw Error("worker failure");};
  await assert.rejects(report("biomes"), /worker failure/);
  assert.equal(pack.cells.biome, saved);
});
