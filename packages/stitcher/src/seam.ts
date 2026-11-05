/**
 * Finds the minimum-error top-to-bottom cut through a region by dynamic programming: one column per
 * row, moving at most one column between rows, kept at least `margin` columns from each side.
 * `energy` is the per-pixel cost of cutting there (here: how much the two images disagree).
 * Returns the cut column for each row, relative to the region.
 */
export function findSeam(energy: Float32Array, width: number, height: number, margin: number): Int32Array {
  const lo = width > 2 * margin ? margin : 0;
  const hi = width > 2 * margin ? width - 1 - margin : width - 1;
  const center = (width - 1) / 2;
  let total = 0;
  for (const e of energy) total += e;
  // A small preference for the middle keeps the cut from hugging an edge when costs tie. It scales with
  // the typical energy (1%), so it decides ties but never outweighs a real difference.
  const biasScale = 0.01 * (total / energy.length + 1);
  const centerBias = (x: number): number => biasScale * ((x - center) / Math.max(1, width)) ** 2;

  // Float64: with float32 the tiny bias is lost once the running cost gets large.
  const cost = new Float64Array(width * height);
  const from = new Int8Array(width * height);
  for (let x = lo; x <= hi; x++) cost[x] = energy[x]! + centerBias(x);

  for (let y = 1; y < height; y++) {
    for (let x = lo; x <= hi; x++) {
      let best = cost[(y - 1) * width + x]!;
      let step = 0;
      if (x > lo && cost[(y - 1) * width + x - 1]! < best) {
        best = cost[(y - 1) * width + x - 1]!;
        step = -1;
      }
      if (x < hi && cost[(y - 1) * width + x + 1]! < best) {
        best = cost[(y - 1) * width + x + 1]!;
        step = 1;
      }
      cost[y * width + x] = best + energy[y * width + x]! + centerBias(x);
      from[y * width + x] = step;
    }
  }

  const seam = new Int32Array(height);
  let x = lo;
  for (let c = lo + 1; c <= hi; c++) if (cost[(height - 1) * width + c]! < cost[(height - 1) * width + x]!) x = c;
  for (let y = height - 1; y >= 0; y--) {
    seam[y] = x;
    x += from[y * width + x]!;
  }
  return seam;
}
