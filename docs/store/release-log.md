# ChatDuel 应用市场发布日记

这份文档记录每次提交 Chrome Web Store / Microsoft Edge Add-ons 时，GitHub 代码版本、GitHub Release 版本、商店文案、权限说明、发布包和验证结果。

以后每次发布新版前，先看这份文档，再看 GitHub tag / compare / release 页面整理本次更新内容，避免商店后台文案、隐私说明、权限说明和代码功能脱节。

## 每次发布前先做

1. 查看最近一条发布记录，确认上次应用市场版本、GitHub source version、GitHub Release version、包版本和商店文案。
2. 从 GitHub compare 页面整理本次变化，例如 `https://github.com/ifeeling/ChatDuel/compare/<上一版>...<新版>`。
3. 核对 `manifest.json`、`package.json`、`package-lock.json` 的版本号是否和本次 GitHub Release version 一致。
4. 核对 `manifest.json` 的权限、`host_permissions`、`_locales`、`default_locale` 是否和商店后台说明一致。
5. 跑发布前验证：`npm run typecheck`、`npm test`、`npm run build`。
6. 生成并检查 Release zip：根目录必须直接包含 `manifest.json`、`_locales`、`assets` 等扩展运行文件，不能把整个源码目录套进去。
7. 创建或更新 GitHub tag / Release 后，把 Release URL、zip 文件名、commit、compare URL 记回本文件。
8. 更新 Chrome Web Store / Edge Add-ons 文案时，只写当前版本真实支持的功能、平台、语言和权限用途。
9. 如果本次新增权限、host、数据处理、远程配置、截图、隐私政策或支持平台，必须同步更新商店说明和审核备注。
10. 发布后记录最终提交的商店语言、说明、摘要、隐私政策 URL、验证结果和任何审核注意事项。

## 每条发布记录建议包含

- 发布日期和应用市场版本。
- GitHub source version、source commit、source tag、compare URL。
- GitHub Release version、Release URL、Release zip 文件名。
- Chrome / Edge package version、manifest version、package.json version。
- 本次面向用户的更新内容。
- 本次商店文案：标题、简短摘要、详细说明。
- 权限、host permissions、数据使用和远程代码说明是否变化。
- 多语言和 `_locales` 状态。
- 发布前验证命令和结果。
- 截图、隐私政策、审核备注是否需要更新。
- 下次发布需要特别注意的事项。

## 2026-07-16 - v0.4.13

### 发布范围

- GitHub source version: `v0.4.13`
- GitHub compare source: `https://github.com/ifeeling/ChatDuel/compare/v0.4.12...v0.4.13`
- Chrome / Edge package version: `0.4.13`
- Manifest version: `0.4.13`
- Package.json version: `0.4.13`

### 本次代码变化

- **Claude 历史记录修复（commit b0643fd）**：`getLatestResponseText()` 旧版用「选最长文本」挑回答，多轮对话时误把更长的旧回答当当前回答抓取，导致抓取文本 == 发送前基线被判「无新内容」而**不写入记录**。改为用 Claude 官方 `[data-last-message='true']` 标记精确取最新消息；若标在用户提问上（AI 尚未回答）则倒序遍历所有消息取最新 AI 回复；用 `Claude responded:` / `You said:` 文本前缀区分 AI 与用户消息（实页验证 `justify-end` 不可区分），并去掉前缀。`selectors.json` 的 `lastResponse` 改为优先命中 `main [data-last-message='true'] [role='article']`。新增 3 个单测覆盖：最新是 AI 回复 / 最新是用户提问 / 旧回复更长仍取最新。
- **Claude 图标残留清理（commit fa62584）**：记录里回答末尾偶发 `[[[[[[[]` 等多余字符（消息内操作按钮/图标字体被 textContent 一并抓取）。`cleanClaudeText` 新增行尾清理：去掉连续的 `[`、`]`、空白、PUA 图标字体字符，保留常见句末标点；代码中的 `arr[0]` 等不会被误删。

### 验证结果

- 284 tests passed / 33 test files passed
- `npm run build` 成功

---

## 2026-07-14 - v0.4.12

### 发布范围

- GitHub source version: `v0.4.12`
- GitHub compare source: `https://github.com/ifeeling/ChatDuel/compare/v0.4.11...v0.4.12`
- Chrome / Edge package version: `0.4.12`
- Manifest version: `0.4.12`
- Package.json version: `0.4.12`

### 本次代码变化

