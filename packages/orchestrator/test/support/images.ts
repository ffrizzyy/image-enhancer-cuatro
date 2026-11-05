import { writeFileSync } from 'node:fs';

import type { Rgba } from '@ie/slicer';
import sharp from 'sharp';

/** A blocky, colourful test picture with structure at several scales. Different seeds give unrelated pictures. */
export function picture(seed: number, width = 300, height = 200): Rgba {
  const data = Buffer.alloc(width * height * 4);
  let s = seed;
  const grid = Array.from({ length: 40 }, () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 24;
  });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gx = Math.floor((x * 300) / width / 30) % 10;
      const gy = Math.floor((y * 200) / height / 50) % 4;
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) data[i + c] = (grid[(gy * 10 + gx + c * 7) % 40]! + c * 20) % 256;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

/** `a` with a fraction `t` of `b` mixed in: the more of it, the less the result resembles `a`. */
export function mix(a: Rgba, b: Rgba, t: number): Rgba {
  const data = Buffer.from(a.data);
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = Math.round(a.data[i + c]! * (1 - t) + b.data[i + c]! * t);
  return { data, width: a.width, height: a.height };
}

export async function toPng(image: Rgba): Promise<Buffer> {
  return sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } }).png().toBuffer();
}

export async function writePng(image: Rgba, file: string): Promise<string> {
  writeFileSync(file, await toPng(image));
  return file;
}

export function solid(width: number, height: number, value: number): Rgba {
  const data = Buffer.alloc(width * height * 4, value);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { data, width, height };
}

export async function resized(image: Rgba, width: number, height: number): Promise<Rgba> {
  const { data, info } = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } }).resize(width, height, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
