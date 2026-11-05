# Capability Map: Local Image Enhancer

Desktop app. User imports one image + a prompt, picks a category, slices the image into N tiles
(6 / 8 / custom grid), each tile is enhanced through the user's logged-in consumer web account
(ChatGPT, Gemini, Grok) by automating the web UI, then tiles are stitched into ONE enhanced image.

| Module id     | Responsibility                                                                 | Depends on                     |
|---------------|--------------------------------------------------------------------------------|--------------------------------|
| intake        | Image import, validation, job creation, prompt + category capture              | -                              |
| presets       | Category catalog (prompt templates, default prompts, fidelity, grid/overlap defaults, auto-detect) | -                              |
| slicer        | Grid split with overlap, tile metadata for reassembly                          | intake                         |
| sessions      | Isolated persistent browser session per provider, manual login, expiry detect  | -                              |
| providers     | Adapter interface + web-UI adapters (GPT, Gemini, Grok); optional API adapter later | sessions                  |
| orchestrator  | Per-tile prompt build, paced dispatch, pause/resume on captcha/quota, job state | slicer, presets, providers    |
| stitcher      | Overlap blending, color/style matching, optional whole-image pass              | slicer, orchestrator           |
| app-ui        | Electron renderer: upload, pickers, login status, progress, compare, export    | all                            |

Build order:
  sessions, presets, intake (parallel) -> providers, slicer (parallel) -> orchestrator -> stitcher -> app-ui

Specs: SPEC-<module-id>.md in this folder. This map is the index.

## Global decisions (apply to every module spec)
- Stack: Electron + TypeScript (strict), Node >= 20, pnpm, Vitest, Playwright Test for adapter/e2e.
  Electron chosen so each provider gets its own persistent `session.fromPartition('persist:<provider>')`
  and the whole app stays in one language.
- Everything local. Only network traffic is to the chosen provider's website.
- No passwords are ever read, stored, or logged by the app. The user logs in by hand in the provider window.
- Risk accepted by user: automating consumer web UIs may violate provider ToS and can trigger rate limits,
  captchas, or account flags. Recommend a secondary account. App shows this notice on first run.
- Provider-specific selectors/URLs live in versioned JSON config, not in code.
- Provider windows use Electron's built-in Chromium only. The app never launches the system default
  browser and v1 has no external-browser picker.
- Each prompt category supplies a default prompt that prefills Setup; the user may edit it. Auto-detect
  is a local, offline suggestion over the imported image plus prompt; it never calls a provider.
- Out of scope for v1: batch of images, cloud sync, accounts, billing, external-browser automation,
  learned/ML category classifiers.
- Provider build order: gpt first (proof of concept for automation reliability), then gemini, then grok.
- Spec status: all modules approved 2026-11-05; auto-detect, category-default prompts, and
  built-in-browser-only decisions folded in.
