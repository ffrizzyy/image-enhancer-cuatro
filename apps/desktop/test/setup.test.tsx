// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ImageAsset, Job } from '@ie/contracts';
import { listCategories } from '@ie/presets';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../renderer/src/App';
import { useShellStore } from '../renderer/src/store';
import { installBridge } from './fakeBridge';

const asset: ImageAsset = { id: 'A1', path: 'C:\\pics\\photo.png', width: 400, height: 300, sha256: 'a'.repeat(64) };
const category = (id: string) => listCategories().find((c) => c.id === id)!;

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
  await screen.findByRole('radio', { name: /Realistic environment/ });
  return user;
}

const prompt = () => screen.getByLabelText('Prompt') as HTMLTextAreaElement;
const start = () => screen.getByRole('button', { name: 'Start' });
const pick = (user: ReturnType<typeof userEvent.setup>, name: RegExp) => user.click(screen.getByRole('radio', { name }));

describe('Setup: category', () => {
  it('lists categories grouped by family with descriptions', async () => {
    await openSetup();
    expect(screen.getByRole('group', { name: 'Environments' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Characters & creatures' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio', { name: /./ }).length).toBeGreaterThanOrEqual(19);
    expect(screen.getByText(category('env-realistic').defaultPrompt!)).toBeInTheDocument();
  });

  it('applies the default grid, overlap and fidelity, and prefills the prompt', async () => {
    const user = await openSetup();
    await pick(user, /Landscape \/ matte painting/);

    expect(prompt().value).toBe(category('landscape-matte').defaultPrompt);
    expect(screen.getByLabelText('Rows')).toHaveValue(2);
    expect(screen.getByLabelText('Columns')).toHaveValue(4);
    expect(screen.getByLabelText('Overlap %')).toHaveValue(15);
    expect(screen.getByRole('radio', { name: '8 tiles (4×2)' })).toBeChecked();
    expect(screen.getByTestId('category-details')).toHaveTextContent('Balanced: surfaces may be restyled');
  });

  it('shows the selected category warnings', async () => {
    const user = await openSetup();
    await pick(user, /Realistic character/);
    expect(within(screen.getByTestId('category-details')).getByText(/Faces and hands split across tiles/)).toBeInTheDocument();
  });

  it('switching categories changes the defaults', async () => {
    const user = await openSetup();
    await pick(user, /Realistic environment/);
    expect(screen.getByLabelText('Overlap %')).toHaveValue(15);
    await pick(user, /Realistic character/);
    expect(screen.getByLabelText('Overlap %')).toHaveValue(20);
  });
});

describe('Setup: prompt', () => {
  it('replaces the default on category switch, but keeps an edit and offers Reset', async () => {
    const user = await openSetup();
    await pick(user, /Realistic environment/);
    expect(screen.queryByRole('button', { name: 'Reset to category default' })).not.toBeInTheDocument();

    await user.clear(prompt());
    await user.type(prompt(), 'my own words');
    await pick(user, /Photo restoration/);

    expect(prompt().value).toBe('my own words');
    await user.click(screen.getByRole('button', { name: 'Reset to category default' }));
    expect(prompt().value).toBe(category('photo-restore').defaultPrompt);
    expect(screen.queryByRole('button', { name: 'Reset to category default' })).not.toBeInTheDocument();
  });

  it('accepts exactly 2000 characters and shows an accessible error above that', async () => {
    const user = await openSetup();
    await pick(user, /Realistic environment/);

    await user.clear(prompt());
    await act(async () => useShellStore.getState().setPrompt('x'.repeat(2000)));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => useShellStore.getState().setPrompt('x'.repeat(2001)));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/limit is 2000/);
    expect(prompt()).toHaveAttribute('aria-invalid', 'true');
    expect(prompt().getAttribute('aria-describedby')).toContain(alert.id);
    expect(start()).toBeDisabled();
  });

  it('allows an empty prompt', async () => {
    const user = await openSetup();
    await pick(user, /Realistic environment/);
    await user.clear(prompt());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/Leave it empty to use the category default/)).toBeInTheDocument();
  });
});

