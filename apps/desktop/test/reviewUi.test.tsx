// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { JobProgress, TileProgress, TileState } from '@ie/contracts';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../renderer/src/App';
import { clearThumbnailCache } from '../renderer/src/hooks/useTileThumbnail';
import { useShellStore } from '../renderer/src/store';
import { installBridge } from './fakeBridge';

let bridge: ReturnType<typeof installBridge>;
beforeEach(() => {
  bridge = installBridge();
  clearThumbnailCache();
});
afterEach(cleanup);

const tile = (index: number, state: TileState, over: Partial<TileProgress> = {}): TileProgress => ({ index, state, attempts: state === 'pending' ? 0 : 1, ...over });
const reviewing = (tiles: TileProgress[], over: Partial<JobProgress> = {}): JobProgress => ({
  jobId: 'J1',
  state: 'needs-review',
  providerId: 'gemini',
  grid: { rows: 1, cols: tiles.length },
  completedTiles: tiles.filter((t) => t.state === 'accepted').length,
  totalTiles: tiles.length,
  tiles,
  ...over,
});

async function open(progress: JobProgress) {
  useShellStore.setState({ activeJobId: 'J1', route: 'run' });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'Run' });
  act(() => bridge.emitProgress(progress));
  return user;
}

const panel = () => screen.getByTestId('review-panel');
const cell = (i: number) => screen.getByTestId(`run-tile-${i}`);

