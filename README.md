two

Chrome 扩展，对照 ChatGPT + Gemini 两个 AI 的回答。

## 开发

```bash
npm install
npm run dev      # 启动 vite dev server，载入 dist/ 到 chrome://extensions
npm test         # 单元测试
npm run test:e2e # E2E 测试
npm run typecheck
```

## 加载到 Chrome

1. `npm run build`
2. 打开 `chrome://extensions`
3. 打开"开发者模式"
4. 点击"加载已解压的扩展"，选择 `dist/` 目录

## 文档

- 设计文档：`docs/superpowers/specs/2026-06-08-aichatroom-design.md`
- 实施计划：`docs/superpowers/plans/2026-06-08-aichatroom-impl.md`
