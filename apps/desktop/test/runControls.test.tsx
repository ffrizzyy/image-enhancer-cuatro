// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { CURRENT_RISK_NOTICE_VERSION, type JobProgress, type JobState, type PauseReason } from '@ie/contracts';
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

const progress = (state: JobState, over: Partial<JobProgress> = {}): JobProgress => ({
  jobId: 'J1',
  state,
  providerId: 'gemini',
  grid: { rows: 1, cols: 3 },
  completedTiles: 1,
  totalTiles: 3,
  tiles: [
    { index: 0, state: 'accepted', attempts: 1 },
    { index: 1, state: state === 'running' ? 'running' : 'pending', attempts: state === 'running' ? 1 : 0 },
    { index: 2, state: 'pending', attempts: 0 },
  ],
  ...over,
});

async function openRun(initial: JobProgress) {
  useShellStore.setState({ activeJobId: 'J1', route: 'run' });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'Run' });
  act(() => bridge.emitProgress(initial));
  return user;
}

const button = (name: string | RegExp) => screen.queryByRole('button', { name });

describe('Run controls', () => {
  it.each([
    ['running', { pause: true, resume: false, cancel: true }],
    ['paused', { pause: false, resume: true, cancel: true }],
    ['preflight', { pause: false, resume: false, cancel: true }],
    ['needs-review', { pause: false, resume: false, cancel: true }],
    ['stitching', { pause: false, resume: false, cancel: true }],
    ['done', { pause: false, resume: false, cancel: false }],
    ['failed', { pause: false, resume: false, cancel: false }],
    ['cancelled', { pause: false, resume: false, cancel: false }],
  ] as const)('%s: offers exactly the controls that make sense', async (state, expected) => {
    await openRun(progress(state, state === 'paused' ? { pauseReason: 'user' } : {}));
    expect(Boolean(button('Pause'))).toBe(expected.pause);
    expect(Boolean(button('Resume'))).toBe(expected.resume);
    expect(Boolean(button('Cancel job'))).toBe(expected.cancel);
  });

  it('a job whose checks were blocked can be started again, with the reason shown', async () => {
    const user = await openRun(progress('idle', { error: 'You are logged out of the provider. Log in again in its window.' }));
    expect(screen.getByRole('alert')).toHaveTextContent('logged out');
    await user.click(screen.getByRole('button', { name: 'Check again and start' }));
    expect(bridge.startJob).toHaveBeenCalledExactlyOnceWith('J1');
  });

  it('an idle job with nothing wrong has no start-again button (Start on Setup does that)', async () => {
    await openRun(progress('idle'));
    expect(button('Check again and start')).toBeNull();
  });

  describe('pause and resume', () => {
    it('Pause asks the main process and shows the paused state at once from its answer', async () => {
      bridge.pauseJob.mockResolvedValue({ ok: true, value: progress('paused', { pauseReason: 'user' }) });
      const user = await openRun(progress('running'));
      await user.click(screen.getByRole('button', { name: 'Pause' }));

      expect(bridge.pauseJob).toHaveBeenCalledExactlyOnceWith('J1');
      expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument();
      expect(button('Pause')).toBeNull();
      expect(screen.getByTestId('job-summary')).toHaveTextContent('Paused');
    });

    it('Resume asks the main process to continue the job', async () => {
      bridge.resumeJob.mockResolvedValue({ ok: true, value: progress('running') });
      const user = await openRun(progress('paused', { pauseReason: 'user' }));
      await user.click(within(screen.getByTestId('pause-banner')).getByRole('button', { name: 'Resume' }));
      expect(bridge.resumeJob).toHaveBeenCalledExactlyOnceWith('J1');
      expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();
    });

    it('shows the reason when an action is refused', async () => {
      bridge.pauseJob.mockResolvedValue({ ok: false, error: { code: 'invalid_request', message: 'A job that is idle cannot take "PAUSE".' } });
      const user = await openRun(progress('running'));
      await user.click(screen.getByRole('button', { name: 'Pause' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('cannot take "PAUSE"');
    });

    it('is keyboard-operable: focus the button and press Enter or Space', async () => {
      bridge.pauseJob.mockResolvedValue({ ok: true, value: progress('paused', { pauseReason: 'user' }) });
      const user = await openRun(progress('running'));
      screen.getByRole('button', { name: 'Pause' }).focus();
      await user.keyboard('{Enter}');
      await waitFor(() => expect(bridge.pauseJob).toHaveBeenCalledTimes(1));

      bridge.resumeJob.mockResolvedValue({ ok: true, value: progress('running') });
      act(() => bridge.emitProgress(progress('paused', { pauseReason: 'user' })));
      within(screen.getByTestId('pause-banner')).getByRole('button', { name: 'Resume' }).focus();
      await user.keyboard(' ');
      await waitFor(() => expect(bridge.resumeJob).toHaveBeenCalledTimes(1));
    });
  });

  describe('cancel', () => {
    it('asks first, with the consequence in words, and does nothing until confirmed', async () => {
      const user = await openRun(progress('running'));
      await user.click(screen.getByRole('button', { name: 'Cancel job' }));

      const dialog = screen.getByRole('alertdialog', { name: 'Cancel this job?' });
      expect(dialog).toHaveAccessibleDescription(/stops for good.*finished stay on disk/);
      expect(bridge.cancelJob).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Keep it' })).toHaveFocus(); // the safe choice has focus
    });

    it('"Keep it" and Escape both back out, returning focus to the Cancel button', async () => {
      const user = await openRun(progress('running'));
      await user.click(screen.getByRole('button', { name: 'Cancel job' }));
      await user.click(screen.getByRole('button', { name: 'Keep it' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(screen.getByRole('button', { name: 'Cancel job' })).toHaveFocus();

      await user.click(screen.getByRole('button', { name: 'Cancel job' }));
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(screen.getByRole('button', { name: 'Cancel job' })).toHaveFocus();
      expect(bridge.cancelJob).not.toHaveBeenCalled();
    });

    it('confirming cancels the job through IPC and shows it cancelled', async () => {
      bridge.cancelJob.mockResolvedValue({ ok: true, value: progress('cancelled') });
      const user = await openRun(progress('running'));
      await user.click(screen.getByRole('button', { name: 'Cancel job' }));
      await user.click(screen.getByRole('button', { name: 'Yes, cancel it' }));

      expect(bridge.cancelJob).toHaveBeenCalledExactlyOnceWith('J1');
      await waitFor(() => expect(screen.getByTestId('job-summary')).toHaveTextContent('Cancelled'));
      expect(button('Cancel job')).toBeNull();
      expect(button('Pause')).toBeNull();
    });

    it('can be done with the keyboard alone', async () => {
      bridge.cancelJob.mockResolvedValue({ ok: true, value: progress('cancelled') });
      const user = await openRun(progress('paused', { pauseReason: 'user' }));
      screen.getByRole('button', { name: 'Cancel job' }).focus();
      await user.keyboard('{Enter}'); // opens the question; focus lands on "Keep it"
      await user.tab(); // to "Yes, cancel it"
      expect(screen.getByRole('button', { name: 'Yes, cancel it' })).toHaveFocus();
      await user.keyboard('{Enter}');
      await waitFor(() => expect(bridge.cancelJob).toHaveBeenCalledTimes(1));
    });

    it('closes the question if the job ends meanwhile', async () => {
      const user = await openRun(progress('running'));
      await user.click(screen.getByRole('button', { name: 'Cancel job' }));
      act(() => bridge.emitProgress(progress('done', { completedTiles: 3 })));
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });
});

describe('Pause banners', () => {
  const paused = (reason: PauseReason, over: Partial<JobProgress> = {}) => progress('paused', { pauseReason: reason, ...over });

  it('appears the moment the pause event arrives (well within a second)', async () => {
    await openRun(progress('running'));
    expect(screen.queryByTestId('pause-banner')).toBeNull();

    const before = Date.now();
    act(() => bridge.emitProgress(paused('challenge')));
    expect(screen.getByTestId('pause-banner')).toBeInTheDocument(); // no waiting: it is rendered by the event itself
    expect(Date.now() - before).toBeLessThan(1000);
  });

  it('is announced to screen readers as an alert', async () => {
    await openRun(paused('challenge'));
    expect(screen.getByRole('alert')).toBe(screen.getByTestId('pause-banner'));
  });

  describe('a human check', () => {
    it('offers to open the provider window, then simply to resume once the provider looks fine', async () => {
      const user = await openRun(paused('challenge'));
      const banner = screen.getByTestId('pause-banner');
      expect(banner).toHaveAttribute('data-reason', 'challenge');
      expect(within(banner).getByText(/Solve the check in the Gemini window/)).toBeInTheDocument();

      await user.click(within(banner).getByRole('button', { name: 'Open Gemini' }));
      expect(bridge.open).toHaveBeenCalledWith('gemini', true);

      act(() => bridge.emitStatus('gemini', 'ready')); // the person solved it
      expect(within(screen.getByTestId('pause-banner')).queryByRole('button', { name: 'Open Gemini' })).toBeNull();
      expect(within(screen.getByTestId('pause-banner')).getByText('Gemini looks fine now.')).toBeInTheDocument();

      bridge.resumeJob.mockResolvedValue({ ok: true, value: progress('running') });
      await user.click(within(screen.getByTestId('pause-banner')).getByRole('button', { name: 'Resume' }));
      expect(bridge.resumeJob).toHaveBeenCalledExactlyOnceWith('J1');
    });

    it('lets the person resume anyway before the provider reports ready', async () => {
      bridge.resumeJob.mockResolvedValue({ ok: true, value: progress('running') });
      const user = await openRun(paused('challenge'));
      await user.click(within(screen.getByTestId('pause-banner')).getByRole('button', { name: 'Resume anyway' }));
      expect(bridge.resumeJob).toHaveBeenCalledTimes(1);
    });

    it('goes away when the job runs again', async () => {
      await openRun(paused('challenge'));
      act(() => bridge.emitProgress(progress('running')));
      expect(screen.queryByTestId('pause-banner')).toBeNull();
    });
  });

  it('logged out: the same one-click path, in its own words', async () => {
    const user = await openRun(paused('logged-out'));
    const banner = screen.getByTestId('pause-banner');
    expect(within(banner).getByText('Paused: You were logged out of the provider.')).toBeInTheDocument();
    expect(within(banner).getByText(/Log in to Gemini in its window/)).toBeInTheDocument();
    await user.click(within(banner).getByRole('button', { name: 'Open Gemini' }));
    expect(bridge.open).toHaveBeenCalledWith('gemini', true);
    act(() => bridge.emitStatus('gemini', 'ready'));
    expect(within(screen.getByTestId('pause-banner')).getByText('Gemini looks logged in again.')).toBeInTheDocument();
  });

  describe('a usage limit', () => {
    it('says how long it may last and offers to resume anyway', async () => {
      const resumeAfter = new Date(Date.now() + 30 * 60_000).toISOString();
      await openRun(paused('quota', { resumeAfter }));
      const banner = screen.getByTestId('pause-banner');
      expect(within(banner).getByText(/probably have reset in about (29|30) minutes/)).toBeInTheDocument();
      expect(within(banner).getByRole('button', { name: 'Resume anyway' })).toBeInTheDocument();
      expect(within(banner).queryByRole('button', { name: /Open/ })).toBeNull(); // nothing to fix in the window
    });

    it('offers a plain Resume once the time has passed', async () => {
      await openRun(paused('quota', { resumeAfter: new Date(Date.now() - 60_000).toISOString() }));
      const banner = screen.getByTestId('pause-banner');
      expect(within(banner).getByText('It has probably reset by now.')).toBeInTheDocument();
      expect(within(banner).getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    });
  });

  it('a pause the user asked for has a Resume and reassures that nothing is lost', async () => {
    await openRun(paused('user'));
    const banner = screen.getByTestId('pause-banner');
    expect(within(banner).getByText(/finished tiles stay finished/)).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Resume' })).toBeInTheDocument();
  });

  it('the whole injected-captcha scenario: running, paused with a banner, fixed, resumed', async () => {
    const user = await openRun(progress('running'));
    act(() => bridge.emitProgress(paused('challenge')));
    expect(screen.getByTestId('pause-banner')).toBeInTheDocument();

    await user.click(within(screen.getByTestId('pause-banner')).getByRole('button', { name: 'Open Gemini' }));
    act(() => bridge.emitStatus('gemini', 'ready'));

    bridge.resumeJob.mockImplementation(async () => {
      act(() => bridge.emitProgress(progress('running'))); // the main process pushes the new state
      return { ok: true, value: progress('running') };
    });
    await user.click(within(screen.getByTestId('pause-banner')).getByRole('button', { name: 'Resume' }));

    await waitFor(() => expect(screen.queryByTestId('pause-banner')).toBeNull());
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.getByTestId('job-summary')).toHaveTextContent('Running');
  });
});

describe('Watch mode', () => {
  const withSettings = (watchMode: boolean) =>
    useShellStore.setState({ settings: { firstRunAcknowledged: true, pacingPreset: 'safe', dataFolder: 'C:\\d', watchMode, riskNoticeVersion: CURRENT_RISK_NOTICE_VERSION } });

  it('reflects the saved setting', async () => {
    await openRun(progress('running'));
    act(() => withSettings(true));
    expect(screen.getByRole('checkbox', { name: /Keep the provider window visible/ })).toBeChecked();
    act(() => withSettings(false));
    expect(screen.getByRole('checkbox', { name: /Keep the provider window visible/ })).not.toBeChecked();
  });

  it('saves the choice and applies it to the open provider window straight away', async () => {
    const user = await openRun(progress('running'));
    await user.click(screen.getByRole('checkbox', { name: /Keep the provider window visible/ }));

    expect(bridge.setSettings).toHaveBeenCalledWith({ watchMode: true });
    await waitFor(() => expect(bridge.open).toHaveBeenCalledWith('gemini', true));
    expect(useShellStore.getState().settings?.watchMode).toBe(true);

    await user.click(screen.getByRole('checkbox', { name: /Keep the provider window visible/ }));
    expect(bridge.setSettings).toHaveBeenLastCalledWith({ watchMode: false });
    await waitFor(() => expect(bridge.open).toHaveBeenLastCalledWith('gemini', false));
  });

  it('can be toggled with the keyboard', async () => {
    const user = await openRun(progress('running'));
    screen.getByRole('checkbox', { name: /Keep the provider window visible/ }).focus();
    await user.keyboard(' ');
    await waitFor(() => expect(bridge.setSettings).toHaveBeenCalledWith({ watchMode: true }));
  });
});

describe('Setup: the cost preview', () => {
  const asset = { id: 'A1', path: 'C:\\p.png', width: 3000, height: 2000, sha256: 'a'.repeat(64) };

  async function openSetup(status: 'ready' | 'logged-out' = 'ready') {
    useShellStore.setState({ asset, providers: { gpt: 'unknown', gemini: status, grok: 'unknown' } });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Setup' }));
    await user.click(await screen.findByRole('radio', { name: /Realistic environment/ }));
    return user;
  }
  const preview = () => screen.getByTestId('cost-preview');

  it('asks for a provider first', async () => {
    await openSetup();
    expect(preview()).toHaveTextContent('Choose a provider to see the cost.');
  });

  it('shows the tile count, a rough time and the quota note once a provider is chosen', async () => {
    const user = await openSetup();
    await user.click(screen.getByRole('radio', { name: /Gemini/ }));

    await waitFor(() => expect(preview()).toHaveTextContent('6 image generations on Gemini'));
    expect(preview()).toHaveTextContent(/about 4 minutes in total/);
    expect(preview()).toHaveTextContent('This run makes 6 image generations on your gemini account, plus any retries.');
    expect(bridge.costPreview).toHaveBeenLastCalledWith({ providerId: 'gemini', tileCount: 6 });
  });

  it('follows the grid and the provider', async () => {
    const user = await openSetup();
    await user.click(screen.getByRole('radio', { name: /Gemini/ }));
    await waitFor(() => expect(preview()).toHaveTextContent('6 image generations'));

    await user.click(screen.getByRole('radio', { name: '8 tiles (4×2)' }));
    await waitFor(() => expect(preview()).toHaveTextContent('8 image generations'));

    await user.click(screen.getByRole('radio', { name: /ChatGPT/ }));
    await waitFor(() => expect(bridge.costPreview).toHaveBeenLastCalledWith({ providerId: 'gpt', tileCount: 8 }));
  });

  it('uses the singular for one tile', async () => {
    const user = await openSetup();
    await user.click(screen.getByRole('radio', { name: 'Custom' }));
    for (const field of ['Rows', 'Columns']) {
      const input = screen.getByLabelText(field);
      await user.clear(input);
      await user.type(input, '1');
    }
    await user.click(screen.getByRole('radio', { name: /Gemini/ }));
    await waitFor(() => expect(preview()).toHaveTextContent('1 image generation on Gemini'));
    expect(preview()).not.toHaveTextContent('1 image generations');
  });

  it('says so when the cost cannot be worked out', async () => {
    bridge.costPreview.mockResolvedValue({ ok: false, error: { code: 'invalid_request', message: 'Nope.' } });
    const user = await openSetup();
    await user.click(screen.getByRole('radio', { name: /Gemini/ }));
    await waitFor(() => expect(preview()).toHaveTextContent('Nope.'));
  });

  it('Start stays blocked, with the reason, while the provider session is not ready', async () => {
    const user = await openSetup('logged-out');
    await user.click(screen.getByRole('radio', { name: /Gemini/ }));
    await waitFor(() => expect(preview()).toHaveTextContent('6 image generations'));
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(screen.getByText(/Gemini is not ready \(Logged out\)/)).toBeInTheDocument();
  });
});
