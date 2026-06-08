# Chat 页面 + iframe 嵌入 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 AIChatRoom 改造成"全屏 chat 页面 + iframe 嵌入 ChatGPT/Gemini"形态(参考 ChatBrawl 截图),同时修复"未检测"状态 bug 和 image-handler 回归。

**Architecture:**
- 新增 `src/chat/chat.html` 全屏主页面,用 iframe 直接嵌 `https://chatgpt.com` 和 `https://gemini.google.com`
- 用 `declarativeNetRequest.modifyHeaders` 按需剥离 `X-Frame-Options` 和重写 CSP `frame-ancestors`(照搬 ChatBrawl 0.7.2 已验证规则)
- 规则按需启用:chat 页面打开时启用,关闭时移除(比 ChatBrawl 更保守,Chrome Store 审核更友好)
- 去掉 `src/popup/` 整个目录,`chrome.action.onClicked` → `chrome.tabs.create(chat.html)`
- 沿用基线消息协议(无需新增类型),content script 自动注入到 iframe 内的官方页面

**Tech Stack:** TypeScript(strict) + Vite + `@crxjs/vite-plugin` + Vitest,无新依赖

**Spec 参考:** `docs/superpowers/specs/2026-06-08-chat-page-iframe-design.md`

---

## 文件结构(本改动后)

```
AIChatRoom/
├── manifest.json                          # +declarativeNetRequest 权限, -default_popup
├── vite.config.ts                         # rollupOptions.input 新增 chat
├── src/
│   ├── background/
│   │   ├── service-worker.ts              # +enable/disable-embed-rules, +action.onClicked
│   │   └── dnr-rules.ts                   # ★新增: modifyHeaders 规则封装
│   ├── chat/                              # ★新增目录
│   │   ├── chat.html                      # ★全屏主页面
│   │   ├── chat.css                       # ★暗色主题
│   │   └── chat.ts                        # ★iframe 控制器 + 状态栏 + 输入栏
│   ├── adapters/                          # 不动
│   ├── content-scripts/                   # 不动(自动注入到 iframe)
│   ├── lib/                               # 不动
│   ├── options/                           # 不动
│   ├── popup/                             # ★删除整个目录
│   ├── shared/                            # 不动
│   └── types/                             # 不动
├── tests/
│   ├── unit/
│   │   └── dnr-rules.test.ts              # ★新增: 单元测试
│   └── e2e/                               # 不动(基线 E2E 已用 mock 页面,本改动不直接跑)
├── AIChatRoom_产品设想.md                 # §3.2 / §4 / §7.3 更新
├── docs/superpowers/
│   ├── specs/2026-06-08-aichatroom-design.md  # §2.2 / §2.7 / §2.1 / §3.1 / §4 F10 更新
│   ├── specs/2026-06-08-chat-page-iframe-design.md  # 已有(本 spec)
│   ├── plans/2026-06-08-aichatroom-impl.md      # 不动(基线 plan)
│   └── plans/2026-06-08-chat-page-iframe-impl.md  # ★本计划
└── docs/MANUAL_VERIFICATION.md            # 加新章节
```

---

## Task 总览

| # | Task | 关键产出 | TDD |
|---|------|---------|-----|
| 1 | dnr-rules.ts 单测 | 验证规则 add/remove | ✓ |
| 2 | dnr-rules.ts 实现 | enable/disable 函数 | ✓ |
| 3 | manifest 加权限 | declarativeNetRequest | ✗ |
| 4 | chat.html + chat.css | 全屏双栏 + 暗色主题 | ✗ |
| 5 | chat.ts 实现 | iframe + 状态栏 + 输入栏 + SW 桥 | ✗ |
| 6 | SW 消息路由 | embed-rules 启停 | ✓ |
| 7 | SW action.onClicked | 工具栏图标 → 新开 chat | ✗ |
| 8 | vite.config.ts 配 chat input | 构建能产出 chat.html | ✗ |
| 9 | build + Chrome 加载验证 | 看到 chat 页面 + iframe 加载 | ✗ |
| 10 | chat.ts 接入 imageDataUrl 流程 | 修 deepseek 回归 | ✗ |
| 11 | 删除 popup + 清理 manifest | 精简 | ✗ |
| 12 | 更新基线 spec + 产品设想文档 | 文档同步 | ✗ |
| 13 | MANUAL_VERIFICATION 加新项 | 验收清单 | ✗ |

---

## Task 1: dnr-rules.ts 单元测试(失败)

