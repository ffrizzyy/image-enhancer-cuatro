// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../renderer/src/App';
import { acknowledgedSettings, installBridge } from './fakeBridge';

afterEach(cleanup);

async function audit(): Promise<string[]> {
  // jsdom has no layout or painting, so colour contrast and region checks cannot run here.
  const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}

describe('accessibility audit (axe, serious and critical)', () => {
  it('actually detects a violation (the audit is not vacuous)', async () => {
    render(<img src="x.png" />);
    expect((await audit()).join()).toMatch(/image-alt/);
  });

  it.each(['Home', 'Setup', 'Run', 'Result', 'Settings'])('%s has no serious or critical violations', async (screenName) => {
    const user = userEvent.setup();
    installBridge({ settings: acknowledgedSettings });
    render(<App />);
    await user.click(await screen.findByRole('button', { name: screenName }));
    await screen.findByRole('heading', { level: 1, name: screenName });
    expect(await audit()).toEqual([]);
  });

  it('the first-run risk notice has none either', async () => {
    installBridge({ settings: { ...acknowledgedSettings, firstRunAcknowledged: false, riskNoticeVersion: 0 } });
    render(<App />);
    await screen.findByRole('heading', { name: 'Before you start' });
    expect(await audit()).toEqual([]);
  });
});
