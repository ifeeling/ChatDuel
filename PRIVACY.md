# Privacy Policy

Last updated: August 20, 2026

ChatDuel is a local-first browser extension. Protecting your privacy is the core design goal, not an afterthought.

## What we store

- **Local storage only.** Everything — the questions you ask, the actual content sent to each AI, attachments, AI replies, and official-site session links — is stored **locally** in your browser's extension storage (`chrome.storage.local`). None of it is sent to our servers.
- We use the `unlimitedStorage` permission solely so that long conversation histories and large attachments are not cut off by the browser's standard storage quota.

## Local diagnostic records

To help troubleshoot sending, official-site acknowledgement, and response-reading failures, ChatDuel stores a small technical diagnostic log locally in the browser by default. It may include the extension version, platform name, processing stage, outcome, stable error code, timestamps, elapsed time, retry counts, and random diagnostic identifiers.

Diagnostic records never include prompt or response text, attachment names or contents, page URLs, official conversation links, account details, cookies, tokens, or other credentials. They are never uploaded automatically.

The log retains at most 20 send batches, 100 platform runs, 1,000 events, seven days of history, and 1 MB of serialized data. Older records are removed as complete send batches. In **Settings → Diagnostics**, you can disable new records, preview them before export, copy or download them, and clear them at any time. Records leave your device only when you explicitly copy, download, or send them.

## Prompt optimization

Next to the shared input box (the one question box that broadcasts to multiple platforms), you can tap "Optimize" to rewrite a short draft into a more detailed prompt. This is the one feature where content leaves your device before you send anything to an AI platform:

- **Only the text you submit for that one rewrite** is sent to ChatDuel's own server (`chatduel.ifeeling.app`), which forwards it to a third-party AI service to produce a rewritten suggestion and returns it to you.
- The request also includes a random, anonymous per-install identifier (not tied to any account, name, or email) used only to enforce a daily usage limit, and the extension version.
- The suggestion is shown to you as an editable preview. You can edit it, discard it and keep your original wording, or confirm it — nothing replaces your draft until you explicitly confirm.
- Prompt optimization never sends your conversation history, other platforms' answers, attachments, drafts you have not submitted for optimization, or any account information.
- This feature is on by default and can be turned off entirely in **Settings → Prompts**; once off, no text is ever sent for this purpose.

## What we do NOT do

- **No server uploads of your content, with one narrow exception.** Your prompts, conversations, and AI responses are never uploaded to any external server — except the specific text you explicitly submit via "Optimize" (see **Prompt optimization** above), and only that text.
- **No credential harvesting.** We do not collect or store your login credentials or session tokens. You stay logged in on the official AI sites yourself.
- **No third-party tracking.** We do not track your browsing outside the supported AI platforms.

## Other network requests we make

To keep DOM selectors up to date as the official AI sites change, ChatDuel periodically fetches a small configuration file from `https://chatduel.ifeeling.app/api/extension/config` (the project's own official website). This request sends **only the extension version** as a header — no account information, no conversation content, nothing identifiable. The result is cached locally.

When you click **Check for updates** in Settings, ChatDuel makes a single request to GitHub's public API (`https://api.github.com/repos/ifeeling/ChatDuel/releases/latest`) to look up the latest release. This is a plain, unauthenticated request — no account information or identifiers are sent, and it only happens when you click the button.

## Your control

You can clear all stored data at any time from your browser's extension settings.

## Contact

For privacy, data deletion, or security questions, contact `info@ifeeling.app`.
