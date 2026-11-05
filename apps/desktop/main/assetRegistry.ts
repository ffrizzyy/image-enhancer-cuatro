import type { ImageAsset } from '@ie/contracts';

/** In-memory record of imported assets, so `intake.createJob` can take an `assetId`. */
export interface AssetRegistry {
  add(asset: ImageAsset): void;
  get(id: string): ImageAsset | undefined;
}

export function createAssetRegistry(): AssetRegistry {
  const assets = new Map<string, ImageAsset>();
  return {
    add: (asset) => void assets.set(asset.id, asset),
    get: (id) => assets.get(id),
  };
}
