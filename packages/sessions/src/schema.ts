import { z } from 'zod';

const selectors = z.array(z.string().min(1));

export const ProviderConfigSchema = z.object({
  loginUrl: z.string().url(),
  probes: z.object({
    /** Present only when signed in (e.g. the prompt composer). */
    ready: selectors.min(1),
    /** Present only when signed out (e.g. a login button). */
    loggedOut: selectors.min(1),
    /** Captcha / bot-check widgets. */
    challenge: selectors,
    /** Usage-limit banners. */
    quota: selectors,
  }),
  /** Case-insensitive phrases searched in the visible page text. */
  textMarkers: z.object({
    challenge: z.array(z.string().min(1)),
    quota: z.array(z.string().min(1)),
  }),
});

export const ProvidersConfigSchema = z.object({
  gpt: ProviderConfigSchema,
  gemini: ProviderConfigSchema,
  grok: ProviderConfigSchema,
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;
