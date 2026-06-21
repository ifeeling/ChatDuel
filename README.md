# ChatDuel

**English full name:** ChatDuel - Split-Screen Multi-AI Comparison Workspace  
**中文完整名：** ChatDuel - 多 AI 同步问答与横向对比工具

Chrome 扩展，用来在一个页面里同时对比 ChatGPT、Gemini、豆包、DeepSeek、Copilot、Grok 的回答。它不是 API 聚合器，不需要 API Key，而是嵌入用户已经登录的官方网页来操作。

## 主要功能

- 多 AI 同屏：当前支持 ChatGPT、Gemini、豆包、DeepSeek、Copilot、Grok，最多同时显示 3 个面板。
- 共用输入框：在底部输入一次，可以同时发送到启用的 AI。
- 指定目标：输入 `@chatgpt`、`@gemini`、`@doubao`、`@deepseek`、`@copilot`、`@grok` 或使用 @ 候选，只发给指定 AI。
- 面板管理：每个 AI 标题栏可以切换或关闭当前位置的 AI；底部“添加 AI”可以把隐藏的 AI 加回来。如果目标 AI 已经显示，则交换两个面板位置。
- 附件：支持图片、TXT、Markdown、CSV、PDF、Excel（XLSX）；不同平台会按当前能力自动上传或改用文字处理。DeepSeek、Copilot、Grok 当前需要在官方输入框里手动上传或粘贴图片。
- 转发：从某个 AI 的历史回答里选择一条或多条，转发给其它 AI 解读。
- 总结：从历史记录中选择多条问答，可选择参与总结的 AI，再让指定 AI 做对比总结；“最终结论 / 只看分歧 / 简短摘要 / 汇总意见”都有独立提示词可配置。
- 记录：按“每次用户提交”保存问题、实际发送内容、附件和 AI 回复，主要用于回看、单块复制、复制/导出 Markdown、总结和转发。导出 Markdown 会尽量恢复标题、列表、段落等常用格式。
- 官网会话：保存官方网页的具体会话链接和当时显示的 AI 状态，用来回到以前的官方对话继续聊；它不保存 AI 回复正文。
- 语言：设置里可以切换中文、English、Français、Deutsch、Svenska、Norsk、Nederlands。界面文案、帮助说明和默认提示词会按语言切换；用户保存过的提示词不会被语言切换覆盖，除非点击“恢复当前提示词默认值”。

## 记录和官网会话的区别

| 功能 | 记录内容 | 主要用途 |
| --- | --- | --- |
| 记录 | 用户问题、实际发送内容、附件、AI 回复 | 回看每轮结果、单块复制、复制/导出 Markdown、总结、转发 |
| 官网会话 | ChatGPT / Gemini / 豆包 / DeepSeek / Copilot / Grok 官方会话 URL、当时显示的 AI 状态 | 还原面板并打开旧对话继续聊 |

简单说：想看之前某一轮 AI 回答，用“记录”；想回到官网上的旧对话继续聊，用“官网会话”。

## 使用帮助

扩展页面左下角的设置按钮里有“使用帮助”页签，里面说明了发送、附件、面板管理、转发、总结、记录、官网会话等入口。“显示站点”页签里可以切换界面语言和重新检测状态；“提示词”页签用下拉框选择要编辑的模板，避免多个长文本框同时展开。以后新增功能时，也建议同步更新这里和本 README。

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
- 隐私政策草稿：`docs/store/privacy-policy.md`
- Chrome / Edge 上架材料草稿：`docs/store/chrome-edge-listing.md`
- DeepSeek 接入记录：`docs/DEEPSEEK_INTEGRATION_NOTES.md`
- Copilot 接入记录：`docs/COPILOT_INTEGRATION_NOTES.md`
- Grok 接入记录：`docs/GROK_INTEGRATION_NOTES.md`