**Files:**
- Create: `tests/unit/dnr-rules.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { enableEmbedRules, disableEmbedRules } from '../../src/background/dnr-rules'

declare const chrome: {
  declarativeNetRequest: {
    updateDynamicRules: (opts: any) => Promise<void>
    getDynamicRules: () => Promise<any[]>
  }
}

beforeEach(() => {
  ;(globalThis as any).chrome = {
    declarativeNetRequest: {
      updateDynamicRules: vi.fn().mockResolvedValue(undefined),
      getDynamicRules: vi.fn().mockResolvedValue([]),
    },
  }
})

describe('enableEmbedRules', () => {
  it('adds two modifyHeaders rules for chatgpt and gemini', async () => {
    await enableEmbedRules()
    const call = (chrome.declarativeNetRequest.updateDynamicRules as any).mock.calls[0][0]
    expect(call.addRules).toHaveLength(2)
    const targets = call.addRules.map((r: any) =>
      r.condition.urlFilter.includes('chatgpt') ? 'chatgpt' : 'gemini'
    )
    expect(targets).toEqual(expect.arrayContaining(['chatgpt', 'gemini']))
  })

  it('removes existing rules with the same ids before adding', async () => {
    await enableEmbedRules()
    const call = (chrome.declarativeNetRequest.updateDynamicRules as any).mock.calls[0][0]
    expect(call.removeRuleIds).toEqual(expect.arrayContaining([1, 2]))
  })

  it('each rule sets CSP frame-ancestors to allow extension origin', async () => {
    await enableEmbedRules()
    const call = (chrome.declarativeNetRequest.updateDynamicRules as any).mock.calls[0][0]
    for (const rule of call.addRules) {
      const cspHeader = rule.action.responseHeaders.find(
        (h: any) => h.header === 'Content-Security-Policy'
      )
      expect(cspHeader.operation).toBe('set')
      expect(cspHeader.value).toContain("frame-ancestors 'self' chrome-extension://*")
    }
  })

  it('each rule removes the X-Frame-Options header', async () => {
    await enableEmbedRules()
    const call = (chrome.declarativeNetRequest.updateDynamicRules as any).mock.calls[0][0]
    for (const rule of call.addRules) {
      const xfo = rule.action.responseHeaders.find(
        (h: any) => h.header === 'X-Frame-Options'
      )
      expect(xfo.operation).toBe('remove')
    }
  })
})

describe('disableEmbedRules', () => {
  it('removes the two rules by id and adds none', async () => {
    await disableEmbedRules()
    const call = (chrome.declarativeNetRequest.updateDynamicRules as any).mock.calls[0][0]
    expect(call.removeRuleIds).toEqual(expect.arrayContaining([1, 2]))
    expect(call.addRules).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/dnr-rules.test.ts`
Expected: FAIL with "Cannot find module '../../src/background/dnr-rules'"(文件还没创建)

---

## Task 2: 实现 dnr-rules.ts

**Files:**
- Create: `src/background/dnr-rules.ts`

- [ ] **Step 1: 实现 enableEmbedRules / disableEmbedRules**

```ts
const RULE_IDS = { chatgpt: 1, gemini: 2 } as const

const buildRule = (id: number, urlFilter: string) => ({
  id,
  priority: 1,
  condition: {
    urlFilter,
    resourceTypes: ['main_frame', 'sub_frame'] as chrome.declarativeNetRequest.ResourceType[],
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

- [ ] **Step 2: 跑测试确认通过**

Run: `npx vitest run tests/unit/dnr-rules.test.ts`
Expected: PASS,4 + 1 = 5 个用例全绿

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: 0 errors

- [ ] **Step 4: commit**

```bash
git add tests/unit/dnr-rules.test.ts src/background/dnr-rules.ts
git commit -m "feat(background): declarativeNetRequest rules to strip X-Frame-Options

ChatBrawl 0.7.2 已验证写法,按需启用:仅 chat 页面打开时启用,
关闭后立即移除。规则集:
  - CSP frame-ancestors 改为 'self' chrome-extension://*
  - 移除 X-Frame-Options 头"
```

---

## Task 3: manifest.json 加 declarativeNetRequest 权限

**Files:**
- Modify: `manifest.json:18`(permissions 数组)

- [ ] **Step 1: 加权限**

修改 `permissions` 数组,在末尾加 `"declarativeNetRequest"`:

```json
  "permissions": [
    "storage",
    "unlimitedStorage",
    "tabs",
    "scripting",
    "declarativeNetRequest"
  ],
```

- [ ] **Step 2: 跑 typecheck 确认 manifest 类型没破**

Run: `npm run typecheck`
Expected: 0 errors

- [ ] **Step 3: commit**

```bash
git add manifest.json
git commit -m "chore(manifest): add declarativeNetRequest permission"
```

---

## Task 4: chat.html + chat.css(静态布局)

**Files:**
- Create: `src/chat/chat.html`
- Create: `src/chat/chat.css`

- [ ] **Step 1: 写 chat.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AIChatRoom</title>
  <link rel="stylesheet" href="./chat.css">
</head>
<body>
  <div class="app">
    <header class="topbar">
      <h1 class="brand">AIChatRoom</h1>
      <div class="status" id="status">
        <span class="status-item" data-platform="chatgpt">
          <span class="dot"></span>ChatGPT:<span class="status-text">检测中…</span>
        </span>
        <span class="status-item" data-platform="gemini">
          <span class="dot"></span>Gemini:<span class="status-text">检测中…</span>
        </span>
      </div>
      <div class="topbar-actions">
        <button id="btn-refresh" title="刷新状态">↻</button>
      </div>
    </header>

    <main class="panels">
      <section class="panel" data-platform="gemini">
        <header class="panel-header">
          <span class="panel-title">Gemini</span>
          <button class="panel-open" data-platform="gemini" title="在新标签页打开官方页面">↗</button>
        </header>
        <iframe class="panel-iframe" data-platform="gemini" src="about:blank"></iframe>
      </section>

      <div class="splitter" id="splitter"></div>

      <section class="panel" data-platform="chatgpt">
        <header class="panel-header">
          <span class="panel-title">ChatGPT</span>
          <button class="panel-open" data-platform="chatgpt" title="在新标签页打开官方页面">↗</button>
        </header>
        <iframe class="panel-iframe" data-platform="chatgpt" src="about:blank"></iframe>
      </section>
    </main>

    <footer class="composer">
      <div class="composer-toolbar">
        <button id="btn-image" title="粘贴/拖拽图片">图片</button>
        <span class="at-hint">@chatgpt @gemini 选择目标</span>
        <button id="btn-quote" disabled title="引用上一轮回答">引用</button>
        <button id="btn-transfer-c2g" disabled title="把 ChatGPT 的回答搬到 Gemini">C→G</button>
        <button id="btn-transfer-g2c" disabled title="把 Gemini 的回答搬到 ChatGPT">G→C</button>
        <button id="btn-summary" disabled title="对比总结">总结</button>
        <button id="btn-history" title="查看历史">历史</button>
      </div>
      <div class="composer-input">
        <textarea id="input" rows="2"
          placeholder="在这里输入你的问题 或 输入 @ 和指定AI对话..."></textarea>
        <button id="btn-send" title="发送">↑</button>
      </div>
    </footer>
  </div>
  <script type="module" src="./chat.ts"></script>
</body>
</html>
```

