import {
  CURRENT_RISK_NOTICE_VERSION,
  type AppSettings,
  type Category,
  type CategorySuggestion,
  type ImageAsset,
  type Job,
  type JobSummary,
  type ProviderId,
  type SessionStatus,
} from '@ie/contracts';
import { create } from 'zustand';

import {
  applyCategory,
  applyGridMode,
  detectionPrompt,
  emptyDraft,
  keptSuggestion,
  startBlockReason,
  toCreateJobRequest,
  type GridMode,
  type JobDraft,
} from './draft';
import { ipc } from './ipc';

export type DetectionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; suggestion: CategorySuggestion }
  | { status: 'error'; message: string };

/** Incremented whenever a detection starts or is cancelled, so a late response never overwrites newer state. */
let detectionRun = 0;

export const ROUTE_IDS = ['home', 'setup', 'run', 'result', 'settings'] as const;
export type RouteId = (typeof ROUTE_IDS)[number];

export const PROVIDERS: readonly ProviderId[] = ['gpt', 'gemini', 'grok'];

export type PingState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; version: string; ipcVersion: number }
  | { status: 'error'; message: string };

export interface ImportError {
  code: string;
  message: string;
}

interface ShellState {
  route: RouteId;
  ping: PingState;
  /** `null` until the first `settings.get` resolves; the app renders nothing meaningful before that. */
  settings: AppSettings | null;
  settingsError: string | null;
  providers: Record<ProviderId, SessionStatus>;
  providerError: string | null;
  /** The imported image. No Job exists until the user presses Start in Setup. */
  asset: ImageAsset | null;
  importing: boolean;
  importError: ImportError | null;
  recentJobs: JobSummary[];
  categories: Category[];
  categoriesError: string | null;
  /** The Setup form. Survives navigation; no Job exists until Start. */
  draft: JobDraft;
  /** Auto-detect result for the current image. Local only; never starts a job. */
  detection: DetectionState;
  /** Created by Start; execution arrives in Phase 3. */
  job: Job | null;
  starting: boolean;
  startError: string | null;
  navigate: (route: RouteId) => void;
  loadPing: () => Promise<void>;
  importFile: (file: File) => Promise<void>;
  loadSettings: () => Promise<void>;
  acknowledgeRisk: () => Promise<void>;
  /** Starts listening for live provider status; returns the unsubscribe function. */
  subscribeStatus: () => () => void;
  openProvider: (provider: ProviderId, visible: boolean) => Promise<void>;
  clearProvider: (provider: ProviderId) => Promise<void>;
  loadCategories: () => Promise<void>;
  /** Picks a category by hand (turns Auto off). */
  selectCategory: (id: string) => void;
  /** Selects Auto, or re-detects: analyses the image with the current prompt text and applies the result. */
  detectCategory: () => Promise<void>;
  /** Overrides the detected category with one of the alternatives, keeping the Auto card. */
  chooseAlternative: (id: string) => void;
  /** Goes back to the detected category after an override. */
  useDetected: () => void;
  setPrompt: (prompt: string) => void;
  resetPrompt: () => void;
  setGridMode: (mode: GridMode) => void;
  setGridField: (field: 'rows' | 'cols' | 'overlapPct', value: number) => void;
  setProvider: (provider: ProviderId) => void;
  startJob: () => Promise<void>;
}

export const needsRiskNotice = (settings: AppSettings): boolean =>
  !settings.firstRunAcknowledged || settings.riskNoticeVersion < CURRENT_RISK_NOTICE_VERSION;

