import type { CategorySuggestion, ImageFeatures } from '@ie/contracts';

/** Below this confidence the UI shows a warning and the top alternatives. */
export const SUGGESTION_THRESHOLD = 0.55;

type Candidate =
  | 'env-realistic'
  | 'env-stylized'
  | 'props-realistic'
  | 'props-stylized'
  | 'char-realistic'
  | 'char-stylized'
  | 'creature-realistic'
  | 'creature-stylized'
  | 'vehicle-hardsurface'
  | 'architecture-interior'
  | 'landscape-matte'
  | 'texture-material'
  | 'photo-restore'
  | 'lineart-to-render'
  | 'pixel-art'
  | 'product-still'
  | 'isometric-asset'
  | 'icon-ui';

/** Catalog order; also the deterministic tie-break. `auto` and `custom` are never candidates. */
const CANDIDATES: readonly Candidate[] = [
  'env-realistic',
  'env-stylized',
  'props-realistic',
  'props-stylized',
  'char-realistic',
  'char-stylized',
  'creature-realistic',
  'creature-stylized',
  'vehicle-hardsurface',
  'architecture-interior',
  'landscape-matte',
  'texture-material',
  'photo-restore',
  'lineart-to-render',
  'pixel-art',
  'product-still',
  'isometric-asset',
  'icon-ui',
];

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
/** 0 at or below `lo`, 1 at or above `hi`. */
const ramp = (x: number, lo: number, hi: number): number => clamp01((x - lo) / (hi - lo));
/** 1 at or below `lo`, 0 at or above `hi`. */
const inv = (x: number, lo: number, hi: number): number => 1 - ramp(x, lo, hi);

interface Evidence {
  score: number;
  signal: string;
}

class Scoreboard {
  private readonly scores = new Map<Candidate, number>();
  private readonly signals = new Map<Candidate, Evidence[]>();

  add(candidate: Candidate, score: number, signal: string): void {
    if (score <= 0.01) return;
    this.scores.set(candidate, (this.scores.get(candidate) ?? 0) + score);
    this.signals.set(candidate, [...(this.signals.get(candidate) ?? []), { score, signal }]);
  }

  /** Adds `weight` split between a realistic and a stylized variant by how stylized the image looks. */
  addVariant(realistic: Candidate, stylized: Candidate, weight: number, p: number, signal: string): void {
    this.add(realistic, weight * (1 - p), signal);
    this.add(stylized, weight * p, signal);
  }

  score(candidate: Candidate): number {
    return this.scores.get(candidate) ?? 0;
  }

  topSignals(candidate: Candidate, count: number): string[] {
    return [...(this.signals.get(candidate) ?? [])]
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
      .map((e) => e.signal);
  }
}

interface KeywordRule {
  pattern: RegExp;
  label: string;
  /** Candidate groups this keyword points to. */
  target:
    | { kind: 'single'; id: Candidate; weight: number }
    | { kind: 'variant'; realistic: Candidate; stylized: Candidate; weight: number };
}

/** Weights: medium/format cues (1.6) beat domain cues (1.1), which beat generic subject cues (0.6). */
const single = (pattern: RegExp, label: string, id: Candidate, weight: number): KeywordRule => ({
  pattern,
  label,
  target: { kind: 'single', id, weight },
});
const variant = (
  pattern: RegExp,
  label: string,
  realistic: Candidate,
  stylized: Candidate,
  weight = 0.6,
): KeywordRule => ({ pattern, label, target: { kind: 'variant', realistic, stylized, weight } });

