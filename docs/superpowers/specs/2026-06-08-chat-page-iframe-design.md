# AIChatRoom Chat 页面 + iframe 嵌入设计

**日期**：2026-06-08
**状态**：待审核
**基线**：`docs/superpowers/specs/2026-06-08-aichatroom-design.md`
**作者**：头脑风暴协作（用户 + AI）

---

## 1. 概述

本次改动在 AIChatRoom v1 基线上**新增一个全屏主页面 `chat.html`**,用 iframe 把 ChatGPT 和 Gemini 官方页面**直接嵌入**到扩展页面里。参考产品 ChatBrawl 已经验证此方案可行(0.7.2 版本, 2000+ 用户)。

**为什么改**:
- 旧基线 §2.2 决定"不用 iframe",原因是从外部网页嵌 ChatGPT/Gemini 会被 X-Frame-Options 拒绝。
- 已用 `curl` 验证 ChatGPT 返回 `X-Frame-Options: SAMEORIGIN`,Gemini 返回 `X-Frame-Options: DENY` + 严格 CSP `frame-ancestors`。
- **解法**:Chrome MV3 提供的 `declarativeNetRequest` API 可以**剥离/重写响应头**。ChatBrawl 用一条规则就能把 `Content-Security-Policy` 的 `frame-ancestors` 改成 `frame-ancestors 'self' chrome-extension://*`,并 `remove` `X-Frame-Options`。
- 解法经过 2000+ 用户验证,稳定可用。

**同时修复**:
- F10 双栏界面从 800x600 popup 改成全屏主页面,符合用户最新截图要求。
- 顶部 `ChatGPT: 未检测 / Gemini: 未检测` bug(状态文字从未被 JS 更新)。
- image-handler 的回归(deepseek 改动破坏了"图片作为 imageDataUrl 发送给 content script"流程)。

---

## 2. 改动范围

### 2.1 新增

| 文件 | 用途 |
|------|------|
| `src/chat/chat.html` | 全屏双栏主页面 |
| `src/chat/chat.css` | 暗色主题, 仿 ChatBrawl 风格 |
| `src/chat/chat.ts` | iframe 控制器、状态栏、统一输入栏、工具按钮、消息桥接 |
| `src/background/dnr-rules.ts` | `enableEmbedRules()` / `disableEmbedRules()`,封装 ChatGPT + Gemini 的 modifyHeaders 规则 |

### 2.2 修改

| 文件 | 改动 |
|------|------|
| `manifest.json` | 新增 `declarativeNetRequest` 权限;移除 `action.default_popup`(点工具栏图标直接打开 chat 页面) |
| `src/background/service-worker.ts` | 安装/启动时按需调用 `enableEmbedRules()`;响应 `chat.html` 的 `close-chat-page` 消息调用 `disableEmbedRules()`;增加 `chrome.tabs.onRemoved/onUpdated` 监听,把平台 tab 状态推给 chat 页面 |
| `src/popup/popup.html` | **删除整个文件**(连同 `src/popup/popup.css` 和 `src/popup/popup.ts`) |
| `src/lib/image-handler.ts` | **回退 deepseek 的"复制到剪贴板"改动**,恢复 `acceptImage` 走 `imageDataUrl` 路径 |
| `src/popup/popup.ts` | 见 §2.2(同文件删除,无需改) |
| `vite.config.ts` | 把 `chat` 加入 `rollupOptions.input`,`popup` 从中移除 |
| `AIChatRoom_产品设想.md` | §3.2 删"不嵌入 Electron"那段,改为"Chrome 扩展 + 扩展页内嵌 iframe";§4 加 ChatBrawl 实现原理注;§7.1 加 §7.3 iframe 嵌入方案 |
| `docs/superpowers/specs/2026-06-08-aichatroom-design.md` | §2.2 重写;§2.7 权限加 `declarativeNetRequest`;§2.1 描述"主页面"改用 chat.html;§3.1 准备流程改;§4 F10 改 |

### 2.3 不动

- `src/adapters/`(业务代码与官方页面交互的适配层)
- `src/content-scripts/`(自动注入到 iframe 里的官方页面,不需要改)
- `src/options/`(设置页)
- `src/shared/messages.ts`(消息协议已够用,不需要新增类型)
- `src/types/index.ts`、`src/lib/`(除 image-handler 外)