- [ ] **Step 2: 写 chat.css(暗色主题)**

```css
:root {
  --bg: #0e0e10;
  --bg-2: #18181b;
  --bg-3: #1f1f23;
  --fg: #ececec;
  --muted: #8b8b95;
  --border: #2a2a30;
  --accent: #4f8cff;
  --ok: #22c55e;
  --err: #ef4444;
  --warn: #f59e0b;
}

* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0; height: 100%;
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;
  background: var(--bg); color: var(--fg); font-size: 13px;
}
body { overflow: hidden; }

.app { display: flex; flex-direction: column; height: 100vh; width: 100vw; }

/* Top bar */
.topbar {
  display: flex; align-items: center; gap: 16px;
  padding: 8px 14px; border-bottom: 1px solid var(--border);
  background: var(--bg-2); flex-shrink: 0;
}
.brand { font-size: 14px; font-weight: 600; margin: 0; }
.status { display: flex; gap: 14px; flex: 1; }
.status-item { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
.dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  background: #555; transition: background 0.2s;
}
.dot.ok { background: var(--ok); }
.dot.err { background: var(--err); }
.dot.warn { background: var(--warn); }
.status-text { color: var(--fg); }
.topbar-actions button {
  background: transparent; border: 1px solid var(--border); color: var(--fg);
  padding: 4px 10px; border-radius: 4px; cursor: pointer;
}
.topbar-actions button:hover { background: var(--bg-3); }

/* Panels */
.panels { flex: 1; display: flex; min-height: 0; }
.panel { flex: 1 1 50%; display: flex; flex-direction: column; min-width: 200px; }
.panel-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 6px 12px; border-bottom: 1px solid var(--border);
  background: var(--bg-2); font-size: 12px; color: var(--muted);
  flex-shrink: 0;
}
.panel-title { font-weight: 500; }
.panel-open {
  background: transparent; border: 1px solid var(--border); color: var(--muted);
  padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 12px;
}
.panel-open:hover { color: var(--fg); }
.panel-iframe {
  flex: 1; width: 100%; border: none; background: #fff;
}

/* Splitter */
.splitter {
  width: 4px; cursor: col-resize; background: var(--border);
  flex-shrink: 0; transition: background 0.2s;
}
.splitter:hover, .splitter.dragging { background: var(--accent); }

/* Composer */
.composer {
  border-top: 1px solid var(--border); background: var(--bg-2);
  flex-shrink: 0;
}
.composer-toolbar {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 12px; border-bottom: 1px solid var(--border);
}
.composer-toolbar button {
  background: var(--bg-3); border: 1px solid var(--border); color: var(--fg);
  padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px;
}
.composer-toolbar button:hover:not(:disabled) { background: #2a2a30; }
.composer-toolbar button:disabled { opacity: 0.4; cursor: not-allowed; }
.at-hint { color: var(--muted); font-size: 11px; margin-left: auto; }
.composer-input {
  display: flex; gap: 8px; padding: 8px 12px; align-items: flex-end;
}
#input {
  flex: 1; resize: none; background: var(--bg-3); color: var(--fg);
  border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px;
  font: inherit; line-height: 1.5; min-height: 36px; max-height: 200px;
}
#input:focus { outline: none; border-color: var(--accent); }
#btn-send {
  background: var(--accent); color: #fff; border: none;
  width: 36px; height: 36px; border-radius: 6px; cursor: pointer;
  font-size: 18px; font-weight: bold;
}
#btn-send:hover { background: #3d75e0; }
#btn-send:disabled { background: #555; cursor: not-allowed; }
```

- [ ] **Step 3: 验证文件存在(无需 build,后面 Task 8 后才 build)**

Run: `ls -la src/chat/`
Expected: 看到 `chat.html` 和 `chat.css` 两个文件

- [ ] **Step 4: commit**

```bash
git add src/chat/chat.html src/chat/chat.css
git commit -m "feat(chat): add chat.html and dark-theme chat.css

- Full-screen layout (no popup)
- Top status bar with two dots
- Two iframes (Gemini left, ChatGPT right) with draggable splitter
- Bottom composer: image / @ / quote / transfer / summary / history + textarea + send"
```

---

## Task 5: chat.ts 主体实现

**Files:**
- Create: `src/chat/chat.ts`

> 注:本 task 包含较多 UI 逻辑,无法纯 TDD(渲染测试用 Playwright)。代码先按 spec 一次性写完,验收走 Task 9 的 Chrome 加载验证 + Task 13 的手动清单。

- [ ] **Step 1: 写 chat.ts**

