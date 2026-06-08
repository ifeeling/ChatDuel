# AIChatRoom 设计文档

**日期**：2026-06-08
**状态**：待审核
**作者**：头脑风暴协作（用户 + AI）

---

## 1. 概述

AIChatRoom 是一个 Chrome 浏览器扩展，定位是**多 AI 对照和搬运工具**，不是 API 聚合工具。

**核心约束**：
- **不使用 API**：复用用户已登录的 ChatGPT / Gemini 官方网页订阅账号。
- **保留官方聊天记录**：扩展在官方网页上操作，正常情况下记录保留在官方网站。
- **第一版只支持 ChatGPT + Gemini**。
- **Chrome 扩展优先**，不做 Electron。

**参考产品**：ChatBrawl（仅作为产品思路和体验参考，不复制源码）。

---

## 2. 架构

### 2.1 总体形态

扩展由四部分组成：

1. **扩展主页面（Popup / Side Panel）**：用户输入问题、查看两边 AI 回答、触发搬运等所有交互的中心。
2. **Background Service Worker（扩展后台）**：协调主页面与 content script 之间的消息路由、管理扩展状态、保存本地历史。注意 Manifest V3 的 SW 会在闲置 ~30 秒后休眠，跨 Tab 路由状态必须持久化（见 §2.5）。
3. **Content Script（注入到官方网页的脚本）**：负责识别 ChatGPT / Gemini 页面结构、写入输入框、触发发送、读取最新 AI 回复。
4. **AIAdapter 抽象层（核心）**：把 ChatGPT 和 Gemini 的 DOM 适配细节封装在独立目录里，向上暴露统一接口（`isLoggedIn`、`sendMessage`、`getLastResponse` 等）。v1 第一天就建，即使只支持两个平台。这样后续加 Claude / Grok / DeepSeek 时，只需新增一个 adapter 目录，不动其他代码。

四者通过 `chrome.runtime` 消息和 `chrome.tabs` API 通信。

### 2.2 为什么不用 iframe 嵌入

ChatBrawl 使用 iframe 把 AI 官方网页嵌入扩展页面。但许多网站（包括 ChatGPT 和 Gemini）通过 `X-Frame-Options` 或 CSP `frame-ancestors` 拒绝被第三方页面嵌入，会导致页面空白或被重置。**本扩展采用 content script 方案**：用户自己在浏览器标签页里打开 ChatGPT / Gemini 官方网页并登录，扩展通过 content script 在这些已打开的标签页上执行操作。这样不依赖官方允许被嵌入，也不绕过登录限制。

### 2.3 内容安全策略

- 扩展**不**修改、不绕过、不干扰 ChatGPT / Gemini 官方的登录、权限、使用限制或安全机制。
- 所有自动操作都模拟正常用户行为：填输入框 → 点击发送按钮 → 等待流式输出。
- 不抓取 session、cookie、token 等敏感信息。

### 2.4 AIAdapter 抽象层

**目录结构**：

```
src/adapters/
  base.ts                  # 统一接口定义
  chatgpt/
    adapter.ts             # ChatGPT 的具体实现
    selectors.json         # ChatGPT 的 DOM 选择器配置
  gemini/
    adapter.ts             # Gemini 的具体实现
    selectors.json         # Gemini 的 DOM 选择器配置
```

**统一接口**（v1 范围）：

```ts
interface AIAdapter {
  // 检测当前标签页是否已登录该平台
  isLoggedIn(): Promise<boolean>

  // 写入文本到官方输入框（不触发发送）
  writeText(text: string): Promise<void>

  // 触发官方页面的"发送"动作
  triggerSend(): Promise<void>

  // 一站式：写入 + 发送
  sendMessage(text: string, image?: File): Promise<void>

  // 读取最后一条 AI 回复的完整文本
  getLastResponse(): Promise<string>

  // 查询当前会话状态（用于 SW 休眠恢复后 / Popup 重新打开时主动拉取）
  getConversationState(): Promise<{
    status: 'idle' | 'queued' | 'sending' | 'streaming' | 'paused' | 'finished' | 'error'
    lastResponse?: string
    errorMessage?: string
  }>

  // 订阅官方页面的流式输出状态变化
  // 事件：'started' | 'token' | 'paused' | 'finished' | 'error'
  onStreamEvent(handler: (event: StreamEvent) => void): () => void

  // 检测官方"限流"提示（仅 ChatGPT 等会显示）
  detectRateLimit(): Promise<boolean>
}
```

> **为什么需要 `getConversationState`**：SW 休眠 ~30 秒后所有内存事件都丢了，Popup 重新打开时如果只靠 `onStreamEvent` 订阅，过去的事件无法重放。调用方（Popup 打开时）主动调用 `getConversationState` 拉一次最新状态，才能正确恢复界面。

**好处**：
- 业务代码（主页面、Background SW）只调接口，不知道、不关心底层是 ChatGPT 还是 Gemini。
- 加新平台只需新增一个 adapter 目录，不动其他代码。
- DOM 改版时只改对应 adapter 内部的实现和 selectors.json。
- 单测可以 mock adapter 来测业务逻辑。

### 2.5 Manifest V3 Service Worker 休眠处理

**问题**：MV3 下扩展后台是 Service Worker，闲置 ~30 秒后会被浏览器休眠，内存状态全部清空。如果"等待两边 AI 都回答"这种跨 Tab 协调只靠 SW 内存变量，会因为休眠而中断。

**存储分工**：

| 存储 | 容量 | 用途 | 生命周期 |
|------|------|------|---------|
| `chrome.storage.session` | ≈ 10MB，纯内存 | **只存运行态状态**：当前激活会话 ID、各 AI 的 `streamStatus`、最后响应 hash | 浏览器关闭即清空 |
| `chrome.storage.local` | 默认 5MB，加 `unlimitedStorage` 权限后无限 | **存完整 Session**（用户问题 + 两边回答 + 搬运链 + 统计） | 跨重启保留 |