- **英文翻译修复**：对比总结弹层一句话构式在英文语境下语法修正，多 AI 选择时不再出现 `豆包's content, let DeepSeek` 的错误结构，改为 `Choose content from ..., and have ... generate a ...`（中文不受影响，仅修改 `i18n.ts` 英文片段）。
- **DeepSeek 适配器修复**：`canUseExpandedResponseRoot` 增加 `ds-markdown` class 保护，避免回答容器向上扩展时丢失标记导致评分骤降。

---

## 2026-07-14 - v0.4.11

### 发布范围

- GitHub source version: `v0.4.11`
- GitHub compare source: `https://github.com/ifeeling/ChatDuel/compare/v0.4.10...v0.4.11`
- Chrome / Edge package version: `0.4.11`
- Manifest version: `0.4.11`
- Package.json version: `0.4.11`

### 本次代码变化

- 重构"对比总结"弹层配置区域为内联一句话 + 底部操作栏：
  1. **配置字段串成一句话**：`选择 [AI复选框] 的内容，由 [总结目标] 来生成 [总结方式]`，字段按操作顺序从左到右排列，更紧凑自然。
  2. **底部操作栏**：`已选择N条记录` 和 `取消/生成总结` 按钮放在同一行，左对齐信息 + 右对齐按钮，视觉对齐清晰。
  3. 翻译键从 `summary.targetLabel/modeLabel/sourceLabel` 拆分为 `summary.sentencePrefix/sentenceMid/sentenceSuffix` + `summary.sourceAriaLabel`。
  4. 转发弹层的 `.transfer-target-field` 样式保留，不受对比总结布局影响。

### 验证结果

- 274 tests passed / 32 test files passed
- `npm run build` 成功

---

## 2026-07-14 - v0.4.10

### 发布范围

- GitHub source version: `v0.4.10`
- GitHub compare source: `https://github.com/ifeeling/ChatDuel/compare/v0.4.9...v0.4.10`
- Chrome / Edge package version: `0.4.10`
- Manifest version: `0.4.10`
- Package.json version: `0.4.10`

### 本次代码变化

- 优化"对比总结"弹层布局和交互体验：
  1. **弹层尺寸增大**：`.summary-dialog` 宽度从 `min(1180px, 100vw-32px)` 提升到 `min(1400px, 100vw-48px)`，高度从 `min(760px, 100vh-32px)` 提升到 `min(85vh, 900px)`，内容显示更宽松。
  2. **配置区域左右分栏**：`.summary-config` 改为 flex 布局，左侧放配置字段（总结目标、总结方式、参与 AI、已选数量），右侧放操作按钮（取消、生成总结/转发）。释放了预览区域的垂直空间。
  3. **默认选中左most AI**：`pickSummaryTarget()` 不再硬编码 `chatgpt > gemini` 的优先级，而是按当前面板 DOM 顺序取第一个支持文本的 AI。用户调整好面板顺序后，总结目标会自动跟随最左边的 AI。

### 验证结果

- 274 tests passed / 32 test files passed
- `npm run build` 成功

---

## 2026-07-14 - v0.4.9

### 发布范围

- GitHub source version: `v0.4.9`
- GitHub compare source: `https://github.com/ifeeling/ChatDuel/compare/v0.4.8...v0.4.9`
- Chrome / Edge package version: `0.4.9`
- Manifest version: `0.4.9`
- Package.json version: `0.4.9`

### 本次代码变化

- 优化"记录"页面长回答的显示体验：
  - 给 `.history-block` 添加 `max-height: 160px` 和 `overflow-y: auto`，与"对比总结"的内容预览保持一致。
  - 长回答会在各自的内容块内滚动，不再撑开整个页面，方便快速浏览所有 AI 的回答标题。

### 验证结果

- 274 tests passed / 32 test files passed
- `npm run build` 成功

---

## 2026-07-14 - v0.4.8

### 发布范围

- GitHub source version: `v0.4.8`
- GitHub source commit: `TBD`
- GitHub compare source: `https://github.com/ifeeling/ChatDuel/compare/v0.4.7...v0.4.8`
- GitHub Release version: `v0.4.8`
- Chrome / Edge package version: `0.4.8`
- Release zip: `ChatDuel-v0.4.8-chrome-edge.zip`
- Manifest version: `0.4.8`
- Package.json version: `0.4.8`

### 本次代码变化

