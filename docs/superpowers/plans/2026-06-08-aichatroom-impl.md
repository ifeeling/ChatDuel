# AIChatRoom v1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 AIChatRoom v1 — Chrome MV3 扩展，对照 ChatGPT + Gemini 两个 AI 的回答。

**Architecture:**
- Manifest V3 扩展（Popup + Background SW + Content Scripts；v1 仅 Popup，Side Panel 在 v1.1+ scope）
- AIAdapter 抽象层隔离 ChatGPT / Gemini 的 DOM 操作
- DOM 选择器集中到 `selectors.json`（带 version + lastVerified）
- 状态分两路：`storage.session`（10MB 运行态）+ `storage.local`（无上限，需 `unlimitedStorage` 权限，存完整 Session）
- MutationObserver 走"虚拟信号 + 节流渲染"模式
- 关键工程约束：先做风险最高的 Gemini PoC，再做 UI；TDD 优先；每步可测

**Tech Stack:**
- TypeScript（strict）
- Vite + `@crxjs/vite-plugin`（MV3 扩展构建）
- Vitest（单元测试）
- Playwright（E2E / PoC）
- `diff-match-patch`（字符串 diff，§5.3.1）
- 没有 UI 框架（vanilla TS + DOM API）

**Spec 参考：** `docs/superpowers/specs/2026-06-08-aichatroom-design.md`

---

## 文件结构（最终态）

```
AIChatRoom/
├── manifest.json
├── package.json
├── tsconfig.json
├── vite.config.ts
├── .gitignore
├── README.md
├── src/
│   ├── background/
│   │   └── service-worker.ts
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.ts
│   │   └── popup.css
│   ├── options/
│   │   ├── options.html
│   │   ├── options.ts
│   │   └── options.css
│   ├── adapters/
│   │   ├── base.ts                      # AIAdapter 接口
│   │   ├── chatgpt/
│   │   │   ├── adapter.ts               # ChatGPT 实现
│   │   │   └── selectors.json
│   │   └── gemini/
│   │       ├── adapter.ts               # Gemini 实现
│   │       └── selectors.json
│   ├── content-scripts/
│   │   ├── chatgpt-content.ts           # 注入 chatgpt.com
│   │   └── gemini-content.ts            # 注入 gemini.google.com
│   ├── lib/
│   │   ├── diff.ts                      # 字符串 diff（diff-match-patch 封装）
│   │   ├── stats.ts                     # 字数 / 耗时 / TTFT
│   │   ├── at-parser.ts                 # 解析 @AI 名称
│   │   ├── prompt-template.ts           # 提示词模板渲染
│   │   ├── image-handler.ts             # DataTransfer + clipboard + download
│   │   └── session-store.ts             # Session 写入 / 淘汰
│   ├── types/
│   │   └── index.ts                     # Session, AIAdapter 等共享类型
│   └── shared/
│       └── messages.ts                  # chrome.runtime 消息类型
├── tests/
│   ├── unit/
│   │   ├── diff.test.ts
│   │   ├── stats.test.ts
│   │   ├── at-parser.test.ts
│   │   ├── prompt-template.test.ts
│   │   └── session-store.test.ts
│   └── e2e/
│       ├── chatgpt-mock.html            # mock 页面（用于 PoC 和 E2E）
│       ├── gemini-mock.html
│       ├── chatgpt-poc.spec.ts
│       └── gemini-poc.spec.ts
└── docs/
    └── superpowers/
        ├── specs/2026-06-08-aichatroom-design.md
        └── plans/2026-06-08-aichatroom-impl.md
```

---

## Task 总览

| # | Task | 关键产出 | 估时 |
|---|------|---------|------|
| 0 | 项目脚手架 | manifest, package.json, vite, tsconfig, git init | 短 |
| 1 | 类型定义 | `types/index.ts`, `shared/messages.ts` | 短 |
| 2 | AIAdapter 接口 | `adapters/base.ts` | 短 |
| 3 | 存储层 | `lib/session-store.ts` | 短 |
| 4 | lib 模块（diff/stats/at-parser/prompt-template） | 4 个单测 | 中 |
| 5 | image-handler | `lib/image-handler.ts` | 中 |
| 6 | selectors.json 范式 | 2 个 JSON + JSON schema | 短 |
| 7 | ChatGPT adapter | `adapters/chatgpt/adapter.ts` | 中 |
| 8 | Gemini adapter | `adapters/gemini/adapter.ts` | 中 |
| 9 | ChatGPT content script | `content-scripts/chatgpt-content.ts` | 中 |
| 10 | Gemini content script | `content-scripts/gemini-content.ts` | 中 |
| 11 | Background SW | `background/service-worker.ts` | 中 |
| 12 | Popup 基础布局 | popup.html / popup.ts / popup.css（双栏 + 输入框） | 中 |
| 13 | 发送 + 状态机 | queued/sending/streaming/finished 状态 | 中 |
| 14 | 双方答完视觉提示 | F4 | 短 |
| 15 | 发送占位气泡 | F16 | 短 |
| 16 | @ 选择性发送 | F3 | 中 |
| 17 | 回答统计展示 | F11（统计部分） | 短 |
| 18 | 图片输入 + 兜底 | F14 | 中 |
| 19 | 引用上一轮 | F12 | 短 |
| 20 | 左传右 / 右传左 | F2 + F5 + F8 | 中 |
| 21 | 一键对比总结 | F6 | 短 |
| 22 | 字符串 diff 展示 | F11（diff 部分） | 中 |
| 23 | 键盘快捷键 | F13 | 短 |
| 24 | 本地保存 + 历史查看 | F7 | 中 |
| 25 | 设置页 | F9 | 短 |
| 26 | 错误处理补全 | 限流 / 继续生成 / SW 休眠 | 中 |
| 27 | 端到端验收 | 跑 §10.4 全部清单 | 长 |

---

## 关键原则

1. **每步可独立测试** — 不在没测过的状态下叠加新功能。
2. **TDD** — lib 纯函数模块必须先写失败测试再写实现。
3. **风险前置** — Task 7/8/9/10 必须在主 UI 之前跑通。
4. **频繁提交** — 每个 task 至少 1 次 commit。
5. **adapter 隔离** — 业务代码永远不直接接触 DOM 平台细节，全部走 `AIAdapter` 接口。

---

## Task 0: 项目脚手架

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `.gitignore`
- Create: `manifest.json`
- Create: `README.md`

- [ ] **Step 1: 初始化 git 仓库**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
git init
git config user.name "AIChatRoom Dev"
git config user.email "dev@aichatroom.local"
```

- [ ] **Step 2: 创建 .gitignore**

写入 `/.gitignore`：

```gitignore
node_modules/
dist/
*.log
.DS_Store
.vscode/
coverage/
playwright-report/
test-results/
```

- [ ] **Step 3: 创建 package.json**

写入 `/package.json`：

```json
{
  "name": "aichatroom",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "typecheck": "tsc --noEmit",
    "lint": "tsc --noEmit"
  },
  "devDependencies": {
    "@crxjs/vite-plugin": "^2.0.0",
    "@playwright/test": "^1.40.0",
    "@types/chrome": "^0.0.268",
    "@types/diff-match-patch": "^1.0.36",
    "typescript": "^5.4.0",
    "vite": "^5.2.0",
    "vitest": "^1.4.0"
  },
  "dependencies": {
    "diff-match-patch": "^1.0.5"
  }
}
```

- [ ] **Step 4: 创建 tsconfig.json**

写入 `/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["chrome", "vitest/globals"]
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 5: 创建 vite.config.ts**

写入 `/vite.config.ts`：

```ts
import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import { resolve } from 'path'
import manifest from './manifest.json' with { type: 'json' }

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, 'src/popup/popup.html'),
        options: resolve(import.meta.dirname, 'src/options/options.html'),
        'service-worker': resolve(import.meta.dirname, 'src/background/service-worker.ts'),
        'content-chatgpt': resolve(import.meta.dirname, 'src/content-scripts/chatgpt-content.ts'),
        'content-gemini': resolve(import.meta.dirname, 'src/content-scripts/gemini-content.ts'),
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
  },
})
```

- [ ] **Step 6: 创建 manifest.json**

写入 `/manifest.json`（与 §2.7 一致）：

```json
{
  "manifest_version": 3,
  "name": "AIChatRoom",
  "version": "0.1.0",
  "description": "Multi-AI comparison and transfer tool. No API keys, no data collection.",
  "action": {
    "default_popup": "src/popup/popup.html",
    "default_title": "AIChatRoom"
  },
  "background": {
    "service_worker": "src/background/service-worker.ts",
    "type": "module"
  },
  "permissions": [
    "storage",
    "unlimitedStorage",
    "tabs",
    "scripting"
  ],
  "host_permissions": [
    "https://chatgpt.com/*",
    "https://gemini.google.com/*"
  ],
  "content_scripts": [
    {
      "matches": ["https://chatgpt.com/*"],
      "js": ["src/content-scripts/chatgpt-content.ts"],
      "run_at": "document_idle"
    },
    {
      "matches": ["https://gemini.google.com/*"],
      "js": ["src/content-scripts/gemini-content.ts"],
      "run_at": "document_idle"
    }
  ],
  "options_page": "src/options/options.html",
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  }
}
```

