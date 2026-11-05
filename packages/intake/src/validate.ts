import { IntakeError, type ImportLimits } from './types';

export const MAX_BYTES = 50 * 1024 * 1024;
export const MAX_DIMENSION = 8192;
export const DEFAULT_LIMITS: ImportLimits = { maxBytes: MAX_BYTES, maxDimension: MAX_DIMENSION };

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'svg' | 'unknown';

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  signature.every((value, i) => bytes[offset + i] === value);

/** Identifies the format from content, never from the file extension. */
export function detectFormat(bytes: Uint8Array): ImageFormat {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  // "RIFF" .... "WEBP"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif';

  const head = Buffer.from(bytes.subarray(0, 1024)).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return 'unknown';
}

export function assertSupportedFormat(format: ImageFormat): asserts format is 'png' | 'jpeg' | 'webp' {
  switch (format) {
    case 'png':
    case 'jpeg':
    case 'webp':
      return;
    case 'gif':
      throw new IntakeError('unsupported-gif', 'GIF images are not supported. Use PNG, JPEG or WebP.');
    case 'svg':
      throw new IntakeError('unsupported-svg', 'SVG images are not supported. Export a PNG, JPEG or WebP instead.');
    case 'unknown':
      throw new IntakeError('unsupported-format', 'This file is not a PNG, JPEG or WebP image.');
  }
}

export function assertWithinByteLimit(bytes: number, { maxBytes }: ImportLimits): void {
  if (bytes > maxBytes) {
    throw new IntakeError(
      'file-too-large',
      `The file is ${(bytes / 1024 / 1024).toFixed(1)} MB; the limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`,
    );
  }
}

export function assertWithinDimensionLimit(width: number, height: number, { maxDimension }: ImportLimits): void {
  if (width > maxDimension || height > maxDimension) {
    throw new IntakeError(
      'dimensions-exceeded',
      `The image is ${width}×${height}px; the limit is ${maxDimension}px per side.`,
    );
  }
}

/** EXIF orientations 5–8 are rotated by 90°, so width and height swap. */
export function orientedSize(
  width: number,
  height: number,
  orientation: number | undefined,
): { width: number; height: number } {
  return orientation !== undefined && orientation >= 5 && orientation <= 8
    ? { width: height, height: width }
    : { width, height };
}