**为什么不能把完整会话放进 `storage.session`**：
- 容量上限 10MB，一次完整对话（特别是长回答 + 总结）就可能撑爆。
- 浏览器关闭即丢失，对历史记录没意义。

**运行态持久化方案**：
- 状态转移链：`idle → queued → sending → streaming → paused → finished`（或 `error`）。
- 各阶段写入 `storage.session` 的字段（举例）：

  ```ts
  // 存到 storage.session
  {
    activeConversationId: 'uuid',
    chatgpt: { status: 'streaming', lastResponseHash: 'abc123', startTime: 1717900000000 },
    gemini:  { status: 'finished',  lastResponseHash: 'def456', endTime: 1717900003000 }
  }
  ```

- 完整 Session（用户问题、回答文本、统计等）写入 `storage.local`，key 为 `sessions`，value 为 `Session[]`。
- SW 收到 `chrome.runtime.onMessage` 时先从 storage 读取最新状态再处理。
- 各 content script 的流式输出事件实时写回 `storage.session`，SW 转发给主页面时附带 storage 中的最新状态。
- Popup 重新打开时调 `AIAdapter.getConversationState()` 拉一次最新状态以恢复界面（仅 `storage.session` 中的内容，主面板不缓存大文本）。

**Content Script 访问 `chrome.storage.session` 的坑**：
- 默认情况下 `chrome.storage.session` 只对 Extension pages（Popup / SidePanel / Background）开放，**Content Script 无法直接访问**。
- 必须在 Background SW 启动时显式调一次：
  ```ts
  chrome.storage.session.setAccessLevel({
    accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS'
  })
  ```
  这样 Content Script 才能直接读写 `chrome.storage.session`，不必每次都通过 `chrome.runtime.sendMessage` 倒手。

### 2.6 DOM 选择器集中管理

**问题**：ChatGPT / Gemini 改版频繁。如果选择器散落在 content script 代码里，改版时要改多处。

**解决方案**：
- 每个平台 adapter 目录下放 `selectors.json`，集中所有 DOM 选择器：
  ```json
  {
    "inputBox": "[data-testid='prompt-textarea']",
    "sendButton": "button[data-testid='send-button']",
    "messageContainer": "[data-testid='conversation-turn']",
    "lastResponse": "[data-testid='conversation-turn']:last-child .markdown",
    "rateLimitToast": "[role='alert']"
  }
  ```
- 改版时只改 JSON，业务代码不动。
- v1 阶段选择器是本地 JSON。远期（v1.1+）可考虑从远端拉取配置，避免每次改版都要发 Chrome Store 版本。

### 2.7 Manifest 权限模型

Chrome Manifest V3 审核最先看的就是权限说明。权限越少越好，每加一个权限都要能解释清楚用途。

**v1 计划权限**：

```json
{
  "manifest_version": 3,
  "permissions": [
    "storage",            // 读写 chrome.storage（保存会话、用户偏好、状态快照）
    "unlimitedStorage",   // 突破 chrome.storage.local 默认 5MB 硬上限，支撑 100MB 历史保留
    "tabs",               // 枚举、查询、消息官方 AI 的 Tab（注入 content script、获取 tabId）
    "scripting"           // 动态注入 content script（备用，manifest 静态注入失败时回退）
  ],
  "host_permissions": [
    "https://chatgpt.com/*",     // ChatGPT 官方网页（注入 adapter）
    "https://gemini.google.com/*" // Gemini 官方网页（注入 adapter）
  ]
}
```

**为什么需要 `unlimitedStorage`**：
- `chrome.storage.local` 默认硬上限是 **5MB**（`QUOTA_BYTES`）。
- v1 设计保留上限 100MB（§4.1 F7），超出 5MB 不加这个权限会直接抛 `QUOTA_EXCEEDED_ERR`。
- `unlimitedStorage` 会提示用户"该扩展可以不受限地读写本地数据"，Chrome Store 审核时需说明用途（"用于保存多 AI 对照历史记录"）。

**为什么不需要 `notifications` 权限**：
- "双方都答完"提示仅在扩展 Popup / Side Panel 内部做视觉提示（高亮、变色、状态条），不弹浏览器系统通知。
- 这样 Chrome Store 审核不用解释系统通知的合理用途，审核更简单。

**为什么不需要 `activeTab` / `webRequest` / 等等其他权限**：
- 只在用户已打开 ChatGPT / Gemini 标签页的前提下做操作。
- 不读取、修改用户的浏览数据。
- 不做请求拦截。

**最小权限原则**：上面列的就是 v1 全部权限。如果开发过程中发现需要新权限，**先回到这份文档更新权限说明，再写代码**。

**v1.1+ 可考虑的权限缩窄**：
- `tabs` 权限在某些场景下可以被更细粒度的 `host_permissions` 替代（如直接通过 `chrome.scripting.executeScript({ target: { tabId } })` 替代部分 tab 查询）。v1 保留 `tabs` 是稳妥选择；v1.1+ 可以研究是否真有必要，缩窄后 Chrome Store 审核解释更简单。

### 2.8 Adapter 版本化与选择器时间戳

**问题**：用户反馈"今天突然坏了"时，开发者需要快速判断是不是 ChatGPT / Gemini 改版了。

**解决方案**：
- `selectors.json` 增加 `version` 和 `lastVerified` 字段：
  ```json
  {
    "version": "2026.06",
    "lastVerified": "2026-06-08",
    "selectors": {
      "inputBox": "[data-testid='prompt-textarea']",
      "sendButton": "button[data-testid='send-button']",
      ...
    }
  }
  ```
