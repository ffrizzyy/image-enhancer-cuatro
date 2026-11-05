# Provider discovery notes (read-only surveys, 2026-11-05)

Captured with `pnpm --filter @ie/desktop provider-tool discover <provider>`. Structure only, no page text.

## Gemini (config shipped, partly verified)
See `packages/providers/config/gemini.json`. Two live `enhance` runs: everything verified (see the config's `_status`). The result is a blob: image (1024x683 for a 768x512 input) read back via canvas. `download gemini --chat <url>` re-tests the download on an existing chat without generating.

## GPT (chatgpt.com): configured and verified (1 live generation: 768x512 in, 1536x1024 out in 42 s)
- Composer: `div.ProseMirror[contenteditable='true']` (`role=textbox`, label "Ask ChatGPT").
- File inputs already exist on the idle page (no menu step needed): four hidden `input[type=file]` with dynamic ids; accepts are
  `image/*`, `image/*,video/*`, `image/*`, and unrestricted. Select by `accept`, never by id.
- Controls seen: "Add files and more" (attach menu), "Dictate", "Temporary chat".
- Send: `button[aria-label='Send'][type=submit]` (appears once the composer has text).
- The session manager's readiness probe for gpt does not match (status stays `unknown` with a visible composer): fix `providersConfig.gpt.probes`.

## Grok (grok.com): configured; generation blocked by the account's image limit
- Composer: `.tiptap.ProseMirror[contenteditable='true']` (`role=combobox`, label "Ask Grok anything").
- One hidden `form input.hidden[type=file]` (no accept filter) exists on the idle page.
- Attach control: `button[data-testid='attach-button']` (opens a menu).
- A cookie banner (OneTrust) overlays the page; the discovery ignores it. A stray `<textarea>` on `body` is not the composer.
- Readiness probe also does not match (status `unknown`): fix `providersConfig.grok.probes`.
- Send: `button[data-testid='chat-submit']` (appears once the composer has text).

- Grok live run: stopped with the site's own limit message ("You've used your image generations. Please try again later."), correctly classified as quota. Result selectors still need one successful generation.
- provider-tool markers <provider> [--chat <url>] lists which configured marker phrases match a page (add --draft snippet for a short snippet; test chats only).
