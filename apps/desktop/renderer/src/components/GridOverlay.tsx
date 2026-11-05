import type { ProviderId, TilePlan } from '@ie/contracts';

import { describeTile, overlapRegions, planWarnings, PROVIDER_OUTPUT_PX, tileNumber } from '../gridOverlay';

interface GridOverlayProps {
  plan: TilePlan;
  /** A downscaled picture of the image; without it the grid is drawn on a plain background. */
  previewUrl: string | null;
  providerId: ProviderId | null;
}

/**
 * The real tile grid over the image. The picture and the lines share one coordinate system (the image's own
 * pixels, as a viewBox), so every line sits exactly where the plan puts it at any display size.
 */
export function GridOverlay({ plan, previewUrl, providerId }: GridOverlayProps) {
  const { width, height } = plan.source;
  const overlaps = overlapRegions(plan);
  const warnings = planWarnings(plan, providerId ? PROVIDER_OUTPUT_PX[providerId] : null);
  const label = `Tile grid: ${plan.grid.rows} rows by ${plan.grid.cols} columns, ${plan.tiles.length} tiles, overlap ${plan.overlapPx} px${plan.wrap ? ', wrap mode' : ''}.`;
  // Lines stay a constant on-screen width however large the image is.
  const stroke = Math.max(width, height) / 400;

  return (
    <section aria-labelledby="grid-preview-title" className="space-y-2">
      <h3 id="grid-preview-title" className="text-lg font-medium">
        Tile preview
      </h3>
      <div className="relative w-full max-w-3xl overflow-hidden rounded border border-slate-300 bg-slate-200" style={{ aspectRatio: `${width} / ${height}` }}>
        {previewUrl && <img src={previewUrl} alt="" className="absolute inset-0 h-full w-full object-fill" />}
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="absolute inset-0 h-full w-full" data-testid="grid-overlay">
          <defs>
            <pattern id="overlap-hatch" width={stroke * 6} height={stroke * 6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={stroke * 6} height={stroke * 6} fill="#f59e0b" fillOpacity="0.28" />
              <line x1="0" y1="0" x2="0" y2={stroke * 6} stroke="#b45309" strokeWidth={stroke * 1.5} />
            </pattern>
          </defs>

          {overlaps.map((region, i) => (
            <rect key={i} data-testid="overlap" data-wrapped={region.wrapped} {...region.rect} fill="url(#overlap-hatch)" />
          ))}

          {plan.tiles.map((tile) => (
            <g key={tile.index} data-testid={`tile-${tile.index}`}>
              {/* A dark line under a light one keeps the grid visible on both bright and dark pictures. */}
              <rect {...tile.core} fill="none" stroke="#0f172a" strokeWidth={stroke * 3} />
              <rect {...tile.core} fill="none" stroke="#ffffff" strokeWidth={stroke * 1.2} />
              <circle cx={tile.core.x + tile.core.width / 2} cy={tile.core.y + tile.core.height / 2} r={stroke * 14} fill="#0f172a" fillOpacity="0.8" />
              <text
                x={tile.core.x + tile.core.width / 2}
                y={tile.core.y + tile.core.height / 2}
                fill="#ffffff"
                fontSize={stroke * 16}
                textAnchor="middle"
                dominantBaseline="central"
                aria-hidden="true"
              >
                {tileNumber(tile.index)}
              </text>
            </g>
          ))}

          {plan.wrap && <rect data-testid="wrap-border" x="0" y="0" width={width} height={height} fill="none" stroke="#7c3aed" strokeWidth={stroke * 4} strokeDasharray={`${stroke * 10} ${stroke * 6}`} />}
        </svg>
      </div>

      <p className="text-sm text-slate-700" data-testid="grid-legend">
        <span aria-hidden="true" className="mr-1 inline-block h-3 w-3 border border-amber-700 bg-amber-300 align-middle" />
        Hatched bands are where neighbouring tiles overlap and get blended.
        {plan.wrap && (
          <span data-testid="wrap-note">
            {' '}
            <strong>Wrap mode:</strong> the dashed border marks edges that continue from the opposite side, so the result tiles seamlessly.
          </span>
        )}
      </p>

      {warnings.length > 0 && (
        // Advice, not an error that blocks Start: announced politely rather than as an alert.
        <ul data-testid="plan-warnings" aria-label="Warnings about this plan" aria-live="polite" className="space-y-1">
          {warnings.map((warning) => (
            <li key={warning.kind} className="rounded border border-amber-400 bg-amber-50 p-2 text-sm text-amber-900">
              {warning.message}
            </li>
          ))}
        </ul>
      )}

      <details className="text-sm">
        <summary className="cursor-pointer">Tile details ({plan.tiles.length})</summary>
        <ul className="mt-1 list-disc pl-5">
          {plan.tiles.map((tile) => (
            <li key={tile.index}>{describeTile(tile)}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
