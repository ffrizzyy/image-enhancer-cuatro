// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { CURRENT_RISK_NOTICE_VERSION } from '@ie/contracts';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../renderer/src/App';
import { acknowledgedSettings, installBridge } from './fakeBridge';

afterEach(cleanup);

describe('first-run risk notice', () => {
  const unacknowledged = { ...acknowledgedSettings, firstRunAcknowledged: false, riskNoticeVersion: 0 };

  it('blocks the app until acknowledged, then saves the acknowledgement', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({ settings: unacknowledged });
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Before you start' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.getByText(/terms of service/i)).toBeInTheDocument();
    expect(bridge.setSettings).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'I understand and accept the risk' }));

    expect(bridge.setSettings).toHaveBeenCalledExactlyOnceWith({ firstRunAcknowledged: true });
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Before you start' })).not.toBeInTheDocument();
  });

  it('is not shown again once acknowledged (settings persisted across a restart)', async () => {
    installBridge({ settings: acknowledgedSettings });
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Before you start' })).not.toBeInTheDocument();
  });

  it('is shown again when the notice text version is newer than the acknowledged one', async () => {
    installBridge({ settings: { ...acknowledgedSettings, riskNoticeVersion: CURRENT_RISK_NOTICE_VERSION - 1 } });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Before you start' })).toBeInTheDocument();
  });

  it('stays blocked and shows an error if the acknowledgement cannot be saved', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({ settings: unacknowledged });
    bridge.setSettings.mockResolvedValue({ ok: false, error: { code: 'internal', message: 'Settings could not be saved.' } });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'I understand and accept the risk' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings could not be saved.');
    expect(screen.getByRole('heading', { name: 'Before you start' })).toBeInTheDocument();
  });

  it('shows an error instead of the app when settings fail to load', async () => {
    const bridge = installBridge();
    bridge.getSettings.mockRejectedValue(new Error('ipc down'));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings failed to load');
  });
});

