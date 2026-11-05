import type { Rect, Tile } from '@ie/contracts';
import { extractRegion, type Rgba } from '@ie/slicer';
import sharp from 'sharp';

const CHANNELS = 4;

/** Aspect mismatches smaller than this (0.5%) are treated as rounding, not as a different shape. */
const ASPECT_TOLERANCE = 0.005;

export interface NormalizedTile {
  /** The provider output at exactly the tile's `send` size. */
  image: Rgba;
  /** True when the output had a different shape and was centre-cropped (never stretched) to match. */
  croppedToAspect: boolean;
}

/**
 * Returns a provider output to tile geometry: uniformly scaled to the `send` rect size. If the output
 * came back with a different aspect ratio it is centre-cropped to the right shape first, so
 * nothing is ever stretched non-uniformly.
 */
export async function normalizeTile(output: Rgba, send: Pick<Rect, 'width' | 'height'>): Promise<NormalizedTile> {
  const sendAspect = send.width / send.height;
  const outputAspect = output.width / output.height;

  let source = output;
  let croppedToAspect = false;
  if (Math.abs(outputAspect / sendAspect - 1) > ASPECT_TOLERANCE) {
    // Keep the whole of the shorter side, trim the longer one equally on both ends.
    const width = outputAspect > sendAspect ? Math.max(1, Math.round(output.height * sendAspect)) : output.width;
    const height = outputAspect > sendAspect ? output.height : Math.max(1, Math.round(output.width / sendAspect));
    const region: Rect = { x: Math.floor((output.width - width) / 2), y: Math.floor((output.height - height) / 2), width, height };
    source = { data: extractRegion(output, region, false), width, height };
    croppedToAspect = true;
  }

  if (source.width === send.width && source.height === send.height) return { image: source, croppedToAspect };

  const { data, info } = await sharp(source.data, { raw: { width: source.width, height: source.height, channels: CHANNELS } })
    .resize(send.width, send.height, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { image: { data, width: info.width, height: info.height }, croppedToAspect };
}

/** Drops the context padding: cuts the tile's `crop` region out of an image of its `send` size. */
export function cropToCrop(image: Rgba, tile: Pick<Tile, 'crop' | 'send'>): Rgba {
  const region: Rect = {
    x: tile.crop.x - tile.send.x,
    y: tile.crop.y - tile.send.y,
    width: tile.crop.width,
    height: tile.crop.height,
  };
  if (
    image.width !== tile.send.width ||
    image.height !== tile.send.height ||
    region.x < 0 ||
    region.y < 0 ||
    region.x + region.width > image.width ||
    region.y + region.height > image.height
  ) {
    throw new RangeError('The image must have the tile\'s send size, and the crop must lie inside it.');
  }
  return { data: extractRegion(image, region, false), width: region.width, height: region.height };
}
