// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { CategorySuggestion, ImageAsset } from '@ie/contracts';
import { listCategories } from '@ie/presets';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../renderer/src/App';
import { useShellStore } from '../renderer/src/store';
import { installBridge } from './fakeBridge';

const asset: ImageAsset = { id: 'A1', path: 'C:\\pics\\photo.png', width: 400, height: 300, sha256: 'a'.repeat(64) };
const category = (id: string) => listCategories().find((c) => c.id === id)!;

const suggestion = (over: Partial<CategorySuggestion> = {}): CategorySuggestion => ({
  categoryId: 'env-realistic',
  confidence: 0.8,
  alternatives: [
    { categoryId: 'landscape-matte', confidence: 0.3 },
    { categoryId: 'architecture-interior', confidence: 0.2 },
    { categoryId: 'props-realistic', confidence: 0.1 },
  ],
  signals: ['Looks photographic (many colours, natural noise)'],
  lowConfidence: false,
  ...over,
});

let bridge: ReturnType<typeof installBridge>;
beforeEach(() => {
  bridge = installBridge();
  useShellStore.setState({ asset });
});
afterEach(cleanup);

async function openSetup() {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Setup' }));
  await screen.findByRole('radio', { name: /Auto-detect/ });
  return user;
}

const autoRadio = () => screen.getByRole('radio', { name: /Auto-detect/ });
const prompt = () => screen.getByLabelText('Prompt') as HTMLTextAreaElement;
const card = () => screen.getByRole('region', { name: 'Auto-detect' });
const start = () => screen.getByRole('button', { name: 'Start' });

async function selectAuto(user: ReturnType<typeof userEvent.setup>) {
  await user.click(autoRadio());
  await screen.findByRole('heading', { name: /Detected:/ });
}

describe('Auto card in the picker', () => {
  it('is the first option, in its own group, with a one-line explanation', async () => {
    await openSetup();
    expect(screen.getByRole('group', { name: 'Automatic' })).toContainElement(autoRadio());
    expect(screen.getAllByRole('radio')[0]).toBe(autoRadio());
    expect(screen.getByText(/suggests the best category\. You can override it/)).toBeInTheDocument();
  });

  it('shows no detection card until Auto is selected', async () => {
    await openSetup();
    expect(screen.queryByRole('region', { name: 'Auto-detect' })).not.toBeInTheDocument();
    expect(bridge.suggest).not.toHaveBeenCalled();
  });
});