- [ ] **Step 7: 安装依赖**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm install
```

预期：依赖安装成功，`node_modules/` 创建，`package-lock.json` 生成。

- [ ] **Step 8: 创建 README.md**

写入 `/README.md`：

```markdown
# AIChatRoom

Chrome 扩展，对照 ChatGPT + Gemini 两个 AI 的回答。

## 开发

```bash
npm install
npm run dev      # 启动 vite dev server，载入 dist/ 到 chrome://extensions
npm test         # 单元测试
npm run test:e2e # E2E 测试
npm run typecheck
```

## 加载到 Chrome

1. `npm run build`
2. 打开 `chrome://extensions`
3. 打开"开发者模式"
4. 点击"加载已解压的扩展"，选择 `dist/` 目录

## 文档

- 设计文档：`docs/superpowers/specs/2026-06-08-aichatroom-design.md`
- 实施计划：`docs/superpowers/plans/2026-06-08-aichatroom-impl.md`
```

- [ ] **Step 9: 验证脚手架**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm run typecheck
```

预期：成功（无错误，src/ 是空的）。

- [ ] **Step 10: 提交**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
git add -A
git commit -m "chore: bootstrap project scaffold (Vite + CRX + TS)"
```

---

## Task 1: 类型定义

**Files:**
- Create: `src/types/index.ts`
- Create: `src/shared/messages.ts`
- Test: `tests/unit/types.test.ts`（手测编译通过即可）

- [ ] **Step 1: 写 Session / StreamEvent 等类型**

写入 `src/types/index.ts`（与 §4.1 Session 定义一致）：

```ts
export type AIPlatform = 'chatgpt' | 'gemini'

export type StreamStatus =
  | 'idle'
  | 'queued'
  | 'sending'
  | 'streaming'
  | 'paused'
  | 'finished'
  | 'error'

export interface SessionFollowUp {
  from: 'user' | 'chatgpt' | 'gemini'
  to: 'chatgpt' | 'gemini'
  text: string
  timestamp: number
}

export interface SessionStats {
  wordCount: { chatgpt?: number; gemini?: number }
  durationMs: { chatgpt?: number; gemini?: number }
  ttftMs: { chatgpt?: number; gemini?: number }
}

export interface Session {
  id: string
  createdAt: number
  prompt: string
  responses: { chatgpt?: string; gemini?: string }
  followUps: SessionFollowUp[]
  summary?: string
  stats?: SessionStats
}

export type StreamEvent =
  | { type: 'started'; platform: AIPlatform; timestamp: number }
  | { type: 'token'; platform: AIPlatform; text: string; timestamp: number }
  | { type: 'paused'; platform: AIPlatform; timestamp: number }
  | { type: 'finished'; platform: AIPlatform; text: string; timestamp: number }
  | { type: 'error'; platform: AIPlatform; message: string; timestamp: number }
  | { type: 'rate-limit'; platform: AIPlatform; timestamp: number }

export interface ConversationState {
  status: StreamStatus
  lastResponse?: string
  errorMessage?: string
}
```

- [ ] **Step 2: 写 chrome.runtime 消息类型**

写入 `src/shared/messages.ts`：

```ts
import type { AIPlatform, ConversationState, StreamEvent } from '../types'

export type PopupToSw =
  | { type: 'send-message'; platforms: AIPlatform[]; text: string; imageDataUrl?: string }
  | { type: 'transfer'; from: AIPlatform; to: AIPlatform; promptTemplateId: string }
  | { type: 'get-conversation-state'; platform: AIPlatform }
  | { type: 'quote-last'; from: AIPlatform }
  | { type: 'request-summary'; target: AIPlatform }

export type SwToContent =
  | { type: 'write-and-send'; text: string; imageDataUrl?: string }
  | { type: 'get-state' }
  | { type: 'get-last-response' }

export type ContentToSw =
  | { type: 'state'; platform: AIPlatform; state: ConversationState }
  | { type: 'stream-event'; event: StreamEvent }
  | { type: 'last-response'; text: string }

export type SwToPopup =
  | { type: 'state-update'; platform: AIPlatform; state: ConversationState }
  | { type: 'stream-event'; event: StreamEvent }
  | { type: 'last-response'; platform: AIPlatform; text: string }
  | { type: 'error'; platform: AIPlatform; message: string }
```

- [ ] **Step 3: 验证类型编译**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm run typecheck
```

预期：通过。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "feat(types): add Session, StreamEvent, message types"
```

---

## Task 2: AIAdapter 接口

**Files:**
- Create: `src/adapters/base.ts`
- Test: `tests/unit/adapter-base.test.ts`

- [ ] **Step 1: 写失败测试**

写入 `tests/unit/adapter-base.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import type { AIAdapter } from '../../src/adapters/base'

describe('AIAdapter interface', () => {
  it('can be implemented with all required methods', () => {
    const adapter: AIAdapter = {
      platform: 'chatgpt',
      isLoggedIn: async () => true,
      writeText: async () => {},
      triggerSend: async () => {},
      sendMessage: async () => {},
      getLastResponse: async () => '',
      getConversationState: async () => ({ status: 'idle' }),
      onStreamEvent: () => () => {},
      detectRateLimit: async () => false,
    }
    expect(adapter.platform).toBe('chatgpt')
  })
})
```

- [ ] **Step 2: 写 AIAdapter 接口**

写入 `src/adapters/base.ts`：

```ts
import type { ConversationState, StreamEvent } from '../types'

export interface AIAdapter {
  readonly platform: 'chatgpt' | 'gemini'

  isLoggedIn(): Promise<boolean>
  writeText(text: string): Promise<void>
  triggerSend(): Promise<void>
  sendMessage(text: string, image?: File): Promise<void>
  getLastResponse(): Promise<string>
  getConversationState(): Promise<ConversationState>
  onStreamEvent(handler: (event: StreamEvent) => void): () => void
  detectRateLimit(): Promise<boolean>
}
```

- [ ] **Step 3: 跑测试**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm test -- adapter-base
```

预期：PASS。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "feat(adapters): define AIAdapter interface"
```

---

## Task 3: lib/session-store（Session 持久化 + 淘汰）

**Files:**
- Create: `src/lib/session-store.ts`
- Test: `tests/unit/session-store.test.ts`

- [ ] **Step 1: 写失败测试**

写入 `tests/unit/session-store.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { addSession, loadSessions, MAX_SESSIONS, MAX_BYTES } from '../../src/lib/session-store'
import type { Session } from '../../src/types'

const make = (id: string, prompt = 'p'): Session => ({
  id, createdAt: Date.now(), prompt,
  responses: {}, followUps: [],
})

