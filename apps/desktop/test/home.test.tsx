// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ImageAsset } from '@ie/contracts';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../renderer/src/App';
import { useShellStore } from '../renderer/src/store';
import { installBridge } from './fakeBridge';

const asset: ImageAsset = {
  id: '01ASSET',
  path: 'C:\\Users\\me\\Pictures\\photo.png',
  width: 40,
  height: 20,
  sha256: 'a'.repeat(64),
};

let importImage: ReturnType<typeof installBridge>['importImage'];
let pathFor: ReturnType<typeof installBridge>['pathFor'];

beforeEach(() => {
  // The bridge deliberately has no createJob: Home must never create a Job.
  const bridge = installBridge();
  importImage = bridge.importImage;
  pathFor = bridge.pathFor;
  pathFor.mockReturnValue(asset.path);
  importImage.mockResolvedValue({ ok: true, value: asset });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const png = () => new File(['x'], 'photo.png', { type: 'image/png' });

describe('Home import', () => {
  it('imports a dropped file and lands on Setup with the asset', async () => {
    render(<App />);
    await screen.findByTestId('dropzone');
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files: [png()] } });

    expect(await screen.findByRole('heading', { level: 1, name: 'Setup' })).toHaveFocus();
    expect(screen.getByTestId('asset-summary')).toHaveTextContent('photo.png (40×20 px)');
    expect(importImage).toHaveBeenCalledExactlyOnceWith(asset.path);
    expect(useShellStore.getState().asset).toEqual(asset);
  });

  it('imports a file chosen with the picker', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId('dropzone');
    await user.upload(screen.getByLabelText('Image file'), png());

    expect(await screen.findByTestId('asset-summary')).toBeInTheDocument();
    expect(importImage).toHaveBeenCalledExactlyOnceWith(asset.path);
  });

  it('opens the picker from the keyboard-operable button', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId('dropzone');
    const click = vi.spyOn(screen.getByLabelText('Image file'), 'click');

    const choose = screen.getByRole('button', { name: 'Choose image…' });
    for (let i = 0; i < 8 && document.activeElement !== choose; i++) await user.tab();
    expect(choose).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(click).toHaveBeenCalled();
  });

  it('shows the specific validation message inline and stays on Home', async () => {
    importImage.mockResolvedValue({
      ok: false,
      error: { code: 'unsupported-gif', message: 'GIF images are not supported. Use PNG, JPEG or WebP.' },
    });
    render(<App />);
    await screen.findByTestId('dropzone');
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files: [png()] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('GIF images are not supported. Use PNG, JPEG or WebP.');
    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    expect(useShellStore.getState().asset).toBeNull();
  });

  it('clears the previous error when a new import starts', async () => {
    importImage.mockResolvedValueOnce({ ok: false, error: { code: 'corrupt-image', message: 'Damaged file.' } });
    render(<App />);
    await screen.findByTestId('dropzone');
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files: [png()] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Damaged file.');

    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files: [png()] } });
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('reports a missing file path and an IPC failure without crashing', async () => {
    pathFor.mockReturnValueOnce('');
    render(<App />);
    await screen.findByTestId('dropzone');
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files: [png()] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read the location');
    expect(importImage).not.toHaveBeenCalled();

    importImage.mockRejectedValueOnce(new Error('channel closed'));
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files: [png()] } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Import failed'));
  });

  it('ignores a drop with no files', async () => {
    render(<App />);
    await screen.findByTestId('dropzone');
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files: [] } });
    expect(importImage).not.toHaveBeenCalled();
  });

  it('shows the recent-jobs empty state', async () => {
    render(<App />);
    await screen.findByTestId('dropzone');
    expect(screen.getByRole('heading', { name: 'Recent jobs' })).toBeInTheDocument();
    expect(screen.getByText('No recent jobs yet.')).toBeInTheDocument();
  });

  it('lists recent jobs when the store has some', async () => {
    useShellStore.setState({
      recentJobs: [{ id: 'J1', createdAt: '2026-11-05T00:00:00Z', state: 'paused', completedTiles: 2, totalTiles: 6 }],
    });
    render(<App />);
    await screen.findByTestId('dropzone');
    expect(screen.getByText('J1 — paused (2/6 tiles)')).toBeInTheDocument();
    useShellStore.setState({ recentJobs: [] });
  });

  it('Setup asks for an image when none was imported', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId('dropzone');
    await user.click(screen.getByRole('button', { name: 'Setup' }));
    expect(screen.getByText('Import an image on Home first.')).toBeInTheDocument();
  });
});