describe('Settings screen', () => {
  let bridge: ReturnType<typeof installBridge>;

  beforeEach(() => {
    bridge = installBridge();
  });

  async function openSettings() {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    return user;
  }

  const card = (name: string) => screen.getByRole('heading', { level: 2, name }).closest('li')!;

  it('lists the three providers with an Open login action each', async () => {
    await openSettings();
    for (const name of ['ChatGPT', 'Gemini', 'Grok']) {
      expect(within(card(name)).getByRole('button', { name: 'Open login' })).toBeInTheDocument();
      expect(within(card(name)).getByRole('status')).toHaveTextContent('Not checked');
    }
  });

  it('states that provider windows use the built-in browser and offers no browser picker', async () => {
    await openSettings();
    expect(screen.getByText(/built-in browser/i)).toBeInTheDocument();
    expect(screen.getByText(/never opens your system default browser/i)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /browser/i })).not.toBeInTheDocument(); // the category select in the template editor is not a browser picker
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/browser/i)).not.toBeInTheDocument();
  });

  it('Open login opens a visible window; Check status opens a hidden one', async () => {
    const user = await openSettings();
    await user.click(within(card('ChatGPT')).getByRole('button', { name: 'Open login' }));
    await user.click(within(card('Gemini')).getByRole('button', { name: 'Check status' }));

    expect(bridge.open).toHaveBeenNthCalledWith(1, 'gpt', true);
    expect(bridge.open).toHaveBeenNthCalledWith(2, 'gemini', false);
  });

  it('shows live status pushed from the main process, with an accessible name', async () => {
    await openSettings();

    act(() => bridge.emitStatus('gpt', 'ready'));
    expect(screen.getByRole('status', { name: 'ChatGPT login: Ready' })).toBeInTheDocument();

    act(() => bridge.emitStatus('gpt', 'logged-out'));
    expect(screen.getByRole('status', { name: 'ChatGPT login: Logged out' })).toBeInTheDocument();

    act(() => bridge.emitStatus('grok', 'challenge'));
    expect(screen.getByRole('status', { name: 'Grok login: Needs verification' })).toBeInTheDocument();

    act(() => bridge.emitStatus('gemini', 'quota-limited'));
    expect(screen.getByRole('status', { name: 'Gemini login: Limit reached' })).toBeInTheDocument();
  });

  it('clearing requires confirmation, and cancel does nothing', async () => {
    const user = await openSettings();
    const grok = card('Grok');

    await user.click(within(grok).getByRole('button', { name: 'Clear session' }));
    expect(bridge.clear).not.toHaveBeenCalled();
    expect(within(grok).getByText(/You will be logged out/)).toBeInTheDocument();

    await user.click(within(grok).getByRole('button', { name: 'Cancel' }));
    expect(bridge.clear).not.toHaveBeenCalled();
    expect(within(grok).getByRole('button', { name: 'Clear session' })).toBeInTheDocument();
  });

  it('confirming clears that provider only and resets its status', async () => {
    const user = await openSettings();
    act(() => {
      bridge.emitStatus('grok', 'ready');
      bridge.emitStatus('gpt', 'ready');
    });

    const grok = card('Grok');
    await user.click(within(grok).getByRole('button', { name: 'Clear session' }));
    await user.click(within(grok).getByRole('button', { name: 'Confirm clear' }));

    expect(bridge.clear).toHaveBeenCalledExactlyOnceWith('grok');
    await waitFor(() => expect(within(card('Grok')).getByRole('status')).toHaveTextContent('Not checked'));
    expect(within(card('ChatGPT')).getByRole('status')).toHaveTextContent('Ready');
  });

  it('shows an error when a provider action fails', async () => {
    bridge.open.mockResolvedValue({ ok: false, error: { code: 'internal', message: 'Could not open the provider window.' } });
    const user = await openSettings();
    await user.click(within(card('ChatGPT')).getByRole('button', { name: 'Open login' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not open the provider window.');
  });

  it('stops listening for status events when the app unmounts', async () => {
    const { unmount } = render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    expect(bridge.listenerCount()).toBe(1);
    unmount();
    expect(bridge.listenerCount()).toBe(0);
  });
});

describe('Settings: pacing and notice', () => {
  it('saves the pacing preset and shows the risk notice again on request', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({ settings: acknowledgedSettings });
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));

    expect(await screen.findByRole('radio', { name: /Safe/ })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: /Normal/ }));
    expect(bridge.setSettings).toHaveBeenCalledWith({ pacingPreset: 'normal' });
    await waitFor(() => expect(screen.getByRole('radio', { name: /Normal/ })).toBeChecked());

    await user.click(screen.getByRole('button', { name: 'Read the notice again' }));
    expect(screen.getByText(/terms of service/i)).toBeInTheDocument();
  });
});

describe('Settings: templates and data', () => {
  it('edits a template, shows a validation error, and resets', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({ settings: acknowledgedSettings });
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Category' }), 'env-realistic');
    const prompt = screen.getByRole('textbox', { name: 'Default prompt' });
    await user.clear(prompt);
    await user.type(prompt, 'My default');

    bridge.saveOverride.mockResolvedValueOnce({ ok: false, error: { code: 'invalid_request', message: 'template must contain {{userPrompt}}' } });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('template must contain');
    expect(bridge.saveOverride).toHaveBeenCalledWith(expect.objectContaining({ categoryId: 'env-realistic', defaultPrompt: 'My default' }));

    expect(screen.getByRole('button', { name: 'Reset to default' })).toBeDisabled(); // nothing is stored yet
  });

  it('opens the data folder, and treats a cancelled clear as no error', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({ settings: acknowledgedSettings });
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));

    await user.click(await screen.findByRole('button', { name: 'Open data folder' }));
    expect(bridge.openDataFolder).toHaveBeenCalled();

    bridge.clearJobs.mockResolvedValueOnce({ ok: false, error: { code: 'cancelled', message: 'Nothing was deleted.' } });
    await user.click(screen.getByRole('button', { name: /Clear job data/ }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Clear job data/ }));
    expect(await screen.findByText('Removed 2 jobs.')).toBeInTheDocument();
  });
});