describe('session-store', () => {
  beforeEach(() => {
    // 每次测试前清空 storage
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.clear()
    }
  })

  it('adds a session and reads it back', async () => {
    await addSession(make('s1', 'hello'))
    const all = await loadSessions()
    expect(all.find(s => s.id === 's1')).toBeTruthy()
  })

  it('keeps at most MAX_SESSIONS, evicting oldest', async () => {
    for (let i = 0; i < MAX_SESSIONS + 10; i++) {
      await addSession(make(`s${i}`))
    }
    const all = await loadSessions()
    expect(all.length).toBe(MAX_SESSIONS)
    // 最早的 10 个被淘汰
    expect(all.find(s => s.id === 's0')).toBeUndefined()
    expect(all.find(s => s.id === `s${MAX_SESSIONS + 9}`)).toBeTruthy()
  })

  it('exports numeric limits for documentation', () => {
    expect(MAX_SESSIONS).toBe(500)
    expect(MAX_BYTES).toBe(100 * 1024 * 1024)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm test -- session-store
```

预期：FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

写入 `src/lib/session-store.ts`：

```ts
import type { Session } from '../types'

export const MAX_SESSIONS = 500
export const MAX_BYTES = 100 * 1024 * 1024 // 100MB

const STORAGE_KEY = 'sessions'

async function getRaw(): Promise<Session[]> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  return (result[STORAGE_KEY] as Session[] | undefined) ?? []
}

async function setRaw(sessions: Session[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: sessions })
}

async function evictIfNeeded(sessions: Session[]): Promise<Session[]> {
  // 1. 按条数淘汰
  if (sessions.length > MAX_SESSIONS) {
    sessions.sort((a, b) => a.createdAt - b.createdAt)
    sessions = sessions.slice(sessions.length - MAX_SESSIONS)
  }
  // 2. 按字节数淘汰
  const json = JSON.stringify(sessions)
  if (json.length > MAX_BYTES) {
    sessions.sort((a, b) => a.createdAt - b.createdAt)
    while (sessions.length > 1 && JSON.stringify(sessions).length > MAX_BYTES) {
      sessions.shift()
    }
  }
  return sessions
}

export async function addSession(session: Session): Promise<void> {
  const all = await getRaw()
  all.push(session)
  const trimmed = await evictIfNeeded(all)
  await setRaw(trimmed)
}

export async function loadSessions(): Promise<Session[]> {
  return getRaw()
}

export async function getSession(id: string): Promise<Session | undefined> {
  const all = await getRaw()
  return all.find(s => s.id === id)
}

export async function deleteSession(id: string): Promise<void> {
  const all = await getRaw()
  await setRaw(all.filter(s => s.id !== id))
}
```

- [ ] **Step 4: 跑测试**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm test -- session-store
```

预期：PASS（vitest jsdom 环境会提供 `chrome.storage.local` 的 shim；如未提供，先在测试 setup 中 mock）。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(lib): session-store with 500/100MB eviction"
```

---

## Task 4: lib/diff（字符串 diff，diff-match-patch 封装）

**Files:**
- Create: `src/lib/diff.ts`
- Test: `tests/unit/diff.test.ts`

- [ ] **Step 1: 安装类型**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm install --save-dev @types/diff-match-patch
```

（注：已在 Task 0 的 package.json 声明）

- [ ] **Step 2: 写失败测试**

写入 `tests/unit/diff.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { diffResponses, type DiffChunk } from '../../src/lib/diff'

describe('diffResponses', () => {
  it('returns single equal chunk for identical input', () => {
    const chunks: DiffChunk[] = diffResponses('hello', 'hello')
    expect(chunks.every(c => c.type === 'equal')).toBe(true)
  })

  it('marks only-A content as added-on-A and corresponding gap on B', () => {
    const a = 'cats are great'
    const b = 'dogs are great'
    const chunks = diffResponses(a, b)
    const types = chunks.map(c => c.type).sort()
    expect(types).toContain('added-on-a')
    expect(types).toContain('added-on-b')
  })

  it('handles empty input', () => {
    const chunks = diffResponses('', 'something')
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('chunks have a, b, and type fields', () => {
    const chunks = diffResponses('abc', 'abd')
    for (const c of chunks) {
      expect(c).toHaveProperty('type')
      expect(c).toHaveProperty('a')
      expect(c).toHaveProperty('b')
    }
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm test -- diff
```

预期：FAIL。

- [ ] **Step 4: 写实现**

写入 `src/lib/diff.ts`：

```ts
import DiffMatchPatch from 'diff-match-patch'

export type DiffChunkType =
  | 'equal'
  | 'added-on-a'
  | 'added-on-b'

export interface DiffChunk {
  type: DiffChunkType
  a: string
  b: string
}

const dmp = new DiffMatchPatch()

/**
 * 对两段文本做字符串级 diff（不做语义判断）。
 * 段落 / 句子级拆分：先按双换行拆段，每段内再按句号 / 问号 / 感叹号 / 单换行拆句。
 * 拆出来的每个 chunk 单独跑 diff，最后拼回。
 */
export function diffResponses(a: string, b: string): DiffChunk[] {
  const aChunks = splitIntoChunks(a)
  const bChunks = splitIntoChunks(b)
  const result: DiffChunk[] = []

  // 简单策略：按位置对齐 chunk 列表（不同长度的部分在尾部处理）
  const max = Math.max(aChunks.length, bChunks.length)
  for (let i = 0; i < max; i++) {
    const ac = aChunks[i] ?? ''
    const bc = bChunks[i] ?? ''

    if (ac === bc) {
      result.push({ type: 'equal', a: ac, b: bc })
    } else {
      // 内部用 diff-match-patch 做精细 diff
      const diffs = dmp.diff_main(ac, bc)
      dmp.diff_cleanupSemantic(diffs)
      // 把 DIFF_INSERT（只在 b）合并成 added-on-b，DIFF_DELETE（只在 a）合并成 added-on-a
      for (const [op, text] of diffs) {
        if (op === 0) {
          result.push({ type: 'equal', a: text, b: text })
        } else if (op === -1) {
          result.push({ type: 'added-on-a', a: text, b: '' })
        } else if (op === 1) {
          result.push({ type: 'added-on-b', a: '', b: text })
        }
      }
    }
  }
  return result
}

function splitIntoChunks(text: string): string[] {
  if (!text) return []
  // 先按段，再按句
  return text
    .split(/\n{2,}/)
    .flatMap(p => p.split(/(?<=[.!?。！？\n])\s*/))
    .map(s => s.trim())
    .filter(s => s.length > 0)
}
```

- [ ] **Step 5: 跑测试**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm test -- diff
```

预期：PASS。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(lib): string diff via diff-match-patch"
```

---

## Task 5: lib/stats（字数 / 耗时 / TTFT）

**Files:**
- Create: `src/lib/stats.ts`
- Test: `tests/unit/stats.test.ts`

- [ ] **Step 1: 写失败测试**

写入 `tests/unit/stats.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { countWords, durationMs, ttftMs } from '../../src/lib/stats'

describe('countWords', () => {
  it('counts Chinese characters as 1 each', () => {
    expect(countWords('你好世界')).toBe(4)
  })
  it('counts English words by whitespace', () => {
    expect(countWords('hello world foo')).toBe(3)
  })
  it('handles mixed text', () => {
    expect(countWords('你好 world')).toBe(2)
  })
  it('returns 0 for empty', () => {
    expect(countWords('')).toBe(0)
  })
})

describe('durationMs', () => {
  it('returns positive duration', () => {
    const start = Date.now() - 1000
    expect(durationMs(start)).toBeGreaterThanOrEqual(1000)
  })
})

describe('ttftMs', () => {
  it('subtracts timestamps', () => {
    expect(ttftMs(1000, 1500)).toBe(500)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm test -- stats
```

预期：FAIL。

- [ ] **Step 3: 写实现**

写入 `src/lib/stats.ts`：

```ts
/**
 * 字数统计：中文每个字符算 1，英文按空白分词。
 * 混合文本：剥离中文后按英文分词，词数 + 中文字符数。
 */
export function countWords(text: string): number {
  if (!text) return 0
  // 把连续中文字符作为一个整体
  const cjkMatches = text.match(/[\u4e00-\u9fff]/g) ?? []
  const cjkCount = cjkMatches.length
  // 去掉中文字符后按空白分词
  const nonCjk = text.replace(/[\u4e00-\u9fff]/g, ' ')
  const words = nonCjk.split(/\s+/).filter(w => w.length > 0)
  return cjkCount + words.length
}

export function durationMs(startTimestamp: number, endTimestamp: number = Date.now()): number {
  return Math.max(0, endTimestamp - startTimestamp)
}

export function ttftMs(sendTimestamp: number, firstTokenTimestamp: number): number {
  return Math.max(0, firstTokenTimestamp - sendTimestamp)
}
```

- [ ] **Step 4: 跑测试**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm test -- stats
```

预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(lib): stats module (word count, duration, TTFT)"
```

---

## Task 6: lib/at-parser（@AI 名称解析）

**Files:**
- Create: `src/lib/at-parser.ts`
- Test: `tests/unit/at-parser.test.ts`

- [ ] **Step 1: 写失败测试**

写入 `tests/unit/at-parser.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { parseAtMentions } from '../../src/lib/at-parser'

describe('parseAtMentions', () => {
  it('returns empty array when no @', () => {
    expect(parseAtMentions('hello world')).toEqual([])
  })
  it('extracts single @AI', () => {
    expect(parseAtMentions('@chatgpt 你好')).toEqual(['chatgpt'])
  })
  it('extracts multiple @AI', () => {
    const r = parseAtMentions('@chatgpt @gemini 你好')
    expect(r.sort()).toEqual(['chatgpt', 'gemini'])
  })
  it('dedupes repeated mentions', () => {
    const r = parseAtMentions('@chatgpt @chatgpt hi')
    expect(r).toEqual(['chatgpt'])
  })
  it('strips @ prefix from output', () => {
    expect(parseAtMentions('@ChatGPT')).toEqual(['ChatGPT'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm test -- at-parser
```

预期：FAIL。

- [ ] **Step 3: 写实现**

写入 `src/lib/at-parser.ts`：

```ts
const AT_RE = /@([A-Za-z][\w-]*)/g

/**
 * 解析文本中所有 @AI 提及（去重，保持首次出现顺序）。
 * 不区分大小写归一化输出（小写）。
 */
export function parseAtMentions(text: string): string[] {
  if (!text) return []
  const seen = new Set<string>()
  const result: string[] = []
  let m: RegExpExecArray | null
  AT_RE.lastIndex = 0
  while ((m = AT_RE.exec(text)) !== null) {
    const name = m[1]
    const key = name.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      result.push(key)
    }
  }
  return result
}
```

- [ ] **Step 4: 跑测试**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm test -- at-parser
```

预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(lib): @AI mention parser"
```

---

## Task 7: lib/prompt-template（提示词模板渲染）

**Files:**
- Create: `src/lib/prompt-template.ts`
- Test: `tests/unit/prompt-template.test.ts`

- [ ] **Step 1: 写失败测试**

写入 `tests/unit/prompt-template.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { renderTemplate, getDefaultTemplates } from '../../src/lib/prompt-template'

describe('renderTemplate', () => {
  it('substitutes {{var}} placeholders', () => {
    const tpl = 'Hello {{name}}, you are {{role}}'
    expect(renderTemplate(tpl, { name: 'Gemini', role: 'reviewer' }))
      .toBe('Hello Gemini, you are reviewer')
  })
  it('leaves unknown placeholders intact', () => {
    expect(renderTemplate('hi {{name}}', {})).toBe('hi {{name}}')
  })
  it('handles missing variables gracefully', () => {
    expect(renderTemplate('{{a}} {{b}}', { a: 'x' })).toBe('x {{b}}')
  })
})

describe('getDefaultTemplates', () => {
  it('returns at least review and summary templates', () => {
    const t = getDefaultTemplates()
    expect(t.review).toBeTruthy()
    expect(t.summary).toBeTruthy()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm test -- prompt-template
```

预期：FAIL。

- [ ] **Step 3: 写实现**

写入 `src/lib/prompt-template.ts`：

```ts
export interface PromptTemplates {
  review: string
  summary: string
  rebut: string
  simplify: string
}

export function getDefaultTemplates(): PromptTemplates {
  return {
    review: `下面是另一个 AI 的回答，请你帮我审查：

1. 哪些地方可能是错的？
2. 哪些地方说得太笼统？
3. 有没有遗漏？
4. 请给出你认为更准确的版本。

以下是对方的回答：

{{response}}`,
    summary: `请总结下面两个 AI 的回答差异：

【AI A 的回答】
{{responseA}}

【AI B 的回答】
{{responseB}}

输出结构：
1. 两边共同认可的结论
2. 两边说法不同的地方
3. 哪些内容需要进一步确认
4. 最后更建议采用哪种方案`,
    rebut: `请以最强反驳姿态针对下面这段 AI 回答提出质疑，找出逻辑漏洞、事实错误和遗漏：

{{response}}`,
    simplify: `请用更简单、更口语化的话重写下面这段 AI 回答，让普通人也能听懂：

{{response}}`,
  }
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const v = vars[key]
    return v !== undefined ? v : match
  })
}
```

- [ ] **Step 4: 跑测试**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm test -- prompt-template
```

预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(lib): prompt template render + defaults"
```

---

## Task 8: lib/image-handler（DataTransfer 模拟 + 兜底）

**Files:**
- Create: `src/lib/image-handler.ts`
- Test: `tests/unit/image-handler.test.ts`

- [ ] **Step 1: 写失败测试**

写入 `tests/unit/image-handler.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { buildDataTransferFromFile, MAX_IMAGE_BYTES } from '../../src/lib/image-handler'

describe('buildDataTransferFromFile', () => {
  it('creates a DataTransfer with files', () => {
    const file = new File(['hello'], 'test.png', { type: 'image/png' })
    const dt = buildDataTransferFromFile(file)
    expect(dt.files.length).toBe(1)
    expect(dt.files[0].name).toBe('test.png')
  })

  it('throws when file is too large', () => {
    // 构造一个 21MB 的假文件
    const big = new File([new Uint8Array(21 * 1024 * 1024)], 'big.png', { type: 'image/png' })
    expect(() => buildDataTransferFromFile(big)).toThrow(/too large/i)
  })
})

describe('MAX_IMAGE_BYTES', () => {
  it('is 20MB', () => {
    expect(MAX_IMAGE_BYTES).toBe(20 * 1024 * 1024)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm test -- image-handler
```

预期：FAIL。

- [ ] **Step 3: 写实现**

写入 `src/lib/image-handler.ts`：

```ts
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024 // 20MB

export class ImageTooLargeError extends Error {
  constructor(size: number) {
    super(`Image too large: ${size} bytes (max ${MAX_IMAGE_BYTES})`)
    this.name = 'ImageTooLargeError'
  }
}

/**
 * 把 File 包成 DataTransfer 对象。
 * 注意：浏览器原生 DataTransfer 构造在某些环境下不可用，我们做 polyfill。
 */
export function buildDataTransferFromFile(file: File): DataTransfer {
  if (file.size > MAX_IMAGE_BYTES) {
    throw new ImageTooLargeError(file.size)
  }
  const dt = new DataTransfer()
  dt.items.add(file)
  return dt
}

/**
 * 在目标元素上派发一个 paste / drop 事件，附带构造的 DataTransfer。
 * 某些 React 应用会读 window.event.clipboardData，必要时用 defineProperty 挂上去。
 */
export function dispatchPaste(target: HTMLElement, dt: DataTransfer, eventType: 'paste' | 'drop' = 'paste'): void {
  const event = new ClipboardEvent(eventType, {
    clipboardData: dt,
    bubbles: true,
    cancelable: true,
  })
  // 兜底：把 DataTransfer 挂到 window.event（某些 React 版本会读这里）
  try {
    Object.defineProperty(event, 'clipboardData', { value: dt, configurable: true })
  } catch {
    // 忽略：某些环境 ClipboardEvent 的 clipboardData 是只读
  }
  target.dispatchEvent(event)
}

/**
 * 尝试把图片复制到剪贴板。返回 Promise<boolean>，失败时返回 false。
 * 注意：必须在用户交互上下文中调用，且浏览器 / 权限允许。
 */
export async function tryCopyImageToClipboard(file: File): Promise<boolean> {
  try {
    if (!navigator.clipboard || !('write' in navigator.clipboard)) return false
    // @ts-ignore - ClipboardItem 在部分 lib.dom 版本里没定义
    await navigator.clipboard.write([new ClipboardItem({ [file.type]: file })])
    return true
  } catch {
    return false
  }
}

/**
 * 把图片下载到本地（兜底 C）。
 */
export function downloadImage(file: File, filename?: string): void {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = filename ?? file.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
```

- [ ] **Step 4: 跑测试**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm test -- image-handler
```

预期：PASS（jsdom 对 DataTransfer 支持有限，可能需要在测试 setup 里 mock 一下；如果失败，给 DataTransfer 加最小 mock）。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(lib): image handler with DataTransfer + clipboard + download fallback"
```

---

## Task 9: selectors.json 范式

**Files:**
- Create: `src/adapters/chatgpt/selectors.json`
- Create: `src/adapters/gemini/selectors.json`
- Test: `tests/unit/selectors-schema.test.ts`

- [ ] **Step 1: 写失败测试**

写入 `tests/unit/selectors-schema.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import chatgpt from '../../src/adapters/chatgpt/selectors.json'
import gemini from '../../src/adapters/gemini/selectors.json'

interface SelectorFile {
  version: string
  lastVerified: string
  selectors: Record<string, string>
}

function check(file: SelectorFile, name: string) {
  expect(file.version, `${name}.version`).toMatch(/^\d{4}\.\d{2}(\.\d+)?$/)
  expect(file.lastVerified, `${name}.lastVerified`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(file.selectors.inputBox, `${name}.selectors.inputBox`).toBeTruthy()
  expect(file.selectors.sendButton, `${name}.selectors.sendButton`).toBeTruthy()
  expect(file.selectors.messageContainer, `${name}.selectors.messageContainer`).toBeTruthy()
  expect(file.selectors.lastResponse, `${name}.selectors.lastResponse`).toBeTruthy()
}

describe('selectors.json schema', () => {
  it('chatgpt selectors.json has required fields', () => check(chatgpt as SelectorFile, 'chatgpt'))
  it('gemini selectors.json has required fields', () => check(gemini as SelectorFile, 'gemini'))
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm test -- selectors-schema
```

预期：FAIL（JSON 不存在）。

- [ ] **Step 3: 写 ChatGPT selectors.json**

写入 `src/adapters/chatgpt/selectors.json`（**注：以下选择器基于 2026-06 真实 ChatGPT 页面结构观察；实施时需在 Playwright 中实际打开 chatgpt.com 验证；如有失效，按 §2.6 流程更新本文件并小幅 bump version）：

```json
{
  "version": "2026.06",
  "lastVerified": "2026-06-08",
  "selectors": {
    "inputBox": "#prompt-textarea",
    "sendButton": "button[data-testid='send-button']",
    "messageContainer": "[data-testid='conversation-turn']",
    "lastResponse": "[data-testid='conversation-turn']:last-of-type .markdown",
    "userMessage": "[data-testid='conversation-turn'][data-turn='user']",
    "rateLimitToast": "[role='alert']",
    "continueButton": "button[data-testid='continue-generation-button']",
    "loggedIn": "[data-testid='user-menu-button']"
  }
}
```

- [ ] **Step 4: 写 Gemini selectors.json**

写入 `src/adapters/gemini/selectors.json`（**注：Gemini DOM 嵌套更深，可能需要 PoC 后调整**）：

```json
{
  "version": "2026.06",
  "lastVerified": "2026-06-08",
  "selectors": {
    "inputBox": "div.ql-editor[contenteditable='true']",
    "sendButton": "button[aria-label*='Send' i]",
    "messageContainer": "message-content, [data-test-id='conversation-turn']",
    "lastResponse": "message-content:last-of-type model-response",
    "userMessage": "user-message",
    "rateLimitToast": "[role='alert']",
    "continueButton": "button[aria-label*='Continue' i]",
    "loggedIn": "[aria-label*='Google Account' i], img[alt*='avatar' i]"
  }
}
```

- [ ] **Step 5: 跑测试**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm test -- selectors-schema
```

预期：PASS。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(adapters): selectors.json for ChatGPT and Gemini"
```

---

## Task 10: ChatGPT adapter 实现

**Files:**
- Create: `src/adapters/chatgpt/adapter.ts`
- Test: `tests/e2e/chatgpt-poc.spec.ts`
- Create: `tests/e2e/chatgpt-mock.html`

- [ ] **Step 1: 创建 ChatGPT mock 页面（用于 PoC）**

写入 `tests/e2e/chatgpt-mock.html`：

```html
<!DOCTYPE html>
<html>
<head><title>Mock ChatGPT</title></head>
<body>
  <div data-testid="conversation-turns">
    <div data-testid="conversation-turn" data-turn="user">Hello</div>
    <div data-testid="conversation-turn" data-turn="assistant">
      <div class="markdown">Mock response 1</div>
    </div>
  </div>
  <div id="prompt-textarea" contenteditable="true"></div>
  <button data-testid="send-button">Send</button>
  <button data-testid="user-menu-button">Menu</button>

  <script>
    let streaming = false
    const sendBtn = document.querySelector("[data-testid='send-button']")
    sendBtn.addEventListener('click', () => {
      const text = document.querySelector('#prompt-textarea').textContent
      if (!text) return
      // 模拟用户消息
      const userDiv = document.createElement('div')
      userDiv.setAttribute('data-testid', 'conversation-turn')
      userDiv.setAttribute('data-turn', 'user')
      userDiv.textContent = text
      document.querySelector("[data-testid='conversation-turns']").appendChild(userDiv)
      document.querySelector('#prompt-textarea').textContent = ''

      // 模拟 AI 响应（流式）
      streaming = true
      const aiDiv = document.createElement('div')
      aiDiv.setAttribute('data-testid', 'conversation-turn')
      aiDiv.setAttribute('data-turn', 'assistant')
      const md = document.createElement('div')
      md.className = 'markdown'
      md.textContent = ''
      aiDiv.appendChild(md)
      document.querySelector("[data-testid='conversation-turns']").appendChild(aiDiv)

      const fullText = `Mock AI response to: ${text}`
      let i = 0
      const interval = setInterval(() => {
        md.textContent = fullText.slice(0, i + 1)
        i++
        if (i >= fullText.length) {
          clearInterval(interval)
          streaming = false
        }
      }, 10)
    })

    window.__getStreaming = () => streaming
  </script>
</body>
</html>
```

- [ ] **Step 2: 写 PoC E2E 测试**

写入 `tests/e2e/chatgpt-poc.spec.ts`：

```ts
import { test, expect } from '@playwright/test'
import path from 'path'

test('ChatGPT adapter can write and read on mock page', async ({ page }) => {
  const url = 'file://' + path.resolve(__dirname, 'chatgpt-mock.html')
  await page.goto(url)

  // 通过 evaluate 直接调用 adapter（开发期 PoC）
  // 实际集成时这一步会被 content script 注入到真实 ChatGPT 页面
  await page.fill('#prompt-textarea', 'hello chatgpt')
  await page.click("[data-testid='send-button']")

  // 等待流式输出完成（每个字符 10ms，最长 2 秒）
  await page.waitForFunction(() => {
    return !window.__getStreaming() && document.querySelector("[data-testid='conversation-turn']:last-child .markdown")?.textContent
  }, { timeout: 3000 })

  const lastText = await page.locator("[data-testid='conversation-turn']:last-child .markdown").textContent()
  expect(lastText).toContain('Mock AI response to: hello chatgpt')
})
```

- [ ] **Step 3: 写 ChatGPT adapter**

写入 `src/adapters/chatgpt/adapter.ts`：

```ts
import type { AIAdapter } from '../base'
import type { ConversationState, StreamEvent } from '../../types'
import selectorsJson from './selectors.json'

const S = selectorsJson.selectors

export function createChatGPTAdapter(): AIAdapter {
  let lastEventHandler: ((e: StreamEvent) => void) | null = null
  let observer: MutationObserver | null = null
  let dirty = false
  let pollTimer: ReturnType<typeof setInterval> | null = null

  function q<T extends Element = Element>(sel: string): T | null {
    return document.querySelector<T>(sel)
  }

  function startObserver() {
    const container = q(S.messageContainer)
    if (!container) return
    observer = new MutationObserver(() => { dirty = true })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    pollTimer = setInterval(() => {
      if (!dirty || !lastEventHandler) return
      dirty = false
      const text = q(S.lastResponse)?.textContent ?? ''
      lastEventHandler({ type: 'token', platform: 'chatgpt', text, timestamp: Date.now() })
      // 简易结束判定：DOM 内容连续 600ms 不再变化
      // 实际实现可更精细
    }, 150)
  }

  return {
    platform: 'chatgpt',

    async isLoggedIn() {
      return !!q(S.loggedIn)
    },

    async writeText(text: string) {
      const box = q<HTMLElement>(S.inputBox)
      if (!box) throw new Error('input box not found')
      box.focus()
      // 对 contenteditable 用 textContent
      if (box.getAttribute('contenteditable') === 'true') {
        box.textContent = text
        box.dispatchEvent(new InputEvent('input', { bubbles: true }))
      } else {
        // 对 textarea
        ;(box as HTMLTextAreaElement).value = text
        box.dispatchEvent(new InputEvent('input', { bubbles: true }))
      }
    },

    async triggerSend() {
      const btn = q<HTMLButtonElement>(S.sendButton)
      if (!btn) throw new Error('send button not found')
      btn.click()
    },

    async sendMessage(text: string) {
      await this.writeText(text)
      await this.triggerSend()
    },

    async getLastResponse() {
      return q(S.lastResponse)?.textContent ?? ''
    },

    async getConversationState(): Promise<ConversationState> {
      const last = await this.getLastResponse()
      if (!last) return { status: 'idle' }
      return { status: 'finished', lastResponse: last }
    },

    onStreamEvent(handler) {
      lastEventHandler = handler
      startObserver()
      return () => {
        observer?.disconnect()
        observer = null
        if (pollTimer) clearInterval(pollTimer)
        pollTimer = null
        lastEventHandler = null
      }
    },

    async detectRateLimit() {
      return !!q(S.rateLimitToast)
    },
  }
}
```

- [ ] **Step 4: 跑 PoC**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npx playwright test tests/e2e/chatgpt-poc.spec.ts
```

预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(adapters): ChatGPT adapter with mock PoC"
```

---

## Task 11: Gemini adapter 实现（风险最高）

**Files:**
- Create: `src/adapters/gemini/adapter.ts`
- Test: `tests/e2e/gemini-poc.spec.ts`
- Create: `tests/e2e/gemini-mock.html`

> **⚠️ 风险最高的环节**：Gemini DOM 嵌套深、类名混淆。如果 mock 页面能跑通，再去真实页面验证。

- [ ] **Step 1: 创建 Gemini mock 页面**

写入 `tests/e2e/gemini-mock.html`：

```html
<!DOCTYPE html>
<html>
<head><title>Mock Gemini</title></head>
<body>
  <user-message>Hello</user-message>
  <message-content>
    <model-response>Mock Gemini response 1</model-response>
  </message-content>

  <div class="ql-editor ql-blank" contenteditable="true" data-placeholder="Enter a prompt here"></div>
  <button aria-label="Send message">Send</button>

  <script>
    let streaming = false
    const sendBtn = document.querySelector("button[aria-label='Send message']")
    sendBtn.addEventListener('click', () => {
      const editor = document.querySelector('.ql-editor')
      const text = editor.textContent
      if (!text) return

      const user = document.createElement('user-message')
      user.textContent = text
      document.body.appendChild(user)
      editor.textContent = ''

      streaming = true
      const content = document.createElement('message-content')
      const resp = document.createElement('model-response')
      resp.textContent = ''
      content.appendChild(resp)
      document.body.appendChild(content)

      const fullText = `Mock Gemini response to: ${text}`
      let i = 0
      const interval = setInterval(() => {
        resp.textContent = fullText.slice(0, i + 1)
        i++
        if (i >= fullText.length) clearInterval(interval), streaming = false
      }, 10)
    })

    window.__getStreaming = () => streaming
  </script>
</body>
</html>
```

- [ ] **Step 2: 写 PoC E2E 测试**

写入 `tests/e2e/gemini-poc.spec.ts`：

```ts
import { test, expect } from '@playwright/test'
import path from 'path'

test('Gemini adapter can write and read on mock page', async ({ page }) => {
  const url = 'file://' + path.resolve(__dirname, 'gemini-mock.html')
  await page.goto(url)

  await page.locator('.ql-editor').fill('hello gemini')
  await page.click("button[aria-label='Send message']")

  await page.waitForFunction(() => {
    return !window.__getStreaming() && document.querySelector('message-content:last-of-type model-response')?.textContent
  }, { timeout: 3000 })

  const lastText = await page.locator('message-content:last-of-type model-response').textContent()
  expect(lastText).toContain('Mock Gemini response to: hello gemini')
})
```

- [ ] **Step 3: 写 Gemini adapter**

写入 `src/adapters/gemini/adapter.ts`：

```ts
import type { AIAdapter } from '../base'
import type { ConversationState, StreamEvent } from '../../types'
import selectorsJson from './selectors.json'

const S = selectorsJson.selectors

export function createGeminiAdapter(): AIAdapter {
  let lastEventHandler: ((e: StreamEvent) => void) | null = null
  let observer: MutationObserver | null = null
  let dirty = false
  let pollTimer: ReturnType<typeof setInterval> | null = null

  function q<T extends Element = Element>(sel: string): T | null {
    return document.querySelector<T>(sel)
  }

  function startObserver() {
    observer = new MutationObserver(() => { dirty = true })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    pollTimer = setInterval(() => {
      if (!dirty || !lastEventHandler) return
      dirty = false
      const text = q(S.lastResponse)?.textContent ?? ''
      lastEventHandler({ type: 'token', platform: 'gemini', text, timestamp: Date.now() })
    }, 150)
  }

  return {
    platform: 'gemini',

    async isLoggedIn() {
      return !!q(S.loggedIn)
    },

    async writeText(text: string) {
      const box = q<HTMLElement>(S.inputBox)
      if (!box) throw new Error('input box not found')
      box.focus()
      box.textContent = text
      box.dispatchEvent(new InputEvent('input', { bubbles: true }))
    },

    async triggerSend() {
      const btn = q<HTMLButtonElement>(S.sendButton)
      if (!btn) throw new Error('send button not found')
      btn.click()
    },

    async sendMessage(text: string) {
      await this.writeText(text)
      await this.triggerSend()
    },

    async getLastResponse() {
      return q(S.lastResponse)?.textContent ?? ''
    },

    async getConversationState(): Promise<ConversationState> {
      const last = await this.getLastResponse()
      if (!last) return { status: 'idle' }
      return { status: 'finished', lastResponse: last }
    },

    onStreamEvent(handler) {
      lastEventHandler = handler
      startObserver()
      return () => {
        observer?.disconnect()
        observer = null
        if (pollTimer) clearInterval(pollTimer)
        pollTimer = null
        lastEventHandler = null
      }
    },

    async detectRateLimit() {
      return !!q(S.rateLimitToast)
    },
  }
}
```

- [ ] **Step 4: 跑 PoC**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npx playwright test tests/e2e/gemini-poc.spec.ts
```

预期：PASS。

- [ ] **Step 5: 在真实 Gemini 页面手动验证**

打开浏览器，登录 Gemini，手动验证：
- 扩展 popup 显示"Gemini 已识别"
- 输入"test"回车，Gemini 回答出现
- console 看到 stream event 正常推送

如有 selector 失效，按 §2.6 流程更新 `selectors.json` 并小幅 bump `version`。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(adapters): Gemini adapter with mock PoC"
```

---

## Task 12: Content Scripts（chatgpt-content, gemini-content）

**Files:**
- Create: `src/content-scripts/chatgpt-content.ts`
- Create: `src/content-scripts/gemini-content.ts`

- [ ] **Step 1: 写 ChatGPT content script**

写入 `src/content-scripts/chatgpt-content.ts`：

```ts
import { createChatGPTAdapter } from '../adapters/chatgpt/adapter'
import type { SwToContent, ContentToSw } from '../shared/messages'

const adapter = createChatGPTAdapter()

// 订阅流式事件并转发给 SW
adapter.onStreamEvent((event) => {
  const msg: ContentToSw = { type: 'stream-event', event }
  chrome.runtime.sendMessage(msg)
})

// 监听 SW 消息
chrome.runtime.onMessage.addListener((msg: SwToContent, _sender, sendResponse) => {
  if (msg.type === 'write-and-send') {
    adapter.sendMessage(msg.text)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }))
    return true
  }
  if (msg.type === 'get-state') {
    adapter.getConversationState()
      .then((state) => {
        const reply: ContentToSw = { type: 'state', platform: 'chatgpt', state }
        sendResponse(reply)
      })
    return true
  }
  if (msg.type === 'get-last-response') {
    adapter.getLastResponse()
      .then((text) => {
        const reply: ContentToSw = { type: 'last-response', text }
        sendResponse(reply)
      })
    return true
  }
  return false
})
```

- [ ] **Step 2: 写 Gemini content script**

写入 `src/content-scripts/gemini-content.ts`：

```ts
import { createGeminiAdapter } from '../adapters/gemini/adapter'
import type { SwToContent, ContentToSw } from '../shared/messages'

const adapter = createGeminiAdapter()

adapter.onStreamEvent((event) => {
  const msg: ContentToSw = { type: 'stream-event', event }
  chrome.runtime.sendMessage(msg)
})

chrome.runtime.onMessage.addListener((msg: SwToContent, _sender, sendResponse) => {
  if (msg.type === 'write-and-send') {
    adapter.sendMessage(msg.text)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }))
    return true
  }
  if (msg.type === 'get-state') {
    adapter.getConversationState()
      .then((state) => {
        const reply: ContentToSw = { type: 'state', platform: 'gemini', state }
        sendResponse(reply)
      })
    return true
  }
  if (msg.type === 'get-last-response') {
    adapter.getLastResponse()
      .then((text) => {
        const reply: ContentToSw = { type: 'last-response', text }
        sendResponse(reply)
      })
    return true
  }
  return false
})
```

- [ ] **Step 3: 验证编译**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm run typecheck
```

预期：通过。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "feat(content): wire content scripts to AIAdapter"
```

---

## Task 13: Background Service Worker

**Files:**
- Create: `src/background/service-worker.ts`

- [ ] **Step 1: 写 SW**

写入 `src/background/service-worker.ts`：

```ts
import type { PopupToSw, SwToPopup, SwToContent, ContentToSw } from '../shared/messages'
import type { AIPlatform } from '../types'

// §2.5：必须先调 setAccessLevel 才能让 content script 访问 storage.session
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch((e) => console.error('[AIChatRoom] setAccessLevel failed', e))

interface SessionState {
  activeConversationId?: string
  chatgpt?: { status: string; lastResponseHash?: string; startTime?: number }
  gemini?: { status: string; lastResponseHash?: string; startTime?: number }
}

const STORAGE_KEY = 'runtime-state'

async function loadState(): Promise<SessionState> {
  const r = await chrome.storage.session.get(STORAGE_KEY)
  return (r[STORAGE_KEY] as SessionState | undefined) ?? {}
}

async function saveState(state: SessionState): Promise<void> {
  await chrome.storage.session.set({ [STORAGE_KEY]: state })
}

async function findTabFor(platform: AIPlatform): Promise<chrome.tabs.Tab | null> {
  const patterns: Record<AIPlatform, RegExp> = {
    chatgpt: /^https:\/\/chatgpt\.com\//,
    gemini: /^https:\/\/gemini\.google\.com\//,
  }
  const tabs = await chrome.tabs.query({ url: patterns[platform].source })
  return tabs[0] ?? null
}

async function sendToTab<T>(tabId: number, msg: SwToContent): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
      else resolve(response as T)
    })
  })
}

// 监听 content script 主动上报
chrome.runtime.onMessage.addListener((msg: ContentToSw, _sender, _sendResponse) => {
  if (msg.type === 'stream-event') {
    // 转发给 popup
    const reply: SwToPopup = { type: 'stream-event', event: msg.event }
    chrome.runtime.sendMessage(reply).catch(() => {/* popup 可能没开 */})
    return false
  }
  return false
})

// 监听 popup 请求
chrome.runtime.onMessage.addListener((msg: PopupToSw, _sender, sendResponse) => {
  if (msg.type === 'send-message') {
    ;(async () => {
      const state = await loadState()
      const newState: SessionState = { ...state, activeConversationId: crypto.randomUUID() }
      for (const p of msg.platforms) {
        const tab = await findTabFor(p)
        if (!tab?.id) {
          sendResponse({ ok: false, error: `${p} tab not found` })
          return
        }
        newState[p] = { status: 'sending', startTime: Date.now() }
        await saveState(newState)
        try {
          await sendToTab(tab.id, { type: 'write-and-send', text: msg.text, imageDataUrl: msg.imageDataUrl })
        } catch (e) {
          sendResponse({ ok: false, error: String(e) })
          return
        }
      }
      sendResponse({ ok: true })
    })()
    return true
  }
  if (msg.type === 'get-conversation-state') {
    ;(async () => {
      const tab = await findTabFor(msg.platform)
      if (!tab?.id) {
        sendResponse({ ok: false, error: 'tab not found' })
        return
      }
      const state = await sendToTab<{ type: 'state'; platform: AIPlatform; state: unknown }>(tab.id, { type: 'get-state' })
      sendResponse({ ok: true, state })
    })()
    return true
  }
  return false
})
```

- [ ] **Step 2: 验证编译**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm run typecheck
```

预期：通过。

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "feat(background): SW with message routing + storage.session"
```

---

## Task 14: Popup 基础布局（HTML / CSS）

**Files:**
- Create: `src/popup/popup.html`
- Create: `src/popup/popup.css`

- [ ] **Step 1: 写 popup.html**

写入 `src/popup/popup.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>AIChatRoom</title>
  <link rel="stylesheet" href="./popup.css">
</head>
<body>
  <div class="app">
    <header class="topbar">
      <h1>AIChatRoom</h1>
      <div class="status" id="status">
        <span class="status-item" data-platform="chatgpt">ChatGPT: <span class="dot"></span> 未检测</span>
        <span class="status-item" data-platform="gemini">Gemini: <span class="dot"></span> 未检测</span>
      </div>
    </header>

    <main class="panels">
      <section class="panel" data-platform="gemini">
        <header class="panel-header">
          <span class="panel-title">Gemini</span>
          <span class="panel-state">空闲</span>
        </header>
        <div class="messages" id="messages-gemini"></div>
      </section>

      <section class="panel" data-platform="chatgpt">
        <header class="panel-header">
          <span class="panel-title">ChatGPT</span>
          <span class="panel-state">空闲</span>
        </header>
        <div class="messages" id="messages-chatgpt"></div>
      </section>
    </main>

    <footer class="composer">
      <textarea id="input" rows="3" placeholder="输入问题，@AI 选择目标，例如：@chatgpt @gemini 你好"></textarea>
      <div class="composer-actions">
        <button id="btn-quote" disabled>引用</button>
        <button id="btn-image" title="粘贴/拖拽图片">图片</button>
        <button id="btn-send">发送</button>
      </div>
    </footer>
  </div>
  <script type="module" src="./popup.ts"></script>
</body>
</html>
```

- [ ] **Step 2: 写 popup.css**

写入 `src/popup/popup.css`：

```css
:root {
  --bg: #fff;
  --fg: #222;
  --muted: #888;
  --border: #e0e0e0;
  --highlight-a: #d4f4d4;
  --highlight-b: #d4e4f4;
  --highlight-gap: #f0f0f0;
  --error: #d44;
  --ok: #4a4;
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif; }
body { background: var(--bg); color: var(--fg); font-size: 13px; }

.app { display: flex; flex-direction: column; height: 600px; width: 800px; }

.topbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-bottom: 1px solid var(--border);
}
.topbar h1 { font-size: 14px; margin: 0; }
.status { display: flex; gap: 12px; font-size: 11px; color: var(--muted); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #ccc; margin-right: 4px; }
.dot.ok { background: var(--ok); }
.dot.err { background: var(--error); }

.panels { flex: 1; display: flex; min-height: 0; }
.panel { flex: 1; display: flex; flex-direction: column; border-right: 1px solid var(--border); }
.panel:last-child { border-right: none; }
.panel-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 6px 10px; border-bottom: 1px solid var(--border);
  font-size: 12px; color: var(--muted);
}
.panel-state { font-size: 11px; }
.panel-state.streaming { color: #06c; }
.panel-state.finished { color: var(--ok); }
.panel-state.error { color: var(--error); }

.messages { flex: 1; overflow-y: auto; padding: 8px 10px; }
.bubble { padding: 6px 8px; border-radius: 6px; margin-bottom: 6px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }
.bubble.user { background: #f4f4f4; }
.bubble.ai { background: #fafafa; border: 1px solid var(--border); }
.bubble.placeholder { background: var(--highlight-gap); color: var(--muted); font-style: italic; }
.bubble .stats { font-size: 10px; color: var(--muted); margin-top: 4px; }
.diff-equal { background: transparent; }
.diff-added-on-a { background: var(--highlight-a); }
.diff-added-on-b { background: var(--highlight-b); }
.diff-gap { background: var(--highlight-gap); color: var(--muted); font-style: italic; }

.composer { border-top: 1px solid var(--border); padding: 8px 10px; }
#input { width: 100%; resize: vertical; border: 1px solid var(--border); border-radius: 4px; padding: 6px; font: inherit; }
.composer-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px; }
.composer-actions button { padding: 4px 10px; border: 1px solid var(--border); background: #fafafa; border-radius: 4px; cursor: pointer; }
.composer-actions button:hover { background: #f0f0f0; }
#btn-send { background: #06c; color: #fff; border-color: #06c; }
#btn-send:disabled { background: #ccc; border-color: #ccc; cursor: not-allowed; }

@keyframes flash { 0%, 100% { background: var(--bg); } 50% { background: #fffae0; } }
.panel.flash { animation: flash 0.6s ease 2; }
```

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "feat(popup): HTML + CSS layout"
```

---

## Task 15: Popup 基础 JS 框架（状态管理 + 消息总线）

**Files:**
- Create: `src/popup/popup.ts`

- [ ] **Step 1: 写 popup.ts 骨架**

写入 `src/popup/popup.ts`：

```ts
import type { AIPlatform, StreamStatus } from '../types'
import type { SwToPopup, PopupToSw } from '../shared/messages'

// ---------- DOM refs ----------
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!
const statusDot = (p: AIPlatform) => document.querySelector<HTMLSpanElement>(`.status-item[data-platform="${p}"] .dot`)!
const panelState = (p: AIPlatform) => document.querySelector<HTMLElement>(`.panel[data-platform="${p}"] .panel-state`)!
const messagesEl = (p: AIPlatform) => document.getElementById(`messages-${p}`) as HTMLDivElement
const inputEl = $<HTMLTextAreaElement>('#input')
const sendBtn = $<HTMLButtonElement>('#btn-send')
const quoteBtn = $<HTMLButtonElement>('#btn-quote')
const imageBtn = $<HTMLButtonElement>('#btn-image')

// ---------- 状态 ----------
interface UIState {
  status: Record<AIPlatform, StreamStatus>
  lastResponses: Record<AIPlatform, string>
  hasUserMessage: boolean
}
const state: UIState = {
  status: { chatgpt: 'idle', gemini: 'idle' },
  lastResponses: { chatgpt: '', gemini: '' },
  hasUserMessage: false,
}

// ---------- 渲染 ----------
function setPlatformStatus(p: AIPlatform, s: StreamStatus) {
  state.status[p] = s
  const el = panelState(p)
  el.className = 'panel-state'
  if (s === 'streaming' || s === 'sending') el.classList.add('streaming'), el.textContent = '回答中...'
  else if (s === 'finished') el.classList.add('finished'), el.textContent = '已回答'
  else if (s === 'error') el.classList.add('error'), el.textContent = '出错'
  else el.textContent = '空闲'

  const dot = statusDot(p)
  dot.classList.remove('ok', 'err')
  if (s === 'finished') dot.classList.add('ok')
  if (s === 'error') dot.classList.add('err')
}

function addBubble(p: AIPlatform, text: string, kind: 'user' | 'ai' | 'placeholder') {
  const div = document.createElement('div')
  div.className = `bubble ${kind}`
  div.textContent = text
  messagesEl(p).appendChild(div)
  messagesEl(p).scrollTop = messagesEl(p).scrollHeight
}

function flashPanel(p: AIPlatform) {
  const panel = document.querySelector(`.panel[data-platform="${p}"]`)!
  panel.classList.remove('flash')
  void panel.offsetWidth
  panel.classList.add('flash')
}

// ---------- 消息到 SW ----------
function sendToSw<T = unknown>(msg: PopupToSw): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
      else resolve(response as T)
    })
  })
}

