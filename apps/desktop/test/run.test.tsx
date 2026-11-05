// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { JobProgress, TileProgress, TileState } from '@ie/contracts';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../renderer/src/App';
import { clearThumbnailCache } from '../renderer/src/hooks/useTileThumbnail';
import { TILE_STATE_LABELS } from '../renderer/src/labels';
import { useShellStore } from '../renderer/src/store';
import { installBridge } from './fakeBridge';

let bridge: ReturnType<typeof installBridge>;

beforeEach(() => {
  bridge = installBridge();
  clearThumbnailCache();
});
afterEach(cleanup);

const tile = (index: number, state: TileState = 'pending', over: Partial<TileProgress> = {}): TileProgress => ({ index, state, attempts: state === 'pending' ? 0 : 1, ...over });

const progress = (rows: number, cols: number, states: Array<TileState | TileProgress> = [], over: Partial<JobProgress> = {}): JobProgress => {
  const tiles = Array.from({ length: rows * cols }, (_, i) => {
    const s = states[i];
    return typeof s === 'object' ? s : tile(i, s ?? 'pending');
  });
  return {
    jobId: 'J1',
    state: 'running',
    providerId: 'gemini',
    grid: { rows, cols },
    completedTiles: tiles.filter((t) => t.state === 'accepted').length,
    totalTiles: tiles.length,
    tiles,
    ...over,
  };
};

async function openRun(initial?: JobProgress) {
  useShellStore.setState({ activeJobId: 'J1', route: 'run' });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'Run' });
  if (initial) act(() => bridge.emitProgress(initial));
  return user;
}

const cells = () => screen.getAllByTestId(/^run-tile-\d+$/);
const cell = (i: number) => screen.getByTestId(`run-tile-${i}`);

describe('Run: the tile grid', () => {
  it.each([
    ['6 tiles (3×2)', 2, 3],
    ['8 tiles (4×2)', 2, 4],
    ['custom 3×2', 3, 2],
    ['custom 1×5', 1, 5],
    ['a single tile', 1, 1],
  ])('draws %s as %i rows by %i columns', async (_name, rows, cols) => {
    await openRun(progress(rows, cols));
    expect(cells()).toHaveLength(rows * cols);
    const list = screen.getByRole('list', { name: `Tiles, ${rows} rows by ${cols} columns` });
    expect(list.style.gridTemplateColumns).toBe(`repeat(${cols}, minmax(0, 1fr))`);
    expect(cells().map((c) => c.textContent?.match(/Tile (\d+)/)?.[1])).toEqual(Array.from({ length: rows * cols }, (_, i) => String(i + 1)));
  });

  it('shows each tile with its state as a word and a symbol, never colour alone', async () => {
    const states: TileState[] = ['pending', 'running', 'accepted', 'retrying', 'needs-review', 'failed'];
    await openRun(progress(2, 3, states));
    states.forEach((state, i) => {
      const { label, symbol } = TILE_STATE_LABELS[state];
      expect(cell(i)).toHaveAttribute('data-state', state);
      expect(within(cell(i)).getByText(label, { exact: false })).toBeInTheDocument(); // the word
      expect(cell(i).textContent).toContain(symbol); // the symbol
    });
    // Every state looks different from every other: its own word, symbol and border.
    expect(new Set(states.map((s) => TILE_STATE_LABELS[s].label)).size).toBe(6);
    expect(new Set(states.map((s) => TILE_STATE_LABELS[s].symbol)).size).toBe(6);
    expect(new Set(states.map((_, i) => cell(i).className)).size).toBe(6);
  });

  it('says which try a retried tile is on, and why a tile was set aside', async () => {
    await openRun(progress(1, 3, [tile(0, 'retrying', { attempts: 2 }), tile(1, 'needs-review', { attempts: 3, note: 'The output no longer matches the source tile.' }), tile(2, 'accepted', { note: 'old note' })]));
    expect(cell(0)).toHaveTextContent('Retrying, try 2');
    expect(cell(1)).toHaveTextContent('Needs review, try 3');
    expect(cell(1)).toHaveTextContent('no longer matches the source tile');
    expect(cell(2)).not.toHaveTextContent('old note'); // a note on an accepted tile is history
  });

  it('shows a thumbnail for a tile with an output, and a symbol until then', async () => {
    await openRun(progress(1, 3, [tile(0, 'accepted', { outputPath: 'C:\\out\\0.png' }), tile(1, 'running'), tile(2)]));
    await waitFor(() => expect(within(cell(0)).getByRole('presentation', { hidden: true })).toHaveAttribute('src', 'data:image/jpeg;base64,BBBB'));
    expect(within(cell(1)).queryByRole('presentation', { hidden: true })).toBeNull();
    expect(bridge.tileThumbnail).toHaveBeenCalledTimes(1);
    expect(bridge.tileThumbnail).toHaveBeenCalledWith({ jobId: 'J1', index: 0, maxSide: 160 });
  });

  it('fetches a thumbnail again only when the tile output changes, not on every progress event', async () => {
    await openRun(progress(1, 2, [tile(0, 'accepted', { outputPath: 'C:\\out\\0-try1.png' }), tile(1)]));
    await waitFor(() => expect(bridge.tileThumbnail).toHaveBeenCalledTimes(1));

    act(() => bridge.emitProgress(progress(1, 2, [tile(0, 'accepted', { outputPath: 'C:\\out\\0-try1.png' }), tile(1, 'running')])));
    act(() => bridge.emitProgress(progress(1, 2, [tile(0, 'accepted', { outputPath: 'C:\\out\\0-try1.png' }), tile(1, 'running', { attempts: 2 })])));
    expect(bridge.tileThumbnail).toHaveBeenCalledTimes(1);

    act(() => bridge.emitProgress(progress(1, 2, [tile(0, 'accepted', { outputPath: 'C:\\out\\0-try2.png' }), tile(1)])));
    await waitFor(() => expect(bridge.tileThumbnail).toHaveBeenCalledTimes(2));
  });

  it('copes with a thumbnail that cannot be made', async () => {
    bridge.tileThumbnail.mockResolvedValue({ ok: false, error: { code: 'invalid_request', message: 'gone' } });
    await openRun(progress(1, 1, [tile(0, 'accepted', { outputPath: 'C:\\gone.png' })]));
    await waitFor(() => expect(bridge.tileThumbnail).toHaveBeenCalled());
    expect(cell(0)).toHaveTextContent('Done');
    expect(within(cell(0)).queryByRole('presentation', { hidden: true })).toBeNull();
  });
});