---

## 3. 详细设计

### 3.1 架构总览

```
chrome-extension://ai-chat-room/
  └── src/chat/chat.html        ← ★新主页面 (点工具栏图标打开)
       ├── 左 iframe → https://gemini.google.com/
       ├── 右 iframe → https://chatgpt.com/
       ├── 顶部状态栏 (两个 dot)
       ├── 底部统一输入栏 (@chatgpt @gemini 选择 + textarea + 发送)
       └── 工具栏按钮 (引用 / 转移 / 总结 / 历史 / 图片)
```

`chat.html` 加载时:
1. 调 SW 的 `enable-embed-rules` → SW 调 `chrome.declarativeNetRequest.updateDynamicRules` 加规则
2. 创建两个 iframe,`src` 指向 ChatGPT / Gemini
3. 监听 `chrome.tabs.onRemoved` / `onUpdated`(经 SW 中转),更新顶部状态栏
4. 用户在底部输入框输入并发送 → SW → content script(在 iframe 内的 ChatGPT/Gemini 页面)→ AI

`chat.html` 关闭时(用户切到其他 tab / 关闭):
1. `window.addEventListener('beforeunload')` 调 SW 的 `disable-embed-rules` → SW 移除 DNR 规则
2. 这是按需启用的关键:规则只在用户主动使用 chat 页面时生效,不会污染用户正常浏览

### 3.2 declarativeNetRequest 规则

`src/background/dnr-rules.ts`:

```ts
import type { DeclarativeNetRequest } from '~types'

const RULE_IDS = { chatgpt: 1, gemini: 2 }

const buildRule = (id: number, urlFilter: string) => ({
  id,
  priority: 1,
  condition: {
    urlFilter,
    resourceTypes: ['main_frame', 'sub_frame'] as DeclarativeNetRequest.ResourceType[],
  },
  action: {
    type: 'modifyHeaders' as const,
    responseHeaders: [
      {
        header: 'Content-Security-Policy',
        operation: 'set' as const,
        value: "frame-ancestors 'self' chrome-extension://*",
      },
      { header: 'X-Frame-Options', operation: 'remove' as const },
    ],
  },
})

export async function enableEmbedRules(): Promise<void> {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_IDS.chatgpt, RULE_IDS.gemini],
    addRules: [
      buildRule(RULE_IDS.chatgpt, '||chatgpt.com^'),
      buildRule(RULE_IDS.gemini, '||gemini.google.com^'),
    ],
  })
}

export async function disableEmbedRules(): Promise<void> {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_IDS.chatgpt, RULE_IDS.gemini],
  })
}
```

**与 ChatBrawl 唯一差异**:ChatBrawl 在 background SW 启动时**永久**启用规则。本项目**按需启用** —— 仅 chat 页面打开时启用,关闭后立即移除。对用户透明,Chrome Store 审核时也更容易解释("仅在用户主动打开扩展页面时短暂启用")。

### 3.3 chat.html 主页面

**布局**(参考用户提供的 ChatBrawl 截图):

```
┌─────────────────────────────────────────────────────┐
│ [AIChatRoom]    [● ChatGPT] [● Gemini]    [⚙] [⛶] │ ← 顶部状态栏 (40px)
├─────────────────────────┬───────────────────────────┤
│                         │                           │
│   <iframe Gemini>       │   <iframe ChatGPT>        │ ← 双栏 (flex: 1)
│   (可拖拽改宽度)        │                           │
│                         │                           │
├─────────────────────────┴───────────────────────────┤
│ [图片] [@chatgpt][@gemini] [引用] [C→G] [G→C] [总结]│ ← 工具栏 (40px)
│ ┌─────────────────────────────────────────────┐ [↑] │ ← 输入框 (60-100px)
│ │ 在这里输入你的问题 或 输入 @ 和指定AI对话...  │    │
│ └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

- 暗色主题 (`#0e0e10` 背景, 跟 ChatBrawl 截图一致)
- 全屏 (`width: 100vw; height: 100vh`, 不限 800x600)
- iframe 宽度可拖拽(中间加 4px 拖拽条)
- 顶部状态点:绿点 = tab 在线,灰点 = tab 未打开,红点 = 出错