// ---------- 监听 SW 推送 ----------
chrome.runtime.onMessage.addListener((msg: SwToPopup) => {
  if (msg.type === 'stream-event') {
    const e = msg.event
    if (e.type === 'finished') {
      state.lastResponses[e.platform] = e.text
      setPlatformStatus(e.platform, 'finished')
      // 检查双方是否都完成
      if (state.status.chatgpt === 'finished' && state.status.gemini === 'finished') {
        flashPanel('chatgpt')
        flashPanel('gemini')
      }
    } else if (e.type === 'started' || e.type === 'token') {
      setPlatformStatus(e.platform, 'streaming')
    } else if (e.type === 'paused') {
      setPlatformStatus(e.platform, 'paused')
    } else if (e.type === 'error') {
      setPlatformStatus(e.platform, 'error')
    } else if (e.type === 'rate-limit') {
      setPlatformStatus(e.platform, 'error')
      addBubble(e.platform, `⚠️ 限流：${e.message}`, 'placeholder')
    }
  }
})

// ---------- 启动 ----------
window.addEventListener('DOMContentLoaded', () => {
  console.log('[AIChatRoom popup] ready')
  sendBtn.addEventListener('click', onSend)
  inputEl.addEventListener('input', () => {
    state.hasUserMessage = inputEl.value.trim().length > 0
  })
})