- Adapter 在初始化时把 `version` 和 `lastVerified` 暴露给主页面。
- 主页面在"扩展状态"区域显示：`ChatGPTAdapter v2026.06（最后验证 2026-06-08）`。
- 用户反馈问题时，开发者一眼能看出某个 adapter 是不是长期没更新、可能已失效。
- 每次手动验证选择器可用时，更新 `lastVerified` 字段并小幅 bump `version`（如 `2026.06.1`）。

---

## 3. 用户使用流程

### 3.1 一次性准备

1. 用户在 Chrome 中安装扩展。
2. 用户在浏览器中**手动**打开 ChatGPT 官方网页，登录自己的订阅账号。
3. 用户在浏览器中**手动**打开 Gemini 官方网页，登录自己的订阅账号。
4. 用户点击扩展图标，打开扩展主页面。
5. 扩展检测到两个官方网页都在登录状态，提示"已识别 ChatGPT 和 Gemini，可以开始对话"。

### 3.2 一次对照

1. 用户在扩展主页面的**统一输入框**里输入问题（可包含 `@AI` 前缀、可粘贴图片）。
2. 用户点击"发送"。
3. 扩展解析输入文本中的 `@` 标记，确定要发送的目标 AI（默认两个都发）。
4. 扩展向对应的官方网页标签页的 content script 发送"写入并发送"指令。
5. 被 `@` 跳过的 AI 标签页**完全静默**，扩展不触碰。
6. content script 把文本（或图片）写入对应 AI 的输入框，触发发送。
7. 扩展主页面的对应 AI 面板显示一个**"等待回应"占位气泡**。
8. content script 监听官方页面的 DOM 变化，检测该 AI 是否开始流式输出、是否结束。
9. 当**两个被 @ 的 AI 都回答完毕**，扩展主页面给出"双方都已回答"的**视觉提示**（双方回答卡片高亮闪烁一次、状态条变色）。**不**弹浏览器系统通知。
10. 用户可以在任一边面板里查看回答，可以触发"左传右"或"右传左"（带审查提示词模板）搬运，也可以点击"对比总结"让某一边的 AI 总结双方差异。

---

## 4. 功能清单

### 4.1 v1 必须实现

| # | 功能 | 描述 |
|---|------|------|
| F1 | 同时发送问题 | 输入一次问题，自动发送到被 @ 的所有 AI（默认 ChatGPT + Gemini） |
| F2 | 左右互传最后回复 | 两个按钮："ChatGPT → Gemini"、"Gemini → ChatGPT"，自动用审查提示词模板包装 |
| F3 | @ 选择性发送 | 在输入框中输入 `@AI名称` 可选择本次只发给某几个 AI，触发候选弹窗 |
| F4 | 双方答完自动提示 | 扩展检测到两边（或所有被 @ 的 AI）都回答完毕时，弹出提示 |
| F5 | 自动包装提示词 | 搬运回答时用预设的审查提示词模板（用户可编辑） |
| F6 | 一键生成对比总结 | 当两边都回答后，按钮触发，包装"对比总结"提示词发给选中的一边 AI 总结；输入超过 3000 字符时截断并提示 |
| F7 | 本地保存对照记录 | 每次会话保存到本地（用户原始问题、两边 AI 回答、后续搬运、最终总结）；保留上限 500 条或 100MB，超出后按时间淘汰最旧；存储位置 `chrome.storage.local`（需 `unlimitedStorage` 权限，见 §2.7） |
| F8 | 可配置提示词模板 | 用户能编辑常用提示词（审查、总结、反驳、简化解释） |
| F9 | 设置页勾选 AI | 简单设置：启用 / 禁用 ChatGPT、Gemini |
| F10 | 双栏界面 + 统一输入框 | 主页布局：左边默认 Gemini、右边默认 ChatGPT、底部输入框 |
| F11 | 字符串 diff 差异高亮 + 回答统计 | 在主页面内对两边回答做**字符串级** diff（不涉及语义相似度），把不同的部分用不同背景色标出；同时显示字数、回答耗时、首次 Token 时间 |
| F12 | 引用上一轮回答 | "引用"按钮，一键把另一边上一条 AI 回答插入当前输入框（可作为继续追问的上下文） |
| F13 | 键盘快捷键 | `Ctrl/Cmd + Enter` 发送；`Ctrl/Cmd + Shift + 1` 触发"左传右"；`Ctrl/Cmd + Shift + 2` 触发"右传左" |
| F14 | 图片输入 | 在统一输入框里支持粘贴 / 拖拽图片，发送到被 @ 的 AI；通过构造 `DataTransfer` + 派发 `paste`/`drop` 事件模拟用户粘贴 |
| F15 | ~~新话题 / 续聊切换~~ | **v1 砍掉**：v1 只支持续聊。"新话题"功能移到 v1.1 |
| F16 | 发送占位气泡 | 发送后到官方页面真正显示"已发送"之间的 0.5–2 秒延迟里，扩展面板显示"等待回应"占位气泡 |

**Session 数据结构（F7 实现细节）**：

```ts
interface Session {
  id: string                       // UUID
  createdAt: number                // 时间戳（毫秒）
  prompt: string                   // 用户原始问题
  responses: {
    chatgpt?: string               // ChatGPT 的回答
    gemini?: string                // Gemini 的回答
  }
  // 后续搬运 / 引用 / 总结产生的链式记录
  // 按时间顺序追加，前端可展开查看
  followUps: Array<{
    from: 'user' | 'chatgpt' | 'gemini'
    to: 'chatgpt' | 'gemini'
    text: string                   // 包装后的实际发送给目标 AI 的文本
    timestamp: number
  }>
  summary?: string                 // 用户最后触发的对比总结
  stats?: {
    wordCount: { chatgpt?: number; gemini?: number }
    durationMs: { chatgpt?: number; gemini?: number }
    ttftMs: { chatgpt?: number; gemini?: number }  // Time To First Token
  }
}
```

