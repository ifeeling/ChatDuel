# AIChatRoom — Agent Instructions

## Project identity

Chrome extension for multi-AI chat comparison (ChatGPT + Gemini). NOT an API aggregator — operates on the user's already-logged-in official web pages. No API keys involved.

## Current state

Only `AIChatRoom_产品设想.md` exists — product spec document. No code, no `package.json`, no build tooling, no manifest.json.

## What matters (hard-earned context)

- **First-class targets**: ChatGPT + Gemini only. No Claude/DeepSeek/Grok in v1.
- **Gemini is the riskiest**: ChatBrawl (reference product) already fails at Gemini. Validate Gemini page interaction (input field detection, text injection, send trigger) before building UI.
- **Not a ChatBrawl clone**: Product design inspiration only. Implement from scratch.
- **Chrome extension first**, not Electron. The spec explicitly rejects Electron for v1.

## When coding begins

- `manifest.json` is the first file to create (Manifest V3).
- No test framework or lint config exists — set up before writing real logic.
- No dependencies to install yet; keep dependency count minimal per the spec.

## Development approach

- Spec recommends iterative validation per platform, not bulk feature builds ("每一步都要能实际测试").
- Page structure of ChatGPT/Gemini will change over time — avoid brittle selectors; use content scripts + mutation observers.

## Communication

- 所有非代码的回复、备注、说明全部使用中文。
