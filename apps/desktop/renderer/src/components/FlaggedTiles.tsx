import type { JobProgress, JobResultView } from '@ie/contracts';
import { useState } from 'react';

import { ipc } from '../ipc';
import { TILE_STATE_LABELS } from '../labels';
import type { TileActions } from '../hooks/useTileActions';

interface FlaggedTilesProps {
  jobId: string;
  progress: JobProgress;
  result: JobResultView;
  /** The tile shown in the tile map, so a flagged tile can point at it. */
  selected: number | null;
  onSelect: (index: number) => void;
  actions: TileActions;
}

interface FlaggedRowProps {
  index: number;
  progress: JobProgress;
  actions: TileActions;
  selected: boolean;
  onSelect: (index: number) => void;
}

function pendingLabel(action: 'accept' | 'rerun' | 'override', index: number): string {
  const number = index + 1;
  if (action === 'accept') return `Keeping tile ${number} as it is…`;
  if (action === 'rerun') return `Asking the provider for tile ${number} again…`;
  return `Saving tile ${number} and asking for it again…`;
}

function FlaggedTileRow({ index, progress, actions, selected, onSelect }: FlaggedRowProps) {
  const tile = progress.tiles.find((t) => t.index === index);
  const state = actions.stateFor(index);
  const busy = state.status === 'pending';
  const running = tile?.state === 'running';
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(tile?.promptOverride ?? '');
  const [sourcePath, setSourcePath] = useState<string | null | undefined>(undefined);
  const [fileError, setFileError] = useState<string | null>(null);

  const reason = tile?.note ?? 'The stitcher was not confident that this tile lined up with its neighbours.';
  const stateLabel = tile ? TILE_STATE_LABELS[tile.state].label : 'Not known';

  const chooseSource = (file: File | undefined) => {
    if (!file) return;
    const path = ipc.files.pathFor(file);
    if (!path) {
      setFileError('Could not read the location of that picture. Choose it again.');
      return;
    }
    setFileError(null);
    setSourcePath(path);
  };

  const saveAndRerun = async () => {
    const patch = { prompt, ...(sourcePath !== undefined ? { sourcePath } : {}) };
    const ok = await actions.saveAndRerun(index, patch);
    if (ok) {
      setEditing(false);
      setSourcePath(undefined);
    }
  };

  return (
    <li data-testid={`flagged-tile-${index}`} aria-current={selected ? 'true' : undefined} className={`rounded border p-3 text-sm ${selected ? 'border-slate-900 bg-slate-100' : 'border-slate-300'}`}>
      <div className="space-y-1">
        <p className="font-medium">
          Tile {index + 1} <span className="font-normal text-slate-700">· {stateLabel}</span>
        </p>
        <p className="text-slate-700">{reason}</p>
        {tile?.promptOverride && <p className="text-xs text-slate-700">It has its own prompt for the next run.</p>}
        {tile?.sourceOverride && <p className="text-xs text-slate-700">It uses its own picture instead of its slice of the original.</p>}
      </div>

      <div role="group" aria-label={`Actions for tile ${index + 1}`} className="mt-2 flex flex-wrap gap-1">
        <button type="button" className="rounded border border-slate-500 bg-white px-2 py-0.5 text-xs" onClick={() => onSelect(index)} aria-label={`Show tile ${index + 1} in the tile map`}>
          Show in tile map
        </button>
        {tile?.state === 'needs-review' && tile.outputPath && (
          <button type="button" className="rounded border border-slate-500 bg-white px-2 py-0.5 text-xs" disabled={busy} onClick={() => void actions.accept(index)} aria-label={`Accept tile ${index + 1} as it is`}>
            Accept as is
          </button>
        )}
        <button type="button" className="rounded border border-slate-500 bg-white px-2 py-0.5 text-xs" disabled={busy || running} onClick={() => void actions.rerun(index)} aria-label={`Try tile ${index + 1} again`}>
          Try again
        </button>
        <button
          type="button"
          className="rounded border border-slate-500 bg-white px-2 py-0.5 text-xs"
          disabled={busy || running}
          aria-expanded={editing}
          aria-controls={`tile-${index}-edit`}
          onClick={() => setEditing((open) => !open)}
        >
          {editing ? 'Close' : 'Change prompt or picture'}
        </button>
      </div>

      {editing && (
        <form
          id={`tile-${index}-edit`}
          className="mt-2 space-y-2 rounded border border-slate-300 bg-white p-2"
          onSubmit={(event) => {
            event.preventDefault();
            void saveAndRerun();
          }}
        >
          <div>
            <label htmlFor={`tile-${index}-prompt`} className="block font-medium">
              Tile {index + 1} prompt
            </label>
            <textarea
              id={`tile-${index}-prompt`}
              value={prompt}
              rows={3}
              className="mt-1 w-full rounded border border-slate-400 p-1"
              placeholder={progress.prompt ?? 'The job’s prompt'}
              onChange={(event) => setPrompt(event.currentTarget.value)}
            />
            <p className="text-xs text-slate-700">Leave this empty to use the job’s prompt.</p>
          </div>
          <div>
            <label htmlFor={`tile-${index}-source`} className="block font-medium">
              A different picture for tile {index + 1} (optional)
            </label>
            <input
              id={`tile-${index}-source`}
              type="file"
              accept="image/*"
              className="mt-1 block text-xs"
              onChange={(event) => chooseSource(event.currentTarget.files?.[0])}
            />
            {sourcePath && <p className="text-xs text-slate-700">Chosen: {sourcePath}</p>}
            {fileError && (
              <p role="alert" className="text-xs text-red-800">
                {fileError}
              </p>
            )}
            {tile?.sourceOverride && (
              <button
                type="button"
                className="mt-1 rounded border border-slate-500 bg-white px-2 py-0.5 text-xs"
                onClick={() => {
                  setSourcePath(null);
                  setFileError(null);
                }}
              >
                Use its slice of the original again
              </button>
            )}
          </div>
          <button type="submit" className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-50" disabled={busy}>
            Save and try again
          </button>
        </form>
      )}

      {state.status === 'pending' && (
        <p role="status" className="mt-2 text-xs text-slate-700">
          {pendingLabel(state.action, index)}
        </p>
      )}
      {state.status === 'success' && (
        <p role="status" className="mt-2 text-xs text-green-800">
          {state.message}
        </p>
      )}
      {state.status === 'error' && (
        <p role="alert" className="mt-2 text-xs text-red-800">
          {state.message}
        </p>
      )}
    </li>
  );
}

/**
 * The tiles the stitcher flagged, each with why it is flagged, what state it is in now, and the actions that can fix
 * it. Every action goes through the main process; the row says whether it is still working, worked, or failed.
 */
export function FlaggedTiles({ progress, result, selected, onSelect, actions }: FlaggedTilesProps) {
  return (
    <section aria-labelledby="flagged-title" data-testid="flagged-tiles" className="space-y-2">
      <h2 id="flagged-title" className="text-lg font-medium">
        Flagged tiles
      </h2>
      {result.flagged.length === 0 ? (
        <p className="text-sm text-slate-700">No tiles were flagged. The seams were clean enough that none needed a closer look.</p>
      ) : (
        <>
          <p className="text-sm text-slate-700">
            {result.flagged.length} tile{result.flagged.length === 1 ? ' was' : 's were'} flagged while the picture was put together. Fix one here and the picture is put
            together again without restarting the job.
          </p>
          <ul aria-label="Flagged tiles" className="space-y-2">
            {result.flagged.map((index) => (
              <FlaggedTileRow key={index} index={index} progress={progress} actions={actions} selected={selected === index} onSelect={onSelect} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