```ts
import type { AIPlatform } from '../types'
import type { PopupToSw, SwToPopup } from '../shared/messages'

// ---------- DOM refs ----------
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!
const statusText = (p: AIPlatform) =>
  document.querySelector<HTMLSpanElement>(`.status-item[data-platform="${p}"] .status-text`)!
const statusDot = (p: AIPlatform) =>
  document.querySelector<HTMLSpanElement>(`.status-item[data-platform="${p}"] .dot`)!
const panelIframe = (p: AIPlatform) =>
  document.querySelector<HTMLIFrameElement>(`.panel-iframe[data-platform="${p}"]`)!
const panelOpenBtn = (p: AIPlatform) =>
  document.querySelector<HTMLButtonElement>(`.panel-open[data-platform="${p}"]`)!
const inputEl = $<HTMLTextAreaElement>('#input')
const sendBtn = $<HTMLButtonElement>('#btn-send')
const quoteBtn = $<HTMLButtonElement>('#btn-quote')
const btnC2G = $<HTMLButtonElement>('#btn-transfer-c2g')
const btnG2C = $<HTMLButtonElement>('#btn-transfer-g2c')
const btnSummary = $<HTMLButtonElement>('#btn-summary')
const btnHistory = $<HTMLButtonElement>('#btn-history')
const btnImage = $<HTMLButtonElement>('#btn-image')
const btnRefresh = $<HTMLButtonElement>('#btn-refresh')
const splitter = $<HTMLDivElement>('#splitter')

// ---------- State ----------
const PLATFORMS: AIPlatform[] = ['chatgpt', 'gemini']
const OFFICIAL_URLS: Record<AIPlatform, string> = {
  chatgpt: 'https://chatgpt.com/',
  gemini: 'https://gemini.google.com/',
}

const lastResponses: Record<AIPlatform, string> = { chatgpt: '', gemini: '' }
let pendingImage: File | null = null

// ---------- SW bridge ----------
function sendToSw<T = unknown>(msg: PopupToSw): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
      else resolve(response as T)
    })
  })
}

chrome.runtime.onMessage.addListener((msg: SwToPopup) => {
  if (msg.type === 'tab-status-changed') {
    updatePlatformStatus(msg.platform, msg.exists ? 'ok' : 'err',
      msg.exists ? '已打开' : '未打开')
  }
})

// ---------- Status bar ----------
function updatePlatformStatus(p: AIPlatform, dot: 'ok' | 'err' | 'warn' | 'idle', text: string) {
  const d = statusDot(p)
  d.classList.remove('ok', 'err', 'warn')
  if (dot !== 'idle') d.classList.add(dot)
  statusText(p).textContent = text
}

async function refreshAllStatuses() {
  for (const p of PLATFORMS) {
    updatePlatformStatus(p, 'warn', '检测中…')
    try {
      const r = await sendToSw<{ ok: boolean; exists: boolean }>({
        type: 'check-tab-exists', platform: p,
      })
      if (r.ok && r.exists) {
        updatePlatformStatus(p, 'ok', '已打开')
        panelIframe(p).src = OFFICIAL_URLS[p]
      } else {
        updatePlatformStatus(p, 'err', '未打开')
        // keep iframe blank
      }
    } catch {
      updatePlatformStatus(p, 'err', '检测失败')
    }
  }
}

// ---------- Splitter (draggable width) ----------
function initSplitter() {
  let dragging = false
  splitter.addEventListener('mousedown', (e) => {
    dragging = true
    splitter.classList.add('dragging')
    e.preventDefault()
  })
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return
    const total = document.querySelector('.panels')!.clientWidth
    const left = document.querySelector<HTMLElement>('.panel[data-platform="gemini"]')!
    const ratio = Math.max(0.15, Math.min(0.85, e.clientX / total))
    left.style.flex = `0 0 ${ratio * 100}%`
  })
  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false
      splitter.classList.remove('dragging')
    }
  })
}

// ---------- "Open in new tab" buttons ----------
function initPanelOpenButtons() {
  for (const p of PLATFORMS) {
    panelOpenBtn(p).addEventListener('click', () => {
      chrome.tabs.create({ url: OFFICIAL_URLS[p] })
    })
  }
}

// ---------- Composer ----------
function updateTransferButtons() {
  btnC2G.disabled = !lastResponses.chatgpt
  btnG2C.disabled = !lastResponses.gemini
  quoteBtn.disabled = !(lastResponses.chatgpt || lastResponses.gemini)
  btnSummary.disabled = !(lastResponses.chatgpt && lastResponses.gemini)
}

async function onSend() {
  const text = inputEl.value.trim()
  if (!text && !pendingImage) return

  // Parse @AI mentions (simple version: detect "@chatgpt" / "@gemini" tokens)
  const mentioned: AIPlatform[] = []
  for (const p of PLATFORMS) {
    if (text.toLowerCase().includes(`@${p}`)) mentioned.push(p)
  }
  const targets = mentioned.length > 0 ? mentioned : PLATFORMS

  // Build imageDataUrl if pending
  let imageDataUrl: string | undefined
  if (pendingImage) {
    imageDataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(pendingImage!)
    })
  }

  await sendToSw({ type: 'send-message', platforms: targets, text, imageDataUrl })
  inputEl.value = ''
  pendingImage = null
  btnImage.textContent = '图片'
}

function onQuote() {
  const source: AIPlatform | null = lastResponses.chatgpt
    ? 'chatgpt' : (lastResponses.gemini ? 'gemini' : null)
  if (!source) return
  const name = source === 'chatgpt' ? 'ChatGPT' : 'Gemini'
  const insertion = `[引用 ${name} 的上一条回答]：\n${lastResponses[source]}\n\n`
  const start = inputEl.selectionStart ?? inputEl.value.length
  const end = inputEl.selectionEnd ?? inputEl.value.length
  inputEl.value = inputEl.value.slice(0, start) + insertion + inputEl.value.slice(end)
  const newPos = start + insertion.length
  inputEl.setSelectionRange(newPos, newPos)
  inputEl.focus()
}

function onTransfer(from: AIPlatform, to: AIPlatform) {
  const text = lastResponses[from]
  if (!text) return
  const wrapped = `下面是另一个 AI 的回答，请你帮我审查：\n1. 哪些地方可能是错的？\n2. 哪些地方说得太笼统？\n3. 有没有遗漏？\n4. 请给出你认为更准确的版本。\n\n以下是对方的回答：\n${text}`
  void sendToSw({ type: 'send-message', platforms: [to], text: wrapped })
}

function onSummary() {
  const a = lastResponses.chatgpt
  const b = lastResponses.gemini
  if (!a || !b) return
  const tpl = `请对比以下两个 AI 的回答，输出：\n1. 两边都认可的结论。\n2. 两边说法不同的地方。\n3. 哪些内容需要进一步确认。\n4. 最后更建议采用哪种方案。\n\n--- AI A (ChatGPT) ---\n${a}\n\n--- AI B (Gemini) ---\n${b}`
  void sendToSw({ type: 'send-message', platforms: ['chatgpt'], text: tpl })
}

function onHistory() {
  void sendToSw({ type: 'get-history' })
}

function onImage() {
  alert('直接 Ctrl+V 粘贴图片，或拖拽图片到输入框')
}

function acceptImage(file: File) {
  pendingImage = file
  btnImage.textContent = '图片 ✓'
}

// Paste / drop image
function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile()
      if (f) { e.preventDefault(); acceptImage(f); return }
    }
  }
}
function onDrop(e: DragEvent) {
  const files = e.dataTransfer?.files
  if (!files) return
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    if (f.type.startsWith('image/')) { e.preventDefault(); acceptImage(f); return }
  }
}

// ---------- Boot ----------
window.addEventListener('DOMContentLoaded', async () => {
  console.log('[AIChatRoom chat] ready')
  initSplitter()
  initPanelOpenButtons()
  sendBtn.addEventListener('click', () => void onSend())
  quoteBtn.addEventListener('click', onQuote)
  btnC2G.addEventListener('click', () => onTransfer('chatgpt', 'gemini'))
  btnG2C.addEventListener('click', () => onTransfer('gemini', 'chatgpt'))
  btnSummary.addEventListener('click', onSummary)
  btnHistory.addEventListener('click', onHistory)
  btnImage.addEventListener('click', onImage)
  btnRefresh.addEventListener('click', () => void refreshAllStatuses())
  inputEl.addEventListener('paste', onPaste)
  inputEl.addEventListener('drop', onDrop)
  inputEl.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void onSend()
    }
  })
  updateTransferButtons()

  // Enable embed rules and then refresh status
  try {
    await sendToSw({ type: 'enable-embed-rules' })
  } catch (e) {
    console.error('[AIChatRoom] enable-embed-rules failed', e)
  }
  await refreshAllStatuses()
})

window.addEventListener('beforeunload', () => {
  // Best-effort cleanup; not strictly required but reduces attack window
  try {
    chrome.runtime.sendMessage({ type: 'disable-embed-rules' })
  } catch {
    // SW may already be gone
  }
})
```

