// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ImageAsset } from '@ie/contracts';
import { listCategories } from '@ie/presets';
import { planTiles } from '@ie/slicer';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../renderer/src/App';
import { GridOverlay } from '../renderer/src/components/GridOverlay';
import { useShellStore } from '../renderer/src/store';
import { installBridge } from './fakeBridge';

afterEach(cleanup);

describe('GridOverlay', () => {
  const plan = (rows: number, cols: number, wrap = false, width = 3000, height = 2000) => planTiles({ width, height, rows, cols, overlapPct: 15, wrap });

  it('draws in the image own pixel coordinates, so each core is exactly where the plan puts it', () => {
    for (const [rows, cols] of [[1, 1], [2, 3], [2, 4], [3, 3], [6, 6], [1, 6]] as const) {
      const p = plan(rows, cols);
      const { unmount } = render(<GridOverlay plan={p} previewUrl={null} providerId="gpt" />);
      expect(screen.getByTestId('grid-overlay')).toHaveAttribute('viewBox', '0 0 3000 2000');

      for (const tile of p.tiles) {
        const rect = screen.getByTestId(`tile-${tile.index}`).querySelector('rect')!;
        expect({ x: +rect.getAttribute('x')!, y: +rect.getAttribute('y')!, width: +rect.getAttribute('width')!, height: +rect.getAttribute('height')! }, `${rows}x${cols} tile ${tile.index}`).toEqual(tile.core);
      }
      expect(screen.getAllByTestId(/^tile-\d+$/)).toHaveLength(rows * cols);
      unmount();
    }
  });

  it('numbers the tiles from 1', () => {
    render(<GridOverlay plan={plan(2, 2)} previewUrl={null} providerId={null} />);
    expect(within(screen.getByTestId('tile-0')).getByText('1')).toBeInTheDocument();
    expect(within(screen.getByTestId('tile-3')).getByText('4')).toBeInTheDocument();
  });

  it('shows the overlap bands, hatched so they do not depend on colour', () => {
    const { container } = render(<GridOverlay plan={plan(1, 2)} previewUrl={null} providerId={null} />);
    const bands = screen.getAllByTestId('overlap');
    expect(bands).toHaveLength(1);
    expect(bands[0]).toHaveAttribute('fill', 'url(#overlap-hatch)');
    expect(container.querySelector('pattern#overlap-hatch line')).not.toBeNull();
    expect(screen.getByTestId('grid-legend')).toHaveTextContent(/overlap/i);
  });

  it('has no overlap bands when the overlap is 0', () => {
    render(<GridOverlay plan={planTiles({ width: 3000, height: 2000, rows: 2, cols: 3, overlapPct: 0 })} previewUrl={null} providerId={null} />);
    expect(screen.queryAllByTestId('overlap')).toHaveLength(0);
  });

  it('shows the picture under the grid, and still draws the grid without one', () => {
    const { rerender } = render(<GridOverlay plan={plan(2, 2)} previewUrl="data:image/jpeg;base64,AAAA" providerId={null} />);
    expect(document.querySelector('img')).toHaveAttribute('src', 'data:image/jpeg;base64,AAAA');
    rerender(<GridOverlay plan={plan(2, 2)} previewUrl={null} providerId={null} />);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByTestId('grid-overlay')).toBeInTheDocument();
  });

  it('keeps the picture shape: the box has the aspect ratio of the image', () => {
    const { container } = render(<GridOverlay plan={plan(2, 2, false, 3000, 1000)} previewUrl={null} providerId={null} />);
    expect((container.querySelector('div.relative') as HTMLElement).style.aspectRatio).toBe('3000 / 1000');
  });

  describe('wrap mode', () => {
    it('is indicated by a border and a sentence, and shows the overlaps across the border', () => {
      render(<GridOverlay plan={plan(2, 3, true)} previewUrl={null} providerId={null} />);
      expect(screen.getByTestId('wrap-border')).toBeInTheDocument();
      expect(screen.getByTestId('wrap-note')).toHaveTextContent(/Wrap mode.*opposite side/);
      expect(screen.getAllByTestId('overlap').some((r) => r.getAttribute('data-wrapped') === 'true')).toBe(true);
      expect(screen.getByRole('img', { name: /wrap mode/i })).toBeInTheDocument();
    });

    it('is not indicated otherwise', () => {
      render(<GridOverlay plan={plan(2, 3)} previewUrl={null} providerId={null} />);
      expect(screen.queryByTestId('wrap-border')).toBeNull();
      expect(screen.queryByTestId('wrap-note')).toBeNull();
    });
  });

  describe('warnings', () => {
    it('warns about cores under 384 px, politely rather than as an error', () => {
      render(<GridOverlay plan={plan(2, 3, false, 900, 600)} previewUrl={null} providerId={null} />);
      const list = screen.getByTestId('plan-warnings');
      expect(list).toHaveAttribute('aria-live', 'polite');
      expect(within(list).getByText(/under 384 px/)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it("warns when tiles are larger than the selected provider's output, and only then", () => {
      const big = plan(1, 1, false, 2400, 1600);
      const { rerender } = render(<GridOverlay plan={big} previewUrl={null} providerId="gemini" />);
      expect(screen.getByTestId('plan-warnings')).toHaveTextContent(/larger than the 1024 px the provider returns/);
      rerender(<GridOverlay plan={big} previewUrl={null} providerId={null} />);
      expect(screen.queryByTestId('plan-warnings')).toBeNull();
    });

    it('has none for a comfortable plan: each tile is sent at 1300 px or less, within what the provider returns', () => {
      render(<GridOverlay plan={plan(2, 3, false, 3000, 2000)} previewUrl={null} providerId="gpt" />);
      expect(screen.queryByTestId('plan-warnings')).toBeNull();
    });

    it('but the same plan is too large for a provider that returns less', () => {
      render(<GridOverlay plan={plan(2, 3, false, 3000, 2000)} previewUrl={null} providerId="gemini" />);
      expect(screen.getByTestId('plan-warnings')).toHaveTextContent(/lower resolution than sent/);
    });
  });

  it('lists every tile in text for people who cannot see the picture', async () => {
    const user = userEvent.setup();
    render(<GridOverlay plan={plan(1, 2)} previewUrl={null} providerId={null} />);
    await user.click(screen.getByText(/Tile details \(2\)/));
    expect(screen.getByText(/^Tile 1 \(row 1, column 1\): core 1500×2000 px/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Tile grid: 1 rows by 2 columns, 2 tiles/ })).toBeInTheDocument();
  });
});

describe('Setup: tile preview', () => {
  const asset: ImageAsset = { id: 'A1', path: 'C:\\pics\\photo.png', width: 3000, height: 2000, sha256: 'a'.repeat(64) };
  let bridge: ReturnType<typeof installBridge>;

  beforeEach(() => {
    bridge = installBridge();
    useShellStore.setState({ asset });
  });

  async function openSetup() {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Setup' }));
    await screen.findByTestId('grid-overlay');
    return user;
  }

  const tileCount = () => screen.getAllByTestId(/^tile-\d+$/).length;

  it('shows the 6-tile preset grid for the image, over its preview picture', async () => {
    await openSetup();
    expect(tileCount()).toBe(6);
    expect(screen.getByTestId('grid-overlay')).toHaveAttribute('viewBox', '0 0 3000 2000');
    await waitFor(() => expect(document.querySelector('img')).toHaveAttribute('src', 'data:image/jpeg;base64,AAAA'));
    expect(bridge.preview).toHaveBeenCalledTimes(1);
  });

  it('follows the grid mode with the keyboard, and the preview does not reload', async () => {
    const user = await openSetup();
    screen.getByRole('radio', { name: '6 tiles (3×2)' }).focus();
    await user.keyboard('{ArrowDown}'); // radio groups move with the arrow keys
    expect(screen.getByRole('radio', { name: '8 tiles (4×2)' })).toBeChecked();
    await waitFor(() => expect(tileCount()).toBe(8));
    expect(bridge.preview).toHaveBeenCalledTimes(1);
  });

  it('follows custom rows, columns and overlap', async () => {
    const user = await openSetup();
    await user.click(screen.getByRole('radio', { name: 'Custom' }));
    const rows = screen.getByLabelText('Rows');
    await user.clear(rows);
    await user.type(rows, '3');
    const cols = screen.getByLabelText('Columns');
    await user.clear(cols);
    await user.type(cols, '2');
    await waitFor(() => expect(tileCount()).toBe(6));
    expect(screen.getByTestId('grid-overlay')).toHaveAccessibleName(/3 rows by 2 columns/);

    const overlap = screen.getByLabelText('Overlap %');
    await user.clear(overlap);
    await user.type(overlap, '0');
    await waitFor(() => expect(screen.queryAllByTestId('overlap')).toHaveLength(0));
  });

  it('asks the slicer for exactly the grid in the form, and keeps the last good picture while an edit is invalid', async () => {
    const user = await openSetup();
    expect(bridge.plan).toHaveBeenLastCalledWith({ assetId: 'A1', grid: { rows: 2, cols: 3 }, overlapPct: 15, wrap: false });

    await user.click(screen.getByRole('radio', { name: 'Custom' }));
    await user.clear(screen.getByLabelText('Rows')); // empty: invalid
    await waitFor(() => expect(screen.queryByTestId('grid-overlay')).toBeNull());
    expect(screen.getByText('Rows must be a whole number from 1 to 6.')).toBeInTheDocument();
  });

  it('stores the plan alongside the draft', async () => {
    await openSetup();
    const state = useShellStore.getState();
    expect(state.plan.status).toBe('ok');
    expect(state.plan.status === 'ok' && state.plan.plan).toEqual(planTiles({ width: 3000, height: 2000, rows: 2, cols: 3, overlapPct: 15 }));
  });

  it('uses wrap mode for a seamless-texture category, and sends it with the job so the plan is reproduced', async () => {
    const user = await openSetup();
    await waitFor(() => expect(useShellStore.getState().categories.length).toBeGreaterThan(0));
    const texture = listCategories().find((c) => c.wrap === true)!;
    await user.click(screen.getByRole('radio', { name: new RegExp(texture.name.replace(/[/()]/g, '.')) }));

    await waitFor(() => expect(screen.getByTestId('wrap-border')).toBeInTheDocument());
    expect(bridge.plan).toHaveBeenLastCalledWith(expect.objectContaining({ wrap: true }));

    useShellStore.setState({ providers: { gpt: 'ready', gemini: 'ready', grok: 'ready' } });
    await user.click(screen.getByRole('radio', { name: /ChatGPT/ }));
    bridge.createJob.mockResolvedValue({ ok: false, error: { code: 'internal', message: 'stop here' } });
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(bridge.createJob).toHaveBeenCalled());
    expect(bridge.createJob.mock.calls[0]![0].grid).toMatchObject({ wrap: true });
  });

  it('shows a message, not a broken picture, when the plan fails', async () => {
    bridge.plan.mockResolvedValue({ ok: false, error: { code: 'invalid_request', message: 'A 6x6 grid needs a larger image.' } });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Setup' }));
    expect(await screen.findByText('A 6x6 grid needs a larger image.')).toBeInTheDocument();
    expect(screen.queryByTestId('grid-overlay')).toBeNull();
  });

  it('still draws the grid when the preview picture cannot be made', async () => {
    bridge.preview.mockResolvedValue({ ok: false, error: { code: 'file-not-found', message: 'The image file is no longer there.' } });
    await openSetup();
    expect(await screen.findByText(/The image file is no longer there\. The grid is still drawn to scale\./)).toBeInTheDocument();
    expect(tileCount()).toBe(6);
  });

  it('ignores a plan that arrives late for an older grid', async () => {
    let release: (v: unknown) => void = () => {};
    const slow = new Promise((resolve) => (release = resolve));
    const original = bridge.plan.getMockImplementation()!;
    bridge.plan.mockImplementationOnce(() => slow as never);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Setup' })); // first request hangs
    await user.click(screen.getByRole('radio', { name: '8 tiles (4×2)' })); // newer request resolves at once
    await waitFor(() => expect(tileCount()).toBe(8));

    release(await original({ grid: { rows: 2, cols: 3 }, overlapPct: 15 })); // the stale 6-tile answer
    await new Promise((r) => setTimeout(r, 20));
    expect(tileCount()).toBe(8);
  });
});
