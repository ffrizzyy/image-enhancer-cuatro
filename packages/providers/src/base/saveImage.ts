import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';

export interface SavedImage {
  imagePath: string;
  width: number;
  height: number;
}

/** Stores downloaded image bytes and reports their size. Throws if the bytes are not a decodable image. */
export type ImageSaver = (bytes: Uint8Array) => Promise<SavedImage>;

const EXTENSIONS: Record<string, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' };

/** Saves each image as `<prefix>-<n>.<ext>` (format from the content) in `dir`. */
export function createImageSaver(dir: string, prefix = 'result'): ImageSaver {
  let counter = 0;
  return async (bytes) => {
    const meta = await sharp(Buffer.from(bytes), { failOn: 'error' }).metadata();
    const ext = EXTENSIONS[meta.format ?? ''];
    if (!ext || !meta.width || !meta.height) throw new Error(`Unsupported or empty image (${meta.format ?? 'unknown'}).`);

    mkdirSync(dir, { recursive: true });
    const imagePath = path.join(dir, `${prefix}-${String(++counter).padStart(3, '0')}.${ext}`);
    writeFileSync(imagePath, bytes);
    return { imagePath, width: meta.width, height: meta.height };
  };
}