- 修复 DeepSeek 多轮对话（尤其是含图片的对话）中回复捕获间歇性失败的问题。
  - **根因**：`expandResponseCandidate()` 将 `div.ds-markdown` 向上扩展到父容器时，评分骤降（~100 → ~-20），导致多轮对话中历史回复的 `ds-markdown` 元素评分高于最新回复，系统持续选中历史回复文本。
  - **修复1**：`canUseExpandedResponseRoot()` 新增检查：如果当前元素已有 `ds-markdown` class（DeepSeek 完整回答容器），且父元素没有同类 class 也没有操作按钮，则阻止向上扩展。测试中的 `markdown`/`answer`/`ds-markdown-paragraph` 等 class 不受影响。
  - **修复2**：`getLatestResponseText()` 优化候选选择策略：优先从高分候选（score >= 50）中按 DOM 顺序取最后一个，确保多轮对话时始终返回最新回复。

### 验证结果

- 274 tests passed / 32 test files passed
- `npm run build` 成功

## 2026-07-13 - v0.4.7

### 发布范围

- GitHub source version: `v0.4.7`
- GitHub source commit: `a945499`
- GitHub source tag: `https://github.com/ifeeling/ChatDuel/tree/v0.4.7`
- GitHub compare source: `https://github.com/ifeeling/ChatDuel/compare/v0.4.6...v0.4.7`
- GitHub Release version: `v0.4.7`
- GitHub Release URL: `https://github.com/ifeeling/ChatDuel/releases/tag/v0.4.7`
- Chrome / Edge package version: `0.4.7`
- Release zip: `ChatDuel-v0.4.7-chrome-edge.zip`
- Manifest version: `0.4.7`
- Package.json version: `0.4.7`

### 本次代码变化

- 修复 DeepSeek "官网会话"功能：DeepSeek 的 URL（`https://chat.deepseek.com/`）pathname 始终是 `/`，没有 per-conversation 标识，无法通过 URL 恢复特定会话。
  - `isSpecificConversationUrl` 对 `deepseek` 返回 `false`，新保存的会话不再记录 DeepSeek URL。
  - `restoreConversation` 中跳过 pathname 为 `/` 的 DeepSeek URL，避免重新加载 iframe 后显示新对话页面。

### 验证结果

- 274 tests passed / 32 test files passed
- `npm run build` 成功

## 2026-07-13 - v0.4.6

### 发布范围

- GitHub source version: `v0.4.6`
- GitHub source commit: `5eadcc9`
- GitHub source tag: `https://github.com/ifeeling/ChatDuel/tree/v0.4.6`
- GitHub compare source: `https://github.com/ifeeling/ChatDuel/compare/v0.4.5...v0.4.6`
- GitHub Release version: `v0.4.6`
- GitHub Release URL: `https://github.com/ifeeling/ChatDuel/releases/tag/v0.4.6`
- Chrome / Edge package version: `0.4.6`
- Release zip: `ChatDuel-v0.4.6-chrome-edge.zip`
- Manifest version: `0.4.6`
- Package.json version: `0.4.6`

### 本次代码变化

- DeepSeek 面板加载时自动切换到识图模式，支持图片上传。
- 修复 DeepSeek 图片上传后无法自动发送的问题：`triggerSend` 采用 Enter 键优先、按钮回退的策略，参考 Gemini 的 `waitForSendAccepted` 检测机制，确保发送失败不会静默成功。
- 修复 DeepSeek 识图模式按钮文字重复匹配问题：radio 按钮内因 `aria-hidden` 副本导致 `textContent` 加倍，改用正则 `/^(识图模式)+$/` 匹配。
- 增强 `findSendControl`：新增 `DEFAULT_SEND_BUTTON_SELECTORS` 循环、`aria-disabled` 检查、排除非发送按钮（删除/上传/关闭等）。
- 增加 `_locales` 支持中英等多语言。

### Chrome Web Store 英文说明

保持 `v0.4.4` 的英文说明不变，仅更新 `DeepSeek vision mode` 相关功能点：

```text
Key features:
- Ask once and send to multiple AI services
- Compare ChatGPT, Gemini, Doubao, and DeepSeek responses in one workspace
- DeepSeek automatically switches to vision mode for image and file attachments
- Forward one AI answer to another AI for review
- Summarize shared opinions, disagreements, and final recommendations
- Attach supported files and images where the target AI website allows it
- Keep local records for review, copying, Markdown export, summary, and transfer
- Restore official chat links and continue on the original AI websites
- Interface language support for Chinese, English, French, German, Swedish, Norwegian, Dutch, Japanese, and Korean
```

### Chrome Web Store 简短摘要

```text
Split-screen multi-AI comparison workspace. No API keys, no data collection.
```

### Chrome Web Store 标题

```text
ChatDuel
```

### 本次后台需要核对

- 产品详情语言至少保留 `English (United States) - en-US`。
- 商店说明中已新增 DeepSeek 识图模式自动切换的描述。
- 权限、host 权限、远程代码说明无变化。

