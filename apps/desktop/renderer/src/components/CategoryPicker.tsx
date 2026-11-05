import type { Category, CategoryFamily } from '@ie/contracts';

import { FAMILY_LABELS, FAMILY_ORDER, FIDELITY_LABELS } from '../labels';

interface CategoryPickerProps {
  categories: readonly Category[];
  /** The resolved category: chosen by hand, or detected when Auto is selected. */
  resolvedId: string | null;
  autoSelected: boolean;
  onSelect: (id: string) => void;
  onSelectAuto: () => void;
}

const AUTO_EXPLANATION = 'Looks at your image and prompt, then suggests the best category. You can override it.';

function groupByFamily(categories: readonly Category[]): Array<[CategoryFamily, Category[]]> {
  return FAMILY_ORDER.map((family): [CategoryFamily, Category[]] => [
    family,
    categories.filter((c) => c.family === family),
  ]).filter(([, members]) => members.length > 0);
}

export function CategoryPicker({ categories, resolvedId, autoSelected, onSelect, onSelectAuto }: CategoryPickerProps) {
  const resolved = categories.find((c) => c.id === resolvedId);

  return (
    <fieldset>
      <legend className="mb-2 text-lg font-medium">Category</legend>
      <div className="space-y-4">
        {groupByFamily(categories).map(([family, members]) => (
          <fieldset key={family}>
            <legend className="mb-1 text-sm font-semibold text-slate-700">{FAMILY_LABELS[family]}</legend>
            <ul className="grid gap-2 sm:grid-cols-2">
              {members.map((category) => {
                const isAuto = category.kind === 'auto';
                return (
                  <li key={category.id}>
                    <label className="flex cursor-pointer gap-2 rounded border border-slate-200 p-2 text-sm has-[:checked]:border-slate-900 has-[:checked]:bg-slate-50">
                      <input
                        type="radio"
                        name="category"
                        value={category.id}
                        checked={isAuto ? autoSelected : !autoSelected && category.id === resolvedId}
                        onChange={() => (isAuto ? onSelectAuto() : onSelect(category.id))}
                        className="mt-1"
                      />
                      <span>
                        <span className="block font-medium">{category.name}</span>
                        <span className="block text-slate-600">{isAuto ? AUTO_EXPLANATION : category.defaultPrompt}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        ))}
      </div>

      {resolved && resolved.kind === 'prompt' && (
        <div data-testid="category-details" className="mt-3 rounded bg-slate-50 p-3 text-sm">
          <p>
            <strong>{resolved.name}</strong> &middot; {FIDELITY_LABELS[resolved.fidelity]}
          </p>
          <p className="text-slate-600">
            Default grid {resolved.defaults.grid[1]}×{resolved.defaults.grid[0]} tiles, {resolved.defaults.overlapPct}%
            overlap
          </p>
          {resolved.warnings.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-amber-800">
              {resolved.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </fieldset>
  );
}
