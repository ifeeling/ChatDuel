# Claude 接入记录

## 状态（2026-07-15 更新）

- **2026-06-20**：Claude 曾从 ChatDuel 扩展运行时移除（原因见下文"关键问题"，核心是 iframe 内模型菜单无法列出/切换可用模型）。
- **2026-07-15**：按用户授权（"沿用上次接入 Claude 的方式尝试，不行就用我自己的方式"），**重新接入 Claude**。代码已完整落地，类型检查通过，单测 279 项全过，`npm run build` 成功。

### 当前已接回的内容

- 平台元数据：`AIPlatform` 联合类型、`SUPPORTED_PLATFORMS`、`AI_PLATFORMS` 均加入 `claude`（icon ✺，url `https://claude.ai/`，能力全开）。
- 配置链路：manifest host permission + content script 入口、vite content script build input、DNR iframe 嵌入规则（RULE_IDS.claude = 3）、SW 官方 tab URL 前缀、远程 selector 白名单、会话 URL 识别、i18n、user-settings（默认关闭）、chat.html 面板与设置行。
- 实现：`src/adapters/claude/adapter.ts`、`src/adapters/claude/selectors.json`、`src/content-scripts/claude-content.ts`（含 iframe 模型菜单高度补丁）。
- 测试：`tests/unit/claude-adapter.test.ts`（5 项）、以及随新平台修正的 ai-platforms / at-parser / dnr-rules / chat-html / user-settings 单测。

### 上线前必须手动验证的关卡（不可跳）

代码层面无法保证 Claude 在扩展 iframe 里能正常**列出并切换可用模型**。这是 2026-06-20 移除 Claude 的根因，本次重接沿用了同一套机制，因此这个风险**没有被消除**，只是"先按老路接上、等实页验证"。

> ⚠️ 若实页验证发现 iframe 里模型菜单仍为空/不可切换，则本次重接不能算"可用"，需要走"官方标签页驱动"备选方案（见文末），并与用户确认后再继续。

下面的"关键问题"和"以后如果重新接 Claude"两节保留为历史排查依据。

## 当时实现过什么

- 把 Claude 作为第 4 个可选平台加入平台元数据和设置项，默认关闭。
- 增加 Claude iframe panel、manifest host permission、content script 入口和 DNR iframe 嵌入规则。
- 实现过 Claude adapter：
  - 写入 Claude 输入框。
  - 查找无稳定 `aria-label` 的发送按钮。
  - 发送后确认 prompt 是否真的离开输入框。
  - 捕获 Claude 回答内容，并过滤工具进度、按钮图标等页面噪音。
- 给 Claude 模型菜单做过 iframe 样式补丁，解决过菜单外壳高度过小的问题。
- 尝试过“官方标签页兜底”：iframe 模型不可用时，转而向用户单独打开并已切好模型的 Claude 标签页发送消息。

## 关键问题

### 1. 发送链路不是唯一问题

Claude 输入框可以写入，发送按钮也能被点击。部分情况下父页日志会出现：

```text
[AIChatRoom chat] write-and-send result for claude: ok=true error=
```

但 `ok=true` 只代表 ChatDuel 写入/点击动作完成，不代表 Claude 官方页一定能回答。

### 2. 旧模型不可用

iframe 内 Claude 显示：

```text
claude-3-5-haiku-latest
```

官方提示：

```text
This model isn't available right now. You can switch to another model to continue using Claude.
```

问题是 iframe 里无法切换模型，所以这个入口实际不可用。

### 3. 模型菜单空，不是 CSS 隐藏

修掉父页抢焦点和菜单外壳高度后，iframe 中模型按钮可以变成展开状态，菜单外壳也可见。但调试结果显示：

- `role="menu"` 容器可见。
- 内部有滚动层和 `role="group"`。
- `role="group"` 为空。
- iframe DOM 里没有 `Sonnet` / `Opus` / `Haiku` 菜单项。

所以问题不是菜单项被遮住，而是 Claude 官方页在 iframe 环境没有生成模型列表。

### 4. localStorage 不能同步当前模型

