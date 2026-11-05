/** A supported provider aspect as a reduced width:height pair. Padding grows a tile by whole multiples of it. */
export type AspectPair = readonly [number, number];

/** 1:1, 2:3 (portrait) and 3:2 (landscape). */
export const DEFAULT_ASPECTS: readonly AspectPair[] = [
  [1, 1],
  [2, 3],
  [3, 2],
];

export interface PlanOptions {
  width: number;
  height: number;
  rows: number;
  cols: number;
  /** Overlap as a percentage (0-40) of the base tile core's shorter side, added on each interior side. */
  overlapPct: number;
  /** Texture mode: outer overlap and padding come from the opposite edge of the image. */
  wrap?: boolean;
  aspects?: readonly AspectPair[];
}

export type PlanErrorCode =
  | 'invalid-size'
  | 'invalid-grid'
  | 'invalid-overlap'
  | 'invalid-aspects'
  /** More rows or columns than pixels: some tile core would be empty. */
  | 'grid-too-fine';

export class PlanError extends Error {
  readonly code: PlanErrorCode;

  constructor(code: PlanErrorCode, message: string) {
    super(message);
    this.name = 'PlanError';
    this.code = code;
  }
}