**存储位置**：`chrome.storage.local`，键为 `sessions`，值为 `Session[]`。

**保留策略**：
- 上限：500 条**或** 100MB（哪个先到算哪个）。
- 超出时按 `createdAt` 升序淘汰最旧。
- 写入时检查 + 淘汰，避免长期累积。

### 4.2 远期（v1 不做，明确不做）

| # | 功能 | 描述 |
|---|------|------|
| F15→v1.1 | 新话题切换 | v1.1 加入"在官方网页开新对话"开关；v1 始终续聊 |
| F17 | 推理过程折叠/展开 | ChatGPT o1/o3、Gemini Thinking Mode 的推理过程可折叠 |
| F18 | 本地与官方对话对齐 | 定期检测官方网页已删除的本地记录，提示"幽灵数据" |
| F19 | 导出 Markdown 报告 | 把整个对照会话导出为 markdown 文件 |
| F20 | 多步工作流 | 自动化多步搬运（如：写代码 → 审 → 改） |
| F21 | 裁判模式 | 引入第三个 AI 当裁判，或让其中一个 AI 扮演裁判 |
| F22 | 上下文包 | 搬运时打包：用户最初问题、当前 AI 回答、用户追问、已确认结论 |
| F23 | 分歧提醒 | 检测两边回答明显不一致时主动提示 |
| F24 | 多 AI 扩展 | 支持 Claude、Perplexity、Grok、DeepSeek 等 |
| F25 | 历史搜索 | 本地历史多了之后能搜索 |
| F26 | 选择器配置云端化 | selectors.json 改为远端拉取，避免每次改版都要发 Chrome Store 版本 |

> **注意**：远期功能列表仅作为愿景保留，**v1 实施计划不会涉及**。

### 4.3 v1 明确不做

- 不使用任何 AI 官方 API。
- 不绕过官方登录、权限、使用限制。
- 不自行生成 AI 回复内容（不调任何 LLM、不在扩展内"创造"内容）；仅展示和缓存从官方页面读取的内容。
- 不支持 Claude、Perplexity、Grok、DeepSeek 等其他 AI 平台。
- 不做"新话题"切换（F15）；v1 始终续聊，"新话题"留到 v1.1。

---

## 5. 关键交互细节

### 5.1 @ 选择性发送（F3）

**触发**：用户在统一输入框中输入 `@` 字符。

**弹窗**：
- 位置：光标正下方。
- 内容：当前已启用 AI 列表（带图标和名称）。
- 支持：键盘上下选择、回车确认、Esc 取消。
- 多选：可一次选中多个 AI（每个 AI 用回车确认加入）。

**插入行为**：
- 选中后，输入框中插入 `@AI名称` 文本片段。
- 多个被 @ 的 AI 之间用空格分隔。
- 最终文本示例：`@ChatGPT @Gemini 请帮我写一个快速排序`

**发送时的解析**：
- 扩展解析所有 `@AI名称`，确定本次要发送的目标 AI 集合。
- 没出现在 `@` 列表里的 AI 视为"未选中"。
- 如果用户没写任何 `@`，则默认发给所有**已启用**的 AI。

**与续聊的关系**：
- v1 始终续聊（写入到官方网页的当前活动对话），与 @ 选择独立。
- 比如：用户输入 `@Gemini 你好` → 只在 Gemini 官方网页的当前对话里继续；ChatGPT 标签页完全静默。

### 5.2 引用上一轮回答（F12）

**触发**：点击"引用"按钮（位于输入框旁）。

**行为**：
- 读取"另一边"AI 的最后一条回答文本。
- 把它插入到当前输入框的光标位置，前面加一行引导语，例如：
  ```
  [引用 Gemini 的上一条回答]：
  {{对方回答内容}}
  
  ```
- 用户在引导语之后继续输入自己的追问或评论。
- 点击发送后，扩展把整段文本发送给**当前选中的 AI**（根据 @ 决定）。

**与 @ 选择的配合**：
- 如果用户输入了 `@AI`，则引用内容只插入并发送给那个 AI。另一边的 AI 完全静默。
- 如果用户没有 @，则两边都收到引用内容（两边各引用对方上一轮的回答）。
- v1 兜底：未输入 @ 时，"引用"按钮被禁用（避免歧义），提示用户先 @ 再引用。

**边界**：
- "另一边"指主面板里不在当前焦点 AI 那一边的 AI。
- 如果另一边还没有任何回答，引用按钮置灰。

### 5.3 字符串 diff 差异高亮 + 回答统计（F11）

F11 由两部分组成：**字符串 diff 差异高亮** 和 **回答统计信息**。

#### 5.3.1 字符串 diff 差异高亮

**为什么不用语义相似度**：
- 字符串 / 句子相似度会低估语义差异（如"快速排序平均 O(nlogn)" 与 "Quick Sort 在平均情况下时间复杂度为 O(n log n)" 字符串相似度低但语义相同）。
- 真正准确的语义相似度需要 embedding 模型（如 MiniLM、bge-small），体积大、加载慢，v1 不引入。
- v1 用**字符串级 diff**，不做语义判断，由用户自己看高亮判断差异是否重要。

**算法选择**：
- 使用 `diff-match-patch`（Google 出品）或 `sentence-diff` 之类的成熟库做底层字符串 diff。
- 把回答按行（先按段落、再按句号 / 问号 / 换行拆）拆成 chunk，逐 chunk 做 diff。
- 输出每个 chunk 的状态：`unchanged` / `added-on-A` / `added-on-B`。

**渲染**：
- 双方回答都按原顺序显示。
- `unchanged`（两边都有的内容）：白底，普通文字。
- `added-on-A`（只在 A 出现）：A 侧浅绿色背景；B 侧对应位置显示灰色占位"（对方未提到）"。
- `added-on-B`（只在 B 出现）：B 侧浅绿色背景；A 侧对应位置显示灰色占位"（对方未提到）"。

