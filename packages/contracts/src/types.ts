export type ProviderId = 'gpt' | 'gemini' | 'grok';

export type SessionStatus = 'logged-out' | 'ready' | 'challenge' | 'quota-limited' | 'unknown';

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Grid {
  rows: number;
  cols: number;
}

export interface ImageAsset {
  id: string;
  path: string;
  width: number;
  height: number;
  sha256: string;
  featuresPath?: string | undefined;
}

export interface ImageFeatures {
  width: number;
  height: number;
  aspect: number;
  saturation: number;
  colorfulness: number;
  edgeDensity: number;
  highFrequencyEnergy: number;
  paletteSize: number;
  blockiness: number;
  blurVariance: number;
  noiseEstimate: number;
  transparencyRatio: number;
  luminanceBimodality: number;
}

export type CategoryKind = 'prompt' | 'auto';

export type CategoryFamily =
  | 'environment'
  | 'props'
  | 'character'
  | 'texture'
  | 'restore'
  | 'stylize'
  | 'custom'
  | 'smart';

export type Fidelity = 'strict' | 'preserve' | 'balanced' | 'reimagine';

export interface Category {
  id: string;
  name: string;
  kind: CategoryKind;
  family: CategoryFamily;
  fidelity: Fidelity;
  template?: string | undefined;
  defaultPrompt?: string | undefined;
  negative: string[];
  defaults: {
    grid: [number, number];
    overlapPct: number;
  };
  wrap?: boolean | undefined;
  warnings: string[];
}

export interface CategorySuggestion {
  categoryId: string;
  confidence: number;
  alternatives: Array<{ categoryId: string; confidence: number }>;
  signals: string[];
  lowConfidence: boolean;
}

export type CategorySource = 'user' | 'auto';

export type PromptSource = 'user' | 'category-default';

export interface SourceImage {
  path: string;
  width: number;
  height: number;
  sha256: string;
}

export interface JobGrid {
  rows: number;
  cols: number;
  overlapPct: number;
  /** Seamless texture: the outer overlap wraps to the opposite edge. Absent means false. */
  wrap?: boolean | undefined;
}

export interface Job {
  id: string;
  createdAt: string;
  source: SourceImage;
  prompt: string;
  promptSource: PromptSource;
  categoryId: string;
  categorySource: CategorySource;
  categoryConfidence?: number | undefined;
  grid: JobGrid;
  providerId: ProviderId;
}

/** A small stand-in for an imported image, as a data URL. width x height is the preview's own size. */
export interface ImagePreview {
  dataUrl: string;
  width: number;
  height: number;
}

export interface CreateJobRequest {
  assetId: string;
  prompt: string;
  categoryId: string;
  grid: JobGrid;
  providerId: ProviderId;
  /** "auto" when the user kept an auto-detect suggestion; defaults to "user". */
  categorySource?: CategorySource | undefined;
  /** Recorded only with categorySource: auto. */
  categoryConfidence?: number | undefined;
}

export interface TileEdges {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
}

export type TileRole = 'corner' | 'edge' | 'center';

export interface Tile {
  index: number;
  row: number;
  col: number;
  core: Rect;
  crop: Rect;
  send: Rect;
  edges: TileEdges;
  role: TileRole;
}

export interface TilePlan {
  source: Size;
  grid: Grid;
  overlapPx: number;
  wrap: boolean;
  tiles: Tile[];
}

export type JobState =
  | 'idle'
  | 'preflight'
  | 'running'
  | 'paused'
  | 'needs-review'
  | 'stitching'
  | 'done'
  | 'failed'
  | 'cancelled';

export type TileState = 'pending' | 'running' | 'accepted' | 'retrying' | 'needs-review' | 'failed';

export type PauseReason = 'challenge' | 'logged-out' | 'quota' | 'user';

export type JobMode = 'chained' | 'independent';

