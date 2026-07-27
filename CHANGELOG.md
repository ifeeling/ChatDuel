# Changelog

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
