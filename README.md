# ChatDuel

**English full name:** ChatDuel - Split-Screen Multi-AI Comparison Workspace
**中文完整名：** ChatDuel - 多 AI 同步问答与横向对比工具

A Chrome extension that lets you compare answers from multiple AIs side by side on a single page. It is **not** an API aggregator and needs **no API key** — instead it drives the official web UIs you are already logged into (by embedding them in iframes).

## Supported AIs

- ChatGPT
- Claude
- Gemini
- Doubao (豆包)
- DeepSeek

You can show up to **3 panels** at the same time.

## Features

- **Shared input box** — type once at the bottom and send to all enabled AIs at once.
- **Target a specific AI** — prefix with `@chatgpt`, `@claude`, `@gemini`, `@doubao`, `@deepseek`, or use the @-candidate menu, to send to just one.
- **Panel management** — each AI's title bar can switch or close the AI in that slot; "Add AI" brings hidden AIs back. If the target AI is already shown, the two panels swap positions.
- **Attachments** — images, TXT, Markdown, CSV, PDF, and Excel (XLSX) are supported; they are uploaded automatically or downgraded to text depending on each platform's current capability.
- **Forwarding** — pick one or more past answers from an AI and forward them to another AI for interpretation.
- **Summarizing** — select several Q&As from history, choose which AIs take part, and let a chosen AI write a comparison summary. "Final conclusion / disagreements only / short summary / combined opinion" each have their own configurable prompt.
- **History records** — per submission, saves the question, actual sent content, attachments, and AI replies, for review, per-block copy, Markdown export, summarizing, and forwarding. Markdown export restores headings, lists, and paragraphs where possible.
- **Official-site sessions** — saves the official conversation URL and the AI state shown at the time, so you can restore the panels and reopen an old chat to continue.
- **Languages** — the UI, help text, and default prompts switch among 中文 / English / Français / Deutsch / Svenska / Norsk / Nederlands / 日本語 / 한국어. Your saved prompts are not overwritten by language switching unless you click "Restore current prompt defaults".

## Records vs official-site sessions

| | Records | Official-site sessions |
| --- | --- | --- |
| What it saves | User question, actual sent content, attachments, AI replies | Official conversation URL (ChatGPT / Gemini / Doubao / DeepSeek / Claude) + AI state shown at the time |
| Main use | Review each round, copy per block, copy/export Markdown, summarize, forward | Restore panels and reopen an old official chat to continue |

In short: to look back at a past AI answer, use **Records**; to return to an old official conversation, use **Official-site sessions**.

## Usage help

The settings button (bottom-left of the extension) has a "Usage help" tab explaining sending, attachments, panel management, forwarding, summarizing, records, and official-site sessions. The "Display" tab switches the UI language and re-detects status; the "Prompts" tab uses a dropdown to pick the template to edit. When adding features later, update both this help and this README.

## Development

```bash
npm install
npm run dev        # start the vite dev server; load dist/ in chrome://extensions
npm test           # unit tests
npm run test:e2e   # e2e tests
npm run typecheck
```

## Load into Chrome / Edge

1. `npm run build`
2. Open `chrome://extensions` or `edge://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked" and select the `dist/` folder

## License

Released under the [MIT License](LICENSE).
