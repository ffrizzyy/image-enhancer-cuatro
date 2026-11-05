import { MAX_GRID_AXIS, MAX_OVERLAP, type GridErrors, type GridMode } from '../draft';

interface GridControlsProps {
  mode: GridMode;
  rows: number;
  cols: number;
  overlapPct: number;
  errors: GridErrors;
  onMode: (mode: GridMode) => void;
  onField: (field: 'rows' | 'cols' | 'overlapPct', value: number) => void;
}

const MODES: Array<{ mode: GridMode; label: string }> = [
  { mode: 'preset-6', label: '6 tiles (3×2)' },
  { mode: 'preset-8', label: '8 tiles (4×2)' },
  { mode: 'custom', label: 'Custom' },
];

const input = 'w-20 rounded border border-slate-300 p-1 text-sm disabled:bg-slate-100';

export function GridControls({ mode, rows, cols, overlapPct, errors, onMode, onField }: GridControlsProps) {
  const custom = mode === 'custom';
  const field = (id: 'rows' | 'cols' | 'overlapPct', label: string, value: number, min: number, max: number, error?: string) => (
    <div>
      <label htmlFor={`grid-${id}`} className="mr-2 text-sm">
        {label}
      </label>
      <input
        id={`grid-${id}`}
        type="number"
        min={min}
        max={max}
        value={Number.isNaN(value) ? '' : value}
        disabled={id !== 'overlapPct' && !custom}
        onChange={(event) => onField(id, event.target.value === '' ? NaN : Number(event.target.value))}
        aria-invalid={error !== undefined}
        aria-describedby={error ? `grid-${id}-error` : undefined}
        className={input}
      />
      {error && (
        <p id={`grid-${id}-error`} role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );

  return (
    <fieldset>
      <legend className="mb-2 text-lg font-medium">Grid</legend>
      <div className="mb-3 flex gap-4">
        {MODES.map((option) => (
          <label key={option.mode} className="flex items-center gap-1 text-sm">
            <input type="radio" name="grid-mode" checked={mode === option.mode} onChange={() => onMode(option.mode)} />
            {option.label}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-4">
        {field('rows', 'Rows', rows, 1, MAX_GRID_AXIS, errors.rows)}
        {field('cols', 'Columns', cols, 1, MAX_GRID_AXIS, errors.cols)}
        {field('overlapPct', 'Overlap %', overlapPct, 0, MAX_OVERLAP, errors.overlap)}
      </div>
    </fieldset>
  );
}