export interface Pacing {
  concurrency: 1 | 2;
  minDelayMs: number;
  maxDelayMs: number;
}

export type ProviderErrorKind =
  | 'logged-out'
  | 'challenge'
  | 'quota'
  | 'refusal'
  | 'timeout'
  | 'ui-changed'
  | 'download-failed';

export interface EnhanceAttachment {
  role: 'tile' | 'global-reference' | 'neighbor';
  path: string;
}

export interface EnhanceRequest {
  attachments: EnhanceAttachment[];
  prompt: string;
  timeoutMs: number;
}

export interface EnhanceResult {
  imagePath: string;
  width: number;
  height: number;
  elapsedMs: number;
}

export interface ProviderCapabilities {
  maxAttachments: number;
  outputAspects: string[];
  approxOutputPx: number;
}

export interface ProviderHealth {
  ok: boolean;
  missingSelectors: string[];
}

export type BlendMode = 'multiband' | 'feather';

export interface StitchOptions {
  blend: BlendMode;
  maxShiftPx: number;
  harmonize: boolean;
}

export interface StitchMetrics {
  seamScore: number;
  maxDeltaE: number;
}

export interface StitchResult {
  imagePath: string;
  metrics: StitchMetrics;
  flagged: number[];
}

/** A picture that has been put together, with what it looked like when the stitcher last ran. */
export interface StitchedResult extends StitchResult {
  /** When the stitcher last wrote this picture; a re-stitch changes it. */
  stitchedAt: string;
}

/** Everything the Result screen needs: the pictures, the metrics and the tile geometry for its overlays. */
export interface JobResultView extends StitchedResult {
  jobId: string;
  width: number;
  height: number;
  plan: TilePlan;
  /** The original picture, for the before side of the comparison. */
  sourcePreview: ImagePreview;
  /** A downscaled copy of the stitched picture, for the after side. */
  preview: ImagePreview;
}

/** A change to one tile's own prompt or source picture. `null` goes back to the job's prompt / the sliced tile. */
export interface TileOverridePatch {
  prompt?: string | null | undefined;
  sourcePath?: string | null | undefined;
}

export interface StitchInput {
  plan: TilePlan;
  tiles: Array<{ index: number; path: string }>;
  options: StitchOptions;
}

export type ExportFormat = 'png' | 'jpeg' | 'webp';

export interface ExportRequest {
  imagePath: string;
  format: ExportFormat;
  quality?: number | undefined;
  destination?: string | undefined;
}

export interface ExportResult {
  path: string;
  width: number;
  height: number;
}

export type PacingPreset = 'safe' | 'normal';

export interface AppSettings {
  firstRunAcknowledged: boolean;
  pacingPreset: PacingPreset;
  dataFolder: string;
  watchMode: boolean;
  riskNoticeVersion: number;
}

export interface SessionHandle {
  providerId: ProviderId;
  partition: string;
  visible: boolean;
}

export interface TileProgress {
  index: number;
  state: TileState;
  outputPath?: string | undefined;
  errorKind?: ProviderErrorKind | undefined;
  /** Why a tile was rejected or set aside, in plain words. */
  note?: string | undefined;
  attempts: number;
  /** This tile's own prompt, when the person changed it; absent means the job's prompt. */
  promptOverride?: string | undefined;
  /** The picture this tile used instead of its slice of the job's source, when the person changed it. */
  sourceOverride?: string | undefined;
}

export interface JobProgress {
  jobId: string;
  state: JobState;
  pauseReason?: PauseReason | undefined;
  resumeAfter?: string | undefined;
  /** Why the job failed, or why the pre-run checks blocked it. */
  error?: string | undefined;
  providerId?: ProviderId | undefined;
  /** The job's prompt, for editing one tile's prompt against it. */
  prompt?: string | undefined;
  /** How the tiles are laid out, so the Run screen can draw them as a grid. */
  grid?: Grid | undefined;
  /** The picture and its metrics, once the stitcher has run. */
  result?: StitchedResult | undefined;
  completedTiles: number;
  totalTiles: number;
  tiles: TileProgress[];
}