async function onSend() {
  const text = inputEl.value.trim()
  if (!text) return
  // 简易实现：@ 解析在后续 task 加
  const platforms: AIPlatform[] = ['chatgpt', 'gemini']
  for (const p of platforms) {
    addBubble(p, text, 'user')
    setPlatformStatus(p, 'queued')
  }
  inputEl.value = ''
  await sendToSw({ type: 'send-message', platforms, text })
}
```

- [ ] **Step 2: 验证编译**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm run typecheck
```

预期：通过。

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "feat(popup): state management + SW message bridge"
```

---

## Task 16: 验证 dev build

- [ ] **Step 1: 跑 vite build**

```bash
cd /Users/xucong/Project/opencode/AIChatRoom
npm run build
```

预期：`dist/` 生成，无错误。

- [ ] **Step 2: 加载到 Chrome**

1. 打开 `chrome://extensions`
2. 开启"开发者模式"
3. "加载已解压的扩展" → 选 `dist/`
4. 打开 `https://chatgpt.com` 和 `https://gemini.google.com`，分别登录
5. 点击扩展图标
6. 验证：状态条显示两个 AI 都已识别；输入测试文本回车，两边面板出现用户气泡

- [ ] **Step 3: 修复遇到的问题**

（如有：选择器失效、消息路由不通、状态不同步等，回到对应 Task 修复。）

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "chore: verify dev build in real Chrome"
```

---

## 剩余 Tasks（17–27）— 概要

> 详细步骤以 Task 0–16 为模板，每个 task 包含失败测试、实现、验证、提交四步。下面给出关键产出与产出位置，详细代码在执行时由 subagent 按"先 TDD，再实现"原则补全。

### Task 17: 发送占位气泡（F16）
- `popup.ts` 在 `onSend` 后，给两边各插入一个"等待回应..."占位气泡，监听 stream-event 替换为真实回答。
- 验收：手动测试能看到占位气泡在 0.5-2 秒延迟期间显示。

### Task 18: @ 选择性发送（F3）
- `popup.ts` 监听 `#input` 的 `input` 事件，检测 `@` 触发候选弹窗。
- 用 `parseAtMentions` 解析发送目标。
- 验收：@chatgpt 后回车只发给 ChatGPT；不输入 @ 时发两边。