const KEYWORDS: readonly KeywordRule[] = [
  single(/\b(pixel[- ]?art|pixelart|sprite|8[- ]?bit|16[- ]?bit|retro game)\b/i, 'pixel art', 'pixel-art', 1.6),
  single(/\b(icon|ui element|button|glyph|logo|emblem|badge)\b/i, 'icon or UI', 'icon-ui', 1.6),
  single(/\b(sketch|line ?art|lineart|line drawing|outline|ink drawing|pencil drawing)\b/i, 'sketch or line art', 'lineart-to-render', 1.6),
  single(/\b(seamless|tileable|tiling|texture|pbr|material sample|albedo)\b/i, 'texture', 'texture-material', 1.6),
  single(/\b(restor\w*|old photo|vintage photo|scanned?|damaged|faded|scratch\w*|denoise|deblur|upscal\w*|blurry|grainy)\b/i, 'restoration', 'photo-restore', 1.6),
  single(/\b(isometric)\b/i, 'isometric', 'isometric-asset', 1.6),
  single(/\b(product|packshot|still life|bottle|perfume|watch|packaging|sneaker)\b/i, 'product shot', 'product-still', 1.1),
  single(/\b(architecture|architectural|interior|living room|bedroom|kitchen|facade|building|skyscraper|cathedral)\b/i, 'architecture or interior', 'architecture-interior', 1.1),
  single(/\b(landscape|mountains?|valley|vista|panorama|matte painting|horizon|canyon|waterfall)\b/i, 'landscape', 'landscape-matte', 1.1),
  single(/\b(car|vehicle|mech|robot|tank|spaceship|starship|airplane|aircraft|helicopter|weapon|rifle|gun|truck|motorcycle)\b/i, 'vehicle or hard-surface', 'vehicle-hardsurface', 1.1),
  variant(/\b(creature|monster|dragon|beast|animal|wolf|cat|dog|horse|bird|demon|alien)\b/i, 'creature', 'creature-realistic', 'creature-stylized'),
  variant(/\b(portrait|person|people|woman|man|girl|boy|face|character|hero|knight|warrior|selfie|model)\b/i, 'character', 'char-realistic', 'char-stylized'),
  variant(/\b(prop|object|item|chest|barrel|sword|furniture|lamp|crate|tool|artifact)\b/i, 'props', 'props-realistic', 'props-stylized'),
  variant(/\b(environment|scene|forest|city|street|village|dungeon|jungle|desert|room|market|ruins|town)\b/i, 'environment', 'env-realistic', 'env-stylized'),
];

const STYLIZED_WORDS = /\b(anime|cartoon|stylized|stylised|painterly|toon|cel[- ]?shaded|low[- ]?poly|illustration|hand[- ]?painted|comic|flat)\b/i;
const REALISTIC_WORDS = /\b(photo|photograph|photoreal\w*|realistic|raw|dslr|cinematic)\b/i;

/** 0 = looks photographic, 1 = looks flat / illustrated, from features plus prompt hints. */
function stylizedness(f: ImageFeatures, prompt: string): { p: number; reason: string } {
  const flat = ramp(f.blockiness, 0.3, 0.8);
  const palette = inv(f.paletteSize, 40, 400);
  const quiet = inv(f.noiseEstimate, 2, 10);
  let s = 0.45 * flat + 0.35 * palette + 0.2 * quiet;
  if (STYLIZED_WORDS.test(prompt)) s += 0.4;
  if (REALISTIC_WORDS.test(prompt)) s -= 0.4;
  s = clamp01(s);
  // Sharpen around 0.5 so a clear call is not split evenly between the two variants.
  const p = 1 / (1 + Math.exp(-(s - 0.5) * 8));
  return {
    p,
    reason: p > 0.5 ? 'Looks flat or illustrated (few colours, little noise)' : 'Looks photographic (many colours, natural noise)',
  };
}

