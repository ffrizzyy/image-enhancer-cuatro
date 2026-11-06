/** The band a seam score falls into. The stitcher's passing threshold is 1.2; a visible step scores well above 1.5. */
export type QualityBand = 'clean' | 'fair' | 'visible';

export interface Quality {
  band: QualityBand;
  label: string;
  tone: string;
}

export function qualityFor(seamScore: number): Quality {
  if (seamScore <= 1.2) return { band: 'clean', label: 'Clean seams', tone: 'border-green-700 bg-green-50 text-green-900' };
  if (seamScore <= 1.5) return { band: 'fair', label: 'Slightly visible seams', tone: 'border-amber-500 bg-amber-50 text-amber-900' };
  return { band: 'visible', label: 'Visible seams', tone: 'border-red-700 bg-red-50 text-red-900' };
}

interface QualityBadgeProps {
  seamScore: number;
  maxDeltaE: number;
  flaggedCount: number;
}

/** What the stitcher's own numbers say about the picture, in words as well as a colour. */
export function QualityBadge({ seamScore, maxDeltaE, flaggedCount }: QualityBadgeProps) {
  const quality = qualityFor(seamScore);
  return (
    <section data-testid="quality-badge" data-band={quality.band} aria-label="Picture quality" className={`rounded border-2 p-3 text-sm ${quality.tone}`}>
      <p className="font-medium">{quality.label}</p>
      <p>
        Seam score {seamScore.toFixed(2)} (a passing picture scores 1.20 or less) &middot; colour difference {maxDeltaE.toFixed(1)} &middot;{' '}
        {flaggedCount === 0 ? 'no tiles flagged' : `${flaggedCount} tile${flaggedCount === 1 ? '' : 's'} flagged`}
      </p>
    </section>
  );
}
