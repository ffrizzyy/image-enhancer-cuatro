import type { ExportFormat, ExportResult } from '@ie/contracts';
import sharp from 'sharp';

export interface ExportImageRequest {
  /** The stitched picture to write. */
  imagePath: string;
  /** The file to write, already chosen by the user. */
  destination: string;
  format: ExportFormat;
  /** 1–100, used by JPEG and WebP. Defaults to a high-quality 92. */
  quality?: number;
}

const DEFAULT_QUALITY = 92;

/**
 * Writes a copy of the stitched picture in the chosen format, at its full size. The source is never modified: this is
 * the last step, taking the picture out of the app.
 */
export async function exportImage({ imagePath, destination, format, quality = DEFAULT_QUALITY }: ExportImageRequest): Promise<ExportResult> {
  let image = sharp(imagePath);

  if (format === 'jpeg') {
    // JPEG has no alpha channel: flatten transparent pixels onto white instead of letting them turn black.
    image = image.flatten({ background: '#ffffff' }).jpeg({ quality, chromaSubsampling: '4:4:4' });
  } else if (format === 'webp') {
    image = image.webp({ quality });
  } else {
    image = image.png({ compressionLevel: 9 });
  }

  const info = await image.toFile(destination);
  return { path: destination, width: info.width, height: info.height };
}