### Task 19: 回答统计展示（F11 统计部分）
- 在 stream-event finished 时计算字数 / 耗时 / TTFT，渲染到 AI 气泡下方。
- 用 `countWords` / `durationMs` / `ttftMs`。
- 验收：两边气泡下方各显示一行小字统计。

### Task 20: 图片输入（F14）
- `popup.ts` 监听 `#input` 的 `paste` / `drop`，构造 DataTransfer 通过 sendToSw 传 `imageDataUrl`。
- 失败兜底链：clipboard → download button。
- 验收：粘贴截图能到两边官方页面；失败时给"下载"按钮。

### Task 21: 引用上一轮（F12）
- `popup.ts` "引用"按钮读取 `state.lastResponses[other]`，插入到输入框光标位置。
- 验收：点击引用按钮，对方的最后回答插入到输入框。

### Task 22: 左传右 / 右传左 + 提示词模板（F2 + F5 + F8）
- 顶部加两个按钮 "ChatGPT→Gemini" / "Gemini→ChatGPT"。
- 触发时用 `renderTemplate(getDefaultTemplates().review, { response: ... })`，包装后调用 send-message 流程。
- 验收：点击后对方面板出现"审查："开头的用户气泡。

### Task 23: 一键对比总结（F6）
- 加"对比总结"按钮，触发时把双方回答塞进 summary 模板，发给选中的 AI。
- > 3000 字符截断并提示。
- 验收：点击后选中侧 AI 收到带双方回答的总结请求。