function scoreFeatures(board: Scoreboard, f: ImageFeatures, p: number, styleReason: string, keywordMatched: boolean): void {
  const longest = Math.max(f.width, f.height);
  const flat = ramp(f.blockiness, 0.5, 0.9);
  const blocky = ramp(f.blockiness, 0.35, 0.75);
  const smallPalette = inv(f.paletteSize, 16, 96);
  const smallImage = inv(longest, 256, 1024);
  const square = inv(Math.abs(f.aspect - 1), 0.02, 0.25);
  const bimodal = ramp(f.luminanceBimodality, 0.6, 0.95);
  const grey = inv(f.saturation, 0.05, 0.2);

  const pixel = blocky * smallPalette * (0.4 + 0.6 * smallImage) * ramp(f.edgeDensity, 0.06, 0.25);
  board.add('pixel-art', 1.0 * pixel, `Small palette (${f.paletteSize} colours) and flat blocks, like pixel art`);

  const lineart = bimodal * grey * inv(f.edgeDensity, 0.1, 0.35) * flat;
  board.add('lineart-to-render', 1.0 * lineart, 'Mostly paper-white with dark strokes and almost no colour');

  const transparent = ramp(f.transparencyRatio, 0.02, 0.2);
  board.add('icon-ui', 0.8 * transparent + 0.25 * flat * smallPalette * square * smallImage, 'Transparent or flat, compact graphic');

  const busy = ramp(f.edgeDensity, 0.2, 0.5);
  board.add('texture-material', 0.35 * square * busy * inv(f.blockiness, 0.1, 0.4), 'Square, uniformly busy surface detail');

  // Photographic (not flat or graphic) and showing damage: soft, noisy, or faded to near-grey.
  const photoLike = inv(f.blockiness, 0.1, 0.5);
  const blurry = inv(f.blurVariance, 15, 80);
  const noisy = ramp(f.noiseEstimate, 6, 14);
  const faded = inv(f.colorfulness, 8, 30) * inv(f.saturation, 0.08, 0.25);
  const damage = Math.max(0.7 * blurry, 0.7 * noisy, 0.55 * faded);
  board.add('photo-restore', photoLike * damage, 'Photo that looks soft, noisy or faded');

  // Weak scene prior so the answer is still sensible with no keywords; it never competes with a keyword.
  if (!keywordMatched) board.addVariant('env-realistic', 'env-stylized', 0.3, p, styleReason);
  if (f.aspect >= 1.7) board.add('landscape-matte', 0.45, 'Very wide frame, typical of landscapes');
  if (f.aspect <= 0.8) board.addVariant('char-realistic', 'char-stylized', 0.45, p, 'Tall frame, typical of portraits');
}

/**
 * Local, offline, deterministic category suggestion from image features and the prompt.
 * Never returns `auto` or `custom`, never calls a provider, never starts a job.
 */
export function suggestCategory(features: ImageFeatures, prompt: string): CategorySuggestion {
  const board = new Scoreboard();
  const { p, reason } = stylizedness(features, prompt);

  let keywordMatched = false;
  for (const rule of KEYWORDS) {
    const match = rule.pattern.exec(prompt);
    if (!match) continue;
    keywordMatched = true;
    const signal = `Prompt mentions "${match[0].toLowerCase()}" (${rule.label})`;
    if (rule.target.kind === 'single') board.add(rule.target.id, rule.target.weight, signal);
    else board.addVariant(rule.target.realistic, rule.target.stylized, rule.target.weight, p, signal);
  }
  scoreFeatures(board, features, p, reason, keywordMatched);

  const ranked = CANDIDATES.map((id, order) => ({ id, order, score: board.score(id) })).sort(
    (a, b) => b.score - a.score || a.order - b.order,
  );
  const top = ranked[0]!;
  const second = ranked[1]!;

  const confidenceOf = (candidate: { score: number }, rival: { score: number }): number => {
    const share = candidate.score / (candidate.score + rival.score + 1e-9);
    return Math.round(clamp01(share * Math.min(1, candidate.score / 0.6)) * 100) / 100;
  };

  const confidence = confidenceOf(top, second);
  const alternatives = ranked.slice(1, 4).map((c) => ({
    categoryId: c.id,
    confidence: Math.min(confidence, confidenceOf(c, top)),
  }));

  return {
    categoryId: top.id,
    confidence,
    alternatives,
    // Never empty: the scene prior always contributes evidence, so the top candidate has at least one signal.
    signals: board.topSignals(top.id, 3),
    lowConfidence: confidence < SUGGESTION_THRESHOLD,
  };
}