**关闭**：
- 默认开启。设置页可关闭。

#### 5.3.2 回答统计信息

**触发时机**：每条回答卡片显示完成后，立即在卡片下方展示统计信息。

**统计项**：

| 统计项 | 含义 | 单位 |
|--------|------|------|
| 字数 | 回答文本的字数（中文按字符，英文按单词） | 字 / 词 |
| 回答耗时 | 从点击发送到 AI 完全流式输出结束的时间 | 秒 |
| 首次 Token 时间 | 从点击发送到 AI 输出第一个字符的时间 | 秒 |

**渲染**：在回答卡片下方一行小字灰色显示，例：

```
ChatGPT 回答完毕
3120 字 · 12.3 秒 · 首次 Token 2.1 秒
```

**用途**：
- 用户快速对比两边回答的长度、速度。
- 不涉及内容理解，纯客观数据。

### 5.4 键盘快捷键（F13）

| 快捷键 | 行为 |
|--------|------|
| `Ctrl/Cmd + Enter` | 发送当前输入框内容 |
| `Ctrl/Cmd + Shift + 1` | 触发"左传右"（左面板 AI → 右面板 AI） |
| `Ctrl/Cmd + Shift + 2` | 触发"右传左"（右面板 AI → 左面板 AI） |

**冲突处理**：
- 监听 `keydown` 时检查事件目标是否是输入框 / 可编辑元素。
- 如果扩展焦点不在输入框，按下快捷键不响应，避免和浏览器全局快捷键冲突。

### 5.5 图片输入（F14）

> **⚠️ Best Effort 功能**：图片发送**不保证**一定能成功。ChatGPT / Gemini 未来可能改上传实现方式，导致事件模拟失效。失败时**必须**有兜底，绝不能让用户卡死或消息丢失。v1 不把"图片一定能发"作为成功标准。

**输入方式**：
- 剪贴板粘贴（`Ctrl/Cmd + V`）。
- 拖拽到输入框。

**技术难点**：
- ChatGPT / Gemini 都是现代前端框架（React / Angular），直接给 `<input type="file">` 赋值或修改 `value` 不会被框架感知。
- 需要模拟真实用户的"粘贴文件"行为：构造 `DataTransfer` 对象，把图片 `File` 放进去，再派发 `paste` 或 `drop` 事件给官方输入框元素。
- ChatGPT 和 Gemini 的事件接受方式可能不同，v1 需要分别适配（通过 AIAdapter 隔离，ChatGPT 一个适配、Gemini 一个适配）。

**事件派发细节**：
- 派发 `paste` 事件时 `bubbles: true` 和 `cancelable: true` 必须设置。
- 某些框架（特别是 React）会读取 `window.event.clipboardData` 或 `event.clipboardData`。如果 `dispatchEvent` 被忽略，可临时用 `Object.defineProperty` 把构造的 `DataTransfer` 挂到 `window.event` 上：
  ```ts
  Object.defineProperty(window.event ?? eventTarget, 'clipboardData', {
    value: dataTransfer,
    configurable: true
  })
  ```
  派发完成后恢复。

**处理流程**：
1. 用户粘贴 / 拖拽图片到主面板输入框。
2. 扩展读取图片为 `File` 对象，在主面板输入框显示缩略图。
3. 用户点击发送。
4. 扩展把图片 + 文本通过 `sendMessage(text, image)` 调用传给目标 AI 的 adapter。
5. adapter 内部构造 `DataTransfer`、派发 `paste` / `drop` 事件给官方输入框。
6. **失败兜底（必做，链式降级）**：
   - **兜底 A**：若官方网页不接受事件模拟，adapter 在 3 秒内检测不到官方页面图片预览，标记发送失败。
   - **兜底 B**：主面板提示"图片发送失败"。**尝试**用 `navigator.clipboard.write()` 把图片复制到剪贴板（用户必须在 Popup 可见且已交互的前提下才能成功，浏览器也可能拒绝）。
   - **兜底 C（终极）**：若 `navigator.clipboard.write()` 失败或被拒，主面板额外显示一个 **"下载图片"按钮**，用户点击后浏览器下载图片到本地；用户再到 ChatGPT/Gemini 官方页面手动上传。
   - **兜底 D（语义保护）**：文字部分照常发送，**绝不**因为图片失败而丢失用户输入的文字。

**限制**：
- v1 一次只支持一张图片。
- 图片大小限制 20MB（超过则提示）。
- 主面板输入框里图片 + 文本同时存在时，发送时图片在前、文本在后（用户可在文本框调整顺序）。

### 5.6 新话题 / 续聊切换（F15）

**v1 状态**：**v1 不实现**。v1 始终续聊（写入到官方网页的当前活动对话），不提供"新话题"切换。

**为什么砍**：
- "New Chat" 按钮选择器维护成本高（ChatGPT / Gemini 改版频繁）。
- 这是破坏性操作（会丢弃官方网页当前对话的未保存草稿）。
- v1 先验证"同时问两个 AI"这个核心价值；新话题场景用户可在官方网页自己开新聊天，再回扩展继续。
- 完整方案留到 v1.1。

**v1 行为**：
- AIAdapter 的 `sendMessage` 只在当前活动对话的输入框写入 + 发送。
- 续聊语义：官方网页"当前在哪个对话"，扩展就在哪个对话里续。

### 5.7 发送占位气泡（F16）

**触发**：用户点击发送，且目标 AI 标签页的 content script 已确认写入但官方页面还未显示"已发送"动画。

**渲染**：
- 主面板对应 AI 那一侧底部，显示一个浅灰色占位气泡：
  ```
  [用户的问题]
  ⏳ 等待回应...
  ```

