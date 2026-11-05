// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { IPC_VERSION } from '@ie/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../renderer/src/App';
import { installBridge } from './fakeBridge';

let bridge: ReturnType<typeof installBridge>;

beforeEach(() => {
  bridge = installBridge();
});

afterEach(cleanup);

describe('renderer shell', () => {
  it('renders Home and shows the ping result from IPC', async () => {
    render(<App />);
    expect(await screen.findByText(`Main process ready: app 0.1.0, IPC v${IPC_VERSION}`)).toBeInTheDocument();
    expect(bridge.ping).toHaveBeenCalledTimes(1);
  });

  it('shows a typed IPC error instead of crashing', async () => {
    bridge.ping.mockResolvedValue({ ok: false, error: { code: 'internal', message: 'boom' } });
    render(<App />);
    expect(await screen.findByText('Main process error: internal: boom')).toBeInTheDocument();
  });

  it('tabs through the five nav buttons in order', async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();

    for (const name of ['Home', 'Setup', 'Run', 'Result', 'Settings']) {
      await user.tab();
      expect(screen.getByRole('button', { name })).toHaveFocus();
    }
  });

  it.each(['Setup', 'Run', 'Result', 'Settings'])('opens %s with Tab + Enter and focuses its heading', async (name) => {
    const user = userEvent.setup();
    render(<App />);

    const target = await screen.findByRole('button', { name });
    for (let i = 0; i < 5 && document.activeElement !== target; i++) await user.tab();
    expect(target).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(screen.getByRole('heading', { level: 1, name })).toHaveFocus();
    expect(target).toHaveAttribute('aria-current', 'page');
  });
});
