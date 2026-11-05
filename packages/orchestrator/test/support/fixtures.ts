import type { Job, Rect, Tile, TilePlan } from '@ie/contracts';

/** A plan of `count` tiles side by side across a (count * 100) x 100 image. Geometry is plausible, not computed by the slicer. */
export function rowPlan(count: number): TilePlan {
  const rect = (x: number): Rect => ({ x, y: 0, width: 100, height: 100 });
  const tiles: Tile[] = Array.from({ length: count }, (_, i) => ({
    index: i,
    row: 0,
    col: i,
    core: rect(i * 100),
    crop: rect(i * 100),
    send: rect(i * 100),
    edges: { top: true, right: i === count - 1, bottom: true, left: i === 0 },
    role: count === 1 ? 'center' : i === 0 || i === count - 1 ? 'edge' : 'center',
  }));
  return { source: { width: count * 100, height: 100 }, grid: { rows: 1, cols: count }, overlapPx: 0, wrap: false, tiles };
}

export function makeJob(id = 'J1', over: Partial<Job> = {}): Job {
  return {
    id,
    createdAt: '2026-11-05T10:00:00.000Z',
    source: { path: 'C:\\pics\\photo.png', width: 800, height: 100, sha256: 'a'.repeat(64) },
    prompt: 'Enhance this tile.',
    promptSource: 'user',
    categoryId: 'env-realistic',
    categorySource: 'user',
    grid: { rows: 1, cols: 4, overlapPct: 15 },
    providerId: 'gemini',
    ...over,
  };
}