- [ ] **Step 2: typecheck(预期会失败,因为 SW 消息路由还没加)**

Run: `npm run typecheck`
Expected: 报错提示 `check-tab-exists` / `enable-embed-rules` / `disable-embed-rules` / `get-history` / `tab-status-changed` 等消息类型不存在

> 这是**预期**的。下个 task 加 SW 消息路由后就会好。

- [ ] **Step 3: 不 commit(等 Task 6 加完 SW 消息路由,确认 typecheck 通过后一起 commit)**

---

## Task 6: SW 增 embed-rules 启停 + tab 状态推送

**Files:**
- Modify: `src/background/service-worker.ts`(整个文件改写,在原基础上加)
- Modify: `src/shared/messages.ts`(增几个消息类型)

- [ ] **Step 1: 在 `src/shared/messages.ts` 增类型**

在 `PopupToSw` 联合类型前加:

```ts
  | { type: 'enable-embed-rules' }
  | { type: 'disable-embed-rules' }
  | { type: 'check-tab-exists'; platform: AIPlatform }
  | { type: 'get-history' }
```

在 `SwToPopup` 联合类型前加:

```ts
  | { type: 'tab-status-changed'; platform: AIPlatform; exists: boolean }
```

- [ ] **Step 2: 在 `src/background/service-worker.ts` 顶部加 import 和 import dnr-rules**

```ts
import { enableEmbedRules, disableEmbedRules } from './dnr-rules'
```

- [ ] **Step 3: 在 `chrome.runtime.onMessage.addListener((msg: PopupToSw, ...` 的 handler 内,现有 `if (msg.type === 'send-message')` 之前,加四个分支**

```ts
  if (msg.type === 'enable-embed-rules') {
    ;(async () => {
      try { await enableEmbedRules() } catch (e) { console.error(e) }
      sendResponse({ ok: true })
    })()
    return true
  }
  if (msg.type === 'disable-embed-rules') {
    ;(async () => {
      try { await disableEmbedRules() } catch (e) { console.error(e) }
      sendResponse({ ok: true })
    })()
    return true
  }
  if (msg.type === 'check-tab-exists') {
    ;(async () => {
      const tab = await findTabFor(msg.platform)
      sendResponse({ ok: true, exists: !!tab })
    })()
    return true
  }
  if (msg.type === 'get-history') {
    ;(async () => {
      // Stub for now: future use session-store from popup.ts
      sendResponse({ ok: true, sessions: [] })
    })()
    return true
  }
```

- [ ] **Step 4: 加 `chrome.tabs.onRemoved` / `onUpdated` 监听,推送 tab 状态变化给 chat 页面**

在 `findTabFor` 函数**之前**,加:

```ts
const OFFICIAL_URL_PATTERNS: Record<AIPlatform, string> = {
  chatgpt: 'https://chatgpt.com/*',
  gemini: 'https://gemini.google.com/*',
}

function broadcastTabStatus(platform: AIPlatform, exists: boolean): void {
  const reply: SwToPopup = { type: 'tab-status-changed', platform, exists }
  chrome.runtime.sendMessage(reply).catch(() => {/* chat page may be closed */})
}

chrome.tabs.onRemoved.addListener((_tabId, removeInfo) => {
  // Best-effort: check each platform's tabs and broadcast
  for (const p of PLATFORMS) {
    void findTabFor(p).then((t) => broadcastTabStatus(p, !!t))
  }
})

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!tab.url) return
  for (const p of PLATFORMS) {
    if (tab.url.startsWith(OFFICIAL_URL_PATTERNS[p].replace('/*', '/'))) {
      void findTabFor(p).then((t) => broadcastTabStatus(p, !!t))
    }
  }
})
```

