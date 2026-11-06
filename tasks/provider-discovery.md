# Provider discovery notes (read-only surveys, 2026-11-05)

Captured with `pnpm --filter @ie/desktop provider-tool discover <provider>`. Structure only, no page text.

## Gemini (config shipped, partly verified)
See `packages/providers/config/gemini.json`. Two live `enhance` runs: everything verified (see the config's `_status`). The result is a blob: image (1024x683 for a 768x512 input) read back via canvas. `download gemini --chat <url>` re-tests the download on an existing chat without generating.

## GPT (chatgpt.com): configured and verified (1 live generation: 768x512 in, 1536x1024 out in 42 s)
- Composer: `div.ProseMirror[contenteditable='true']` (`role=textbox`, label "Ask ChatGPT").
- File inputs already exist on the idle page (no menu step needed): four hidden `input[type=file]` with dynamic ids; accepts are
  `image/*`, `image/*,video/*`, `image/*`, and unrestricted. Select by `accept`, never by id.
- **None of the four file inputs has `multiple` (checked 2026-11-06).** Setting two files at once registered only the
  first, which failed real jobs with "Only 1 of 2 attachments appeared". `config/gpt.json` now uses
  `attachMode: "one-by-one"`: each file is set separately and its preview awaited before the next. Two synthetic
  attachments were confirmed in the composer this way.
- Controls seen: "Add files and more" (attach menu), "Dictate", "Temporary chat".
- Send: `button[aria-label='Send'][type=submit]` (appears once the composer has text).
- The session manager's readiness probe for gpt now reports `ready` (`div.ProseMirror[contenteditable='true']`).

## Grok (grok.com): configured; generation blocked by the account's image limit
- Composer: `.tiptap.ProseMirror[contenteditable='true']` (`role=combobox`, label "Ask Grok anything").
- One hidden `form input.hidden[type=file]` (no accept filter, **no `multiple`**) exists on the idle page. Same fix as
  GPT: `attachMode: "one-by-one"`.
- Attachment previews are the composer's `[aria-label*='Conversation attachments' i] [role='listitem']` list, not the
  conversation's `assets.grok.com` images. The old selector counted sent pictures, so it was replaced.
- Attach control: `button[data-testid='attach-button']` (opens a menu), but setting the hidden input directly works.
- A cookie banner (OneTrust) overlays the page; the discovery ignores it. A stray `<textarea>` on `body` is not the composer.
- The readiness probe reports `ready` (`.tiptap.ProseMirror[contenteditable='true']`).
- Send: `button[data-testid='chat-submit']` (appears once the composer has text).

- Grok live run: stopped with the site's own limit message ("You've used your image generations. Please try again later."), correctly classified as quota. Result selectors still need one successful generation.
- provider-tool markers <provider> [--chat <url>] lists which configured marker phrases match a page (add --draft snippet for a short snippet; test chats only).
- provider-tool discover <provider> [--attach] [--attach-count <n>] surveys the composer; with --attach it adds n throwaway images (one at a time, never sent) so attachment selectors can be checked without a generation.
