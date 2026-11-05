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
  attempts: number;
}

export interface JobProgress {
  jobId: string;
  state: JobState;
  pauseReason?: PauseReason | undefined;
  resumeAfter?: string | undefined;
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
  'slicer.plan': {
    request: { assetId: string; grid: Grid; overlapPct: number; wrap?: boolean };
    response: TilePlan;
  };
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
