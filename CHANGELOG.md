# Changelog

## v0.4.13 (2026-07-16)

- Initial public open-source release under the MIT License.
- Chrome Web Store review note (#FZSL): the `scripting` and `downloads` permissions were previously declared but were not called by the code, so they have been removed. Content scripts are injected via static declaration, and exports are implemented through `Blob` + `<a download>`.
