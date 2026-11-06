// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { JobProgress, JobResultView, TileProgress } from '@ie/contracts';
import { planTiles } from '@ie/slicer';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const plan = planTiles({ width: 800, height: 400, rows: 1, cols: 2, overlapPct: 15 });
const STITCHED_AT = '2026-11-06T10:00:00.000Z';

const tile = (index: number, over: Partial<TileProgress> = {}): TileProgress => ({ index, state: 'accepted', attempts: 1, ...over });
const tiles = (): TileProgress[] => [
  tile(0, { outputPath: 'C:\\out\\0.png' }),
  tile(1, { state: 'needs-review', attempts: 3, outputPath: 'C:\\out\\1.png', note: 'The output is only 218x218 px, too small to use.' }),
];

const stitched = (over: Partial<JobResultView> = {}): JobResultView => ({
  jobId: 'J1',
  imagePath: 'C:\\jobs\\J1\\stitched.png',
  metrics: { seamScore: 1.05, maxDeltaE: 1.2 },
  flagged: [1],
  stitchedAt: STITCHED_AT,
  width: 800,
  height: 400,
  plan,
  sourcePreview: { dataUrl: 'data:image/jpeg;base64,SOURCE', width: 800, height: 400 },
  preview: { dataUrl: 'data:image/jpeg;base64,AFTER', width: 800, height: 400 },
  ...over,
});

const done = (over: Partial<JobProgress> = {}): JobProgress => ({
  jobId: 'J1',
  state: 'done',
  providerId: 'gemini',
  prompt: 'Enhance this tile.',
  grid: { rows: 1, cols: 2 },
  completedTiles: 1,
  totalTiles: 2,
  tiles: tiles(),
  result: { imagePath: 'C:\\jobs\\J1\\stitched.png', metrics: { seamScore: 1.05, maxDeltaE: 1.2 }, flagged: [1], stitchedAt: STITCHED_AT },
  ...over,
});

async function openResult(initial: JobProgress = done(), image: JobResultView = stitched()) {
  bridge.result.mockResolvedValue({ ok: true, value: image });
  useShellStore.setState({ activeJobId: 'J1', route: 'result' });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'Result' });
  act(() => bridge.emitProgress(initial));
  await screen.findByTestId('quality-badge');
  return user;
}

const flaggedRow = (index: number) => screen.getByTestId(`flagged-tile-${index}`);