export const useShellStore = create<ShellState>((set, get) => ({
  route: 'home',
  ping: { status: 'idle' },
  settings: null,
  settingsError: null,
  providers: { gpt: 'unknown', gemini: 'unknown', grok: 'unknown' },
  providerError: null,
  asset: null,
  importing: false,
  importError: null,
  recentJobs: [],
  categories: [],
  categoriesError: null,
  draft: emptyDraft(),
  detection: { status: 'idle' },
  job: null,
  starting: false,
  startError: null,
  navigate: (route) => set({ route }),
  loadPing: async () => {
    set({ ping: { status: 'loading' } });
    try {
      const result = await ipc.app.ping();
      set({
        ping: result.ok
          ? { status: 'ok', version: result.value.version, ipcVersion: result.value.ipcVersion }
          : { status: 'error', message: `${result.error.code}: ${result.error.message}` },
      });
    } catch (error) {
      set({ ping: { status: 'error', message: String(error) } });
    }
  },
  importFile: async (file) => {
    set({ importing: true, importError: null });
    try {
      const path = ipc.files.pathFor(file);
      if (!path) {
        set({
          importing: false,
          importError: { code: 'no-path', message: 'Could not read the location of that file. Try choosing it again.' },
        });
        return;
      }
      const result = await ipc.intake.import(path);
      if (result.ok) {
        // A new image invalidates any detection; Setup re-runs it if Auto is still selected.
        detectionRun++;
        set({ importing: false, asset: result.value, job: null, startError: null, detection: { status: 'idle' }, route: 'setup' });
      } else {
        set({ importing: false, importError: result.error });
      }
    } catch (error) {
      set({ importing: false, importError: { code: 'internal', message: `Import failed: ${String(error)}` } });
    }
  },
  loadSettings: async () => {
    try {
      const result = await ipc.settings.get();
      set(result.ok ? { settings: result.value, settingsError: null } : { settingsError: result.error.message });
    } catch (error) {
      set({ settingsError: `Settings failed to load: ${String(error)}` });
    }
  },
  acknowledgeRisk: async () => {
    try {
      const result = await ipc.settings.set({ firstRunAcknowledged: true });
      set(result.ok ? { settings: result.value, settingsError: null } : { settingsError: result.error.message });
    } catch (error) {
      set({ settingsError: `Could not save your acknowledgement: ${String(error)}` });
    }
  },
  subscribeStatus: () =>
    ipc.sessions.onStatus(({ providerId, status }) =>
      set((state) => ({ providers: { ...state.providers, [providerId]: status } })),
    ),
  openProvider: async (provider, visible) => {
    set({ providerError: null });
    try {
      const result = await ipc.sessions.open(provider, visible);
      if (!result.ok) set({ providerError: result.error.message });
    } catch (error) {
      set({ providerError: `Could not open the provider window: ${String(error)}` });
    }
  },
  clearProvider: async (provider) => {
    set({ providerError: null });
    try {
      const result = await ipc.sessions.clear(provider);
      if (result.ok) {
        set((state) => ({ providers: { ...state.providers, [provider]: 'unknown' } }));
      } else {
        set({ providerError: result.error.message });
      }
    } catch (error) {
      set({ providerError: `Could not clear the session: ${String(error)}` });
    }
  },
  loadCategories: async () => {
    try {
      const result = await ipc.presets.list();
      set(result.ok ? { categories: result.value, categoriesError: null } : { categoriesError: result.error.message });
    } catch (error) {
      set({ categoriesError: `Categories failed to load: ${String(error)}` });
    }
  },
  selectCategory: (id) => {
    const { categories, draft } = get();
    const next = categories.find((category) => category.id === id);
    if (!next) return;
    const previous = categories.find((category) => category.id === draft.categoryId);
    detectionRun++; // cancels any detection still running
    set({ draft: { ...applyCategory(draft, next, previous), autoSelected: false }, detection: { status: 'idle' } });
  },
  detectCategory: async () => {
    const { asset, categories, draft } = get();
    if (!asset) return;

    const run = ++detectionRun;
    const prompt = detectionPrompt(draft, categories.find((c) => c.id === draft.categoryId));
    set({ draft: { ...draft, autoSelected: true }, detection: { status: 'loading' } });

    try {
      const result = await ipc.presets.suggestCategory({ assetId: asset.id, prompt });
      if (run !== detectionRun) return;
      if (!result.ok) {
        set({ detection: { status: 'error', message: result.error.message } });
        return;
      }

      const suggestion = result.value;
      const resolved = get().categories.find((c) => c.id === suggestion.categoryId);
      if (!resolved) {
        set({ detection: { status: 'error', message: 'The detected category is not available.' } });
        return;
      }
      set((state) => ({
        detection: { status: 'ok', suggestion },
        draft: applyCategory(
          state.draft,
          resolved,
          state.categories.find((c) => c.id === state.draft.categoryId),
        ),
      }));
    } catch (error) {
      if (run === detectionRun) set({ detection: { status: 'error', message: `Auto-detect failed: ${String(error)}` } });
    }
  },
  chooseAlternative: (id) => {
    const { categories, draft } = get();
    const next = categories.find((category) => category.id === id);
    if (!next) return;
    set({ draft: applyCategory(draft, next, categories.find((c) => c.id === draft.categoryId)) });
  },
  useDetected: () => {
    const { detection } = get();
    if (detection.status === 'ok') get().chooseAlternative(detection.suggestion.categoryId);
  },
  setPrompt: (prompt) => set((state) => ({ draft: { ...state.draft, prompt } })),
  resetPrompt: () => {
    const { categories, draft } = get();
    const category = categories.find((c) => c.id === draft.categoryId);
    if (category?.defaultPrompt) set({ draft: { ...draft, prompt: category.defaultPrompt } });
  },
  setGridMode: (mode) => set((state) => ({ draft: applyGridMode(state.draft, mode) })),
  setGridField: (field, value) => set((state) => ({ draft: { ...state.draft, [field]: value } })),
  setProvider: (provider) => {
    set((state) => ({ draft: { ...state.draft, providerId: provider } }));
    // Opens the provider hidden so the monitor can report a live status for it.
    void get().openProvider(provider, false);
  },
  startJob: async () => {
    const { draft, asset, providers, starting, detection } = get();
    const detecting = detection.status === 'loading';
    if (starting || !asset || startBlockReason(draft, { asset, providers, detecting }) !== null) return;

    const auto = keptSuggestion(draft, detection.status === 'ok' ? detection.suggestion : null);
    set({ starting: true, startError: null });
    try {
      const result = await ipc.intake.createJob(toCreateJobRequest(draft, asset.id, auto));
      if (result.ok) {
        set({ starting: false, job: result.value, route: 'run' });
      } else {
        set({ starting: false, startError: result.error.message });
      }
    } catch (error) {
      set({ starting: false, startError: `Could not start the job: ${String(error)}` });
    }
  },
}));