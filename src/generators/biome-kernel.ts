export interface BiomeInput {
  heights: ArrayLike<number>;
  flux: ArrayLike<number>;
  rivers: ArrayLike<number>;
  neighbors: ArrayLike<ArrayLike<number>>;
  reference: ArrayLike<number>;
  temperature: ArrayLike<number>;
  precipitation: ArrayLike<number>;
  matrix: ArrayLike<number>[];
}
export function biomeId(
  moisture: number,
  temperature: number,
  height: number,
  river: boolean,
  matrix: ArrayLike<number>[]
): number {
  if (height < 20) return 0;
  if (temperature < -5) return 11;
  if (temperature >= 25 && !river && moisture < 8) return 1;
  if (temperature > -2 && ((moisture > 40 && height < 25) || (moisture > 24 && height > 24 && height < 60))) return 12;
  return matrix[Math.min((moisture / 5) | 0, 4)][Math.min(Math.max(20 - temperature, 0), 25)];
}
export function defineBiomes(input: BiomeInput): Uint8Array {
  const { heights, rivers, flux, neighbors, reference, temperature, precipitation, matrix } = input;
  const result = new Uint8Array(heights.length);
  for (let cell = 0; cell < heights.length; cell++) {
    let moisture = 0;
    if (heights[cell] >= 20) {
      let sum = precipitation[reference[cell]] + (rivers[cell] ? Math.max(flux[cell] / 10, 2) : 0);
      let count = 1;
      for (let index = 0; index < neighbors[cell].length; index++) {
        const neighbor = neighbors[cell][index];
        if (heights[neighbor] < 20) continue;
        sum += precipitation[reference[neighbor]];
        count++;
      }
      moisture = Math.round(4 + sum / count);
    }
    result[cell] = biomeId(moisture, temperature[reference[cell]], heights[cell], Boolean(rivers[cell]), matrix);
  }
  return result;
}
