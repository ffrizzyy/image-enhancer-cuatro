import { useMemo } from 'react';

import { gridErrors, promptError, startBlockReason } from '../draft';
import { useShellStore } from '../store';

/** Derived, read-only view of the Setup draft; all rules live in `draft.ts`. */
export function useJobDraft() {
  const draft = useShellStore((s) => s.draft);
  const categories = useShellStore((s) => s.categories);
  const providers = useShellStore((s) => s.providers);
  const asset = useShellStore((s) => s.asset);
  const detection = useShellStore((s) => s.detection);

  return useMemo(() => {
    const category = categories.find((c) => c.id === draft.categoryId);
    return {
      draft,
      category,
      detection,
      promptError: promptError(draft.prompt),
      gridErrors: gridErrors(draft),
      blockReason: startBlockReason(draft, { asset, providers, detecting: detection.status === 'loading' }),
      showReset: category?.defaultPrompt !== undefined && draft.prompt !== category.defaultPrompt,
    };
  }, [draft, categories, providers, asset, detection]);
}