**结束**：
- 当 content script 检测到官方页面开始流式输出 → 占位气泡替换为"正在输入..."动画。
- 当 content script 检测到输出结束 → 占位气泡变为最终回答。

---

## 6. 数据流

### 6.1 发送问题流程

```
[扩展主页面]
  用户输入文本 + 解析 @ + 确定目标 AI 列表
  ↓ chrome.runtime.sendMessage
[Background SW]
  根据目标 AI 列表，路由到对应标签页的 content script
  ↓ chrome.tabs.sendMessage
[Content Script（chatgpt.com 或 gemini.google.com）]
  找到输入框元素 → 写入文本 → 触发发送按钮
  ↓ 监听 DOM 变化
[Content Script]
  检测到 AI 开始流式输出 → 发送"开始回答"事件
  检测到 AI 输出结束 → 发送"回答完毕"事件，附上完整文本
  ↓ chrome.runtime.sendMessage
[Background SW]
  把"开始 / 完毕"事件转发给主页面
  ↓
[扩展主页面]
  切换占位气泡状态 → 渲染最终回答
```

### 6.2 引用上一轮流程

```
[扩展主页面]
  用户点击"引用"按钮
  ↓
[Background SW]
  查询另一边 AI 的最后一条回答（缓存中）
  ↓
[扩展主页面]
  把文本插入当前输入框光标位置
```

### 6.3 差异高亮与回答统计流程

```
[扩展主页面]
  双方都回答完毕时触发
  ↓
[本地 JS 模块：差异分析器（基于 diff-match-patch）]
  把两段文本按行 / 按句拆分 → 字符串 diff → 生成差异块
  ↓
[本地 JS 模块：回答统计]
  计算字数、回答耗时、首次 Token 时间
  ↓
[扩展主页面]
  重新渲染两边回答面板，附带高亮标记 + 统计行
```

---

## 7. 组件边界

| 组件 | 职责 | 依赖 |
|------|------|------|
| **主页面 UI** | 渲染双栏面板、输入框、按钮、@ 弹窗、快捷键监听、统计展示 | Background SW、本地存储、AIAdapter 接口 |
| **Background SW** | 消息路由、标签页状态、扩展生命周期、跨 Tag 协调；状态持久化到 `chrome.storage.session` | Chrome API |
| **AIAdapter - ChatGPT** | 实现统一接口，识别 chatgpt.com 页面结构、读写输入框、监听流式输出；选择器从 `selectors.json` 读取 | DOM API |
| **AIAdapter - Gemini** | 实现统一接口，识别 gemini.google.com 页面结构、读写输入框、监听流式输出；选择器从 `selectors.json` 读取 | DOM API |
| **AIAdapter 接口定义（base）** | 统一 TS 接口，让业务代码不依赖具体平台 | 无 |
| **本地存储** | 保存历史会话、用户偏好、提示词模板、SW 状态快照 | `chrome.storage.local`、`chrome.storage.session` |
| **差异分析器** | 纯本地 JS 模块，对两段文本做字符串 diff（基于 `diff-match-patch`） | 无外部依赖 |
| **回答统计模块** | 纯本地 JS 模块，计算字数、回答耗时、首次 Token 时间 | 无外部依赖 |
| **图片处理** | 把图片从剪贴板 / 拖拽转为可粘贴到官方输入框的文件（构造 `DataTransfer` + 派发 `paste`/`drop` 事件） | DOM API、File API |

每个组件独立可测：
- AIAdapter 可以在 Playwright 里打开 ChatGPT / Gemini 模拟页面，验证读写行为；或通过 mock 的 adapter 测试业务逻辑。
- 差异分析器、回答统计模块、@ 解析器、提示词模板渲染都是纯函数，单测覆盖各种边界。
- 本地存储有清晰的读写接口。
- 主页面 UI 可独立开发（mock 掉 AIAdapter）。
- SW 状态持久化可独立测试（构造 storage 事件）。

---

## 8. 错误处理

### 8.1 官方网页未登录

- content script 注入后检测登录状态（如检测用户头像、URL 是否带登录重定向）。
- 未登录则向 Background SW 上报"未登录"。
- 主页面显示："ChatGPT 未登录，请先在浏览器中打开 chatgpt.com 并登录"。
- 发送按钮置灰。

### 8.2 找不到输入框

- ChatGPT / Gemini 改版可能导致 content script 找不到输入框。
- content script 重试 3 次（间隔 500ms）。
- 失败后向 Background SW 上报"找不到输入框"，主页面显示："无法识别 ChatGPT 输入框，可能是网页改版，请稍后重试或联系开发者"。
- 记录 console 错误 + 当前页面 DOM 片段（仅本地，不外发），便于排查。

### 8.3 找不到发送按钮

- 同 8.2，机制一致。
- 兜底：使用键盘事件 `Enter` 触发发送（很多 AI 输入框 Enter 即发送）。

### 8.4 流式输出未检测到结束

- 监听超时（默认 60 秒无新输出视为结束）。
- 超时则把当前已显示的内容作为最终回答，主页面显示"⚠️ 回答可能被截断，可手动刷新"。

### 8.5 流式输出"继续生成"中间态

- ChatGPT 在长文本输出时可能因 token 限制 / 内容审查触发"继续生成 (Continue generating)"按钮。
- 此时官方页面的回答**未结束**。adapter 必须能识别这个中间状态。
- 识别方式：检测官方页面是否出现"继续生成"按钮元素（如 `[data-testid='continue-generation-button']`）。
- adapter 通过 `onStreamEvent` 抛出 `paused` 事件，主页面显示"⏸ ChatGPT 暂停，点击'继续生成'或等待自动继续"。
- adapter 也可选择**自动点击**"继续生成"按钮（v1 默认不自动点击，避免越权；只提示用户）。

