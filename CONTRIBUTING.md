# Contributing to ChatDuel

Thanks for your interest in improving ChatDuel!

## Development setup

```bash
npm install
npm run dev       # vite dev server; load dist/ in chrome://extensions (Developer mode)
npm run build     # production build into dist/
npm run typecheck
```

## About the test suites

The automated unit and e2e test suites are **not included in this public repository**. As a result, `npm test` and `npm run test:e2e` will not run on a fresh clone. Pull requests are validated manually by the maintainers. If you would like to contribute tests, please open an issue to discuss first.

## Code style

- TypeScript throughout; follow the existing structure under `src/`.
- Run `npm run typecheck` and make sure it passes before submitting.
- Keep changes focused — one logical change per pull request.

## Pull requests

1. Fork the repository and create a feature branch.
2. Make your change with a clear, descriptive commit message.
3. Open a PR describing the motivation and what you changed.
4. If your change affects user-facing behavior, please also update `README.md` (English) and `README.zh-CN.md` (Chinese).

## Documentation language

- `README.md` is English; `README.zh-CN.md` is the Chinese version. Please keep both in sync for user-facing changes.
- Other docs (this file, PRIVACY.md, SECURITY.md) are in English.