并在文件顶部 import 后加:

```ts
const PLATFORMS: AIPlatform[] = ['chatgpt', 'gemini']
```

- [ ] **Step 5: 跑 typecheck**

Run: `npm run typecheck`
Expected: 0 errors

- [ ] **Step 6: 跑所有单元测试确认没破坏**

Run: `npm test`
Expected: 所有原有测试 + Task 2 的 dnr-rules 测试全绿

- [ ] **Step 7: commit**

```bash
git add src/shared/messages.ts src/background/service-worker.ts src/chat/chat.ts
git commit -m "feat(sw+chat): enable/disable embed rules, tab status broadcast, chat.ts wiring

- SW: new message handlers for enable-embed-rules, disable-embed-rules,
  check-tab-exists, get-history
- SW: subscribe chrome.tabs.onRemoved/onUpdated, broadcast
  tab-status-changed to chat page
- chat.ts: full UI controller (status bar / splitter / composer / image paste
  / quote / transfer / summary / history stub)
- shared/messages.ts: add 4 PopupToSw variants and 1 SwToPopup variant"
```

---

## Task 7: SW 增 action.onClicked 监听

**Files:**
- Modify: `src/background/service-worker.ts`

- [ ] **Step 1: 在文件末尾(所有 import 和函数之后)加 `chrome.action.onClicked` 监听**

```ts
chrome.action.onClicked.addListener((tab) => {
  void chrome.tabs.create({
    url: chrome.runtime.getURL('src/chat/chat.html'),
  })
})
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: 0 errors

- [ ] **Step 3: commit**

```bash
git add src/background/service-worker.ts
git commit -m "feat(sw): open chat.html when toolbar icon clicked (popup removed)"
```

---

## Task 8: vite.config.ts 配 chat input

**Files:**
- Modify: `vite.config.ts`(rollupOptions.input)

- [ ] **Step 1: 在 `rollupOptions.input` 加 chat 条目**

修改 `vite.config.ts` 的 `build.rollupOptions.input`:

```ts
      input: {
        chat: resolve(import.meta.dirname, 'src/chat/chat.html'),
        options: resolve(import.meta.dirname, 'src/options/options.html'),
        'service-worker': resolve(import.meta.dirname, 'src/background/service-worker.ts'),
        'content-chatgpt': resolve(import.meta.dirname, 'src/content-scripts/chatgpt-content.ts'),
        'content-gemini': resolve(import.meta.dirname, 'src/content-scripts/gemini-content.ts'),
      },
```

> 删除了原 `popup: ...` 条目。

- [ ] **Step 2: build 确认产物里有 chat.html**

Run: `npm run build`
Expected: `dist/src/chat/chat.html` 出现

- [ ] **Step 3: 验证 build 产物里嵌了 chat.css 和 chat.js**

Run: `ls dist/src/chat/`
Expected:
```
chat.html
chat.css  (或 assets/chat-[hash].css)
chat.js   (或 assets/chat-[hash].js)
```

- [ ] **Step 4: commit**

```bash
git add vite.config.ts
git commit -m "build: add chat.html to rollupOptions.input, drop popup"
```

---

## Task 9: 加载到 Chrome 验证(关键里程碑)

> 这一步需要用户在真实 Chrome 里手动操作,AI 无法直接验证。

- [ ] **Step 1: 跑 build 一次**

Run: `npm run build`
Expected: 0 errors,产物在 `dist/`

- [ ] **Step 2: 用户操作:加载扩展**

操作:
1. 打开 `chrome://extensions`
2. 开启"开发者模式"
3. "加载已解压的扩展" → 选择 `dist/` 目录
4. 扩展出现在列表里,名称"AIChatRoom"

Expected: 加载成功,无 manifest 错误

- [ ] **Step 3: 用户操作:打开 ChatGPT 和 Gemini 官方页面(供 iframe 嵌)**

操作:
1. 新标签页打开 `https://chatgpt.com/`,登录
2. 新标签页打开 `https://gemini.google.com/`,登录

- [ ] **Step 4: 用户操作:点扩展图标**

Expected:
- 弹出新标签页 `chrome-extension://.../src/chat/chat.html`
- 全屏,暗色主题
- 顶部状态条显示 "ChatGPT: 已打开"(绿点)和 "Gemini: 已打开"(绿点)
- 两个 iframe 内分别加载 ChatGPT 和 Gemini 官方页面(已登录状态)

- [ ] **Step 5: 验证 DNR 规则已启用**

操作:打开 `chrome://extensions` → 找到 AIChatRoom → "检查视图" → "service worker" → DevTools 控制台

Run: `chrome.declarativeNetRequest.getDynamicRules()`

Expected: 返回 2 条规则,id 1 和 2,action.type === 'modifyHeaders'

- [ ] **Step 6: 验证关闭 chat 页面后规则被移除**

操作:关闭 chat 页面 tab,回到 SW 控制台

Run: `chrome.declarativeNetRequest.getDynamicRules()`

Expected: 返回 `[]`

- [ ] **Step 7: 如果 Step 4-6 任何一步失败,回到 Task 2/6/7 排查,不要继续**

---

## Task 10: chat.ts 接入 imageDataUrl 流程(回退 deepseek 回归)

> Task 5 的 chat.ts 里 `onSend` 已经写了 `imageDataUrl` 路径(看 `await new Promise<string>... readAsDataURL`)。本 task 验证它真的能跑通,无需额外代码改动。

