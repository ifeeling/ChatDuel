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

## 2026-07-20 - v0.4.14

### 发布范围

- GitHub source version / tag: `v0.4.14`
- 功能代码提交：`a437a47`（`fix: stabilize response capture and embed lifecycle`）
- GitHub source tag: `https://github.com/ifeeling/ChatDuel/tree/v0.4.14`
- GitHub compare source: `https://github.com/ifeeling/ChatDuel/compare/v0.4.13...v0.4.14`
- GitHub 版本关联：本次以 Git tag `v0.4.14` 关联 Manifest 版本，未单独创建 GitHub Release 页面。
- Chrome / Edge package version: `0.4.14`
- Manifest version: `0.4.14`
- Package.json / package-lock.json version: `0.4.14`

### 面向用户的更新

- 新增所有支持 AI 的本地循环诊断：记录发送、路由、状态读取和回答抓取等技术事件，只保存在本机，不自动上传，也不记录问题、回答、附件名、网址或账号信息。
- 设置页新增诊断查看、导出预览、下载全部诊断、复制最近一次失败和清空记录。
- 修复 ChatGPT、Claude、Gemini 等平台长回答仍在增长时被固定超时误判为发送失败的问题。
- 修复豆包多轮对话选择旧回答、刚开始生成就显示完成、完成后又退回旧回答，以及长回答中途停顿时只保存部分内容的问题。
- 豆包现在以本轮可见操作栏作为主要完成信号，连续 45 秒无增长作为改版兼容兜底。
- 修复多个 ChatDuel 标签页并存时 DNR 嵌入规则可能被过早关闭的问题，并增加 iframe 首次加载失败后的规则恢复重试。

### 开发过程中的关键问题与解决方案

- **固定超时不适合长回答**：改为按最后一次内容增长计算无进展时间，并保留 10 分钟绝对上限。
- **豆包停止按钮不可稳定识别**：不再以“读到文字”作为完成依据，增加本轮节点快照、内容增长和可见操作栏的组合判断。
- **旧回答评分压过新回答**：发送前记录已有节点，本轮只接受新节点或内容变化节点；过滤在文本去重之前执行。
- **适配器和历史层生命周期不一致**：豆包首次完成后继续缓存本轮最终回答，直到下一次发送，满足上层连续稳定确认。
- **15 秒静默会截断分段生成**：操作栏连续检测两次后完成；没有操作栏时改为 45 秒静默兜底。
- **诊断按钮和日志噪声**：没有失败记录时给出明确提示；成功响应后清除残留 timeout 计时器。
- 详细技术复盘：`docs/postmortems/2026-07-20-response-diagnostics-and-doubao-capture.md`。

### 商店、权限与隐私变化

- 没有新增 `permissions`、`host_permissions` 或远程代码。
- 新增的诊断数据仅保存在 `chrome.storage.local`，不会自动上传；隐私政策和设置页已同步披露。
- DBG 回答抓取日志仍默认关闭；开启后控制台可能包含部分对话内容，需要用户确认后主动提供给开发者。
- Chrome / Edge 商店现有平台和权限说明无需新增域名，但发布说明应加入“本地技术诊断”和“长回答状态判断优化”。

### 验证结果

- `npm run typecheck`：通过。
- `npm test`：42 个测试文件、353 项测试通过。
- `npm run build`：通过。
- 用户真实页面验证：ChatGPT、Claude、Gemini、DeepSeek 长回答状态正常；豆包连续多轮长回答可完整记录，并在完成后正确更新状态。

### 后续维护提示

- 豆包改版时优先检查本轮回答节点、`message-action-bar` 可见性和 `completionActionBarDetected` 诊断字段。
- 新增 AI 平台时必须覆盖长回答增长、短暂停顿、多轮旧回答竞争和完成信号消失等测试。
- “复制最近一次失败”不会包含被误判为成功的批次；这类问题应让用户下载全部诊断，并按批次和平台执行链分析。

---

