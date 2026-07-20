# Privacy Policy

Last updated: July 20, 2026

ChatDuel is a local-first browser extension. Protecting your privacy is the core design goal, not an afterthought.

## What we store

- **Local storage only.** Everything — the questions you ask, the actual content sent to each AI, attachments, AI replies, and official-site session links — is stored **locally** in your browser's extension storage (`chrome.storage.local`). None of it is sent to our servers.
- We use the `unlimitedStorage` permission solely so that long conversation histories and large attachments are not cut off by the browser's standard storage quota.

## Local diagnostic records

To help troubleshoot sending, official-site acknowledgement, and response-reading failures, ChatDuel stores a small technical diagnostic log locally in the browser by default. It may include the extension version, platform name, processing stage, outcome, stable error code, timestamps, elapsed time, retry counts, and random diagnostic identifiers.

Diagnostic records never include prompt or response text, attachment names or contents, page URLs, official conversation links, account details, cookies, tokens, or other credentials. They are never uploaded automatically.

The log retains at most 20 send batches, 100 platform runs, 1,000 events, seven days of history, and 1 MB of serialized data. Older records are removed as complete send batches. In **Settings → Diagnostics**, you can disable new records, preview them before export, copy or download them, and clear them at any time. Records leave your device only when you explicitly copy, download, or send them.

## What we do NOT do

- **No server uploads of your content.** Your prompts, conversations, and AI responses are never uploaded to any external server.
- **No credential harvesting.** We do not collect or store your login credentials or session tokens. You stay logged in on the official AI sites yourself.
- **No third-party tracking.** We do not track your browsing outside the supported AI platforms.

## The one network request we make

To keep DOM selectors up to date as the official AI sites change, ChatDuel periodically fetches a small configuration file from `https://chatduel.ifeeling.app/api/extension/config` (the project's own official website). This request sends **only the extension version** as a header — no account information, no conversation content, nothing identifiable. The result is cached locally.

## Your control

You can clear all stored data at any time from your browser's extension settings.

## Contact

For privacy, data deletion, or security questions, contact `info@ifeeling.app`.