describe('Run: live progress from events', () => {
  it('updates tiles and the overall progress as events arrive, without asking for them', async () => {
    await openRun(progress(2, 2, ['running', 'pending', 'pending', 'pending']));
    const bar = () => screen.getByRole('progressbar') as HTMLProgressElement;
    expect(bar()).toHaveValue(0);
    expect(screen.getByText('0 of 4 tiles done')).toBeInTheDocument();

    act(() => bridge.emitProgress(progress(2, 2, ['accepted', 'running', 'pending', 'pending'])));
    expect(cell(0)).toHaveAttribute('data-state', 'accepted');
    expect(cell(1)).toHaveAttribute('data-state', 'running');
    expect(bar()).toHaveValue(1);
    expect(screen.getByText('1 of 4 tiles done')).toBeInTheDocument();

    act(() => bridge.emitProgress(progress(2, 2, ['accepted', 'accepted', 'accepted', 'accepted'], { state: 'done' })));
    expect(bar()).toHaveValue(4);
    expect(screen.getByTestId('job-summary')).toHaveTextContent('Done');

    // Everything above came from pushed events: nothing was polled.
    expect(bridge.getJob).not.toHaveBeenCalled();
    expect(bridge.listRecent).not.toHaveBeenCalled();
  });

  it('ignores events about other jobs', async () => {
    await openRun(progress(1, 2, ['running', 'pending']));
    act(() => bridge.emitProgress({ ...progress(1, 2, ['accepted', 'accepted']), jobId: 'OTHER' }));
    expect(cell(0)).toHaveAttribute('data-state', 'running');
    expect(useShellStore.getState().progress.OTHER).toBeDefined(); // remembered, just not shown
  });

  it('subscribes once for the whole app and lets go when it closes', async () => {
    await openRun();
    expect(bridge.progressListenerCount()).toBe(1);
    cleanup();
    expect(bridge.progressListenerCount()).toBe(0);
  });

  it('shows why a job is paused or failed', async () => {
    await openRun(progress(1, 2, ['accepted', 'pending'], { state: 'paused', pauseReason: 'challenge' }));
    expect(screen.getByText('Paused: The provider asked for a human check.')).toBeInTheDocument();

    act(() => bridge.emitProgress(progress(1, 2, ['accepted', 'failed'], { state: 'failed', error: 'Missing selector: submitButton' })));
    expect(screen.getByRole('alert')).toHaveTextContent('Missing selector: submitButton');
    expect(screen.queryByText(/^Paused:/)).toBeNull();
  });

  it('keeps an activity list from the log events', async () => {
    const user = await openRun(progress(1, 1, ['running']));
    act(() => {
      bridge.emitLog({ jobId: 'J1', level: 'info', message: 'Tile 1: pending → running (attempt 1)' });
      bridge.emitLog({ jobId: 'J1', level: 'info', message: 'Tile 1: running → accepted' });
      bridge.emitLog({ jobId: 'OTHER', level: 'info', message: 'not mine' });
    });
    await user.click(screen.getByText('Activity (2)'));
    expect(screen.getByText('Tile 1: running → accepted')).toBeInTheDocument();
    expect(screen.queryByText('not mine')).toBeNull();
  });

  it('keeps only the latest activity lines', async () => {
    await openRun(progress(1, 1));
    act(() => {
      for (let i = 0; i < 130; i++) bridge.emitLog({ jobId: 'J1', level: 'info', message: `line ${i}` });
    });
    const lines = useShellStore.getState().jobLog.J1!;
    expect(lines).toHaveLength(100);
    expect(lines.at(-1)).toBe('line 129');
  });
});