### Task 24: 字符串 diff 展示（F11 diff 部分）
- 双方都 finished 时，调用 `diffResponses` 计算 chunks，渲染两边消息面板，每段加 `diff-equal` / `diff-added-on-a` / `diff-added-on-b` class。
- 验收：差异部分绿/蓝底色高亮。

### Task 25: 键盘快捷键（F13）
- `popup.ts` 监听 `keydown`：`Ctrl/Cmd+Enter` 触发发送；`Ctrl/Cmd+Shift+1` 触发左传右；`Ctrl/Cmd+Shift+2` 触发右传左。
- 冲突处理：检查 `e.target` 是否在输入框。
- 验收：三个快捷键都能用。

### Task 26: 本地保存 + 历史查看（F7）
- 每次双方都 finished 时调 `addSession` 写一条。
- 加"历史"侧边面板或单独 tab，列出 sessions，点开查看。
- 验收：刷新扩展后历史还在；超过 500 条 / 100MB 淘汰旧记录。

### Task 27: 设置页（F9）
- `src/options/options.html` + `options.ts` + `options.css`。
- 提供启用/禁用 ChatGPT / Gemini 的开关，存 `chrome.storage.local`。
- 验收：禁用后 popup 不再路由到该平台。

### Task 28: 错误处理补全
- 限流：监听 `e.type === 'rate-limit'`，UI 提示。
- 继续生成：监测 `S.continueButton` 出现，UI 提示"⏸ ChatGPT 暂停"。
- SW 休眠恢复：popup 启动时主动 `get-conversation-state` 拉一次。
- 验收：手动模拟限流 / 暂停场景，UI 都有正确提示。

