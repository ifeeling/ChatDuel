# AIChatRoom

Chrome 扩展，用来在一个页面里同时对比 ChatGPT、Gemini、豆包的回答。它不是 API 聚合器，不需要 API Key，而是嵌入用户已经登录的官方网页来操作。

## 主要功能

- 多 AI 同屏：当前支持 ChatGPT、Gemini、豆包。
- 共用输入框：在底部输入一次，可以同时发送到启用的 AI。
- 指定目标：输入 `@chatgpt`、`@gemini`、`@doubao` 或使用 @ 候选，只发给指定 AI。
- 附件：支持图片、TXT、Markdown、CSV、PDF、Excel（XLSX）；不同平台会按当前能力自动上传或改用文字处理。
- 转发：从某个 AI 的历史回答里选择一条或多条，转发给其它 AI 解读。
- 总结：从历史记录中选择多条问答，让指定 AI 做对比总结。
- 历史：按“每次用户提交”保存问题、实际发送内容、附件和 AI 回复，主要用于回看、复制 Markdown、总结和转发。
- 会话：保存官方网页的具体会话链接，用来回到以前的官方对话继续聊；它不保存 AI 回复正文。

## 历史和会话的区别

| 功能 | 记录内容 | 主要用途 |
| --- | --- | --- |
| 历史 | 用户问题、实际发送内容、附件、AI 回复 | 回看每轮结果、复制、总结、转发 |
| 会话 | ChatGPT / Gemini / 豆包官方会话 URL | 打开旧对话继续聊 |

简单说：想看之前某一轮 AI 回答，用“历史”；想回到官网上的旧对话继续聊，用“会话”。

## 使用帮助

扩展页面左下角的设置按钮里有“使用帮助”页签，里面说明了发送、附件、转发、总结、历史、会话等入口。以后新增功能时，也建议同步更新这里和本 README。

## 开发

```bash
npm install
npm run dev      # 启动 vite dev server，载入 dist/ 到 chrome://extensions
npm test         # 单元测试
npm run test:e2e # E2E 测试
npm run typecheck
```

## 加载到 Chrome / Edge

1. `npm run build`
2. 打开 `chrome://extensions` 或 `edge://extensions`
3. 打开“开发者模式”
4. 点击“加载已解压的扩展”，选择 `dist/` 目录

## 文档

- 设计文档：`docs/superpowers/specs/2026-06-08-aichatroom-design.md`
- 实施计划：`docs/superpowers/plans/2026-06-08-aichatroom-impl.md`