describe('Setup: grid', () => {
  it('offers 6, 8 and custom, and unlocks rows and columns only for custom', async () => {
    const user = await openSetup();
    expect(screen.getByLabelText('Rows')).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: '8 tiles (4×2)' }));
    expect(screen.getByLabelText('Rows')).toHaveValue(2);
    expect(screen.getByLabelText('Columns')).toHaveValue(4);

    await user.click(screen.getByRole('radio', { name: 'Custom' }));
    expect(screen.getByLabelText('Rows')).toBeEnabled();
    await user.clear(screen.getByLabelText('Rows'));
    await user.type(screen.getByLabelText('Rows'), '6');
    await user.clear(screen.getByLabelText('Columns'));
    await user.type(screen.getByLabelText('Columns'), '6');
    expect(useShellStore.getState().draft).toMatchObject({ rows: 6, cols: 6, gridMode: 'custom' });
  });

  it('shows accessible errors for out-of-range values and blocks Start', async () => {
    const user = await openSetup();
    await user.click(screen.getByRole('radio', { name: 'Custom' }));
    await user.clear(screen.getByLabelText('Rows'));
    await user.type(screen.getByLabelText('Rows'), '7');
    await user.clear(screen.getByLabelText('Overlap %'));
    await user.type(screen.getByLabelText('Overlap %'), '41');

    expect(await screen.findByText(/Rows must be a whole number from 1 to 6/)).toHaveAttribute('role', 'alert');
    expect(screen.getByText(/Overlap must be from 0 to 40/)).toBeInTheDocument();
    expect(screen.getByLabelText('Rows')).toHaveAttribute('aria-invalid', 'true');
    expect(start()).toBeDisabled();
  });
});

describe('Setup: provider and Start', () => {
  async function completeForm(user: ReturnType<typeof userEvent.setup>) {
    await pick(user, /Realistic environment/);
    await pick(user, /Gemini/);
  }

  it('is disabled with a visible reason until a category and provider are chosen', async () => {
    const user = await openSetup();
    expect(start()).toBeDisabled();
    expect(screen.getByText('Choose a category.')).toBeInTheDocument();

    await pick(user, /Realistic environment/);
    expect(screen.getByText('Choose a provider.')).toBeInTheDocument();
    expect(start()).toHaveAccessibleDescription('Choose a provider.');
  });

  it('selecting a provider starts live status checking (hidden window)', async () => {
    const user = await openSetup();
    await pick(user, /Gemini/);
    expect(bridge.open).toHaveBeenCalledExactlyOnceWith('gemini', false);
  });

  it.each([
    ['logged-out', /Gemini is not ready \(Logged out\)/],
    ['challenge', /not ready \(Needs verification\)/],
    ['quota-limited', /not ready \(Limit reached\)/],
  ] as const)('stays disabled while the provider is %s', async (status, reason) => {
    const user = await openSetup();
    await completeForm(user);
    act(() => bridge.emitStatus('gemini', status));
    expect(start()).toBeDisabled();
    expect(screen.getByText(reason)).toBeInTheDocument();
  });

  it('waits for a live status when the provider has not been checked', async () => {
    const user = await openSetup();
    await completeForm(user);
    expect(start()).toBeDisabled();
    expect(screen.getByText(/Gemini has not been checked yet/)).toBeInTheDocument();
  });

  it('creates the Job through IPC only when Start is pressed, then opens Run', async () => {
    const job = { id: 'JOB1', categoryId: 'env-realistic', grid: { rows: 2, cols: 3, overlapPct: 15 }, providerId: 'gemini' } as Job;
    bridge.createJob.mockResolvedValue({ ok: true, value: job });
    const user = await openSetup();
    await completeForm(user);
    expect(bridge.createJob).not.toHaveBeenCalled();

    act(() => bridge.emitStatus('gemini', 'ready'));
    await waitFor(() => expect(start()).toBeEnabled());
    await user.click(start());

    expect(bridge.createJob).toHaveBeenCalledExactlyOnceWith({
      assetId: 'A1',
      prompt: category('env-realistic').defaultPrompt,
      categoryId: 'env-realistic',
      grid: { rows: 2, cols: 3, overlapPct: 15 },
      providerId: 'gemini',
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Run' })).toBeInTheDocument();
    expect(screen.getByTestId('job-summary')).toHaveTextContent('JOB1');
  });

  it('sends an empty prompt as empty so the main process resolves the category default', async () => {
    bridge.createJob.mockResolvedValue({ ok: true, value: { id: 'J', categoryId: 'env-realistic', grid: { rows: 2, cols: 3, overlapPct: 15 }, providerId: 'gemini' } });
    const user = await openSetup();
    await completeForm(user);
    await user.clear(prompt());
    act(() => bridge.emitStatus('gemini', 'ready'));
    await waitFor(() => expect(start()).toBeEnabled());
    await user.click(start());
    expect(bridge.createJob).toHaveBeenCalledWith(expect.objectContaining({ prompt: '' }));
  });

  it('shows the specific error and stays on Setup when job creation fails', async () => {
    bridge.createJob.mockResolvedValue({ ok: false, error: { code: 'unknown-category', message: 'Unknown category "x".' } });
    const user = await openSetup();
    await completeForm(user);
    act(() => bridge.emitStatus('gemini', 'ready'));
    await waitFor(() => expect(start()).toBeEnabled());
    await user.click(start());

    expect(await screen.findByRole('alert')).toHaveTextContent('Unknown category "x".');
    expect(screen.getByRole('heading', { level: 1, name: 'Setup' })).toBeInTheDocument();
    expect(useShellStore.getState().job).toBeNull();
  });

  it('does not create a Job twice on a double press', async () => {
    let resolve!: (value: unknown) => void;
    bridge.createJob.mockReturnValue(new Promise((r) => (resolve = r)));
    const user = await openSetup();
    await completeForm(user);
    act(() => bridge.emitStatus('gemini', 'ready'));
    await waitFor(() => expect(start()).toBeEnabled());

    await user.click(start());
    await act(async () => void useShellStore.getState().startJob());
    expect(bridge.createJob).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ ok: true, value: { id: 'J', categoryId: 'env-realistic', grid: { rows: 2, cols: 3, overlapPct: 15 }, providerId: 'gemini' } }));
  });
});

