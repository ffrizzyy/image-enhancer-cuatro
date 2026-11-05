import type { TileProgress } from '@ie/contracts';

import { useTileThumbnail } from '../hooks/useTileThumbnail';
import { TILE_STATE_LABELS } from '../labels';

interface TileGridProps {
  jobId: string;
  grid: { rows: number; cols: number };
  tiles: readonly TileProgress[];
  /** When set, tiles that were set aside get Accept / Try again buttons. */
  review?: { onAccept: (index: number) => void; onRerun: (index: number) => void };
}

/** Border and background per state: a second cue next to the symbol and the word. */
const STATE_STYLE: Record<TileProgress['state'], string> = {
  pending: 'border-dashed border-slate-400 bg-slate-50',
  running: 'border-solid border-blue-600 bg-blue-50',
  accepted: 'border-solid border-green-700 bg-green-50',
  retrying: 'border-double border-4 border-amber-600 bg-amber-50',
  'needs-review': 'border-solid border-4 border-orange-600 bg-orange-50',
  failed: 'border-solid border-4 border-red-700 bg-red-50',
};

function TileCell({ jobId, tile, review }: { jobId: string; tile: TileProgress; review: TileGridProps['review'] }) {
  const thumbnail = useTileThumbnail(jobId, tile.index, tile.outputPath);
  const { label, symbol } = TILE_STATE_LABELS[tile.state];
  const tries = tile.attempts > 1 ? `, try ${tile.attempts}` : '';

  return (
    <li
      data-testid={`run-tile-${tile.index}`}
      data-state={tile.state}
      className={`flex flex-col gap-1 rounded border-2 p-2 text-sm ${STATE_STYLE[tile.state]}`}
    >
      <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded bg-slate-200">
        {thumbnail ? <img src={thumbnail} alt="" className="h-full w-full object-cover" /> : <span aria-hidden="true" className="text-2xl text-slate-500">{symbol}</span>}
      </div>
      <p className="font-medium">
        Tile {tile.index + 1}
        <span className="sr-only">: </span>
      </p>
      <p>
        <span aria-hidden="true" className="mr-1">
          {symbol}
        </span>
        {label}
        {tries}
      </p>
      {tile.note && tile.state !== 'accepted' && <p className="text-xs text-slate-700">{tile.note}</p>}
      {review && (tile.state === 'needs-review' || tile.state === 'failed') && (
        <div className="mt-1 flex flex-wrap gap-1">
          {tile.state === 'needs-review' && tile.outputPath && (
            <button type="button" className="rounded border border-slate-500 bg-white px-2 py-0.5 text-xs" aria-label={`Accept tile ${tile.index + 1} as it is`} onClick={() => review.onAccept(tile.index)}>
              Accept as is
            </button>
          )}
          <button type="button" className="rounded border border-slate-500 bg-white px-2 py-0.5 text-xs" aria-label={`Try tile ${tile.index + 1} again`} onClick={() => review.onRerun(tile.index)}>
            Try again
          </button>
        </div>
      )}
    </li>
  );
}

/** The tiles laid out as the picture is cut, each with its picture, state and, when set aside, why. */
export function TileGrid({ jobId, grid, tiles, review }: TileGridProps) {
  return (
    <ul aria-label={`Tiles, ${grid.rows} rows by ${grid.cols} columns`} className="grid gap-2" style={{ gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))` }}>
      {tiles.map((tile) => (
        <TileCell key={tile.index} jobId={jobId} tile={tile} review={review} />
      ))}
    </ul>
  );
}