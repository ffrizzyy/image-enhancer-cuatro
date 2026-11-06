import { useEffect, useState } from 'react';

import type { ExportFormat } from '@ie/contracts';

import { CompareSlider } from '../components/CompareSlider';
import { FlaggedTiles } from '../components/FlaggedTiles';
import { QualityBadge } from '../components/QualityBadge';
import { SeamOverlay } from '../components/SeamOverlay';
import { useTileActions } from '../hooks/useTileActions';
import { ipc } from '../ipc';
import { JOB_STATE_LABELS, TILE_STATE_LABELS } from '../labels';
import { useShellStore } from '../store';

const MAX_ZOOM = 4;
const ZOOM_STEP = 0.5;

type SaveState =
  | { status: 'idle' }
  | { status: 'saved'; path: string; width: number; height: number }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

/**
 * The finished picture against the original. It loads the stitched file and metrics over IPC; the rest of the screen
 * stays usable while that happens. A re-stitch (after a tile is fixed) replaces the picture in place, without
 * restarting the job.
 */
export function Result() {
  const activeJobId = useShellStore((s) => s.activeJobId);
  const progress = useShellStore((s) => (s.activeJobId ? s.progress[s.activeJobId] : undefined));
  const resultState = useShellStore((s) => s.result);
  const loadResult = useShellStore((s) => s.loadResult);
  const navigate = useShellStore((s) => s.navigate);
  const actions = useTileActions(activeJobId ?? '');
  const [zoom, setZoom] = useState(1);
  const [showSeams, setShowSeams] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const [format, setFormat] = useState<ExportFormat>('png');
  const [quality, setQuality] = useState(92);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });

  const done = progress?.state === 'done';
  const stitchedAt = progress?.result?.stitchedAt ?? null;

  // Load the picture when this job is done, and again whenever a re-stitch gives it a new timestamp. The guard means
  // an unchanged result is never fetched twice, and leaving the screen never loses what is already shown.
  useEffect(() => {
    if (!activeJobId || !done) return;
    const current = useShellStore.getState().result;
    const fresh = current.status === 'ok' && current.jobId === activeJobId && (stitchedAt === null || current.result.stitchedAt === stitchedAt);
    if (fresh) return;
    void loadResult(activeJobId);
  }, [activeJobId, done, stitchedAt, loadResult]);

  if (!activeJobId) {
    return (
      <div className="space-y-2">
        <p>No job yet. Set one up and press Start.</p>
        <button type="button" className="rounded border border-slate-500 bg-white px-3 py-1" onClick={() => navigate('setup')}>
          Set up a picture
        </button>
      </div>
    );
  }

  const view = resultState.status === 'ok' && resultState.jobId === activeJobId ? resultState.result : null;
  const loading = resultState.status === 'loading' && resultState.jobId === activeJobId;
  const loadError = resultState.status === 'error' && resultState.jobId === activeJobId ? resultState.message : null;
  const flagged = view?.flagged ?? progress?.result?.flagged ?? [];

  const save = async (): Promise<void> => {
    if (!view) return;
    setSaving(true);
    setSaveState({ status: 'idle' });
    try {
      const response = await ipc.export.save({
        imagePath: view.imagePath,
        format,
        ...(format === 'png' ? {} : { quality }),
      });
      if (response.ok) {
        setSaveState({ status: 'saved', path: response.value.path, width: response.value.width, height: response.value.height });
      } else if (response.error.code === 'cancelled') {
        setSaveState({ status: 'cancelled' });
      } else {
        setSaveState({ status: 'error', message: response.error.message });
      }
    } catch (error) {
      setSaveState({ status: 'error', message: `The picture could not be saved: ${String(error)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div data-testid="result-summary" className="space-y-1 text-sm">
        <p>
          Job <strong>{activeJobId}</strong>
          {progress && <> &middot; {JOB_STATE_LABELS[progress.state]}</>}
        </p>
        {view && <p>{flagged.length === 0 ? 'No tiles flagged.' : `${flagged.length} tile${flagged.length === 1 ? '' : 's'} flagged.`}</p>}
        {progress && progress.state !== 'done' && view && <p role="status">The picture shown is from the last time it was put together.</p>}
      </div>

      {loadError && (
        <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {loadError}
        </p>
      )}

      {!view && !loadError && (loading || done || !progress) && (
        <p role="status" className="text-sm">
          Loading the picture…
        </p>
      )}
      {!view && !loadError && !loading && progress && !done && (
        <p role="status" className="text-sm">
          This job has not finished yet. The picture will appear here when it has.
        </p>
      )}

      {view && (
        <>
          <QualityBadge seamScore={view.metrics.seamScore} maxDeltaE={view.metrics.maxDeltaE} flaggedCount={view.flagged.length} />

          <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="Picture view">
            <button type="button" className="rounded border border-slate-500 bg-white px-2 py-0.5" aria-label="Zoom in" disabled={zoom >= MAX_ZOOM} onClick={() => setZoom((value) => Math.min(MAX_ZOOM, value + ZOOM_STEP))}>
              Zoom in
            </button>
            <button type="button" className="rounded border border-slate-500 bg-white px-2 py-0.5" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom((value) => Math.max(1, value - ZOOM_STEP))}>
              Zoom out
            </button>
            <button type="button" className="rounded border border-slate-500 bg-white px-2 py-0.5" aria-label="Reset zoom" disabled={zoom === 1} onClick={() => setZoom(1)}>
              Reset zoom
            </button>
            <span aria-live="polite" className="tabular-nums text-slate-700">
              Zoom {Math.round(zoom * 100)}%
            </span>
            <label className="ml-2 inline-flex items-center gap-1">
              <input type="checkbox" checked={showSeams} onChange={(event) => setShowSeams(event.currentTarget.checked)} />
              Show seam overlay
            </label>
          </div>

          <CompareSlider
            before={{ src: view.sourcePreview.dataUrl, alt: 'The original picture' }}
            after={{ src: view.preview.dataUrl, alt: 'The stitched picture' }}
            width={view.width}
            height={view.height}
            zoom={zoom}
            overlay={showSeams ? <SeamOverlay plan={view.plan} /> : null}
          />

          <section aria-labelledby="save-title" data-testid="save-panel" className="space-y-2 rounded border border-slate-300 bg-white p-3 text-sm">
            <h2 id="save-title" className="text-lg font-medium">
              Save the picture
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="export-format">Format</label>
              <select
                id="export-format"
                value={format}
                onChange={(event) => {
                  setFormat(event.currentTarget.value as ExportFormat);
                  setSaveState({ status: 'idle' });
                }}
                className="rounded border border-slate-400 bg-white px-2 py-0.5"
              >
                <option value="png">PNG (lossless)</option>
                <option value="jpeg">JPEG</option>
                <option value="webp">WebP</option>
              </select>
              {format !== 'png' && (
                <>
                  <label htmlFor="export-quality">Quality</label>
                  <input
                    id="export-quality"
                    type="range"
                    min={1}
                    max={100}
                    value={quality}
                    aria-valuetext={`${quality}%`}
                    onChange={(event) => {
                      setQuality(Number(event.currentTarget.value));
                      setSaveState({ status: 'idle' });
                    }}
                    className="w-40"
                  />
                  <span aria-hidden="true" className="tabular-nums text-slate-700">
                    {quality}%
                  </span>
                </>
              )}
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="rounded border border-slate-900 bg-slate-900 px-3 py-1 font-medium text-white disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save the picture'}
              </button>
            </div>
            <p className="text-xs text-slate-700">Choose where to save it. The saved file keeps the picture's full size.</p>
            {saveState.status === 'saved' && (
              <p role="status" className="text-green-800">
                Saved to {saveState.path} ({saveState.width} × {saveState.height}).
              </p>
            )}
            {saveState.status === 'cancelled' && (
              <p role="status" className="text-slate-700">
                Saving was cancelled.
              </p>
            )}
            {saveState.status === 'error' && (
              <p role="alert" className="text-red-800">
                {saveState.message}
              </p>
            )}
          </section>

          {progress && (
            <FlaggedTiles jobId={activeJobId} progress={progress} result={view} selected={selected} onSelect={setSelected} actions={actions} />
          )}

          <section aria-labelledby="tile-map-title" data-testid="tile-map" className="space-y-2">
            <h2 id="tile-map-title" className="text-lg font-medium">
              Tiles
            </h2>
            <ul aria-label="Tile map" className="grid gap-1" style={{ gridTemplateColumns: `repeat(${view.plan.grid.cols}, minmax(0, 1fr))` }}>
              {view.plan.tiles.map((tile) => {
                const current = progress?.tiles.find((t) => t.index === tile.index);
                const state = current ? TILE_STATE_LABELS[current.state] : null;
                const isFlagged = view.flagged.includes(tile.index);
                return (
                  <li key={tile.index}>
                    <button
                      type="button"
                      id={`result-tile-${tile.index}`}
                      data-testid={`result-tile-map-${tile.index}`}
                      aria-current={selected === tile.index ? 'true' : undefined}
                      onClick={() => setSelected(tile.index)}
                      className={`w-full rounded border px-2 py-1 text-left text-xs ${selected === tile.index ? 'border-slate-900 bg-slate-200' : isFlagged ? 'border-orange-500 bg-orange-50' : 'border-slate-300 bg-white'}`}
                    >
                      Tile {tile.index + 1}
                      <span className="sr-only">
                        {state ? `: ${state.label}` : ''}
                        {isFlagged ? ', flagged by the stitcher' : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