独立 Claude 标签页和 ChatDuel iframe 都能看到类似下面的 key：

```text
LSS-model-selector-thinking:...:chat:claude-sonnet-4-6
```

但 iframe 当前模型仍是 `claude-3-5-haiku-latest`。这说明当前模型不是简单复制 `localStorage` 就能改变的状态。

### 5. 官方标签页兜底不适合当前框架

官方标签页兜底能绕过 iframe 模型菜单问题，但它会让 Claude 成为唯一一个“不按当前扩展面板发送”的特殊平台：

- 面板里显示旧模型。
- 真实发送可能发生在另一个独立 Claude 标签页。
- 用户很难判断当前到底发给了哪个页面、哪个模型。

这会破坏 ChatDuel “同屏对比官方网页”的一致性，所以最后没有保留。

## 重新接入后的实页验证清单（上线前必做）

以下步骤**只能由人工在浏览器里完成**（无头环境无法验证 iframe 模型菜单）。建议顺序执行，任一步失败即停，回到备选方案讨论。

### A. 基础链路（应已通过代码/单测保证，实页再确认一次）

1. 加载扩展，进入设置页，在站点列表里看到 **Claude / Anthropic** 这一行（默认关闭）。
2. 打开 Claude 开关，确认 chat.html 里出现 Claude 面板（iframe 指向 `https://claude.ai/`）。
3. iframe 能加载、content script 注入并向父页发 `ready`（控制台无 `X-Frame-Options` / `CSP frame-ancestors` 拦截报错）。
4. 登录态正常（面板状态显示已登录，或引导登录）。

### B. 模型菜单（核心关卡，本次重接的最高风险点）

5. 在 iframe 里点开 Claude 模型选择器，确认 `aria-expanded="true"`。
6. **统计 iframe DOM 中是否真的生成了 `Sonnet` / `Opus` / `Haiku` 等模型项**（这是 2026-06-20 失败的根因：当时只有空的 `<div role="group"></div>`）。
7. 从菜单切到一个可用模型（如 Sonnet 4.x），确认选择生效、面板顶部模型名更新。
8. **刷新 iframe / 重新打开会话，确认仍保持刚才选的可用模型**（之前会回退到不可用的 `claude-3-5-haiku-latest`）。

> 判定：步骤 6–8 全部通过 → iframe 模型菜单问题已解决，Claude 可作为普通 iframe 平台上线。
> 步骤 6 失败（菜单为空）或步骤 8 失败（刷新回退旧模型）→ 本次重接仍不可用，进入备选方案。

### C. 发送与抓取

9. 用底部输入框向 Claude 面板转发一个问题，确认：写入成功、发送按钮触发、提示词离开输入框（adapter 有 Enter 兜底与残留检测）。
10. 等待 Claude 回答，确认 ChatDuel 能读到最后回答，且工具进度（`Fetching ... data` / `Searched the web`）和纯图标行已被清洗过滤。
11. 附一张图片再发一次，确认 `attachImageToFileInput` 能注入文件 input 并等待上传就绪。

### D. selectors.json 回填

12. `src/adapters/claude/selectors.json` 当前是基于 Gemini 模板的**最佳猜测**，注释已标 "需实页验证"。实页跑通后，用真实 Claude DOM 选择器覆盖其中的 `inputBox` / `sendButton` / `messageContainer` / `lastResponse` / `userMessage` / `fileInput` 等字段，并补到 `tests/unit/selectors-schema.test.ts`。

## 备选方案：官方标签页驱动（仅当模型菜单仍不可用）

若 B 步验证失败，不要强行把 Claude 当作普通 iframe 平台上线。参考 2026-06-20 的短暂尝试，改造方向是：

- 发送 Claude 时，优先通过 Service Worker 把消息发到用户**单独打开并已在那里切好可用模型**的 Claude 官方标签页。
- 找不到官方 tab 时回落到 iframe。
- **必须在 UI 上明确告知用户：真实发送发生在独立 Claude 标签页，而非当前面板**，避免状态不透明、破坏"同屏对比"一致性。

该方案需要重新设计并单独评审，不在本次重接范围内。
