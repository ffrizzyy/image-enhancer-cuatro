import { useState, type ReactNode } from 'react';

type ViewMode = 'split' | 'original' | 'enhanced';

interface CompareSliderProps {
  before: { src: string; alt: string };
  after: { src: string; alt: string };
  /** The picture's real size, used so the comparison keeps its shape at any zoom. */
  width: number;
  height: number;
  /** How much of the picture to show, where 1 fits it to the panel. */
  zoom: number;
  /** Drawn over both sides, for example the seam overlay. */
  overlay?: ReactNode;
}

const MODE_LABELS: Record<ViewMode, string> = {
  split: 'Split',
  original: 'Original only',
  enhanced: 'Enhanced only',
};

/**
 * The original and the stitched picture, either side by side with a slider between them or one at a time. The slider
 * is a real range input, so it works with the mouse and from the keyboard (arrows, Home and End) and is announced.
 * The single-picture modes make small differences easy to inspect without a divider in the way.
 */
export function CompareSlider({ before, after, width, height, zoom, overlay }: CompareSliderProps) {
  const [position, setPosition] = useState(50);
  const [mode, setMode] = useState<ViewMode>('split');

  return (
    <figure className="space-y-2">
      <div data-testid="compare-viewport" className="max-h-[70vh] overflow-auto rounded border border-slate-300 bg-slate-200">
        <div
          data-testid="compare-frame"
          className="relative mx-auto"
          style={{ width: `${zoom * 100}%`, aspectRatio: `${width} / ${height}` }}
        >
          {mode !== 'enhanced' && <img src={before.src} alt={before.alt} className="absolute inset-0 h-full w-full object-fill" draggable={false} />}
          {mode !== 'original' && (
            <img
              data-testid="compare-after"
              src={after.src}
              alt={after.alt}
              className="absolute inset-0 h-full w-full object-fill"
              style={mode === 'split' ? { clipPath: `inset(0 0 0 ${position}%)` } : undefined}
              draggable={false}
            />
          )}
          {overlay}
          {mode === 'split' && (
            <div aria-hidden="true" data-testid="compare-divider" className="absolute inset-y-0 w-0.5 bg-white shadow" style={{ left: `${position}%` }} />
          )}
          <span
            data-testid="compare-before-label"
            className={`pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs font-medium text-white ${mode === 'enhanced' ? 'hidden' : ''}`}
          >
            Original
          </span>
          <span
            data-testid="compare-after-label"
            className={`pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs font-medium text-white ${mode === 'original' ? 'hidden' : ''}`}
          >
            Enhanced
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="Picture view mode">
        {(Object.keys(MODE_LABELS) as ViewMode[]).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
            className={`rounded border px-2 py-0.5 ${mode === value ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-500 bg-white'}`}
          >
            {MODE_LABELS[value]}
          </button>
        ))}
      </div>

      {mode === 'split' ? (
        <div className="flex items-center gap-2 text-sm">
          <label htmlFor="compare-position">Compare before and after</label>
          <input
            id="compare-position"
            type="range"
            min={0}
            max={100}
            step={1}
            value={position}
            aria-valuetext={`${position}% of the original shown`}
            onChange={(event) => setPosition(Number(event.currentTarget.value))}
            onKeyDown={(event) => {
              // Handle the keys here as well as in the browser's range control, so the comparison always moves by a
              // predictable step and the picture follows immediately.
              const step = event.key === 'PageUp' || event.key === 'PageDown' ? 10 : 1;
              const next =
                event.key === 'ArrowLeft' || event.key === 'ArrowDown' || event.key === 'PageDown'
                  ? position - step
                  : event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'PageUp'
                    ? position + step
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? 100
                        : null;
              if (next === null) return;
              event.preventDefault();
              setPosition(Math.min(100, Math.max(0, next)));
            }}
            className="w-64"
          />
          <span aria-hidden="true" className="tabular-nums text-slate-700">
            {position}%
          </span>
        </div>
      ) : (
        <p className="text-sm text-slate-700">
          Showing the {mode === 'original' ? 'original' : 'enhanced'} picture at {Math.round(zoom * 100)}%.{' '}
          <button type="button" className="underline" onClick={() => setMode('split')}>
            Back to the comparison
          </button>
        </p>
      )}
      <figcaption className="text-xs text-slate-700">
        The <strong>Original</strong> is your imported picture; the <strong>Enhanced</strong> picture is the one put together from the
        enhanced tiles. Zoom in and switch to Original or Enhanced only to see small changes clearly.
      </figcaption>
    </figure>
  );
}
