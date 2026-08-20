# Changelog

## v0.4.19 (2026-08-06)

- Fixed an extra divider line rendering between adjacent visible panels when a panel was hidden.
- Internal refactor: consolidated question-send orchestration into a single "question send coordinator" deep module and unified per-platform command vocabulary into one source of truth. Send behavior is unchanged; testability improved.

## v0.4.18 (2026-08-04)

- Added a "Check for updates" control to Settings: shows the current version and a spinner while checking, then reports up-to-date / update-available / check-failed. An update dialog shows the new version and changelog pulled from GitHub Releases, with buttons to open GitHub or the extension's store listing.
- Added official-website and GitHub links to Settings.
- Rewrote the in-app Help panel into about ten cards covering the send queue, `@`-prefixed targeted sends, panel divider dragging, the four summary modes, failure recovery, history search/copy/delete, and account/settings features.
- Wired up the summary task end-to-end, including failure recovery and a safety re-check pass.
- Fixed several summary/history state bugs: callback propagation, dedup on failed-retry (upsert instead of insert), and list selection/highlight issues.
- Shows a refresh prompt on already-open pages after the extension updates.
- Migrated ChatGPT/Gemini/Claude/DeepSeek/Doubao content-script commands onto a shared command bridge.
- Added `host_permissions` for `https://api.github.com/*`, used only when checking for updates.

## v0.4.17 (2026-07-29)

- Added a "pending question queue": prepare, edit, and manage multiple questions before sending, with per-question file/image attachments where the target platform supports it (e.g. DeepSeek image understanding).
- Questions can now carry attachments and are dispatched in queue order.
- Improved DeepSeek attachment/image-understanding stability across multi-turn conversations by narrowing failure detection.
- Centralized response capture and completion detection across adapters into a single answer-collection task for more consistent cross-platform behavior.
- History-write failures no longer silently drop a captured answer; the answer is preserved and a diagnostic is recorded.
- Fixed a status-bar bug where the platform stayed stuck on "waiting" after an answer appeared but the platform never reported a `streaming` state (notably DeepSeek with images).

## v0.4.16 (2026-07-27)

- Adapted Claude response capture to the current `role="article"` message structure while distinguishing user prompts from Claude responses.
- Fixed Claude completion detection by using visible controls scoped to the latest response and ignoring hidden stale stop buttons.
- Kept long thinking or tool-use responses alive while a real stop button confirms active generation.
- Prevented an older remote selector configuration from overriding a newer bundled selector version.

## v0.4.15 (2026-07-21)

- Published local diagnostic records, progress-aware long-response waiting, Doubao multi-turn response capture fixes, and iframe embed-rule lifecycle recovery.
- Kept `docs/`, `tests/`, and `AGENTS.md` as local maintenance material rather than GitHub release source.
- Added a loadable extension ZIP to the GitHub Release and aligned the Manifest, package version, tag, Release, and build artifact.

## v0.4.14 (2026-07-20)

- Added local-only diagnostic trails for send, routing, response state, and capture failures.
- Replaced the fixed response timeout with per-platform progress tracking and a ten-minute absolute limit.
- Fixed Doubao long-response, multi-turn, completion-signal, and stale-answer capture problems.
- Fixed DNR iframe rule lifecycle behavior when several ChatDuel pages are open and added first-open iframe recovery.

## v0.4.13 (2026-07-16)

- Initial public open-source release under the MIT License.
- Chrome Web Store review note (#FZSL): the `scripting` and `downloads` permissions were previously declared but were not called by the code, so they have been removed. Content scripts are injected via static declaration, and exports are implemented through `Blob` + `<a download>`.
