import sharp from 'sharp';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded noise PNG where (almost) every pixel is unique, so any misplaced pixel shows up in a diff. */
export async function noisePng(width: number, height: number, seed: number, withAlpha = false): Promise<Buffer> {
  const rand = rng(seed);
  const channels = withAlpha ? 4 : 3;
  const data = Buffer.allocUnsafe(width * height * channels);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(rand() * 256);
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}
