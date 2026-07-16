# Claude 接入踩坑记录（已归档）

> ## ✅ 本问题已解决（2026-07-16）
>
> 本文档记录的是 2026-06-20 Claude 被移除时的排查过程。**该问题已在 2026-07-16 通过 `lastActiveOrg` cookie 方案彻底解决**——根因是 iframe 存储分区隔离导致 cookie 缺失，而非文档里推测的"缓存/UI 问题"。
>
> 当前权威文档见 **`docs/CLAUDE_INTEGRATION_NOTES.md`**（含根因、修复 commit、实页验证状态）。
> 本文档已归档至 `docs/research/`，仅保留作为历史排查参考，不再随版本更新。

---

## 最终结论（历史，撰写于 2026-06-20）

2026-06-20，Claude 已从 ChatDuel 扩展运行时移除。

保留本文档，不保留 Claude adapter、Claude content script、Claude iframe panel、Claude manifest 权限、Claude DNR 规则和 Claude 相关单测参与构建。

原因很直接：Claude 官方页在 iframe 里会卡在不可用的旧模型 `claude-3-5-haiku-latest`，而模型菜单虽然能打开外壳，却不生成任何可选模型项。用户在独立 Claude 标签页里切到 `Sonnet 4.6 Low` 后，iframe 刷新仍然显示旧模型。这样继续把 Claude 放在扩展里，会让用户看到一个"可点、可输入、但实际模型不可用且无法切换"的入口，体验比没有入口更差。

如果以后重新加 Claude，先不要直接恢复旧代码。应先验证 Claude 官方页是否已经能在 iframe 环境里正常列出并切换模型；如果仍然不行，就只能重新设计成"官方标签页驱动"的独立方案，而不是把它当作普通 iframe 平台接回三平台框架。

> ⚠️ 注：上面"如果以后重新加 Claude"的担忧**已不成立**。2026-07-15 重新接入，2026-07-16 用 cookie 方案修复了模型菜单问题，Claude 已可作为普通 iframe 平台正常使用。无需"官方标签页驱动"备选方案。

## 背景

ChatDuel 接入 Claude 时，目标是把 Claude 作为第 4 个可选官方网页平台加入：

- 平台顺序：`chatgpt`、`gemini`、`claude`、`doubao`
- 最多仍同时显示 3 个面板
- Claude 默认关闭
- 不走 Claude API，不需要 API Key

## 已验证链路

- `https://claude.ai/` 可以被 iframe 加载，content script 能注入并向父页发送 ready。
- DNR embed rule 需要包含 `claude.ai`，启用后动态规则数量应为 4。
- Claude 输入框可以通过 content script 写入文本。
- Claude 发送按钮可能没有稳定的 `aria-label`，不能只依赖 `button[aria-label="Send message"]`。
- 修复后，Claude 能成功触发发送，控制台能看到：
  - `[AIChatRoom chat] write-and-send result for claude: ok=true error=`

## 关键坑

### 1. 发送按钮选择器不能只靠 aria-label

最初的本地 selector 是：

```text
button[aria-label="Send message"], button[aria-label*="Send"], button[type="submit"]
```

真实页面里，Claude 发送按钮可能只是输入框工具栏里的无文本、无稳定 label 图标按钮。结果是：

```text
claude send button not found
```

正确做法：

- 先尝试明确 selector。
- 找不到时，从输入框向上找“同时包含输入框和按钮”的 composer 外层容器。
- 在这个容器里找最后一个未禁用的 `button` 或 `[role="button"]` 作为发送按钮兜底。

注意：不要在刚遇到第一个包含输入框的 wrapper 时就停下。Claude 的输入框和按钮可能在同一个外层 composer 下，但不是同一个直接父容器。

### 2. 发送成功不等于 Claude 一定能回答

发送按钮触发成功后，Claude 自己可能因为账号、模型或服务端状态报错，例如：

- `This model isn't available right now. You can switch to another model to continue using Claude.`
- `/completion 403`
- model config 404

这些是 Claude 官方网页自身状态，不是 ChatDuel 写入/点击链路的问题。判断 ChatDuel 发送是否成功，看父页日志里的 `write-and-send result for claude: ok=true`。

### 3. 远程 selector 白名单必须同步加平台

项目有服务器下发 selector 的链路：

- `src/lib/remote-selector-config.ts`
- `ALLOWED_SELECTOR_KEYS`

新增 AI 平台时，不只是加本地 adapter/selectors.json。还要把新平台加进远程 selector 白名单，否则服务器下发的 selector 会被本地 sanitize 过滤掉。

Claude 当前允许的 key 对齐 ChatGPT/Gemini：

- `inputBox`
- `sendButton`
- `messageContainer`
- `lastResponse`
- `userMessage`
- `rateLimitToast`
- `continueButton`
- `stopButton`
- `loggedIn`
- `fileInput`