### 验证记录

```text
npm run typecheck
npm test
npm run build
```

验证结果：

- TypeScript 检查通过。
- 单元测试通过：32 个测试文件，274 个测试。
- 构建通过。
- Release zip 根目录包含 `manifest.json` 和 `_locales`。

### 备注

- 诊断脚本归档于 `docs/research/`，如果 DeepSeek 网页改版导致发送逻辑失效可参考。
- 如果后续把日语、韩语做成完整 UI 翻译，需要更新本发布日记和商店说明。

---

## 2026-06-23 - v0.4.4

### 发布范围

- GitHub source version: `v0.4.4`
- GitHub source commit: `7ab20d9`
- GitHub source tag: `https://github.com/ifeeling/ChatDuel/tree/v0.4.4`
- GitHub compare source: `https://github.com/ifeeling/ChatDuel/compare/v0.4.3...v0.4.4`
- GitHub Release version: `v0.4.4`
- GitHub Release URL: `https://github.com/ifeeling/ChatDuel/releases/tag/v0.4.4`
- Chrome / Edge package version: `0.4.4`
- Release zip: `ChatDuel-v0.4.4-chrome-edge.zip`
- Manifest version: `0.4.4`
- Package.json version: `0.4.4`

### 本次代码变化

- 按 Chrome 官方 i18n 机制新增 `_locales` 资源。
- `manifest.json` 使用 `default_locale` 和 `__MSG_...`。
- 商店/扩展包语言新增：中文、英语、法语、德语、瑞典语、挪威语、荷兰语、日语、韩语。
- 扩展内部语言下拉新增日语、韩语。
- 首次使用时按浏览器语言选择默认界面语言；用户手动保存语言后优先使用保存值。
- 下拉顺序调整为：English、Français、Deutsch、Svenska、Norsk、Nederlands、中文、日本語、한국어。
- DeepSeek 已在当前版本中作为支持平台保留。

### Chrome Web Store 英文说明

```text
ChatDuel is a split-screen workspace for comparing multiple AI web apps.

Ask once, send the same prompt to supported official AI websites, compare responses side by side, and organize consensus, disagreements, and next steps without API keys.

ChatDuel works with the official AI pages you are already logged into. It does not provide AI accounts, does not call LLM APIs, and does not bypass login, subscription, rate limit, regional availability, or content rules of any supported AI service.

Key features:
- Ask once and send to multiple AI services
- Compare ChatGPT, Gemini, Doubao, and DeepSeek responses in one workspace
- Forward one AI answer to another AI for review
- Summarize shared opinions, disagreements, and final recommendations
- Attach supported files and images where the target AI website allows it
- Keep local records for review, copying, Markdown export, summary, and transfer
- Restore official chat links and continue on the original AI websites
- Interface language support for Chinese, English, French, German, Swedish, Norwegian, Dutch, Japanese, and Korean

Privacy:
ChatDuel does not collect or upload your prompts, AI responses, attachments, account credentials, cookies, tokens, sessions, or browsing history to ChatDuel servers. Local records stay on your device. The extension only requests a non-executable configuration endpoint from chatduel.ifeeling.app to keep page selectors working when supported official AI websites change.
```

### Chrome Web Store 简短摘要

```text
Split-screen multi-AI comparison workspace. No API keys, no data collection.
```

### Chrome Web Store 标题

```text
ChatDuel
```

### 本次后台需要核对

- 产品详情语言至少保留 `English (United States) - en-US`。
- 如启用多语言商店详情，需要为中文、日语、韩语等语言分别填写对应本地化详情。
- 语言字段不要只停留在 English；已上传包内包含 `_locales`。
- 截图中不要出现真实账号、邮箱、私人聊天或敏感内容。
- 隐私政策 URL 使用 `https://chatduel.ifeeling.app/privacy`。
- 权限说明仍按固定域名填写，不要写 `<all_urls>`。
- 远程代码选择 `No, I am not using remote code.`。

### 验证记录

```text
npm run typecheck
npm test
npm run build
```

验证结果：

- TypeScript 检查通过。
- 单元测试通过：32 个测试文件，266 个测试。
- 构建通过。
- Release zip 根目录包含 `manifest.json` 和 `_locales`。

### 备注

- GitHub Release zip 适合测试用户或懂得手动加载扩展的用户。
- 普通用户仍建议通过 Chrome Web Store / Edge Add-ons 安装。
- 如果后续把日语、韩语做成完整 UI 翻译，需要更新本发布日记和商店说明。
