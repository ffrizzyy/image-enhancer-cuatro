import { useEffect } from 'react';

import { AutoDetectCard } from '../components/AutoDetectCard';
import { CategoryPicker } from '../components/CategoryPicker';
import { GridControls } from '../components/GridControls';
import { PromptBox } from '../components/PromptBox';
import { ProviderPicker } from '../components/ProviderPicker';
import { useJobDraft } from '../hooks/useJobDraft';
import { useShellStore } from '../store';

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

export function Setup() {
  const asset = useShellStore((s) => s.asset);
  const categories = useShellStore((s) => s.categories);
  const categoriesError = useShellStore((s) => s.categoriesError);
  const providers = useShellStore((s) => s.providers);
  const starting = useShellStore((s) => s.starting);
  const startError = useShellStore((s) => s.startError);
  const store = useShellStore.getState;
  const { draft, detection, promptError, gridErrors, blockReason, showReset } = useJobDraft();

  useEffect(() => {
    if (categories.length === 0) void store().loadCategories();
  }, [categories.length, store]);

  // Auto stays selected across a new image or a reload: analyse again whenever there is no result yet.
  const needsDetection = draft.autoSelected && detection.status === 'idle' && asset !== null && categories.length > 0;
  useEffect(() => {
    if (needsDetection) void store().detectCategory();
  }, [needsDetection, store]);

  if (!asset) return <p>Import an image on Home first.</p>;

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        void store().startJob();
      }}
    >
      <p data-testid="asset-summary">
        Selected image: <strong>{baseName(asset.path)}</strong> ({asset.width}×{asset.height} px)
      </p>

      {categoriesError && (
        <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {categoriesError}
        </p>
      )}
      <CategoryPicker
        categories={categories}
        resolvedId={draft.categoryId}
        autoSelected={draft.autoSelected}
        onSelect={(id) => store().selectCategory(id)}
        onSelectAuto={() => void store().detectCategory()}
      />
      {draft.autoSelected && (
        <AutoDetectCard
          detection={detection}
          categories={categories}
          currentId={draft.categoryId}
          onRedetect={() => void store().detectCategory()}
          onUse={(id) => store().chooseAlternative(id)}
          onUseDetected={() => store().useDetected()}
        />
      )}
      <PromptBox
        value={draft.prompt}
        error={promptError}
        showReset={showReset}
        onChange={(value) => store().setPrompt(value)}
        onReset={() => store().resetPrompt()}
      />
      <GridControls
        mode={draft.gridMode}
        rows={draft.rows}
        cols={draft.cols}
        overlapPct={draft.overlapPct}
        errors={gridErrors}
        onMode={(mode) => store().setGridMode(mode)}
        onField={(field, value) => store().setGridField(field, value)}
      />
      <ProviderPicker
        selected={draft.providerId}
        statuses={providers}
        onSelect={(provider) => store().setProvider(provider)}
      />

      <div>
        <button
          type="submit"
          disabled={blockReason !== null || starting}
          aria-describedby="start-reason"
          className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {starting ? 'Starting…' : 'Start'}
        </button>
        <p id="start-reason" className="mt-2 text-sm text-slate-700">
          {blockReason ?? 'Ready to start. Nothing is sent to the provider until the run begins.'}
        </p>
        {startError && (
          <p role="alert" className="mt-2 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            {startError}
          </p>
        )}
      </div>
    </form>
  );
}