describe('detection', () => {
  it('runs on selection and shows the category, confidence, alternatives and signals', async () => {
    const user = await openSetup();
    await selectAuto(user);

    expect(bridge.suggest).toHaveBeenCalledExactlyOnceWith({ assetId: 'A1', prompt: '' });
    expect(screen.getByRole('heading', { name: 'Detected: Realistic environment (80%)' })).toBeInTheDocument();
    expect(within(card()).getByText('Looks photographic (many colours, natural noise)')).toBeInTheDocument();
    for (const label of [/Use Landscape \/ matte painting \(30%\)/, /Use Architecture & interiors \(20%\)/, /Use Realistic props \(10%\)/]) {
      expect(within(card()).getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(autoRadio()).toBeChecked();
  });

  it('applies the resolved category defaults and prefills its default prompt', async () => {
    const user = await openSetup();
    await selectAuto(user);

    expect(prompt().value).toBe(category('env-realistic').defaultPrompt);
    expect(screen.getByLabelText('Rows')).toHaveValue(2);
    expect(screen.getByLabelText('Columns')).toHaveValue(3);
    expect(screen.getByLabelText('Overlap %')).toHaveValue(15);
    expect(screen.getByTestId('category-details')).toHaveTextContent('Realistic environment');
  });

  it('keeps a prompt the user already wrote', async () => {
    const user = await openSetup();
    await user.type(prompt(), 'my own words');
    await selectAuto(user);
    expect(prompt().value).toBe('my own words');
    expect(bridge.suggest).toHaveBeenCalledWith({ assetId: 'A1', prompt: 'my own words' });
  });

  it('is local: it makes no provider or session call and never creates a job', async () => {
    const user = await openSetup();
    await selectAuto(user);
    await user.click(within(card()).getByRole('button', { name: 'Re-detect' }));
    await waitFor(() => expect(bridge.suggest).toHaveBeenCalledTimes(2));

    expect(bridge.open).not.toHaveBeenCalled();
    expect(bridge.status).not.toHaveBeenCalled();
    expect(bridge.clear).not.toHaveBeenCalled();
    expect(bridge.createJob).not.toHaveBeenCalled();
    expect(useShellStore.getState().job).toBeNull();
  });

  it('shows a loading state, and blocks Start with the reason, while analysing', async () => {
    let resolve!: (value: unknown) => void;
    bridge.suggest.mockReturnValue(new Promise((r) => (resolve = r)));
    const user = await openSetup();
    await user.click(autoRadio());

    expect(await screen.findByRole('status', { name: '' })).toHaveTextContent('Analysing your image…');
    expect(start()).toBeDisabled();
    expect(screen.getByText('Detecting the category from your image…')).toBeInTheDocument();

    await act(async () => resolve({ ok: true, value: suggestion() }));
    expect(await screen.findByRole('heading', { name: /Detected:/ })).toBeInTheDocument();
    expect(screen.queryByText('Detecting the category from your image…')).not.toBeInTheDocument();
  });
});

describe('low confidence', () => {
  it('warns, still shows the top 3 alternatives, and can be confirmed with one click', async () => {
    bridge.suggest.mockResolvedValue({ ok: true, value: suggestion({ confidence: 0.41, lowConfidence: true }) });
    const user = await openSetup();
    await selectAuto(user);

    expect(screen.getByRole('heading', { name: 'Detected: Realistic environment (41%)' })).toBeInTheDocument();
    expect(within(card()).getByRole('alert')).toHaveTextContent('Low confidence');
    expect(within(card()).getAllByRole('button', { name: /^Use / })).toHaveLength(3);

    await user.click(within(card()).getByRole('button', { name: 'Keep this suggestion' }));
    expect(within(card()).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(card()).getByText('Suggestion confirmed.')).toBeInTheDocument();
  });

  it('does not warn when confidence is high', async () => {
    const user = await openSetup();
    await selectAuto(user);
    expect(within(card()).queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('override', () => {
  it('applies the chosen alternative defaults and prompt, and says it is overriding', async () => {
    const user = await openSetup();
    await selectAuto(user);
    await user.click(within(card()).getByRole('button', { name: /Use Landscape \/ matte painting/ }));

    expect(prompt().value).toBe(category('landscape-matte').defaultPrompt);
    expect(screen.getByLabelText('Columns')).toHaveValue(4);
    expect(screen.getByRole('radio', { name: '8 tiles (4×2)' })).toBeChecked();
    expect(within(card()).getByText(/instead of the detected category/)).toHaveTextContent('Landscape / matte painting');
    expect(autoRadio()).toBeChecked();
  });

  it('keeps an edited prompt when overriding, and can return to the detected category', async () => {
    const user = await openSetup();
    await selectAuto(user);
    await user.clear(prompt());
    await user.type(prompt(), 'kept');
    await user.click(within(card()).getByRole('button', { name: /Use Landscape/ }));
    expect(prompt().value).toBe('kept');

    await user.click(within(card()).getByRole('button', { name: 'Use detected category' }));
    expect(useShellStore.getState().draft.categoryId).toBe('env-realistic');
    expect(within(card()).queryByText(/instead of the detected category/)).not.toBeInTheDocument();
  });

  it('choosing a category by hand turns Auto off and hides the card', async () => {
    const user = await openSetup();
    await selectAuto(user);
    await user.click(screen.getByRole('radio', { name: /Photo restoration/ }));

    expect(autoRadio()).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /Photo restoration/ })).toBeChecked();
    expect(screen.queryByRole('region', { name: 'Auto-detect' })).not.toBeInTheDocument();
    expect(useShellStore.getState().draft.autoSelected).toBe(false);
  });
});

describe('Job source', () => {
  const job = { id: 'J', categoryId: 'env-realistic', grid: { rows: 2, cols: 3, overlapPct: 15 }, providerId: 'gemini' };

  async function readyToStart(user: ReturnType<typeof userEvent.setup>) {
    await selectAuto(user);
    await user.click(screen.getByRole('radio', { name: /Gemini/ }));
    act(() => bridge.emitStatus('gemini', 'ready'));
    await waitFor(() => expect(start()).toBeEnabled());
  }

  it('records categorySource "auto" and the confidence when the suggestion is kept', async () => {
    bridge.createJob.mockResolvedValue({ ok: true, value: job });
    const user = await openSetup();
    await readyToStart(user);
    await user.click(start());

    expect(bridge.createJob).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ categoryId: 'env-realistic', categorySource: 'auto', categoryConfidence: 0.8 }),
    );
  });

  it('records no auto source after an override, and again after returning to the detected category', async () => {
    bridge.createJob.mockResolvedValue({ ok: true, value: job });
    const user = await openSetup();
    await readyToStart(user);
    await user.click(within(card()).getByRole('button', { name: /Use Landscape/ }));
    await user.click(start());
    expect(bridge.createJob.mock.calls[0]![0]).not.toHaveProperty('categorySource');
    expect(bridge.createJob.mock.calls[0]![0]).toMatchObject({ categoryId: 'landscape-matte' });

    await user.click(screen.getByRole('button', { name: 'Setup' }));
    await user.click(within(card()).getByRole('button', { name: 'Use detected category' }));
    await user.click(start());
    expect(bridge.createJob.mock.calls[1]![0]).toMatchObject({ categoryId: 'env-realistic', categorySource: 'auto' });
  });

  it('records no auto source when a category was picked by hand', async () => {
    bridge.createJob.mockResolvedValue({ ok: true, value: job });
    const user = await openSetup();
    await user.click(screen.getByRole('radio', { name: /Realistic environment/ }));
    await user.click(screen.getByRole('radio', { name: /Gemini/ }));
    act(() => bridge.emitStatus('gemini', 'ready'));
    await waitFor(() => expect(start()).toBeEnabled());
    await user.click(start());
    expect(bridge.createJob.mock.calls[0]![0]).not.toHaveProperty('categorySource');
  });
});

describe('re-detect', () => {
  it('uses the current prompt text', async () => {
    const user = await openSetup();
    await selectAuto(user);
    await user.clear(prompt());
    await user.type(prompt(), 'pixel art sprite');
    await user.click(within(card()).getByRole('button', { name: 'Re-detect' }));

    await waitFor(() => expect(bridge.suggest).toHaveBeenCalledTimes(2));
    expect(bridge.suggest).toHaveBeenLastCalledWith({ assetId: 'A1', prompt: 'pixel art sprite' });
  });

  it('does not feed a category default back into detection', async () => {
    const user = await openSetup();
    await selectAuto(user);
    expect(prompt().value).toBe(category('env-realistic').defaultPrompt);

    await user.click(within(card()).getByRole('button', { name: 'Re-detect' }));
    await waitFor(() => expect(bridge.suggest).toHaveBeenCalledTimes(2));
    expect(bridge.suggest).toHaveBeenLastCalledWith({ assetId: 'A1', prompt: '' });
  });

  it('applies a different result, replacing the previous default prompt', async () => {
    const user = await openSetup();
    await selectAuto(user);
    bridge.suggest.mockResolvedValue({ ok: true, value: suggestion({ categoryId: 'pixel-art', confidence: 0.9 }) });
    await user.click(within(card()).getByRole('button', { name: 'Re-detect' }));

    expect(await screen.findByRole('heading', { name: 'Detected: Pixel art cleanup / upscale (90%)' })).toBeInTheDocument();
    expect(prompt().value).toBe(category('pixel-art').defaultPrompt);
  });

  it('runs again for a new image while Auto stays selected', async () => {
    const user = await openSetup();
    await selectAuto(user);

    act(() => useShellStore.setState({ asset: { ...asset, id: 'A2' }, detection: { status: 'idle' } }));
    await waitFor(() => expect(bridge.suggest).toHaveBeenCalledTimes(2));
    expect(bridge.suggest).toHaveBeenLastCalledWith({ assetId: 'A2', prompt: '' });
  });
});

describe('errors and stale results', () => {
  it('shows an error and recovers with Try again', async () => {
    bridge.suggest.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'The image could not be analysed.' } });
    const user = await openSetup();
    await user.click(autoRadio());

    expect(await within(card()).findByRole('alert')).toHaveTextContent('The image could not be analysed.');
    expect(start()).toBeDisabled();

    await user.click(within(card()).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: /Detected:/ })).toBeInTheDocument();
  });

  it('reports a failed IPC call without crashing', async () => {
    bridge.suggest.mockRejectedValueOnce(new Error('channel closed'));
    const user = await openSetup();
    await user.click(autoRadio());
    expect(await within(card()).findByRole('alert')).toHaveTextContent('Auto-detect failed');
  });

  it('ignores a late result after the user picked a category by hand', async () => {
    let resolve!: (value: unknown) => void;
    bridge.suggest.mockReturnValue(new Promise((r) => (resolve = r)));
    const user = await openSetup();
    await user.click(autoRadio());
    await user.click(screen.getByRole('radio', { name: /Photo restoration/ }));

    await act(async () => resolve({ ok: true, value: suggestion({ categoryId: 'pixel-art' }) }));
    expect(useShellStore.getState().draft).toMatchObject({ categoryId: 'photo-restore', autoSelected: false });
    expect(useShellStore.getState().detection.status).toBe('idle');
  });

  it('shows an error if the detected category is unknown', async () => {
    bridge.suggest.mockResolvedValue({ ok: true, value: suggestion({ categoryId: 'does-not-exist' }) });
    const user = await openSetup();
    await user.click(autoRadio());
    expect(await within(card()).findByRole('alert')).toHaveTextContent('not available');
  });
});

describe('keyboard', () => {
  it('selects Auto and re-detects from the keyboard', async () => {
    const user = await openSetup();
    for (let i = 0; i < 30 && document.activeElement !== autoRadio(); i++) await user.tab();
    expect(autoRadio()).toHaveFocus();
    await user.keyboard(' ');
    await screen.findByRole('heading', { name: /Detected:/ });

    const redetect = within(card()).getByRole('button', { name: 'Re-detect' });
    redetect.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(bridge.suggest).toHaveBeenCalledTimes(2));
  });
});