### 8.6 官方限流提示

- 高频发送可能触发 ChatGPT 的"You are sending messages too fast"或类似提示。
- adapter 的 `detectRateLimit` 定期检测官方页面是否有限流 toast / 弹窗。
- 检测到时抛出 `error` 事件（type: `'rate-limit'`），主页面显示"⚠️ ChatGPT 限流中，请等待 1–2 分钟再试"。

### 8.7 两个标签页关闭

- 用户在发送过程中关闭了某个 AI 标签页。
- content script 上报"标签页关闭"，主页面显示"ChatGPT 标签页已关闭，请在浏览器中重新打开"。

### 8.8 用户网络问题

- 扩展不感知用户网络状态，错误由官方网页自己显示。
- 主页面检测到某边超过 30 秒无流式输出，提示"ChatGPT 长时间无响应，可能是网络问题"。

---

## 9. 性能与稳定性

- **DOM 监听采用"虚拟信号 + 节流渲染"模式**（**必须**遵守）：
  - 在 MutationObserver 回调里**不**做 `querySelector`、**不**做文本提取、**不**做 diff。
  - 回调只做一件事：把布尔标志位 `dirty = true`。
  - 由一个每 100-200ms 执行一次的 `requestAnimationFrame` 或 `setTimeout` 定时器去检查 `dirty`，只在 `true` 时才真正去 DOM 树上提取最新文本、计算 hash、判断是否流式结束、推给主页面。
  - 推完后把 `dirty = false`。
  - 这避免了在 ChatGPT / Gemini 高频流式输出（一次 mutation 可能带数百个子节点变动）时拖慢官方页面。

  ```ts
  // 伪代码示意
  let dirty = false
  const observer = new MutationObserver(() => { dirty = true })
  observer.observe(messageContainer, { childList: true, subtree: true, characterData: true })

  setInterval(() => {
    if (!dirty) return
    dirty = false
    const text = messageContainer.innerText
    onStreamEvent({ type: 'token', text })
  }, 150)
  ```

- **选择器**优先用稳定属性（`data-testid`、`aria-label`、`role`），避免依赖 class 名（class 名经常改）。
- **失败重试**所有官方网页操作都有 3 次重试 + 兜底策略。
- **不影响官方网页**：content script 只读写必要的元素，不修改官方网页的其他 DOM，不干扰用户正常使用官方网页。

---

## 10. 测试策略

### 10.1 单元测试

- **差异分析器**（基于 `diff-match-patch`）：纯函数，覆盖各种输入（空、单边相同、双方不同、超长文本、含特殊字符等）。
- **回答统计模块**：字数（中文按字符、英文按单词）、回答耗时、首次 Token 时间计算的边界条件。
- **@ 解析器**：解析各种格式的输入（单 @、多 @、@ 嵌套、空 @）。
- **提示词模板渲染**：把变量插入到模板里。
- **AIAdapter mock**：mock 一份 adapter 验证主页面、Background SW 的业务逻辑（不依赖真实 ChatGPT / Gemini）。

### 10.2 集成测试（Playwright）

- 打开一个 mock 的 ChatGPT 页面（用 HTML 模拟输入框、回答区、限流提示、"继续生成"按钮等），验证 AIAdapter 能正确写入、读取、检测各种状态。
- 同理 mock Gemini 页面。
- 端到端测试：模拟"用户输入 → 发送 → 等待回答 → 触发搬运 → 验证另一边收到"全流程。
- 状态持久化测试：模拟 SW 休眠、验证 storage 中状态可恢复。

### 10.3 手动测试

- 在真实 ChatGPT / Gemini 账号上验证。
- 验证两边的官方网页聊天记录完整保留。
- 验证不影响用户在官方网页上的其他操作（切对话、删消息、刷新等）。

### 10.4 验收清单

**基础通路**：
- [ ] AIAdapter 抽象层建立（统一接口、ChatGPT / Gemini 两个实现、selectors.json 分离）
- [ ] selectors.json 含 `version` 和 `lastVerified`，主页面显示 adapter 版本
- [ ] Manifest 权限严格匹配 §2.7（storage / tabs / scripting + chatgpt.com / gemini.google.com）
- [ ] SW 启动时调 `chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })`
- [ ] 能识别已登录的 ChatGPT / Gemini 标签页
- [ ] 能写入文本并触发发送
- [ ] 能识别"回答中 / 暂停中 / 回答完毕"三种状态
- [ ] @ 选择性发送正常工作
- [ ] 双方答完**视觉提示**生效（无需 notifications 权限）
- [ ] 续聊行为正常（v1 不做新话题）

**搬运与对比**：
- [ ] 左传右 / 右传左能用，带审查提示词
- [ ] 一键生成对比总结能用；输入超 3000 字符时截断并提示
- [ ] 引用上一轮能用
- [ ] 字符串 diff 差异高亮能用（基于 diff-match-patch，不做语义相似度）
- [ ] 回答统计（字数 / 耗时 / 首次 Token 时间）显示正确

**输入与交互**：
- [ ] 图片发送：成功路径能工作（bubbles/cancelable + clipboardData 兼容）
- [ ] 图片发送：失败兜底能工作（图片复制到剪贴板 + 文字部分照常发送，**不丢文字**）
- [ ] 快捷键生效
- [ ] 占位气泡在延迟期间显示

**稳定性**：
- [ ] SW 休眠后状态能恢复（`getConversationState` 主动拉取）
- [ ] 关闭某个 AI 标签页时主页面有提示
- [ ] 官方限流提示能被捕获并展示给用户
- [ ] ChatGPT 出现"继续生成"按钮时主页面有提示
- [ ] MutationObserver 走"虚拟信号 + 节流渲染"模式，不拖慢官方页面
- [ ] 官方网页改版时能优雅降级（至少不崩溃，给出明确提示）
- [ ] Session 保留策略生效：超过 500 条 / 100MB 后按时间淘汰最旧