describe('Setup: draft persistence and keyboard', () => {
  it('survives navigation to Home and back', async () => {
    const user = await openSetup();
    await pick(user, /Realistic character/);
    await user.clear(prompt());
    await user.type(prompt(), 'keep me');
    await pick(user, /Grok/);

    await user.click(screen.getByRole('button', { name: 'Home' }));
    await user.click(screen.getByRole('button', { name: 'Setup' }));

    expect(screen.getByRole('radio', { name: /Realistic character/ })).toBeChecked();
    expect(prompt().value).toBe('keep me');
    expect(screen.getByRole('radio', { name: /Grok/ })).toBeChecked();
  });

  it('asks for an image when none was imported', async () => {
    useShellStore.setState({ asset: null });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Setup' }));
    expect(screen.getByText('Import an image on Home first.')).toBeInTheDocument();
  });

  it('can be completed with the keyboard alone', async () => {
    bridge.createJob.mockResolvedValue({ ok: true, value: { id: 'KJ', categoryId: 'env-realistic', grid: { rows: 2, cols: 3, overlapPct: 15 }, providerId: 'gemini' } });
    const user = await openSetup();

    // Tab enters the category group at Auto (its first option); arrow keys move within it.
    const autoRadio = screen.getByRole('radio', { name: /Auto-detect/ });
    for (let i = 0; i < 30 && document.activeElement !== autoRadio; i++) await user.tab();
    expect(autoRadio).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: /Realistic environment/ })).toBeChecked();

    // Tab enters a radio group at its first option; arrow keys move within it.
    const firstProvider = screen.getByRole('radio', { name: /ChatGPT/ });
    for (let i = 0; i < 40 && document.activeElement !== firstProvider; i++) await user.tab();
    expect(firstProvider).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: /Gemini/ })).toBeChecked();
    act(() => bridge.emitStatus('gemini', 'ready'));

    await waitFor(() => expect(start()).toBeEnabled());
    for (let i = 0; i < 5 && document.activeElement !== start(); i++) await user.tab();
    expect(start()).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByTestId('job-summary')).toHaveTextContent('KJ');
  });
});