**事件流**(用户发送一条消息):
1. 用户在 textarea 输入,可能加 `@chatgpt` 或 `@gemini` 前缀(决定发送目标)
2. 点发送 → `chat.ts` 解析 at → 调 SW 的 `send-message`(消息协议同基线 §2.1)
3. SW 调 `chrome.tabs.query` 找 ChatGPT/Gemini tab → 给 content script 发 `write-and-send`
4. content script 注入到 iframe 内的官方页面,模拟填框 + 点击发送
5. 官方页面流式输出 → content script 的 `onStreamEvent` → SW → 推给 chat.ts → 更新底部"我方捕获"区(可选)或顶部状态

### 3.4 顶部状态栏修复(原"未检测"bug)

**基线 bug 根因**:`popup.html` 顶部 `.status-item` 的文字(`ChatGPT: 未检测`)是纯 HTML 初始文本,`popup.ts` 的 `setPlatformStatus()` 只更新面板内的"空闲/回答中...",**从来不更新顶部这个文字**。

**本次修复**(已迁移到 chat.html):
- `chat.ts` 启动时调 SW 的 `get-conversation-state` 探两个平台 tab 是否存在
- SW 调 `chrome.tabs.query({ url: 'https://chatgpt.com/*' })`,返回 `{ exists: true }` 或 `{ exists: false }`
- `chat.ts` 根据结果更新顶部 dot 颜色 + 文字(`未检测` / `已打开` / `已登录`)
- SW 订阅 `chrome.tabs.onRemoved` / `onUpdated`,tab 变化时主动 push `tab-status-changed` 消息给 chat.ts

### 3.5 image-handler 回退

**基线现状**(被 deepseek 改坏了):`acceptImage()` 把图片复制到剪贴板,让用户在 AI 输入框 Ctrl+V 粘贴。

**本次修复**:回退到原方案 —
- `acceptImage` 保留 `pendingImage = file`
- `onSend` 里 `await fileToDataUrl(pendingImage)` 转 dataUrl
- 调 SW 的 `send-message`,消息协议里 `imageDataUrl` 字段已经支持(`shared/messages.ts:8` 已定义)
- content script 收到 `write-and-send` 消息后,用 `buildDataTransferFromFile` + 派发 `paste` 事件注入

**保留** deepseek 新加的 `tryPasteFromClipboard`(未来如果用户手动在扩展页内把图片粘到 iframe 内的输入框可以用,目前**不调用**)。

### 3.6 manifest.json 改动

 ```diff
   "manifest_version": 3,
   "name": "AIChatRoom",
   "version": "0.1.0",
   "description": "Multi-AI comparison and transfer tool. No API keys, no data collection.",
   "action": {
-    "default_popup": "src/popup/popup.html",
-    "default_title": "AIChatRoom"
+    "default_title": "AIChatRoom"
   },
   "background": {
     "service_worker": "src/background/service-worker.ts",
     "type": "module"
   },
   "permissions": [
     "storage",
     "unlimitedStorage",
     "tabs",
-    "scripting"
+    "scripting",
+    "declarativeNetRequest"
   ],
   ...
 ```

> `description` 字段保留(仅 `default_popup` 移除,Chrome Store 审核可见)。

**`action.default_popup` 移除后的行为**:点工具栏图标 → 因为没有 popup,Chrome 默认会"无反应"。需要在 background SW 里监听 `chrome.action.onClicked`,调 `chrome.tabs.create({ url: chrome.runtime.getURL('src/chat/chat.html') })` 新开 tab。

---

## 4. 兼容性 / 风险

