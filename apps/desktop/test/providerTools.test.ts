import { describe, expect, it } from 'vitest';

import { parseToolArgs } from '../main/providerTools.js';

describe('parseToolArgs', () => {
  it('reads the command and provider after --provider-tool', () => {
    expect(parseToolArgs(['electron', '.', '--provider-tool', 'discover', 'gemini'])).toEqual({ command: 'discover', provider: 'gemini' });
    expect(parseToolArgs(['--provider-tool', 'enhance', 'gpt'])).toEqual({ command: 'enhance', provider: 'gpt' });
    expect(parseToolArgs(['--provider-tool', 'health', 'grok'])).toEqual({ command: 'health', provider: 'grok' });
  });

  it('reads the optional --draft and --open values', () => {
    expect(parseToolArgs(['--provider-tool', 'discover', 'gemini', '--draft', 'hello world', '--open', 'button.x'])).toEqual({
      command: 'discover',
      provider: 'gemini',
      type: 'hello world',
      open: 'button.x',
    });
    expect(parseToolArgs(['--provider-tool', 'discover', 'gemini', '--attach', '--draft', 'hi'])).toEqual({ command: 'discover', provider: 'gemini', attach: true, type: 'hi' });
    expect(parseToolArgs(['--provider-tool', 'discover', 'gemini', '--bogus', 'x'])).toMatch(/Unexpected argument/);
    expect(parseToolArgs(['--provider-tool', 'discover', 'gemini', '--draft'])).toMatch(/Unexpected argument/);
  });

  it('explains what is wrong instead of guessing', () => {
    expect(parseToolArgs(['--provider-tool'])).toMatch(/Usage/);
    expect(parseToolArgs(['--provider-tool', 'nuke', 'gpt'])).toMatch(/Usage/);
    expect(parseToolArgs(['--provider-tool', 'discover'])).toMatch(/Unknown provider/);
    expect(parseToolArgs(['--provider-tool', 'discover', 'bing'])).toMatch(/Unknown provider "bing"/);
    expect(parseToolArgs(['electron', '.'])).toMatch(/Usage/);
  });
});