describe('review panel', () => {
  const mixed = () => reviewing([tile(0, 'accepted'), tile(1, 'needs-review', { attempts: 3, outputPath: 'C:\\o\\1.png', note: 'The output is only 218x218 px, too small to use.' }), tile(2, 'failed', { note: 'page changed' })]);

  it('says how many tiles need a decision and what each choice does', async () => {
    await open(mixed());
    expect(within(panel()).getByRole('heading')).toHaveTextContent('2 tiles need your decision');
    expect(panel()).toHaveTextContent('Accept as is');
    expect(panel()).toHaveTextContent('Try again');
    expect(screen.getByText(/too small to use/)).toBeInTheDocument(); // the reason is visible on the tile
  });

  it('uses the singular for one tile', async () => {
    await open(reviewing([tile(0, 'accepted'), tile(1, 'needs-review', { outputPath: 'C:\\o.png' })]));
    expect(within(panel()).getByRole('heading')).toHaveTextContent('1 tile needs your decision');
  });

  it('a set-aside tile offers Accept as is and Try again; a failed tile offers only Try again', async () => {
    await open(mixed());
    expect(within(cell(1)).getByRole('button', { name: 'Accept tile 2 as it is' })).toBeInTheDocument();
    expect(within(cell(1)).getByRole('button', { name: 'Try tile 2 again' })).toBeInTheDocument();
    expect(within(cell(2)).queryByRole('button', { name: /Accept/ })).toBeNull();
    expect(within(cell(2)).getByRole('button', { name: 'Try tile 3 again' })).toBeInTheDocument();
    expect(within(cell(0)).queryByRole('button')).toBeNull(); // nothing to decide on a finished tile
  });

  it('shows the picture the provider gave, so there is something to judge', async () => {
    await open(mixed());
    await waitFor(() => expect(bridge.tileThumbnail).toHaveBeenCalledWith({ jobId: 'J1', index: 1, maxSide: 160 }));
    await waitFor(() => expect(within(cell(1)).getByRole('presentation', { hidden: true })).toHaveAttribute('src', 'data:image/jpeg;base64,BBBB'));
  });

  it('Accept as is and Try again call the main process for that tile', async () => {
    bridge.acceptTile.mockResolvedValue({ ok: true, value: reviewing([tile(0, 'accepted'), tile(1, 'accepted', { outputPath: 'C:\\o\\1.png' }), tile(2, 'failed')]) });
    bridge.rerunTile.mockResolvedValue({ ok: true, value: { ...mixed(), state: 'running' } });
    const user = await open(mixed());

    await user.click(within(cell(1)).getByRole('button', { name: 'Accept tile 2 as it is' }));
    expect(bridge.acceptTile).toHaveBeenCalledExactlyOnceWith('J1', 1);
    await waitFor(() => expect(cell(1)).toHaveAttribute('data-state', 'accepted'));

    await user.click(within(cell(2)).getByRole('button', { name: 'Try tile 3 again' }));
    expect(bridge.rerunTile).toHaveBeenCalledExactlyOnceWith('J1', 2);
    await waitFor(() => expect(screen.queryByTestId('review-panel')).toBeNull()); // the job is running again
  });

  it('puts the picture together only once every tile is decided', async () => {
    const user = await open(mixed());
    const finish = () => within(panel()).getByRole('button', { name: 'Put the picture together' });
    expect(finish()).toBeDisabled();
    expect(panel()).toHaveTextContent('Decide on every marked tile first.');

    act(() => bridge.emitProgress(reviewing([tile(0, 'accepted'), tile(1, 'accepted', { outputPath: 'C:\\o.png' }), tile(2, 'accepted', { outputPath: 'C:\\p.png' })])));
    expect(within(panel()).getByRole('heading')).toHaveTextContent('All tiles are settled');
    expect(finish()).toBeEnabled();

    bridge.finishReview.mockResolvedValue({ ok: true, value: reviewing([tile(0, 'accepted'), tile(1, 'accepted'), tile(2, 'accepted')], { state: 'stitching' }) });
    await user.click(finish());
    expect(bridge.finishReview).toHaveBeenCalledExactlyOnceWith('J1');
    await waitFor(() => expect(screen.queryByTestId('review-panel')).toBeNull());
    expect(screen.getByTestId('job-summary')).toHaveTextContent('Putting the picture together');
  });

  it('offers to accept every set-aside tile at once when there are several', async () => {
    bridge.acceptTile.mockImplementation(async (_id: string, index: number) => ({ ok: true, value: reviewing([tile(0, 'accepted'), tile(1, index >= 1 ? 'accepted' : 'needs-review', { outputPath: 'C:\\1.png' }), tile(2, index >= 2 ? 'accepted' : 'needs-review', { outputPath: 'C:\\2.png' })]) }));
    const user = await open(reviewing([tile(0, 'accepted'), tile(1, 'needs-review', { outputPath: 'C:\\1.png' }), tile(2, 'needs-review', { outputPath: 'C:\\2.png' })]));
    await user.click(screen.getByRole('button', { name: 'Accept all 2 as they are' }));
    await waitFor(() => expect(bridge.acceptTile).toHaveBeenCalledTimes(2));
    expect(bridge.acceptTile.mock.calls.map((c) => c[1])).toEqual([1, 2]);
  });

  it('does not offer "accept all" for a single tile', async () => {
    await open(reviewing([tile(0, 'accepted'), tile(1, 'needs-review', { outputPath: 'C:\\1.png' })]));
    expect(screen.queryByRole('button', { name: /Accept all/ })).toBeNull();
  });

  it('shows the reason when an action is refused', async () => {
    bridge.acceptTile.mockResolvedValue({ ok: false, error: { code: 'invalid_request', message: 'This tile has no picture to keep. Try it again instead.' } });
    const user = await open(mixed());
    await user.click(within(cell(1)).getByRole('button', { name: 'Accept tile 2 as it is' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no picture to keep');
  });

  it('is not shown while the job is running or finished, and tiles have no review buttons then', async () => {
    await open(reviewing([tile(0, 'accepted'), tile(1, 'needs-review', { outputPath: 'C:\\1.png' })], { state: 'running' }));
    expect(screen.queryByTestId('review-panel')).toBeNull();
    expect(screen.queryByRole('button', { name: /Try tile/ })).toBeNull();
  });

  it('every review control works from the keyboard', async () => {
    bridge.rerunTile.mockResolvedValue({ ok: true, value: { ...mixed(), state: 'running' } });
    const user = await open(mixed());
    within(cell(2)).getByRole('button', { name: 'Try tile 3 again' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(bridge.rerunTile).toHaveBeenCalledWith('J1', 2));
  });
});