### 4. 新平台要补完整协议链路

新增平台不只是 UI 加一行。至少要检查：

- `src/types/index.ts` 的 `AIPlatform`
- `src/lib/ai-platforms.ts` 的 `SUPPORTED_PLATFORMS` 和能力
- `src/lib/user-settings.ts` 默认值和旧设置补齐
- `manifest.json` host permissions 和 content script
- `src/background/dnr-rules.ts` iframe 嵌入规则
- `src/background/service-worker.ts` 官方 tab URL 前缀
- `src/chat/chat.html` 面板和设置行
- `src/chat/chat.ts` 平台状态 map
- `src/lib/remote-selector-config.ts` 远程 selector 白名单
- `src/lib/conversation-store.ts` 官方会话 URL 识别
- `src/lib/i18n.ts` 站点 owner/open 文案
- `vite.config.ts` content script build input
- adapter 单测、manifest 单测、HTML 单测、selector schema 单测

### 5. 真实页面验证要分层看

排查时先分层：

1. iframe 是否加载。
2. content script 是否 ready。
3. 输入框是否能写入。
4. 发送按钮是否能触发。
5. Claude 官方是否真的完成回答。
6. ChatDuel 是否能读取最后回答。

这次发送问题卡在第 4 层，前 1-3 层都正常。

### 6. Claude 回答内容不一定有语义标记

发送成功后，历史记录仍可能显示“待回填”。这时不要再看发送按钮，应该看读取回答链路：

- `getConversationState()`
- `getLastResponse()`
- `src/adapters/claude/adapter.ts` 里的 `getLatestResponseText()`

真实 Claude 页面里，回答内容有时不是下面这些结构：

```text
[data-testid="assistant-message"]
Claude responded:
article
section
```

而只是普通 `main` 下的 `div/p` 内容块，旁边还混着消息操作按钮、通知条、模型选择器和 composer。只依赖 `lastResponse` selector 或标题标记会读不到内容，导致：

```text
Claude 已发送，等待回答
历史记录里 Claude 待回填
```

当前做法：

- 先读明确 selector。
- 再读 `Claude responded:` 标记。
- 最后从 `main` 里的普通文本节点兜底读取。
- 兜底读取时排除按钮、输入框、通知条等 UI 文案。
- 从最后一个有效文本叶子向上找最近的回答容器，以便多段回答能合并。

### 7. 工具调用进度不要写进历史

Claude 开启联网或工具调用时，页面文本里可能混入工具状态，例如：

```text
Fetching sports data
Fetching sports data
Searched the web
Searched the web, used a tool
```

这些不是最终回答内容，不能保存进历史记录。另一个相关问题是 Claude 底部消息操作按钮可能在文本里暴露成几个纯图标字符，看起来像一串空方框，也不能保存。

当前清洗规则：

- 删除 `Fetching ... data`
- 删除 `Searched the web` / `Searched the web, used a tool`
- 删除没有任何文字或数字的纯图标行
- 如果回答开头句在工具状态后又重复出现一次，删掉第一份重复开头

对应回归测试：

- `tests/unit/claude-adapter.test.ts`
  - `removes Claude tool progress and icon-only action text from captured responses`

相关回归测试：

- `tests/unit/claude-adapter.test.ts`
  - `reads Claude responses from plain main text when semantic assistant markers are missing`

### 8. 点击发送后要确认输入框真的提交了

Claude 新会话页里，有时输入框能写入内容，发送图标也显示为可点，但图标按钮点击没有真正提交。只看 `click()` 有没有执行会产生假成功：

- ChatDuel 显示 `Claude 已完成`
- Claude 输入框里仍然留着用户问题
- 历史记录自然没有 Claude 回答

当前做法：

- 写入文本后先点击发送按钮。
- 等待一小段时间，看 composer 里是否还保留原提示词。
- 如果还在，聚焦输入框后发送一次 Enter 作为兜底。
- 如果提示词仍然留在 composer 里，抛出 `claude message did not submit`，让上层按发送失败处理。

对应回归测试：

- `tests/unit/claude-adapter.test.ts`
  - `retries with Enter when clicking Claude send leaves the prompt in the composer`
  - `reports Claude send failure when the prompt stays in the composer after fallback`

### 9. iframe 内模型下拉不要被父页抢焦点

Claude 的模型选择器在独立网页窄窗口里可以正常展开，但嵌到 ChatDuel iframe 后可能点不开。根因不是 Claude selector，而是父页底部共用输入框的焦点恢复逻辑：

- 用户刚用过 ChatDuel 底部输入框。
- 再去 iframe 里点 Claude 的模型选择器。
- 浏览器可能触发父窗口 blur/focus。
- 父页把焦点恢复到底部输入框，Claude 的下拉菜单随即关闭。

当前做法：

