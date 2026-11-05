import { ProviderIdSchema } from '@ie/contracts';
import { z } from 'zod';

/**
 * Every selector the shared WebAdapter looks up. The config schema is generated from this list, so a
 * provider config that lacks one of these keys cannot validate.
 */
export const REQUIRED_SELECTOR_KEYS = [
  'promptInput',
  'attachInput',
  'attachmentThumb',
  'submitButton',
  'generatingIndicator',
  'resultImage',
] as const;

export type SelectorKey = (typeof REQUIRED_SELECTOR_KEYS)[number];

/** The keys that exist on a fresh, idle chat page: the only ones `health()` can check without generating. */
export const IDLE_SELECTOR_KEYS: readonly SelectorKey[] = ['promptInput', 'attachInput', 'submitButton'];

/** Ordered fallbacks: the first selector that matches wins. */
const selectorList = z.array(z.string().min(1)).min(1);

/** A page state recognised by CSS selector, by visible text (case-insensitive), or both. */
const marker = z
  .object({
    selectors: z.array(z.string().min(1)),
    text: z.array(z.string().min(1)),
  })
  .refine((m) => m.selectors.length + m.text.length > 0, 'a marker needs at least one selector or phrase');

const ms = z.number().int().positive();

const selectors = z.object(
  Object.fromEntries(REQUIRED_SELECTOR_KEYS.map((key) => [key, selectorList])) as Record<SelectorKey, typeof selectorList>,
);

export const ProviderConfigSchema = z.object({
  id: ProviderIdSchema,
  urls: z.object({
    /** Opens a brand-new, empty chat. */
    newChat: z.string().url(),
  }),
  selectors,
  markers: z.object({
    loggedOut: marker,
    challenge: marker,
    quota: marker,
    refusal: marker,
  }),
  timeouts: z.object({
    navigationMs: ms,
    attachMs: ms,
    /** Upper bound for one image to be generated; the request's own `timeoutMs` can only shorten it. */
    generationMs: ms,
    downloadMs: ms,
  }),
  capabilities: z.object({
    maxAttachments: z.number().int().min(1),
    outputAspects: z.array(z.enum(['1:1', '2:3', '3:2'])).min(1),
    approxOutputPx: z.number().int().min(256),
  }),
  /** A download whose longest side is smaller than this is treated as a preview, not the real image. */
  minOutputPx: z.number().int().positive(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type MarkerKind = keyof ProviderConfig['markers'];