---

## 11. 开发顺序（推荐）

**前置原则**：先做**风险最高的环节**（在控制台 / Playwright 跑通 PoC），再做主 UI；AIAdapter 抽象层第一天就建。

1. **创建 Chrome 扩展基础结构**（manifest.json、目录、Background SW、Popup 页面）。
2. **建立 AIAdapter 抽象层**：`base.ts`（统一接口）、`selectors.json` 模式（先把 ChatGPT 的 selectors 写出来）。这一步不接官方页面，只把目录和接口定义好。
3. **PoC 验证 ChatGPT**（在控制台跑，不走扩展 UI）：用一个简单的脚本 / 测试页面，验证能识别 chatgpt.com 的输入框、发送按钮、最后回答、流式结束事件。**这一步不通就停下来排查**。
4. **PoC 验证 Gemini**（同上，**风险最高**）：用脚本验证 gemini.google.com 的输入框、发送按钮、最后回答。Gemini 的 DOM 嵌套更深、类名混淆更严重，可能需要更精细的 selector。
5. **主页面双栏布局 + 统一输入框 + 发送按钮**：先打通"输入 → 写两边 → 看到回答"的最简通路。
6. **双方答完自动提示（F4）**。
7. **发送占位气泡（F16）**。
8. **@ 选择性发送（F3）**。
9. **回答统计模块**（字数 / 耗时 / 首次 Token 时间，F11 的统计部分）。
10. **图片输入（F14）**：先实现 `DataTransfer` 事件模拟，失败时给出手动粘贴兜底。
11. **引用上一轮回答（F12）**。
12. **左传右 / 右传左 + 审查提示词模板**（F2、F5、F8）。
13. **一键生成对比总结**（F6，含 3000 字符截断）。
14. **字符串 diff 差异高亮**（F11 的 diff 部分）。
15. **键盘快捷键**（F13）。
16. **本地保存对照记录 + 历史查看**（F7）。
17. **设置页**（F9）。
18. **错误处理补全**：限流捕获（§8.6）、"继续生成"识别（§8.5）、SW 休眠状态恢复（§2.5）。

> **新话题切换（F15）不在 v1 范围内**，留到 v1.1。

---

## 12. 风险与限制（沿用产品设想文档 §8）

- **官方网页结构可能变化**：选择器会失效，要有重试 + 优雅降级。
- **自动操作不一定稳定**：比 API 调用更脆弱，但用户换不到 API。
- **不能保证所有聊天记录都保留**：取决于官方。
- **不应绕过官方限制**：本工具只减少重复操作，不绕过任何官方机制。

---

## 13. v1 成功标准

满足以下条件即认为 v1 达成：

- 用户打开 ChatGPT 和 Gemini 官方网页、登录后，扩展能识别两个标签页。
- 用户输入一个问题，能一键发送到两边。
- 用户能用 @ 选择只发给某一边。
- 双方都回答完毕后，扩展有提示。
- 用户能把一边的回答一键搬到另一边（带审查提示词）。
- v1 始终续聊（写入当前官方对话），不提供新话题切换。
- 图片能发送（事件模拟 + 失败兜底）。
- 引用上一轮正常工作。
- 字符串 diff 差异高亮 + 回答统计可用。
- 快捷键能触发。
- 本地能保存历史并查看。
- SW 休眠后状态能恢复。
- 官方限流提示能被捕获并展示。
- ChatGPT 出现"继续生成"按钮时主页面有提示。
- 关闭某个 AI 标签页时扩展不崩溃，给出明确提示。
- 在真实 ChatGPT / Gemini 上连续使用 30 分钟无崩溃。

---

## 14. 法律与平台兼容声明

这一节用于 Chrome Store 审核、用户质疑、官方平台策略变化时直接引用。

**AIChatRoom 是什么 / 不是什么**：

- **AIChatRoom 不提供 AI 服务。** 扩展不调用任何 LLM API，不运行任何 AI 模型，不替用户生成内容。
- **AIChatRoom 不修改官方网页内容。** content script 只读 + 模拟用户输入 + 点击已存在的按钮，**不**修改 ChatGPT / Gemini 官方网页的 DOM 结构、样式、文案。
- **AIChatRoom 不抓取 Cookie、Token、Session 等敏感凭据。** 扩展不读取、不存储、不外发任何登录凭据。
- **AIChatRoom 不绕过官方平台任何机制。** 不绕过登录、不绕过付费墙、不绕过内容审查、不绕速率限制、不绕过用户已设定的任何偏好。
- **AIChatRoom 仅协助用户在已登录官方网页上执行重复操作。** 用户的所有 AI 服务订阅关系、对话记录、账号安全均归原平台所有；本扩展只是一个"机械臂"。

**对官方平台的责任**：

- 扩展遵循 [Chrome Web Store 开发者政策](https://developer.chrome.com/docs/webstore/program-policies/) 和 [Manifest V3 规范](https://developer.chrome.com/docs/extensions/mv3/intro/)。
- 若 ChatGPT / Gemini 官方明确禁止第三方工具操作其网页，扩展会立即下架 / 调整。
- 扩展使用的所有 AI 平台名称、图标、商标归原公司所有，本扩展不以商业方式使用。
- 扩展不与原平台形成代理、合作、附属关系；本扩展是独立工具。

**对用户的责任**：

- 用户使用本扩展须遵守其与 ChatGPT / Gemini 平台的用户协议。
- 扩展不保证 ChatGPT / Gemini 任何平台功能的可用性、稳定性、连续性。
- 由于平台改版导致扩展功能失效是预期风险，扩展不为此承担赔偿责任。
- 用户自己用扩展做了什么、问了什么、搬了什么，**用户自己负责**，扩展不背锅。