**Files:**
- 无代码改动,只验证

- [ ] **Step 1: 跑 unit test 看 image-handler 单测仍绿(确认基线未破)**

Run: `npx vitest run tests/unit/image-handler.test.ts`
Expected: 3 个 case 全绿

- [ ] **Step 2: 用户操作:粘贴图片发送**

操作:
1. 打开 chat 页面
2. 复制一张图片到剪贴板
3. 在 textarea 按 Ctrl+V,按钮变 "图片 ✓"
4. 点发送

Expected: 两个 iframe 内的官方 AI 页面输入框收到图片(看 ChatGPT/Gemini 实际显示)

> 注:实际注入到 ChatGPT/Gemini 的 content script 代码已经存在(Task 9-10 在基线已实现,本改动不动它们),图片注入走 `paste` 事件模拟。

- [ ] **Step 3: 跑所有单测确认没破**

Run: `npm test`
Expected: 全绿

- [ ] **Step 4: 不 commit(无代码改动)**

---

## Task 11: 清理 popup(删除 + manifest 改动)

**Files:**
- Delete: `src/popup/popup.html`
- Delete: `src/popup/popup.css`
- Delete: `src/popup/popup.ts`
- Delete: `tests/e2e/` 下如果有 `popup-*.spec.ts`(本仓库没有,跳过)
- Modify: `manifest.json`(删 `action.default_popup`)

- [ ] **Step 1: 删文件**

Run:
```bash
git rm src/popup/popup.html src/popup/popup.css src/popup/popup.ts
```

- [ ] **Step 2: 改 manifest.json 删 `default_popup`**

修改 `action` 字段:

```json
  "action": {
    "default_title": "AIChatRoom"
  },
```

- [ ] **Step 3: build 验证**

Run: `npm run build`
Expected: 0 errors,产物中**无** popup 相关文件

- [ ] **Step 4: typecheck + 单测**

Run: `npm run typecheck && npm test`
Expected: 全绿

- [ ] **Step 5: 加载到 Chrome,确认点工具栏图标直接打开 chat 页(不弹 popup)**

操作:点工具栏图标
Expected: 弹新 tab 到 `chrome-extension://.../src/chat/chat.html`,无 popup 弹出

- [ ] **Step 6: commit**

```bash
git add -A
git commit -m "refactor: remove popup in favor of full-screen chat page

- Delete src/popup/* (3 files)
- manifest.json: remove action.default_popup
- chrome.action.onClicked (Task 7) opens chat.html in new tab"
```

---

## Task 12: 更新基线 spec 和产品设想文档

**Files:**
- Modify: `docs/superpowers/specs/2026-06-08-aichatroom-design.md`
- Modify: `AIChatRoom_产品设想.md`

- [ ] **Step 1: 基线 spec §2.2 重写**

把 `docs/superpowers/specs/2026-06-08-aichatroom-design.md` 的 §2.2 "为什么不用 iframe 嵌入" 整段替换为:

```markdown
### 2.2 iframe 嵌入(extension-page 模式)

扩展主页面 `src/chat/chat.html` 是一个全屏扩展页,直接用 `<iframe>` 嵌入 ChatGPT / Gemini 官方页面。用户的登录 cookie 由浏览器自动带上,content script 也按 manifest 配置自动注入到 iframe 内的官方页面。

**为什么用 iframe 而不依赖用户自己开 tab**:参考产品 ChatBrawl 0.7.2(2000+ 用户)已验证此模式稳定可用,用户用扩展即可对照两边 AI,不必自己开标签页。

**绕过 X-Frame-Options**:ChatGPT 返回 `X-Frame-Options: SAMEORIGIN`,Gemini 返回 `DENY` + CSP `frame-ancestors`。扩展用 `declarativeNetRequest.modifyHeaders` 按需改写响应头:

- `Content-Security-Policy` 重写为 `frame-ancestors 'self' chrome-extension://*`
- `X-Frame-Options` 移除

规则仅在 chat 页面打开时启用(`enableEmbedRules`),关闭时移除(`disableEmbedRules`),不影响用户其他浏览行为。具体实现见 `src/background/dnr-rules.ts`。
```

- [ ] **Step 2: 基线 spec §2.7 权限加 `declarativeNetRequest`**

在 `permissions` 数组里加:

```json
"declarativeNetRequest",  // 按需改写 ChatGPT / Gemini 响应头,允许 iframe 嵌入(详见 §2.2)
```

- [ ] **Step 3: 基线 spec §2.1 改 "主页面" 描述**

把"扩展主页面(Popup / Side Panel)"改为"扩展主页面(全屏 chat 页,`src/chat/chat.html`)"

- [ ] **Step 4: 基线 spec §4 F10 改**

把 F10 "双栏界面 + 统一输入框"描述里"主页布局"改为"全屏 chat 页面布局"

- [ ] **Step 5: 产品设想 §3.2 加注**

在 §3.2 末尾加:

```markdown
> v1.1 注:已改用 iframe 嵌入方案。详见本文件 §7.3 和 `docs/superpowers/specs/2026-06-08-chat-page-iframe-design.md`。
```

- [ ] **Step 6: 产品设想 §4 加 ChatBrawl 实现原理**

在 §4.2 之后加 §4.4:

```markdown
### 4.4 ChatBrawl 实现原理(已验证)

下载 ChatBrawl 0.7.2 扩展包分析,其核心是 `declarativeNetRequest` 动态规则:

```json
{
  "action": {
    "type": "modifyHeaders",
    "responseHeaders": [
      { "header": "Content-Security-Policy", "operation": "set",
        "value": "frame-ancestors 'self' chrome-extension://*" },
      { "header": "X-Frame-Options", "operation": "remove" }
    ]
  }
}
```