### Task 29: 端到端验收
- 跑完 §10.4 全部 18 项验收清单。
- 真实 Chrome + ChatGPT + Gemini 上连续使用 30 分钟无崩溃。
- 最后一次提交：`chore: v1 feature complete, E2E verified`。

---

## 自检

对照设计文档检查覆盖度：

| 设计章节 | 任务 |
|---------|------|
| §1 概述 | （无任务，背景） |
| §2 架构 | Task 0 (manifest), Task 1 (types), Task 2 (AIAdapter), Task 12-13 (SW/content) |
| §2.4 AIAdapter | Task 2 |
| §2.5 SW 休眠 + storage 分工 | Task 3, Task 13 |
| §2.6 DOM 选择器 | Task 9 |
| §2.7 权限模型 | Task 0 (manifest) |
| §2.8 Adapter 版本化 | Task 9 (selectors.json schema) |
| §3 用户流程 | Task 14-15 (popup) |
| §4.1 v1 功能 F1–F16 | Task 10-11 (F1 基础), Task 17 (F16), Task 18 (F3), Task 19 (F11 统计), Task 20 (F14), Task 21 (F12), Task 22 (F2+F5+F8), Task 23 (F6), Task 24 (F11 diff), Task 25 (F13), Task 26 (F7), Task 27 (F9) |
| §4.2 远期 | （无任务，v1 不做） |
| §4.3 v1 不做 | Task 0 (manifest 不含违规权限) |
| §5 关键交互 | Task 14-25 各对应小节 |
| §6 数据流 | Task 13 (SW) |
| §7 组件边界 | Task 1-8 (lib), Task 10-11 (adapters), Task 12 (content), Task 13 (SW), Task 14-15 (popup) |
| §8 错误处理 | Task 28 |
| §9 性能 | Task 4-8 (节流), Task 10-11 (MutationObserver 走 dirty 标志) |
| §10 测试 | Task 3-8 (unit), Task 9 (schema), Task 10-11 (E2E PoC), Task 29 (E2E) |
| §11 开发顺序 | （本计划按此顺序） |
| §12 风险 | （无任务，文档） |
| §13 v1 成功标准 | Task 29 |
| §14 法律声明 | Task 0 (manifest description) |

无遗漏。