## 2026-07-16 - v0.4.13

### 发布范围

- GitHub source version: `v0.4.13`
- GitHub compare source: `https://github.com/ifeeling/ChatDuel/compare/v0.4.12...v0.4.13`
- Chrome / Edge package version: `0.4.13`
- Manifest version: `0.4.13`
- Package.json version: `0.4.13`

### 本次代码变化

- **新增 Claude（claude.ai）平台支持（主线功能）**：这是 0.4.13 最大的变化——Claude 从「文档调研」变成正式可对比平台。
  - 新增文件：`src/adapters/claude/adapter.ts`（约 502 行）、`src/content-scripts/claude-content.ts`（约 528 行）、`src/adapters/claude/selectors.json`、单测 `tests/unit/claude-adapter.test.ts`。
  - `src/lib/ai-platforms.ts`：把 `claude` 加入 `SUPPORTED_PLATFORMS`（现支持 chatgpt / gemini / doubao / deepseek / claude），并补 `claude` 元数据。
  - `manifest.json`：新增 host 权限 `https://claude.ai/*`，并新增对应 content_scripts 注入。
  - 关键修复（均围绕 Claude 接入）：
    - **lastActiveOrg cookie 修复（commit 6e1035c）**：这是 "Unsupported model" 的真正根因——Claude iframe 因存储分区隔离拿不到 `lastActiveOrg` cookie，模型菜单为空。content script 启动时调 Claude 官方 `/edge-api/bootstrap` 接口取组织 UUID 写入 iframe 分区 cookie，Claude 才正常显示可用模型。
    - **选择器无关兜底（commit ca9001b）**：修复回答抓取失败与状态机卡死，新增 DOM 深度遍历兜底（`findResponseByDomWalk`）。
    - **精确取最新 AI 回复（commit b0643fd）**：`getLatestResponseText()` 旧版用「选最长文本」挑回答，多轮对话误抓更长旧回答导致被判「无新内容」而**不写入记录**。改为用 Claude 官方 `[data-last-message='true']` 标记精确取最新消息，并用 `Claude responded:` / `You said:` 文本前缀区分 AI 与用户（实页验证 `justify-end` 不可区分），新增 3 个单测覆盖。
    - **图标残留清理（commit fa62584）**：记录里回答末尾偶发 `[[[[[[[]` 等字符（操作按钮/图标字体被 textContent 抓取）。`cleanClaudeText` 新增行尾清理，去掉连续的 `[`、`]`、空白、PUA 图标字体字符，保留句末标点。

### 本次商店文案 / 权限变化（重要）

- **新增 host 权限 `https://claude.ai/*`**：属于新增访问域名，提交 Chrome Web Store 会触发更深入的权限审核，且商店描述必须如实列出 Claude 平台。
- 已同步更新 `chrome-edge-listing.md`：一句话简介、详细描述、主要功能、指定目标（`@claude`）、host_permissions 说明、tabs/scripting 说明、Edge 清单与搜索词（Claude 从「不建议填写」移到「建议填写」）均已补 Claude。
- `permissions` 数组、`declarativeNetRequest`、`remote code` 口径均无变化。

### 验证结果

- `npm run typecheck` 通过（打包前发现 `adapter.ts` / `claude-content.ts` 共 3 个类型错误，均为 v0.4.13 提交时预存；已修复：`'start'`→`'started'`、`'done'`→`'finished'`、按钮 `.disabled` 加 `HTMLButtonElement` 类型转换，不影响运行时）。
- 284 tests passed / 33 test files passed
- `npm run build` 成功
- 发布包：`chatduel-v0.4.13.zip`（根目录直接含 manifest.json / _locales / assets / icons，结构与 v0.4.12 一致）。

> 注意：上述 3 处类型修复改动了 `src/`，使本地源码与 `v0.4.13` git 标签不一致。是否重新打 tag、升小版本或保留现状，由发布负责人决定（本次未自动 bump 版本、未 push）。

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