本项目沿用此方案,只在 chat 页面打开时启用规则(更保守)。
```

- [ ] **Step 7: 产品设想 §7 加 §7.3**

在 §7 末尾加:

```markdown
### 7.3 iframe 嵌入方案

扩展主页面 `src/chat/chat.html` 用 `<iframe>` 嵌 ChatGPT / Gemini 官方页面。通过 `declarativeNetRequest` 按需剥离响应头里的 `X-Frame-Options` 和重写 CSP `frame-ancestors`,使官方页面允许被扩展页面嵌入。用户的官方 cookie 自动带到 iframe,content script 按 manifest 配置自动注入到 iframe 内的官方页面。
```

- [ ] **Step 8: 提交**

```bash
git add docs/superpowers/specs/2026-06-08-aichatroom-design.md AIChatRoom_产品设想.md
git commit -m "docs: update baseline spec and product doc for iframe embed

- Baseline spec §2.2 rewritten (was 'why not iframe', now 'iframe embed')
- Baseline spec §2.7 adds declarativeNetRequest permission
- Baseline spec §2.1 / §4 F10 reference chat.html
- Product doc §3.2 / §4.4 / §7.3 document new architecture"
```

---

## Task 13: MANUAL_VERIFICATION 加新项 + 跑全套

**Files:**
- Modify: `docs/MANUAL_VERIFICATION.md`

- [ ] **Step 1: 加新章节 "Chat 页面 + iframe 嵌入"**

在文件末尾加:

```markdown
## Chat 页面 + iframe 嵌入(v1.1 改造)

### 加载与打开

- [ ] `npm run build` 成功生成 `dist/`,**且 dist 中无 popup 文件**
- [ ] chrome://extensions 加载 `dist/`,扩展出现
- [ ] 浏览器打开 `https://chatgpt.com/` 并登录
- [ ] 浏览器打开 `https://gemini.google.com/` 并登录
- [ ] 点工具栏的 AIChatRoom 图标
- [ ] 弹出一个新 tab 到 `chrome-extension://.../src/chat/chat.html`(不是 popup)
- [ ] 页面全屏,暗色主题
- [ ] 顶部状态条显示 "ChatGPT: 已打开"(绿点) 和 "Gemini: 已打开"(绿点)
- [ ] 两个 iframe 内分别加载了 ChatGPT 和 Gemini 官方页面,登录态保留

### DNR 规则启停

- [ ] 在扩展 service worker 控制台跑 `chrome.declarativeNetRequest.getDynamicRules()`,返回 2 条规则
- [ ] 关闭 chat tab,再跑同一命令,返回 `[]`

### 双栏 + 拖拽

- [ ] 拖动中间分隔条,左右 iframe 宽度变化

### 发送流程

- [ ] 在底部输入框输入 "你好",点 ↑ 发送
- [ ] 两个 iframe 内都出现用户消息,AI 开始流式回答
- [ ] 顶部状态点状态实时变化

### 图片(回退 imageDataUrl 流程)

- [ ] 复制一张图片到剪贴板,在 textarea 按 Ctrl+V
- [ ] "图片" 按钮变 "图片 ✓"
- [ ] 点发送,两个 iframe 内的 AI 页面输入框收到图片
```

- [ ] **Step 2: 跑全量验证**

Run:
```bash
npm run typecheck && npm test && npm run build
```

Expected: 0 errors,所有 unit test 绿,build 成功

- [ ] **Step 3: 用户跑 MANUAL_VERIFICATION 全套清单(本文件 + 上面新增)**

Expected: 所有勾打上,验证 v1.1 改造达成

- [ ] **Step 4: 提交(仅文档) + 打 tag**

```bash
git add docs/MANUAL_VERIFICATION.md
git commit -m "docs(verification): add chat-page + iframe manual checklist"
git tag v0.2.0
```

---

## 自审(写完后扫一遍)

- [x] **Spec 覆盖**:
  - §1 概述:在 Task 9 验证
  - §2 改动范围:
    - dnr-rules.ts → Task 1-2
    - chat.html/css/ts → Task 4-5
    - manifest + SW → Task 3, 6-7
    - 删除 popup → Task 11
    - image-handler 回退 → Task 10
    - vite.config → Task 8
    - 文档更新 → Task 12-13
  - §3.1 架构:分散在 Task 4-7
  - §3.2 DNR 规则:Task 1-2
  - §3.3 chat.html:Task 4
  - §3.4 状态栏修复:Task 5 (refreshAllStatuses) + Task 6 (broadcastTabStatus)
  - §3.5 image-handler:Task 10
  - §3.6 manifest:Task 3, 11
  - §4 风险:通过 E2E / 手动验证(Task 9, 13)间接覆盖
  - §5 测试:Task 1-2 单测 + Task 9 E2E + Task 13 手动
  - §6 不做范围:本计划不涉及
  - §7 实施顺序:本计划 13 task 与 §7 的 14 步基本对应(第 1 步拆成 Task 1-2,第 6-7 步合并成 Task 6)

- [x] **Placeholder scan**: 0 个 TBD/TODO/稍后

- [x] **类型一致**:
  - `enableEmbedRules` / `disableEmbedRules` 在 dnr-rules.ts,SW 调用,chat.ts 通过 SW 间接触发
  - `check-tab-exists` 在 chat.ts 调用,SW 处理
  - `tab-status-changed` 在 SW 推,chat.ts 监听
  - `OFFICIAL_URLS` 在 chat.ts 定义,OFFICIAL_URL_PATTERNS 在 SW 定义(用 `https://...` 格式),保持一致
  - `PLATFORMS` 数组在 chat.ts 和 SW 都有定义(两边都 import 同一个 `'../types'` 的 AIPlatform 联合类型)