| 风险 | 触发条件 | 缓解 |
|------|---------|------|
| ChatGPT / Gemini 改版后 iframe 内页面更新 DOM 结构,content script 选择器失效 | 官方改版 | 改 `src/adapters/{chatgpt,gemini}/selectors.json`,符合基线 §2.6 |
| DNR 规则被 Google 反爬虫策略检测并额外限制 | 罕见 | 退路:在 chat.ts 里检测 iframe `onerror`,提示"iframe 加载失败,请到 chatgpt.com 手动登录";仍然能用 content script 注入到用户手动打开的 tab |
| `declarativeNetRequest` 在某些 Chrome 版本不支持 `modifyHeaders` 动作 | Chrome < 96(2021 年 12 月之前) | 在 `manifest.json` 加 `"minimum_chrome_version": "96"`(基线已要求 MV3) |
| 用户关闭 chat 页面后规则未及时移除 | `beforeunload` 事件丢失(浏览器崩溃) | 兜底:background SW 启动时(每个浏览器会话开始)调 `disableEmbedRules` 清理 |
| iframe 内 ChatGPT 登录态 cookie 是 `chatgpt.com` 的,被嵌入到扩展页面时是否仍然有效 | 理论: SameSite=Lax cookie 在 iframe 中会丢失 | 实测:ChatBrawl 0.7.2 用此方法 2000+ 用户无反馈登录态丢失问题。`chrome-extension://` 协议页面嵌 `https://` 页面的 cookie 行为等同顶级导航,ChatGPT/Gemini 默认未启用 SameSite=Strict |
| 用户在 iframe 内点击/操作官方页面后,content script 仍能监听 DOM 变化 | 期望行为 | iframe 与扩展页面同源策略下,content script 已经能注入和监听。**iframe 可点击 = 用户可以手动操作官方页面**(用户在 chat 页面外仍可继续手动操作) |

---

## 5. 测试计划

### 5.1 单元测试

- `dnr-rules.ts` 的 `enableEmbedRules` / `disableEmbedRules` mock `chrome.declarativeNetRequest`,验证 addRules / removeRuleIds 正确
- `chat.ts` 的 at-parser、消息路由 mock SW 验证

### 5.2 E2E(Playwright + 真实 Chrome)

- 加载扩展
- 点工具栏图标 → 验证打开 `chrome-extension://.../src/chat/chat.html` tab
- 验证 `chrome.declarativeNetRequest.getDynamicRules()` 在 chat 打开时返回 2 条规则
- 关闭 chat tab → 验证规则被移除
- iframe 加载后,验证 `chatgpt.com` / `gemini.google.com` 真实显示(用户已登录的 cookie 应自动带上)
- 底部输入框输入"你好" → 点发送 → 验证两边 iframe 内出现用户消息,AI 开始流式回答
- 顶部状态点状态切换(关闭其中一个官方页面 tab → 对应 dot 变红)

### 5.3 手动验证清单(在 docs/MANUAL_VERIFICATION.md 加一节)

- [ ] 打开 chat 页面后,iframe 内 ChatGPT 和 Gemini 都能正常显示(用户已登录)
- [ ] 顶部状态条显示"ChatGPT: ✓"和"Gemini: ✓"
- [ ] 输入"你好"点发送,两边 iframe 内都出现用户消息,AI 真实回答
- [ ] 关闭 chat 页面后,刷新 chatgpt.com 标签页,X-Frame-Options 头恢复(用 DevTools Network 面板验证)
- [ ] 用 deepseek 流程的图片粘贴流程正常(粘贴图片 → 发送到 ChatGPT/Gemini)

---

## 6. 不在本 spec 范围(明确不做)

- iframe 内点击的精细化交互(用户在 iframe 里点新对话按钮、滚动、设置等):基线已支持(content script 监听),本次不主动优化 UX
- 多个官方 AI 标签页同时存在时选择哪个:基线用 `chrome.tabs.query` 拿第一个,本次不变
- ChatBrawl 那样的"思考模式" / "网络搜索" / "API 配置" 等高级功能:本次只做基础对照台
- 把现有 popup 改造为"快速状态小窗":本次**直接删除** popup,不做迁移

---

## 7. 实施顺序(供 writing-plans 参考)

1. 写 `dnr-rules.ts`,加 `declarativeNetRequest` 权限到 manifest
2. 写 `src/chat/chat.html` + `chat.css`(静态布局,不接逻辑)
3. 写 `src/chat/chat.ts`,实现状态栏 + 输入栏 + 工具按钮(先不接 SW)
4. SW 增 `enable-embed-rules` / `disable-embed-rules` 消息处理
5. SW 增 `action.onClicked` 监听,新开 chat tab
6. `vite.config.ts` 增 `chat` input
7. `manifest.json` 移除 `default_popup`
8. 验证:`npm run build` 成功,加载到 Chrome,点工具栏图标打开 chat 页
9. 回退 image-handler
10. 顶部状态栏修复(从 popup 移植到 chat)
11. 删除 `src/popup/` 整个目录
12. 单元测试 + E2E
13. 更新 `AIChatRoom_产品设想.md` 和基线 spec
14. 提交,跑 MANUAL_VERIFICATION