export interface JobSummary {
  id: string;
  createdAt: string;
  state: JobState;
  thumbnailPath?: string | undefined;
  completedTiles: number;
  totalTiles: number;
}

/** What a run will cost before it starts: how many generations, roughly how long, and what it uses up. */
export interface CostPreview {
  tiles: number;
  estimatedMinutes: number;
  quotaNote: string;
}

export interface IpcContract {
  'app.ping': { request: void; response: { version: string; ipcVersion: number } };
  'sessions.open': { request: { providerId: ProviderId; visible?: boolean }; response: SessionHandle };
  'sessions.status': { request: { providerId: ProviderId }; response: SessionStatus };
  'sessions.clear': { request: { providerId: ProviderId }; response: { cleared: boolean } };
  'presets.list': { request: void; response: Category[] };
  'presets.get': { request: { categoryId: string }; response: Category };
  'presets.suggestCategory': {
    request: { assetId: string; prompt: string };
    response: CategorySuggestion;
  };
  'intake.import': { request: { path: string }; response: ImageAsset };
  'intake.createJob': { request: CreateJobRequest; response: Job };
  /** A downscaled JPEG of an imported image, for drawing the tile grid over. Never leaves the machine. */
  'intake.preview': { request: { assetId: string; maxSide?: number }; response: ImagePreview };
  'slicer.plan': {
    request: { assetId: string; grid: Grid; overlapPct: number; wrap?: boolean };
    response: TilePlan;
  };
  /** Review: keep a tile that was set aside exactly as its best attempt came back. */
  'jobs.acceptTile': { request: { jobId: string; index: number }; response: JobProgress };
  /** Review: queue a tile to be generated again with a fresh set of retries. */
  'jobs.rerunTile': { request: { jobId: string; index: number }; response: JobProgress };
  /** Change one tile's prompt or source picture before it is run again. */
  'jobs.setTileOverride': {
    request: { jobId: string; index: number; prompt?: string | null; sourcePath?: string | null };
    response: JobProgress;
  };
  /** Everything the Result screen shows: the stitched picture, its metrics, and the tile plan. */
  'jobs.result': { request: { jobId: string; maxSide?: number }; response: JobResultView };
  /** Review: every tile is settled, so put the picture together. */
  'jobs.finishReview': { request: { jobId: string }; response: JobProgress };
  'jobs.costPreview': { request: { providerId: ProviderId; tileCount: number }; response: CostPreview };
  /** A small picture of a tile's current output, for the Run screen. */
  'jobs.tileThumbnail': { request: { jobId: string; index: number; maxSide?: number }; response: ImagePreview };
  'jobs.start': { request: { jobId: string }; response: { jobId: string; state: JobState } };
  'jobs.pause': { request: { jobId: string }; response: JobProgress };
  'jobs.resume': { request: { jobId: string }; response: JobProgress };
  'jobs.cancel': { request: { jobId: string }; response: JobProgress };
  'jobs.get': { request: { jobId: string }; response: JobProgress };
  'jobs.listRecent': { request: { limit?: number }; response: JobSummary[] };
  'stitch.run': { request: { jobId: string; options: StitchOptions }; response: StitchResult };
  'export.save': { request: ExportRequest; response: ExportResult };
  'settings.get': { request: void; response: AppSettings };
  'settings.set': { request: Partial<AppSettings>; response: AppSettings };
}

export interface IpcEvents {
  'jobs.progress': JobProgress;
  'sessions.status': { providerId: ProviderId; status: SessionStatus };
  'jobs.log': { jobId: string; level: 'info' | 'warn' | 'error'; message: string };
}

export type IpcChannel = keyof IpcContract;
export type IpcEventChannel = keyof IpcEvents;
