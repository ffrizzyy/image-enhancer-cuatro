import type { ProviderConfig } from '../../src';

/** A complete, valid config for a made-up chat site. The first promptInput fallback is deliberately absent. */
export function testConfig(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'gpt',
    urls: { newChat: 'https://chat.example.test/new' },
    selectors: {
      promptInput: ['#prompt-missing', '#prompt'],
      attachInput: ['input[type=file]'],
      attachmentThumb: ['.thumb'],
      submitButton: ['button.send'],
      generatingIndicator: ['.spinner'],
      resultImage: ['img.result'],
    },
    markers: {
      loggedOut: { selectors: ['.login-btn'], text: ['log in to continue'] },
      challenge: { selectors: ['iframe.captcha'], text: ['verify you are human'] },
      quota: { selectors: [], text: ['usage limit'] },
      refusal: { selectors: [], text: ["can't help with that"] },
    },
    timeouts: { navigationMs: 2000, attachMs: 2000, generationMs: 3000, downloadMs: 2000 },
    capabilities: { maxAttachments: 3, outputAspects: ['1:1', '2:3', '3:2'], approxOutputPx: 1024 },
    minOutputPx: 512,
    ...over,
  };
}