- 保留底部输入框的焦点恢复能力。
- 但如果当前焦点已经落在 `.panel-iframe`，就不要再抢回到底部输入框。

对应回归测试：

- `tests/unit/focus-restore.test.ts`
  - `does not steal focus back from an AI iframe interaction after the composer was active`

### 10. iframe 里模型菜单打开但高度可能被压扁

修掉父页抢焦点后，Claude 模型按钮能正常变成：

```text
aria-expanded="true"
```

但下拉菜单仍可能看不到。真实调试数据里，菜单节点已经出现：

```text
role="menu"
rect: 129,336 128x9
display: flex
visibility: visible
```

这说明问题不是按钮没点开，而是 Claude 自己的浮层在 iframe 里把可用高度算得太小，只剩 9px，看起来像完全没弹出。

当前做法：

- 在 `src/content-scripts/claude-content.ts` 里只给 Claude 页面注入一个很小的 iframe 样式补丁。
- 目标只限定在 `[data-cds="Menu"][role="menu"][data-open]`。
- 当菜单向下打开时，强制给它一个可用高度，并把菜单向上挪，避免被 iframe 底部压住。
- 只撑外层菜单不够；Claude 内部还有滚动容器，如果内部层仍然沿用错误高度，会出现“灰色菜单外壳可见但没有选项内容”的现象，所以内部 `overflow-y-auto` 层也要继承修正后的高度。

后续实测又发现一层限制：

- 单独打开的 `https://claude.ai/new` 可以切到 `Sonnet 4.6 Low`。
- ChatDuel iframe 里的 Claude 仍显示 `claude-3-5-haiku-latest`。
- 两边 `localStorage` 都能看到 `claude-sonnet-4-6` 相关 key，但当前模型仍不同。

这说明当前模型不是简单复制 `localStorage` 就能同步的状态。曾短暂尝试过官方 tab 兜底：如果用户已经单独打开 Claude 官方页并在那里切好模型，发送 Claude 时优先通过 Service Worker 把消息发到这个官方 tab；找不到官方 tab 时才回落到 iframe。

这条路最后没有保留，原因是它会让 Claude 成为唯一一个不按当前扩展面板发送的特殊平台：面板里显示旧模型，真实发送却可能发生在另一个独立标签页。对用户来说状态不透明，也会破坏“扩展框架内同屏对比”的一致性。

已排除的错误方向：

- **不是父页抢焦点**：模型按钮已经能进入 `aria-expanded="true"`。
- **不是单纯外层高度问题**：CSS 修正后能看到灰色菜单外壳，但选项内容仍为空。
- **不是简单复制 localStorage**：iframe 和独立 Claude 页都能看到 `claude-sonnet-4-6` 相关 key，但 iframe 当前模型仍显示旧的 `claude-3-5-haiku-latest`。
- **模型项没有生成**：空菜单 DOM 里只有 `<div role="group"></div>` 和分隔/渐变层，没有任何 `Sonnet` / `Opus` / `Haiku` 菜单项；这不是隐藏问题，而是官方页面在 iframe 环境没有填充模型列表。
- **不能把 iframe 当前模型显示当成发送实际模型**：如果走官方 tab 兜底，真实发送会发生在用户已选好模型的独立 Claude 标签页里；这也是最终放弃兜底、移除 Claude 运行时的原因之一。

下一步若继续查 iframe 空菜单，优先收集以下证据，不要再盲改 CSS：

1. 点击 iframe 的模型按钮后，统计 iframe DOM 中是否存在 `Sonnet` / `Opus` / `Haiku` 文本。
2. 观察网络面板里 Claude 模型列表/账号能力相关请求，在 iframe 和独立页之间是否返回不同。
3. 检查 iframe 环境是否触发了 `Framing https://a.claude.ai/ ... blocked`、`s-cdn.anthropic.com/s.js` 加载失败，或其它影响模型列表初始化的资源错误。
4. 如果 iframe DOM 里完全没有模型项，而独立页有，不要把这当成可稳定修复的 iframe UI 问题；需要重新评估是否接受官方 tab 驱动方案。
5. 记录已验证的空菜单结构：`role="menu"` 的容器可见，内部滚动层存在，但 `role="group"` 为空。

当时做过的回归检查：

- `tests/unit/content-script-location.test.ts`
  - `keeps the Claude iframe menu height fix installed`
  - `keeps the Claude official tab fallback send path wired`

这些测试已随 Claude 运行时代码一并删除，只保留本文档说明当时为什么这么试、为什么最后不用。

## 后续如果 Claude 改版

优先更新服务器 selector，但如果发送按钮仍然是无 label 图标按钮，本地 composer 兜底仍应保留。

如果改版后读取回答失败，再优先更新：

- `lastResponse`
- `messageContainer`
- `userMessage`

并补 `tests/unit/claude-adapter.test.ts` 的对应 DOM 结构。
