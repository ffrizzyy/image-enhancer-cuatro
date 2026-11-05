import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { ImageAssetSchema, type ImageAsset } from '@ie/contracts';
import sharp from 'sharp';
import { ulid } from 'ulid';

import { IntakeError, type ImportLimits } from './types';
import {
  assertSupportedFormat,
  assertWithinByteLimit,
  assertWithinDimensionLimit,
  DEFAULT_LIMITS,
  detectFormat,
  orientedSize,
} from './validate';

export interface ImportOptions {
  limits?: Partial<ImportLimits>;
  newId?: () => string;
}

/**
 * Validates an image file and returns a frozen `ImageAsset`. The file is only read.
 * `width`/`height` are the display size after EXIF orientation; consumers must call
 * `sharp(path).rotate()` (or equivalent) to read pixels in that orientation.
 */
export async function importImage(filePath: string, options: ImportOptions = {}): Promise<ImageAsset> {
  const limits: ImportLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const absolute = path.resolve(filePath);

  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new IntakeError('file-not-found', `File not found: ${absolute}`);
  }
  if (!info.isFile()) throw new IntakeError('not-a-file', `Not a file: ${absolute}`);
  assertWithinByteLimit(info.size, limits);

  const bytes = await readFile(absolute);
  assertSupportedFormat(detectFormat(bytes));

  let width: number;
  let height: number;
  try {
    // A full (shrink-on-load) decode, so truncated or garbage bodies fail here and not mid-job.
    const image = sharp(bytes, { failOn: 'error' });
    const meta = await image.metadata();
    if (!meta.width || !meta.height) throw new Error('no dimensions');
    await image.clone().rotate().resize(16, 16, { fit: 'inside' }).toBuffer();
    ({ width, height } = orientedSize(meta.width, meta.height, meta.orientation));
  } catch {
    throw new IntakeError('corrupt-image', 'The image could not be decoded; the file may be damaged.');
  }
  assertWithinDimensionLimit(width, height, limits);

  const asset: ImageAsset = ImageAssetSchema.parse({
    id: (options.newId ?? ulid)(),
    path: absolute,
    width,
    height,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  return Object.freeze(asset);
}
