export interface ReliefDrawContext {
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  drawImage(source: ImageBitmap, x: number, y: number, width: number, height: number): void;
}
export function drawReliefCommands(
  context: ReliefDrawContext,
  atlas: Map<number, ImageBitmap>,
  commands: Float64Array,
  ratio: number,
  x0: number,
  y0: number
): void {
  if (commands.length % 4 || !Number.isFinite(ratio) || ratio <= 0 || !Number.isFinite(x0) || !Number.isFinite(y0))
    throw new Error("Invalid relief command buffer");
  context.setTransform(ratio, 0, 0, ratio, -x0 * ratio, -y0 * ratio);
  for (let offset = 0; offset < commands.length; offset += 4) {
    const key = commands[offset],
      x = commands[offset + 1],
      y = commands[offset + 2],
      size = commands[offset + 3];
    const source = atlas.get(key);
    if (!source || !Number.isInteger(key) || ![x, y, size].every(Number.isFinite) || size <= 0)
      throw new Error("Invalid relief sprite command");
    context.drawImage(source, x - size / 2, y - size / 2, size, size);
  }
}
