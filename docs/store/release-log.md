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

## 2026-07-13 - v0.4.7

### 发布范围

- GitHub source version: `v0.4.7`
- GitHub source commit: `a118abe`
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