describe('Run: survives navigation', () => {
  it('shows the same job, with events that arrived while elsewhere, when you come back', async () => {
    const user = await openRun(progress(1, 3, ['accepted', 'running', 'pending']));
    await user.click(screen.getByRole('button', { name: 'Home' }));
    await screen.findByTestId('dropzone');

    // Progress keeps arriving while another screen is open.
    act(() => bridge.emitProgress(progress(1, 3, ['accepted', 'accepted', 'running'])));

    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(cell(1)).toHaveAttribute('data-state', 'accepted');
    expect(cell(2)).toHaveAttribute('data-state', 'running');
    expect(screen.getByText('2 of 3 tiles done')).toBeInTheDocument();
  });

  it('says there is no job when none was opened', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Run' }));
    expect(screen.getByText('No job yet. Set one up and press Start.')).toBeInTheDocument();
  });

  it('shows a loading note until the first progress arrives, then the job', async () => {
    await openRun();
    expect(screen.getByRole('status')).toHaveTextContent('Loading the job…');
    act(() => bridge.emitProgress(progress(1, 2)));
    expect(cells()).toHaveLength(2);
  });
});

describe('Start runs the job', () => {
  it('starts the saved job in the background after creating it, and opens Run on it', async () => {
    const job = { id: 'JOB1', categoryId: 'env-realistic', grid: { rows: 2, cols: 3, overlapPct: 15 }, providerId: 'gemini' } as never;
    bridge.createJob.mockResolvedValue({ ok: true, value: job });
    useShellStore.setState({
      asset: { id: 'A1', path: 'C:\\p.png', width: 3000, height: 2000, sha256: 'a'.repeat(64) },
      providers: { gpt: 'unknown', gemini: 'ready', grok: 'unknown' },
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Setup' }));
    await user.click(await screen.findByRole('radio', { name: /Realistic environment/ }));
    await user.click(screen.getByRole('radio', { name: /Gemini/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Start' }));

    await screen.findByRole('heading', { level: 1, name: 'Run' });
    expect(bridge.startJob).toHaveBeenCalledExactlyOnceWith('JOB1');
    expect(useShellStore.getState().activeJobId).toBe('JOB1');
    act(() => bridge.emitProgress({ ...progress(2, 3), jobId: 'JOB1' }));
    expect(cells()).toHaveLength(6);
  });

  it('shows the reason when the run cannot be started', async () => {
    bridge.startJob.mockResolvedValue({ ok: false, error: { code: 'invalid_request', message: 'Another job is already using gemini.' } });
    const job = { id: 'JOB1', categoryId: 'env-realistic', grid: { rows: 1, cols: 2, overlapPct: 15 }, providerId: 'gemini' } as never;
    bridge.createJob.mockResolvedValue({ ok: true, value: job });
    useShellStore.setState({
      asset: { id: 'A1', path: 'C:\\p.png', width: 3000, height: 2000, sha256: 'a'.repeat(64) },
      providers: { gpt: 'unknown', gemini: 'ready', grok: 'unknown' },
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Setup' }));
    await user.click(await screen.findByRole('radio', { name: /Realistic environment/ }));
    await user.click(screen.getByRole('radio', { name: /Gemini/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Another job is already using gemini.');
  });
});

describe('Home: recent jobs from the job store', () => {
  const summaries = [
    { id: 'PAUSED1', createdAt: '2026-11-05T10:00:00Z', state: 'paused' as const, completedTiles: 2, totalTiles: 6 },
    { id: 'DONE1', createdAt: '2026-11-04T10:00:00Z', state: 'done' as const, completedTiles: 6, totalTiles: 6 },
    { id: 'RUN1', createdAt: '2026-11-03T10:00:00Z', state: 'running' as const, completedTiles: 1, totalTiles: 4 },
  ];

  it('loads the list from the job store when Home opens', async () => {
    bridge.listRecent.mockResolvedValue({ ok: true, value: summaries });
    render(<App />);
    expect(await screen.findByText('PAUSED1 — paused (2/6 tiles)')).toBeInTheDocument();
    expect(screen.getByText('DONE1 — done (6/6 tiles)')).toBeInTheDocument();
    expect(bridge.listRecent).toHaveBeenCalledWith(10);
  });

  it('can resume a paused job, and one that was running when the app closed, but not a finished one', async () => {
    bridge.listRecent.mockResolvedValue({ ok: true, value: summaries });
    render(<App />);
    await screen.findByText('PAUSED1 — paused (2/6 tiles)');
    expect(screen.getByRole('button', { name: 'Resume job PAUSED1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume job RUN1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume job DONE1' })).toBeNull();
  });

  it('resuming asks the main process to continue it and opens it on the Run screen', async () => {
    bridge.listRecent.mockResolvedValue({ ok: true, value: summaries });
    bridge.resumeJob.mockResolvedValue({ ok: true, value: { ...progress(2, 3, ['accepted', 'accepted', 'running', 'pending', 'pending', 'pending']), jobId: 'PAUSED1' } });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Resume job PAUSED1' }));

    expect(bridge.resumeJob).toHaveBeenCalledExactlyOnceWith('PAUSED1');
    expect(await screen.findByRole('heading', { level: 1, name: 'Run' })).toBeInTheDocument();
    await waitFor(() => expect(cells()).toHaveLength(6));
    expect(screen.getByTestId('job-summary')).toHaveTextContent('PAUSED1');
  });

  it('shows why a resume was refused', async () => {
    bridge.listRecent.mockResolvedValue({ ok: true, value: summaries });
    bridge.resumeJob.mockResolvedValue({ ok: false, error: { code: 'invalid_request', message: 'Another job is already using gemini.' } });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Resume job PAUSED1' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Another job is already using gemini.');
  });

  it('opens any job to look at it, loading its current state', async () => {
    bridge.listRecent.mockResolvedValue({ ok: true, value: summaries });
    bridge.getJob.mockResolvedValue({ ok: true, value: { ...progress(1, 6, ['accepted', 'accepted', 'accepted', 'accepted', 'accepted', 'accepted'], { state: 'done' }), jobId: 'DONE1' } });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Open job DONE1' }));
    expect(bridge.getJob).toHaveBeenCalledWith('DONE1');
    await waitFor(() => expect(cells()).toHaveLength(6));
    expect(bridge.resumeJob).not.toHaveBeenCalled();
  });

  it('keeps the list it has when the job store cannot be read', async () => {
    useShellStore.setState({ recentJobs: summaries });
    bridge.listRecent.mockResolvedValue({ ok: false, error: { code: 'internal', message: 'db' } });
    render(<App />);
    expect(await screen.findByText('PAUSED1 — paused (2/6 tiles)')).toBeInTheDocument();
  });
});
