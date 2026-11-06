import { CategorySchema, type Category } from '@ie/contracts';

import { applyOverride, OverrideError, resetOverride, saveOverride, type CategoryOverride } from './overrides';
import auto from './catalog/auto.json';
import architectureInterior from './catalog/architecture-interior.json';
import charRealistic from './catalog/char-realistic.json';
import charStylized from './catalog/char-stylized.json';
import creatureRealistic from './catalog/creature-realistic.json';
import creatureStylized from './catalog/creature-stylized.json';
import custom from './catalog/custom.json';
import envRealistic from './catalog/env-realistic.json';
import envStylized from './catalog/env-stylized.json';
import iconUi from './catalog/icon-ui.json';
import isometricAsset from './catalog/isometric-asset.json';
import landscapeMatte from './catalog/landscape-matte.json';
import lineartToRender from './catalog/lineart-to-render.json';
import photoRestore from './catalog/photo-restore.json';
import pixelArt from './catalog/pixel-art.json';
import productStill from './catalog/product-still.json';
import propsRealistic from './catalog/props-realistic.json';
import propsStylized from './catalog/props-stylized.json';
import textureMaterial from './catalog/texture-material.json';
import vehicleHardsurface from './catalog/vehicle-hardsurface.json';

// Spec-table order, with the `auto` meta-category first. Parsed once at load: a malformed shipped
// file fails fast rather than at first use.
const CATALOG: readonly Category[] = [
  auto,
  envRealistic,
  envStylized,
  propsRealistic,
  propsStylized,
  charRealistic,
  charStylized,
  creatureRealistic,
  creatureStylized,
  vehicleHardsurface,
  architectureInterior,
  landscapeMatte,
  textureMaterial,
  photoRestore,
  lineartToRender,
  pixelArt,
  productStill,
  isometricAsset,
  iconUi,
  custom,
].map((entry) => CategorySchema.parse(entry));

/** Categories as the app uses them: the shipped catalog with the person's overrides (template, default prompt) applied. */
export function listCategories(): Category[] {
  return CATALOG.map((category) => structuredClone(applyOverride(category)));
}

export function getCategory(id: string): Category | undefined {
  const found = CATALOG.find((category) => category.id === id);
  return found ? structuredClone(applyOverride(found)) : undefined;
}

/** The category exactly as shipped, ignoring any override (for the editor's "reset" view). */
export function getShippedCategory(id: string): Category | undefined {
  const found = CATALOG.find((category) => category.id === id);
  return found ? structuredClone(found) : undefined;
}

/** Saves an override for a category, validated first. Throws `OverrideError` with a plain message. */
export function saveCategoryOverride(id: string, patch: CategoryOverride): Category {
  const shipped = getShippedCategory(id);
  if (!shipped) throw new OverrideError('That category does not exist.');
  return saveOverride(shipped, patch);
}

/** Removes the override and returns the shipped category. */
export function resetCategoryOverride(id: string): Category {
  const shipped = getShippedCategory(id);
  if (!shipped) throw new OverrideError('That category does not exist.');
  resetOverride(id);
  return shipped;
}

export { configureOverrides, listOverriddenIds, OverrideError } from './overrides';
export type { CategoryOverride } from './overrides';
export { AutoCategoryError, buildPrompt, describeTile, FIDELITY_CLAUSES, PLACEHOLDERS, validateTemplate } from './buildPrompt';
export type { TileInfo, TilePrompt } from './buildPrompt';
export { suggestCategory, SUGGESTION_THRESHOLD } from './suggestCategory';
export { validateCatalogDir } from './validateCatalog';
export type { CatalogReport } from './validateCatalog';
