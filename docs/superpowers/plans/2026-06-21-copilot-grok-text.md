# Copilot/Grok Text Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Copilot and Grok as optional text-capable ChatDuel platforms, leaving image/file auto-upload disabled until separate upload validation.

**Architecture:** Follow the existing platform pattern: platform metadata, HTML panels, content scripts, adapters, DNR rules, service worker URL prefixes, tests, and integration notes. Copilot/Grok adapters use conservative generic DOM selectors for text write/send/last-response capture.

**Tech Stack:** TypeScript, Chrome MV3 extension APIs, Vitest, Vite.

---

## Files

- Modify: `src/types/index.ts`
- Modify: `src/lib/ai-platforms.ts`
- Modify: `src/lib/user-settings.ts`
- Modify: `src/lib/i18n.ts`
- Modify: `src/chat/chat.html`
- Modify: `src/chat/chat.ts`
- Modify: `manifest.json`
- Modify: `vite.config.ts`
- Modify: `src/background/dnr-rules.ts`
- Modify: `src/background/service-worker.ts`
- Modify: `src/lib/remote-selector-config.ts`
- Create: `src/adapters/copilot/adapter.ts`
- Create: `src/adapters/grok/adapter.ts`
- Create: `src/content-scripts/copilot-content.ts`
- Create: `src/content-scripts/grok-content.ts`
- Create: `docs/COPILOT_INTEGRATION_NOTES.md`
- Create: `docs/GROK_INTEGRATION_NOTES.md`
- Modify/Add tests under `tests/unit/`

## Task 1: Platform Registration

- [ ] Add `copilot` and `grok` to `AIPlatform`.
- [ ] Add metadata to `AI_PLATFORMS` with `supportsText: true`, `supportsLastResponse: true`, `supportsImageUpload: false`, `supportsFileUpload: false`.
- [ ] Keep both default-disabled in user settings.
- [ ] Update tests:
  - `tests/unit/ai-platforms.test.ts`
  - `tests/unit/user-settings.test.ts`
  - `tests/unit/file-handler.test.ts`
- [x] Run:

```bash
npm run test -- tests/unit/ai-platforms.test.ts tests/unit/user-settings.test.ts tests/unit/file-handler.test.ts
```

Expected: all selected tests pass.

## Task 2: UI Panels And Platform Routing

- [x] Add Copilot/Grok panels and settings rows in `src/chat/chat.html`.
- [x] Ensure `src/chat/chat.ts` platform maps do not hard-code only existing four platforms. If a map must stay explicit, add Copilot/Grok entries.
- [x] Update i18n strings for open-site labels and any help text that lists platforms.
- [x] Update `tests/unit/chat-html.test.ts`.
- [x] Run:

```bash
npm run test -- tests/unit/chat-html.test.ts tests/unit/i18n.test.ts
```

Expected: panel and i18n tests pass.

## Task 3: Embed Rules And Content Script Wiring

- [x] Add host permissions and content scripts in `manifest.json`.
- [x] Add Vite inputs for `content-copilot` and `content-grok`.
- [x] Add DNR rules for `copilot.microsoft.com` and `grok.com`, using new rule IDs after DeepSeek.
- [x] Update service worker URL prefixes.
- [x] Update startup cleanup `removeRuleIds`.
- [x] Update content script location tests and manifest tests.
- [x] Run:

```bash
npm run test -- tests/unit/manifest.test.ts tests/unit/content-script-location.test.ts
```

Expected: manifest and URL matching tests pass.

## Task 4: Text Adapters And Content Scripts

- [x] Create Copilot adapter using the DeepSeek adapter structure but with Copilot error messages.
- [x] Create Grok adapter using the same conservative generic selector strategy.
- [x] For `sendMessage(text)`, write text, wait briefly, then trigger send.
- [x] For `getLastResponse()`, reuse `elementToMarkdownText()` and candidate scoring similar to DeepSeek.
- [x] Create content scripts by following `deepseek-content.ts`.
- [x] Add unit tests:
  - `tests/unit/text-web-adapter.test.ts`
- [x] Run:

```bash
npm run test -- tests/unit/text-web-adapter.test.ts
```

Expected: adapter tests pass.

## Task 5: Remote Selector Whitelist And Docs

- [x] Allow remote selector override keys for Copilot/Grok: `inputBox`, `sendButton`, `response`.
- [x] Add tests in `tests/unit/remote-selector-config.test.ts`.
- [x] Add `docs/COPILOT_INTEGRATION_NOTES.md`.
- [x] Add `docs/GROK_INTEGRATION_NOTES.md`.
- [x] Update `README.md` supported platform wording.
- [x] Run:

```bash
npm run test -- tests/unit/remote-selector-config.test.ts
```

Expected: remote selector config tests pass.

## Task 6: Final Verification

- [x] Run full unit test suite:

```bash
npm run test
```

- [x] Run typecheck:

```bash
npm run typecheck
```

- [x] Run build:

```bash
npm run build
```

- [ ] Commit and push:

```bash
git add -u
git add -f docs/COPILOT_INTEGRATION_NOTES.md docs/GROK_INTEGRATION_NOTES.md
git commit -m "Add Copilot and Grok text platforms"
git push origin main
```

Expected: all verification commands exit 0 and the branch is pushed.

## Self-Review

- Spec coverage: platform registration, UI routing, content scripts, adapters, DNR/service worker, remote selector whitelist, docs, tests, and verification are covered.
- Placeholder scan: no TODO/TBD placeholders remain.
- Type consistency: platform keys are consistently `copilot` and `grok`; adapter method names match `AIAdapter`.
