# Gemini page fixtures

Hand-built from the structure of the real Gemini page, captured read-only by the discovery tool
(`pnpm --filter @ie/desktop provider-tool discover gemini ...`) on 2026-11-05.

| File | Status |
|---|---|
| `idle.html` | **Verified** against the live page (composer, "Upload & tools" button) |
| `menu.html` | **Verified**: the overlay that appears when "Upload & tools" is clicked, with the three hidden file inputs |
| `send.html` | **Verified**: the "Send message" button that appears once the prompt has text |
| `attached.html` | **Verified**: the attachment chip shown after a file is attached |
| `generating.html`, `done.html`, `quota.html`, `refusal.html`, `challenge.html`, `logged-out.html` | **UNVERIFIED guesses.** Replace them with real captures after the live smoke |

Only structure (tags, classes, label attributes) is kept. No conversation text or personal data.