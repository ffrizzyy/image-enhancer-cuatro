import type { TilePlan } from '@ie/contracts';

import { tileNumber } from '../gridOverlay';

/**
 * The tile edges drawn over the stitched picture, so a person can see exactly which tile a seam belongs to. It is pure
 * drawing: turning it on and off never re-stitches anything.
 */
export function SeamOverlay({ plan }: { plan: TilePlan }) {
  const { width, height } = plan.source;
  // Lines stay a constant on-screen width however large the picture is.
  const stroke = Math.max(width, height) / 400;

  return (
    <svg
      data-testid="seam-overlay"
      viewBox={`0 0 ${width} ${height}`}
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden="true"
    >
      {plan.tiles.map((tile) => (
        <g key={tile.index}>
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
          >
            {tileNumber(tile.index)}
          </text>
        </g>
      ))}
      {plan.wrap && <rect x="0" y="0" width={width} height={height} fill="none" stroke="#7c3aed" strokeWidth={stroke * 4} strokeDasharray={`${stroke * 10} ${stroke * 6}`} />}
    </svg>
  );
}