describe('Result: the stitched picture', () => {
  it('loads the pictures and metrics over IPC and shows before and after', async () => {
    await openResult();
    expect(bridge.result).toHaveBeenCalledExactlyOnceWith({ jobId: 'J1', maxSide: 4096 });
    expect(screen.getByAltText('The original picture')).toHaveAttribute('src', 'data:image/jpeg;base64,SOURCE');
    expect(screen.getByAltText('The stitched picture')).toHaveAttribute('src', 'data:image/jpeg;base64,AFTER');
    expect(screen.getByTestId('quality-badge')).toHaveTextContent('Clean seams');
    expect(screen.getByTestId('quality-badge')).toHaveTextContent('Seam score 1.05');
    expect(screen.getByTestId('quality-badge')).toHaveTextContent('1 tile flagged');
    expect(screen.getByTestId('result-summary')).toHaveTextContent('1 tile flagged');
  });

  it('says the seams are visible when the score is poor', async () => {
    await openResult(done(), stitched({ metrics: { seamScore: 1.8, maxDeltaE: 4.2 }, flagged: [] }));
    expect(screen.getByTestId('quality-badge')).toHaveAttribute('data-band', 'visible');
    expect(screen.getByTestId('quality-badge')).toHaveTextContent('Visible seams');
    expect(screen.getByTestId('quality-badge')).toHaveTextContent('no tiles flagged');
  });

  it('moves the comparison with the keyboard and the mouse', async () => {
    const user = await openResult();
    const slider = screen.getByRole('slider', { name: 'Compare before and after' });
    expect(slider).toHaveValue('50');
    expect(slider).toHaveAttribute('aria-valuetext', '50% of the original shown');

    slider.focus();
    await user.keyboard('{ArrowRight}');
    expect(slider).toHaveValue('51');
    expect(screen.getByTestId('compare-after').style.clipPath).toContain('51%');

    fireEvent.change(slider, { target: { value: '20' } });
    expect(slider).toHaveValue('20');
    expect(screen.getByTestId('compare-after').style.clipPath).toContain('20%');
    expect(slider).toHaveAttribute('aria-valuetext', '20% of the original shown');
  });

  it('zooms in steps, stops at the limit, and resets', async () => {
    const user = await openResult();
    const frame = screen.getByTestId('compare-frame');
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' });
    const reset = screen.getByRole('button', { name: 'Reset zoom' });

    expect(frame).toHaveStyle({ width: '100%' });
    expect(zoomOut).toBeDisabled();
    expect(reset).toBeDisabled();

    await user.click(zoomIn);
    expect(frame).toHaveStyle({ width: '150%' });
    expect(screen.getByText('Zoom 150%')).toBeInTheDocument();
    expect(zoomOut).toBeEnabled();

    await user.click(zoomIn);
    await user.click(zoomIn);
    await user.click(zoomIn);
    await user.click(zoomIn);
    await user.click(zoomIn);
    await user.click(zoomIn);
    expect(frame).toHaveStyle({ width: '400%' });
    expect(zoomIn).toBeDisabled();

    await user.click(reset);
    expect(frame).toHaveStyle({ width: '100%' });
    expect(reset).toBeDisabled();
  });

  it('turns the seam overlay on and off without asking for another stitch', async () => {
    const user = await openResult();
    const toggle = screen.getByRole('checkbox', { name: 'Show seam overlay' });
    expect(toggle).toBeChecked();
    expect(screen.getByTestId('seam-overlay')).toBeInTheDocument();

    await user.click(toggle);
    expect(screen.queryByTestId('seam-overlay')).toBeNull();
    await user.click(toggle);
    expect(screen.getByTestId('seam-overlay')).toBeInTheDocument();
    expect(bridge.result).toHaveBeenCalledTimes(1);
  });

  it('keeps the shown picture while a tile is fixed, then loads the re-stitched one without restarting', async () => {
    bridge.result
      .mockResolvedValueOnce({ ok: true, value: stitched({ preview: { dataUrl: 'data:image/jpeg;base64,ONE', width: 800, height: 400 } }) })
      .mockResolvedValueOnce({ ok: true, value: stitched({ stitchedAt: '2026-11-06T10:05:00.000Z', preview: { dataUrl: 'data:image/jpeg;base64,TWO', width: 800, height: 400 } }) });
    useShellStore.setState({ activeJobId: 'J1', route: 'result' });
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Result' });
    act(() => bridge.emitProgress(done()));
    await waitFor(() => expect(screen.getByAltText('The stitched picture')).toHaveAttribute('src', 'data:image/jpeg;base64,ONE'));

    act(() => bridge.emitProgress(done({ state: 'running' })));
    expect(screen.getByText('The picture shown is from the last time it was put together.')).toBeInTheDocument();
    expect(screen.getByAltText('The stitched picture')).toHaveAttribute('src', 'data:image/jpeg;base64,ONE');

    act(() =>
      bridge.emitProgress(
        done({
          result: { imagePath: 'C:\\jobs\\J1\\stitched.png', metrics: { seamScore: 1.02, maxDeltaE: 0.9 }, flagged: [], stitchedAt: '2026-11-06T10:05:00.000Z' },
        }),
      ),
    );
    await waitFor(() => expect(bridge.result).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByAltText('The stitched picture')).toHaveAttribute('src', 'data:image/jpeg;base64,TWO'));
    expect(bridge.startJob).not.toHaveBeenCalled();

    // A further event that carries the same re-stitch does not fetch the picture again.
    act(() =>
      bridge.emitProgress(
        done({
          result: { imagePath: 'C:\\jobs\\J1\\stitched.png', metrics: { seamScore: 1.02, maxDeltaE: 0.9 }, flagged: [], stitchedAt: '2026-11-06T10:05:00.000Z' },
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridge.result).toHaveBeenCalledTimes(2);
  });

  it('opens from the Run screen with See the result once the job is done', async () => {
    bridge.result.mockResolvedValue({ ok: true, value: stitched() });
    useShellStore.setState({ activeJobId: 'J1', route: 'run' });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Run' });
    act(() => bridge.emitProgress(done()));
    await user.click(screen.getByRole('button', { name: 'See the result' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Result' })).toBeInTheDocument();
    expect(bridge.result).toHaveBeenCalledWith({ jobId: 'J1', maxSide: 4096 });
  });
});

describe('Result: flagged tiles and their actions', () => {
  it('lists each flagged tile with its reason, state and a link to the tile map', async () => {
    const user = await openResult();
    const row = flaggedRow(1);
    expect(within(row).getByText(/Tile 2/)).toBeInTheDocument();
    expect(row).toHaveTextContent('Needs review');
    expect(row).toHaveTextContent('too small to use');
    expect(within(row).getByRole('button', { name: 'Accept tile 2 as it is' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Try tile 2 again' })).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Show tile 2 in the tile map' }));
    expect(screen.getByTestId('result-tile-map-1')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('result-tile-map-0')).not.toHaveAttribute('aria-current');
  });

  it('keeps a flagged tile as it is, saying when it is working and when it is done', async () => {
    const accepted = done({ tiles: [tile(0, { outputPath: 'C:\\out\\0.png' }), tile(1, { state: 'accepted', attempts: 3, outputPath: 'C:\\out\\1.png' })], completedTiles: 2 });
    let finish!: (value: unknown) => void;
    bridge.acceptTile.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const user = await openResult();

    const accept = within(flaggedRow(1)).getByRole('button', { name: 'Accept tile 2 as it is' });
    accept.focus();
    await user.keyboard('{Enter}');
    expect(bridge.acceptTile).toHaveBeenCalledExactlyOnceWith('J1', 1);
    expect(await screen.findByText('Keeping tile 2 as it is…')).toBeInTheDocument();

    await act(async () => finish({ ok: true, value: accepted }));
    expect(await screen.findByText('Tile 2 kept as it is.')).toBeInTheDocument();
    await waitFor(() => expect(within(flaggedRow(1)).queryByRole('button', { name: 'Accept tile 2 as it is' })).toBeNull());
  });

  it('tries one tile again from the keyboard and shows the refusal', async () => {
    bridge.rerunTile.mockResolvedValue({ ok: false, error: { code: 'illegal', message: 'The provider is busy right now.' } });
    const user = await openResult();
    const again = within(flaggedRow(1)).getByRole('button', { name: 'Try tile 2 again' });
    again.focus();
    await user.keyboard('{Enter}');
    expect(bridge.rerunTile).toHaveBeenCalledExactlyOnceWith('J1', 1);
    expect(await screen.findByRole('alert')).toHaveTextContent('The provider is busy right now.');
  });

  it('edits the prompt and the source picture, saves both, then runs the tile again', async () => {
    bridge.setTileOverride.mockResolvedValue({ ok: true, value: done() });
    bridge.rerunTile.mockResolvedValue({ ok: true, value: done({ state: 'running' }) });
    bridge.pathFor.mockReturnValue('C:\\replacement.png');
    const user = await openResult();

    await user.click(within(flaggedRow(1)).getByRole('button', { name: 'Change prompt or picture' }));
    const prompt = screen.getByLabelText('Tile 2 prompt');
    expect(prompt).toHaveAttribute('placeholder', 'Enhance this tile.');
    await user.clear(prompt);
    await user.type(prompt, 'Keep the window matte.');
    await user.upload(screen.getByLabelText('A different picture for tile 2 (optional)'), new File(['x'], 'replacement.png', { type: 'image/png' }));
    expect(screen.getByText('Chosen: C:\\replacement.png')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save and try again' }));
    expect(bridge.setTileOverride).toHaveBeenCalledExactlyOnceWith('J1', 1, { prompt: 'Keep the window matte.', sourcePath: 'C:\\replacement.png' });
    expect(bridge.rerunTile).toHaveBeenCalledExactlyOnceWith('J1', 1);
    expect(await screen.findByText('Tile 2 will use the new settings. It is being tried again.')).toBeInTheDocument();
  });

  it('clears a tile’s own source picture', async () => {
    bridge.setTileOverride.mockResolvedValue({ ok: true, value: done() });
    bridge.rerunTile.mockResolvedValue({ ok: true, value: done({ state: 'running' }) });
    const withSource = done({
      tiles: [tile(0, { outputPath: 'C:\\out\\0.png' }), tile(1, { state: 'needs-review', attempts: 3, outputPath: 'C:\\out\\1.png', sourceOverride: 'C:\\jobs\\J1\\tiles\\tile-001-source.png', promptOverride: 'Keep it matte.' })],
    });
    const user = await openResult(withSource);
    await user.click(within(flaggedRow(1)).getByRole('button', { name: 'Change prompt or picture' }));
    expect(screen.getByLabelText('Tile 2 prompt')).toHaveValue('Keep it matte.');
    expect(screen.getByText(/uses its own picture/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Use its slice of the original again' }));
    await user.click(screen.getByRole('button', { name: 'Save and try again' }));
    expect(bridge.setTileOverride).toHaveBeenCalledWith('J1', 1, { prompt: 'Keep it matte.', sourcePath: null });
  });

  it('says when the picture has not been put together yet', async () => {
    bridge.result.mockResolvedValue({ ok: false, error: { code: 'illegal', message: 'The picture has not been put together yet.' } });
    useShellStore.setState({ activeJobId: 'J1', route: 'result' });
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Result' });
    const notStitched = done();
    delete notStitched.result;
    act(() => bridge.emitProgress(notStitched));
    expect(await screen.findByRole('alert')).toHaveTextContent('The picture has not been put together yet.');
  });
});

describe('Result: saving the finished picture', () => {
  it('saves a PNG by default and shows where it went', async () => {
    const user = await openResult();
    await user.click(screen.getByRole('button', { name: 'Save the picture' }));
    expect(bridge.saveExport).toHaveBeenCalledExactlyOnceWith({ imagePath: 'C:\\jobs\\J1\\stitched.png', format: 'png' });
    expect(await screen.findByRole('status')).toHaveTextContent('Saved to C:\\Pictures\\enhanced.png (800 × 400).');
  });

  it('saves JPEG or WebP at the chosen quality', async () => {
    const user = await openResult();
    await user.selectOptions(screen.getByLabelText('Format'), 'jpeg');
    fireEvent.change(screen.getByLabelText('Quality'), { target: { value: '80' } });
    await user.click(screen.getByRole('button', { name: 'Save the picture' }));
    expect(bridge.saveExport).toHaveBeenCalledWith({ imagePath: 'C:\\jobs\\J1\\stitched.png', format: 'jpeg', quality: 80 });
  });

  it('reports a cancelled save without treating it as an error', async () => {
    bridge.saveExport.mockResolvedValue({ ok: false, error: { code: 'cancelled', message: 'Saving was cancelled.' } });
    const user = await openResult();
    await user.click(screen.getByRole('button', { name: 'Save the picture' }));
    expect(await screen.findByText('Saving was cancelled.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows why a save failed', async () => {
    bridge.saveExport.mockResolvedValue({ ok: false, error: { code: 'invalid_request', message: 'The disk is full.' } });
    const user = await openResult();
    await user.click(screen.getByRole('button', { name: 'Save the picture' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The disk is full.');
  });
});

describe('Result: inspecting the before and after', () => {
  it('shows the original or the enhanced picture on its own', async () => {
    const user = await openResult();
    expect(screen.getByTestId('compare-divider')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Original only' }));
    expect(screen.getByAltText('The original picture')).toBeInTheDocument();
    expect(screen.queryByTestId('compare-after')).toBeNull();
    expect(screen.queryByTestId('compare-divider')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Enhanced only' }));
    expect(screen.queryByAltText('The original picture')).toBeNull();
    expect(screen.getByTestId('compare-after')).toHaveAttribute('src', 'data:image/jpeg;base64,AFTER');
  });
});
