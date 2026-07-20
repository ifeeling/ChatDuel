# ChatDuel 本地循环诊断记录实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 ChatGPT、Gemini、Claude、豆包和 DeepSeek 建立默认开启、仅本地保存、可预览和导出的循环诊断记录，能够区分发送、通信、回答状态和抓取超时的具体原因。

**Architecture:** chat 页面为每次用户发送创建 `batchId` 和每平台 `platformRunId`，content script 在各平台 adapter 内记录发送阶段，chat 页面记录回答回填阶段。所有生产者通过非阻塞 runtime message 把白名单事件交给 background Service Worker；后台是唯一持久化写入者，负责净化、排序、串行合并、完整批次淘汰和跨重启续号。设置页只读取后台生成的脱敏快照，并从同一字符串完成预览、复制和 Blob 下载。

**Tech Stack:** TypeScript 5.4、Manifest V3、Chrome Extension APIs、Vitest、jsdom；不新增运行依赖。

## Global Constraints

- 覆盖 `chatgpt`、`gemini`、`claude`、`doubao`、`deepseek` 五个平台。
- 诊断记录只保存在 `chrome.storage.local`，不自动上传，不增加远程服务。
- 不保存问题/回答正文、摘要或哈希，不保存附件名、URL、会话 ID、账号信息、DOM 文本和原始异常字符串。
- 字符数只允许 `0..100000` 的整数，超过时截断为 `100000`。
- 总上限：20 个发送批次、100 个平台执行链、1000 条事件、1 MB、7 天。
- 单批次上限：200 条事件、256 KB；单平台执行链上限：50 条事件。
- 超限按完整 `batchId` 淘汰；单批次/单执行链膨胀时保留起始、关键、最近、终结信息并记录丢弃数量。
- 不新增 npm 依赖，不新增 manifest 权限，不调用 `chrome.downloads`。
- 诊断写入不得阻塞或改变消息发送、回答抓取和发送锁行为。
- 当前工作区已有 `src/background/service-worker.ts`、`src/chat/chat.ts`、`src/chat/platform-message-route.ts` 和 `src/background/embed-rule-lifecycle.ts` 的用户改动；实施前必须阅读并保留这些改动，禁止覆盖或回滚。

## File Structure

- Create `src/lib/diagnostic-types.ts`: 诊断 schema、枚举、白名单净化和错误映射。
- Create `src/lib/diagnostic-retention.ts`: 完整批次追加、截断、淘汰、排序和派生结果。
- Create `src/background/diagnostic-writer.ts`: Service Worker 单写入者、串行队列、持久化序号和读取/清空接口。
- Create `src/lib/diagnostic-client.ts`: 生产者侧 fire-and-forget reporter 和 `runSequence` 管理。
- Create `src/lib/diagnostic-export.ts`: 从一次快照生成不可变的预览/复制/下载字符串和 Blob。
- Create `src/chat/response-diagnostic.ts`: 回答轮询状态变化、稀疏检查点和最终统计。
- Modify `src/shared/messages.ts`: 跨 chat、content script、background 的诊断上下文和 runtime 消息。
- Modify `src/adapters/base.ts`: `sendMessage` 接受可选 `DiagnosticReporter`。
- Modify five platform adapters and five content scripts: 记录发送阶段和稳定错误码。
- Modify `src/chat/chat.ts`, `src/chat/chat.html`, `src/chat/chat.css`: 创建执行上下文、记录回填、设置、预览、复制、下载和清空 UI。
- Modify `src/lib/user-settings.ts`, `src/lib/i18n.ts`: 默认开启设置、提示版本迁移和多语言文案。
- Modify `src/background/service-worker.ts`: 注册诊断 writer 消息入口，不破坏现有 DNR 生命周期修改。
- Modify `docs/store/privacy-policy.md`: 披露本地诊断记录和保留范围。

---

### Task 1: 诊断 schema、净化与错误映射

**Files:**
- Create: `src/lib/diagnostic-types.ts`
- Test: `tests/unit/diagnostic-types.test.ts`

**Interfaces:**
- Produces: `DiagnosticContext`、`DiagnosticEventDraft`、`DiagnosticEvent`、`DiagnosticRunOutcome`、`sanitizeDiagnosticEventDraft()`、`mapDiagnosticError()`、所有限制常量。
- Consumes: `AIPlatform` from `src/types/index.ts`。

- [ ] **Step 1: 写失败测试，固定 schema 和隐私边界**

```ts
import { describe, expect, it } from 'vitest'
import {
  DIAGNOSTIC_SCHEMA_VERSION,
  mapDiagnosticError,
  sanitizeDiagnosticEventDraft,
} from '../../src/lib/diagnostic-types'

describe('diagnostic types', () => {
  it('keeps only whitelisted bounded fields', () => {
    expect(sanitizeDiagnosticEventDraft({
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      timestamp: 100,
      batchId: 'batch-1',
      platformRunId: 'run-1',
      attempt: 1,
      runSequence: 2,
      platform: 'chatgpt',
      component: 'platform-adapter',
      operation: 'response-read',
      stage: 'response-observed',
      eventStatus: 'observed',
      responseCharacterCount: 999999,
      unknownSecret: 'https://chatgpt.com/c/private prompt',
    } as never)).toEqual(expect.objectContaining({
      responseCharacterCount: 100000,
    }))
    expect(JSON.stringify(sanitizeDiagnosticEventDraft({
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      timestamp: 100,
      batchId: 'batch-1',
      platformRunId: 'run-1',
      attempt: 1,
      runSequence: 2,
      platform: 'chatgpt',
      component: 'platform-adapter',
      operation: 'response-read',
      stage: 'response-observed',
      eventStatus: 'observed',
      unknownSecret: 'PRIVATE_PROMPT',
    } as never))).not.toContain('PRIVATE_PROMPT')
  })

  it('rejects records without a supported schema version', () => {
    expect(sanitizeDiagnosticEventDraft({ batchId: 'batch-1' } as never)).toBeNull()
  })

  it('maps raw errors without persisting their message', () => {
    expect(mapDiagnosticError(new Error('Extension context invalidated: PRIVATE_PROMPT')))
      .toBe('extension-context-invalidated')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/unit/diagnostic-types.test.ts`

Expected: FAIL，提示 `../../src/lib/diagnostic-types` 不存在。

- [ ] **Step 3: 实现最小、严格白名单 schema**

```ts
export const DIAGNOSTIC_SCHEMA_VERSION = 1
export const MAX_DIAGNOSTIC_BATCHES = 20
export const MAX_DIAGNOSTIC_RUNS = 100
export const MAX_DIAGNOSTIC_EVENTS = 1000
export const MAX_DIAGNOSTIC_BYTES = 1_000_000
export const MAX_BATCH_EVENTS = 200
export const MAX_BATCH_BYTES = 256_000
export const MAX_RUN_EVENTS = 50
export const MAX_DIAGNOSTIC_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_CHARACTER_COUNT = 100_000

export type DiagnosticComponent =
  | 'chat-ui' | 'background' | 'content-script' | 'iframe-bridge'
  | 'official-tab' | 'platform-adapter' | 'response-capture'

export type DiagnosticEventStatus = 'observed' | 'succeeded' | 'failed' | 'timed-out' | 'skipped'
export type DiagnosticRunOutcome = 'completed' | 'paused' | 'failed' | 'timed-out' | 'interrupted'
export type DiagnosticOperation =
  | 'route-select' | 'input-locate' | 'input-write' | 'attachment-prepare'
  | 'send-click' | 'send-ack' | 'state-read' | 'response-read'
  | 'response-compare' | 'result-return'
export type DiagnosticStage =
  | 'started' | 'located' | 'written' | 'clicked' | 'accepted'
  | 'state-changed' | 'checkpoint' | 'completed' | 'failed' | 'skipped'
export type DiagnosticErrorCode =
  | 'input-box-not-found' | 'send-button-not-found' | 'send-button-not-ready'
  | 'send-ack-timeout' | 'message-not-accepted' | 'iframe-result-timeout'
  | 'official-tab-unavailable' | 'message-route-unavailable' | 'state-request-timeout'
  | 'response-selector-empty' | 'response-still-streaming' | 'response-equals-baseline'
  | 'response-capture-timeout' | 'content-script-unavailable'
  | 'extension-context-invalidated' | 'tab-closed' | 'tab-navigation-detected'
  | 'input-write-failed' | 'send-click-failed' | 'attachment-preparation-timeout'
  | 'unexpected-error'

export interface DiagnosticContext {
  batchId: string
  platformRunId: string
  attempt: number
}

export interface DiagnosticEventDraft extends DiagnosticContext {
  schemaVersion: 1
  timestamp: number
  runSequence: number
  platform: AIPlatform
  component: DiagnosticComponent
  operation: DiagnosticOperation
  stage: DiagnosticStage
  eventStatus: DiagnosticEventStatus
  runOutcome?: DiagnosticRunOutcome
  errorCode?: DiagnosticErrorCode
  route?: 'iframe' | 'official-tab'
  retryNumber?: number
  retryCount?: number
  waitedMs?: number
  timeoutMs?: number
  stateStatus?: StreamStatus
  lastObservedState?: StreamStatus
  selectorConfigVersion?: string
  inputCharacterCount?: number
  responseCharacterCount?: number
  baselineCharacterCount?: number
  hasAttachment?: boolean
  stopButtonDetected?: boolean
  differsFromBaseline?: boolean
  pollCount?: number
  stateChangeCount?: number
}

export interface DiagnosticEvent extends DiagnosticEventDraft {
  storageSequence: number
  extensionVersion: string
}
```

实现 `sanitizeDiagnosticEventDraft(value: unknown): DiagnosticEventDraft | null` 时逐字段构造新对象；禁止对象展开、禁止保存未知 key、禁止保存原始 `Error.message`。`mapDiagnosticError(error)` 只根据固定字符串模式返回枚举，无法识别时返回 `unexpected-error`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/unit/diagnostic-types.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交 schema**

```bash
git add src/lib/diagnostic-types.ts tests/unit/diagnostic-types.test.ts
git commit -m "feat: add privacy-safe diagnostic schema"
```

---

### Task 2: 完整批次保留、截断和派生结果

**Files:**
- Create: `src/lib/diagnostic-retention.ts`
- Test: `tests/unit/diagnostic-retention.test.ts`

**Interfaces:**
- Consumes: `DiagnosticEvent` and limits from Task 1。
- Produces: `DiagnosticEnvelope`、`appendDiagnosticEvents()`、`pruneDiagnosticEnvelope()`、`deriveDiagnosticExport()`、`serializeDiagnosticExport()`。

- [ ] **Step 1: 写失败测试覆盖完整批次淘汰和异常膨胀**

```ts
const makeEnvelope = (events: DiagnosticEvent[] = []): DiagnosticEnvelope => ({
  schemaVersion: 1,
  nextStorageSequence: events.length + 1,
  events,
  truncation: {},
})

const event = (
  batchId: string,
  platformRunId: string,
  storageSequence: number,
  overrides: Partial<DiagnosticEvent> = {},
): DiagnosticEvent => ({
  schemaVersion: 1,
  timestamp: storageSequence,
  batchId,
  platformRunId,
  attempt: 1,
  runSequence: storageSequence,
  storageSequence,
  extensionVersion: '0.4.13',
  platform: 'chatgpt',
  component: 'response-capture',
  operation: 'state-read',
  stage: 'observed',
  eventStatus: 'observed',
  ...overrides,
})

it('evicts whole oldest batches instead of cutting a run', () => {
  const next = appendDiagnosticEvents(makeEnvelope([
    event('batch-old', 'run-old', 1),
    event('batch-old', 'run-old', 2),
    event('batch-new', 'run-new', 3),
  ]), [event('batch-latest', 'run-latest', 4)], {
    ...DEFAULT_DIAGNOSTIC_LIMITS,
    maxEvents: 2,
  })
  expect(next.events.map((item) => item.batchId)).toEqual(['batch-new', 'batch-latest'])
})

it('folds an oversized run and preserves its terminal outcome', () => {
  const events = Array.from({ length: 70 }, (_, index) =>
    event('batch-1', 'run-1', index + 1, index === 69 ? { runOutcome: 'timed-out' } : {}))
  const next = appendDiagnosticEvents(makeEnvelope(), events)
  expect(next.events.filter((item) => item.platformRunId === 'run-1').length).toBeLessThanOrEqual(50)
  expect(next.events.some((item) => item.runOutcome === 'timed-out')).toBe(true)
  expect(next.truncation['run-1']).toMatchObject({ eventsTruncated: true, droppedEventCount: 20 })
})

it('derives abandoned without forging a stored event', () => {
  const stored = makeEnvelope([event('batch-1', 'run-1', 1, { timestamp: 0 })])
  const exported = deriveDiagnosticExport(stored, { now: 600_001, activePlatformRunIds: new Set() })
  expect(exported.batches[0].runs[0].derivedOutcome).toBe('abandoned')
  expect(stored.events[0].runOutcome).toBeUndefined()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/unit/diagnostic-retention.test.ts`

Expected: FAIL，提示 retention 模块不存在。

- [ ] **Step 3: 实现嵌套限制和确定性导出**

```ts
export interface DiagnosticEnvelope {
  schemaVersion: 1
  nextStorageSequence: number
  events: DiagnosticEvent[]
  truncation: Record<string, { eventsTruncated: true; droppedEventCount: number }>
}

export interface DiagnosticLimits {
  maxBatches: number
  maxRuns: number
  maxEvents: number
  maxBytes: number
  maxAgeMs: number
  maxBatchEvents: number
  maxBatchBytes: number
  maxRunEvents: number
}

export const DEFAULT_DIAGNOSTIC_LIMITS: DiagnosticLimits = {
  maxBatches: 20,
  maxRuns: 100,
  maxEvents: 1000,
  maxBytes: 1_000_000,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxBatchEvents: 200,
  maxBatchBytes: 256_000,
  maxRunEvents: 50,
}

export interface DiagnosticExportRun {
  platformRunId: string
  finalOutcome?: DiagnosticRunOutcome
  recoveredAfterRetry: boolean
  derivedOutcome?: 'abandoned'
  derivedReason?: 'missing-terminal-event'
  events: DiagnosticEvent[]
}

export interface DiagnosticExportPayload {
  schemaVersion: 1
  exportedAt: number
  batches: Array<{ batchId: string; runs: DiagnosticExportRun[] }>
}

export function appendDiagnosticEvents(
  envelope: DiagnosticEnvelope,
  incoming: DiagnosticEvent[],
  limits = DEFAULT_DIAGNOSTIC_LIMITS,
  now = Date.now(),
): DiagnosticEnvelope

export function deriveDiagnosticExport(
  envelope: DiagnosticEnvelope,
  input: { now: number; activePlatformRunIds: Set<string>; latestFailureOnly?: boolean },
): DiagnosticExportPayload

export function serializeDiagnosticExport(payload: DiagnosticExportPayload): string {
  return JSON.stringify(payload, null, 2)
}
```

每个写入批次只对不超过 1 MB 的候选 envelope 做一次 `TextEncoder().encode(JSON.stringify(value)).byteLength` 检查。`latestFailureOnly` 只匹配最终 outcome 为 failed/timed-out/interrupted 的 run，然后返回其完整 batch；paused、abandoned 和 recoveredAfterRetry 不算最终失败。

- [ ] **Step 4: 运行 retention 测试**

Run: `npm test -- tests/unit/diagnostic-retention.test.ts`

Expected: PASS，完整批次、单 run 截断、7 天淘汰、1 MB 和派生结果用例全部通过。

- [ ] **Step 5: 提交 retention 层**

```bash
git add src/lib/diagnostic-retention.ts tests/unit/diagnostic-retention.test.ts
git commit -m "feat: retain complete diagnostic batches"
```

---

### Task 3: Service Worker 单写入者与跨重启续号

**Files:**
- Create: `src/background/diagnostic-writer.ts`
- Modify: `src/background/service-worker.ts`
- Modify: `src/shared/messages.ts`
- Test: `tests/unit/diagnostic-writer.test.ts`

**Interfaces:**
- Consumes: Task 1 sanitizer and Task 2 envelope functions。
- Produces: `createDiagnosticWriter(storage, extensionVersion, warn)` with `append()`, `snapshot()`, `clear()`, `getInternalStatus()`。
- Runtime messages: `diagnostic:append`, `diagnostic:snapshot`, `diagnostic:clear`。

- [ ] **Step 1: 写失败测试覆盖并发、重启和内部错误不递归**

```ts
it('serializes concurrent appends without losing events', async () => {
  const writer = createDiagnosticWriter(storage, '0.4.13', warn)
  await Promise.all(Array.from({ length: 100 }, (_, index) => writer.append(draft(index))))
  const snapshot = await writer.snapshot()
  expect(snapshot.events).toHaveLength(100)
  expect(new Set(snapshot.events.map((event) => event.storageSequence)).size).toBe(100)
})

it('continues storage sequence after a worker restart', async () => {
  const first = createDiagnosticWriter(storage, '0.4.13', warn)
  await first.append(draft(1))
  const restarted = createDiagnosticWriter(storage, '0.4.13', warn)
  await restarted.append(draft(2))
  expect((await restarted.snapshot()).events.map((event) => event.storageSequence)).toEqual([1, 2])
})

it('does not recurse when storage keeps failing', async () => {
  storage.set.mockRejectedValue(new Error('quota'))
  const writer = createDiagnosticWriter(storage, '0.4.13', warn)
  await expect(writer.append(draft(1))).resolves.toEqual({ ok: false })
  expect(storage.set).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/unit/diagnostic-writer.test.ts`

Expected: FAIL，提示 writer 模块不存在。

- [ ] **Step 3: 实现串行 writer**

```ts
export function createDiagnosticWriter(
  storage: Pick<typeof chrome.storage.local, 'get' | 'set' | 'remove'>,
  extensionVersion: string,
  warn: (message: string) => void,
) {
  type Pending = { draft: DiagnosticEventDraft; resolve: (result: { ok: boolean }) => void }
  let pending: Pending[] = []
  let flushScheduled = false
  let writeChain = Promise.resolve()
  let cachedEnvelope: DiagnosticEnvelope | null = null
  let lastWarningAt = 0

  const warnLimited = () => {
    const now = Date.now()
    if (now - lastWarningAt < 30_000) return
    lastWarningAt = now
    warn('[ChatDuel diagnostic] local write failed')
  }

  const loadEnvelope = async () => {
    if (cachedEnvelope) return cachedEnvelope
    const stored = await storage.get(DIAGNOSTIC_STORAGE_KEY)
    cachedEnvelope = sanitizeDiagnosticEnvelope(stored[DIAGNOSTIC_STORAGE_KEY])
      ?? createEmptyDiagnosticEnvelope()
    return cachedEnvelope
  }

  const flush = () => {
    if (pending.length === 0) return
    const batch = pending.splice(0)
    writeChain = writeChain.then(async () => {
      const envelope = await loadEnvelope()
      let nextSequence = Math.max(
        envelope.nextStorageSequence,
        Math.max(0, ...envelope.events.map((event) => event.storageSequence)) + 1,
      )
      const events = batch.map(({ draft }) => ({
        ...draft,
        storageSequence: nextSequence++,
        extensionVersion,
      }))
      const next = appendDiagnosticEvents(envelope, events)
      next.nextStorageSequence = nextSequence
      await storage.set({ [DIAGNOSTIC_STORAGE_KEY]: next })
      cachedEnvelope = next
      batch.forEach(({ resolve }) => resolve({ ok: true }))
    }).catch(() => {
      warnLimited()
      batch.forEach(({ resolve }) => resolve({ ok: false }))
    })
  }

  const append = (value: unknown): Promise<{ ok: boolean }> => {
    const sanitized = sanitizeDiagnosticEventDraft(value)
    if (!sanitized) return Promise.resolve({ ok: false })
    return new Promise((resolve) => {
      pending.push({ draft: sanitized, resolve })
      if (flushScheduled) return
      flushScheduled = true
      queueMicrotask(() => {
        flushScheduled = false
        flush()
      })
    })
  }
  return { append, snapshot, clear, getInternalStatus }
}
```

`snapshot()` 和 `clear()` 先调用 `flush()` 并等待 `writeChain`；snapshot 返回净化后的不可变副本，clear 删除 storage key、清空 cache 并重新建立空 envelope。`getInternalStatus()` 只返回当前生命周期是否发生过 schema/storage 错误，不把错误再次写入诊断 storage。

Service Worker 的 `diagnostic:append` 分支在 writer 完成后调用 `sendResponse` 并返回 `true`；生产者不会 await 该响应，因此业务不阻塞，但 Chrome 会保持后台消息任务存活。

- [ ] **Step 4: 注册 runtime 消息并保留当前未提交的 DNR 改动**

在 `src/background/service-worker.ts` 顶部创建单例 writer；在现有 `chrome.runtime.onMessage` 中只增加三个分支，不改动 `enable-embed-rules`、`disable-embed-rules` 和 `official-tab-command` 的现有逻辑。

- [ ] **Step 5: 运行 writer 和现有后台相关测试**

Run: `npm test -- tests/unit/diagnostic-writer.test.ts tests/unit/platform-message-route.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交后台 writer**

```bash
git add src/background/diagnostic-writer.ts src/background/service-worker.ts src/shared/messages.ts tests/unit/diagnostic-writer.test.ts
git commit -m "feat: persist diagnostics through one background writer"
```

---

### Task 4: 用户设置与一次性隐私提示迁移

**Files:**
- Modify: `src/lib/user-settings.ts`
- Test: `tests/unit/user-settings.test.ts`

**Interfaces:**
- Produces: `UserSettings.diagnosticEnabled`、`UserSettings.diagnosticNoticeVersionSeen`、`CURRENT_DIAGNOSTIC_NOTICE_VERSION`。
- Consumes: existing `loadUserSettings()` and `saveUserSettings()`。

- [ ] **Step 1: 写失败测试固定默认开启但不覆盖用户关闭**

```ts
it('enables local diagnostics only when the setting is absent', async () => {
  await expect(loadUserSettings()).resolves.toMatchObject({ diagnosticEnabled: true })
  await saveUserSettings({ diagnosticEnabled: false })
  await expect(loadUserSettings()).resolves.toMatchObject({ diagnosticEnabled: false })
})

it('does not repeat a seen diagnostic notice after upgrade', async () => {
  await saveUserSettings({ diagnosticNoticeVersionSeen: 1 })
  await expect(loadUserSettings()).resolves.toMatchObject({ diagnosticNoticeVersionSeen: 1 })
})

it('does not re-enable diagnostics when another setting is saved', async () => {
  await saveUserSettings({ diagnosticEnabled: false })
  await saveUserSettings({ language: 'en-US' })
  await expect(loadUserSettings()).resolves.toMatchObject({
    diagnosticEnabled: false,
    language: 'en-US',
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/unit/user-settings.test.ts`

Expected: FAIL，因为新字段尚不存在。

- [ ] **Step 3: 扩展设置 schema**

```ts
export const CURRENT_DIAGNOSTIC_NOTICE_VERSION = 1

export interface UserSettings {
  enabledPlatforms: Record<AIPlatform, boolean>
  platformOrder: AIPlatform[]
  language: UserLanguage
  captureDebug: boolean
  promptTemplates: UserPromptTemplates
  promptTemplateCustomizations: UserPromptTemplateCustomizations
  diagnosticEnabled: boolean
  diagnosticNoticeVersionSeen: number
}

return {
  enabledPlatforms,
  platformOrder,
  language,
  captureDebug: value?.captureDebug === true,
  promptTemplates,
  promptTemplateCustomizations,
  diagnosticEnabled: value?.diagnosticEnabled !== false,
  diagnosticNoticeVersionSeen: Number.isInteger(value?.diagnosticNoticeVersionSeen)
    ? Math.max(0, value.diagnosticNoticeVersionSeen ?? 0)
    : 0,
}
```

`saveUserSettings()` 写入前先读取已保存设置，并把本次 partial 更新合并到旧值后再 normalize。`enabledPlatforms`、`promptTemplates` 和 `promptTemplateCustomizations` 使用浅层字段合并，其它字段直接覆盖。这样任何调用者只保存语言或模板时，都不会把已关闭的诊断重新开启；chat 设置页仍显式提交当前 `diagnosticEnabled`。

- [ ] **Step 4: 运行全部设置测试**

Run: `npm test -- tests/unit/user-settings.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交设置迁移**

```bash
git add src/lib/user-settings.ts tests/unit/user-settings.test.ts
git commit -m "feat: add local diagnostic preferences"
```

---

### Task 5: 诊断 reporter、上下文传递与五个平台发送阶段

**Files:**
- Create: `src/lib/diagnostic-client.ts`
- Modify: `src/adapters/base.ts`
- Modify: `src/shared/messages.ts`
- Modify: `src/types/index.ts`
- Modify: `src/lib/remote-selector-config.ts`
- Modify: `src/content-scripts/selector-overrides.ts`
- Modify: `src/background/service-worker.ts`
- Modify: `src/chat/chat.ts`
- Modify: `src/chat/platform-message-route.ts`
- Modify: `src/content-scripts/chatgpt-content.ts`
- Modify: `src/content-scripts/gemini-content.ts`
- Modify: `src/content-scripts/claude-content.ts`
- Modify: `src/content-scripts/doubao-content.ts`
- Modify: `src/content-scripts/deepseek-content.ts`
- Modify: `src/adapters/chatgpt/adapter.ts`
- Modify: `src/adapters/gemini/adapter.ts`
- Modify: `src/adapters/claude/adapter.ts`
- Modify: `src/adapters/doubao/adapter.ts`
- Modify: `src/adapters/deepseek/adapter.ts`
- Test: `tests/unit/diagnostic-client.test.ts`
- Test: `tests/unit/chatgpt-adapter.test.ts`
- Test: `tests/unit/gemini-adapter.test.ts`
- Test: `tests/unit/claude-adapter.test.ts`
- Test: `tests/unit/doubao-adapter.test.ts`
- Test: `tests/unit/deepseek-adapter.test.ts`
- Test: `tests/unit/platform-message-route.test.ts`
- Test: `tests/unit/remote-selector-config.test.ts`

**Interfaces:**
- Consumes: Task 1 types and Task 3 runtime append message。
- Produces: `DiagnosticReporter` and `createDiagnosticReporter(context, platform, sender)`。
- Changes: `AIAdapter.sendMessage(text, image?, diagnostics?)`。
- Changes: `ConversationState.stopButtonDetected?: boolean` and selector loader returns `{ selectors, version }`。

- [ ] **Step 1: 写 reporter 失败测试**

```ts
it('increments run sequence and never waits for runtime persistence', () => {
  const sender = vi.fn(() => Promise.resolve({ ok: true }))
  const reporter = createDiagnosticReporter(context, 'chatgpt', sender)
  reporter.emit({ component: 'platform-adapter', operation: 'send-click', stage: 'clicked', eventStatus: 'succeeded' })
  reporter.emit({ component: 'platform-adapter', operation: 'send-ack', stage: 'accepted', eventStatus: 'succeeded' })
  expect(sender).toHaveBeenCalledTimes(2)
  expect(sender.mock.calls.map(([message]) => message.event.runSequence)).toEqual([1, 2])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/unit/diagnostic-client.test.ts`

Expected: FAIL，reporter 模块不存在。

- [ ] **Step 3: 实现 fire-and-forget reporter**

```ts
export interface DiagnosticReporter {
  emit(event: Omit<DiagnosticEventDraft,
    'schemaVersion' | 'timestamp' | 'batchId' | 'platformRunId' | 'attempt' | 'runSequence' | 'platform'>): void
}

export function createDiagnosticReporter(
  context: DiagnosticContext,
  platform: AIPlatform,
  sender = (message: unknown) => chrome.runtime.sendMessage(message),
): DiagnosticReporter {
  let runSequence = 0
  return {
    emit(event) {
      runSequence += 1
      void sender({
        type: 'diagnostic:append',
        event: { ...event, ...context, platform, runSequence, timestamp: Date.now(), schemaVersion: 1 },
      }).catch(() => undefined)
    },
  }
}
```

- [ ] **Step 4: 给消息链增加诊断上下文**

把 `DiagnosticContext` 加入 iframe `postMessage` payload 和官方标签页 `SwToContent` 的 `write-and-send` 消息。`onSend()` 创建一个 `batchId`，为每个平台创建 `platformRunId` 和 `attempt: 1`。只有 `userSettings.diagnosticEnabled` 为 true 时才附带诊断上下文；关闭时 content script 不创建 reporter。禁止把 prompt、imageDataUrl、imageName 传入诊断 reporter。

让 `iframeWriteResultTimeoutMs()` 的调用方在超时时返回稳定的 `iframe-result-timeout`，官方标签页不存在映射为 `official-tab-unavailable`，runtime 失联按固定规则映射，不把原始错误透传给诊断模块。补充路由测试验证错误码。

扩展 `ConversationState`：

```ts
export interface ConversationState {
  status: StreamStatus
  lastResponse?: string
  errorMessage?: string
  stopButtonDetected?: boolean
}
```

五个平台的 `getConversationState()` 返回真实停止按钮检测值；Claude 基于近期 DOM 变化推断 streaming 时 `stopButtonDetected` 必须为 false，不能把推断状态冒充停止按钮。

把 selector loader 改为返回版本信息：

```ts
export interface LoadedSelectorConfig {
  selectors?: SelectorOverrideMap
  version: string
}
```

有远程配置时使用远程 `version`，否则使用各 adapter `selectors.json` 的本地版本。reporter 的安全字段增加 `selectorConfigVersion`，只允许符合版本格式的短字符串。

- [ ] **Step 5: 先为 ChatGPT 写失败测试并完成发送阶段记录**

测试至少断言：input-locate、input-write、send-click、send-ack、最终失败映射；原始异常 `PRIVATE_PROMPT` 不进入 reporter payload。然后在 ChatGPT adapter 中围绕 `writeText`、附件准备、按钮等待、每次按钮重试和确认结果发事件。

- [ ] **Step 6: 按同一接口接入 Gemini、Claude、豆包和 DeepSeek**

每个平台只记录实际存在的步骤。无附件时附件准备使用 `eventStatus: 'skipped'`；DeepSeek 的 Enter 重试使用 `retryNumber`，不增加完整链路 `attempt`。所有 catch 只调用 `mapDiagnosticError()`，不发送 `String(error)`。

- [ ] **Step 7: 运行五个平台 adapter 测试**

Run: `npm test -- tests/unit/diagnostic-client.test.ts tests/unit/chatgpt-adapter.test.ts tests/unit/gemini-adapter.test.ts tests/unit/claude-adapter.test.ts tests/unit/doubao-adapter.test.ts tests/unit/deepseek-adapter.test.ts tests/unit/platform-message-route.test.ts tests/unit/remote-selector-config.test.ts`

Expected: PASS；现有发送行为断言保持不变，新断言覆盖诊断阶段。

- [ ] **Step 8: 提交全平台发送诊断**

```bash
git add src/lib/diagnostic-client.ts src/lib/remote-selector-config.ts src/content-scripts/selector-overrides.ts src/adapters/base.ts src/adapters/chatgpt/adapter.ts src/adapters/gemini/adapter.ts src/adapters/claude/adapter.ts src/adapters/doubao/adapter.ts src/adapters/deepseek/adapter.ts src/content-scripts/chatgpt-content.ts src/content-scripts/gemini-content.ts src/content-scripts/claude-content.ts src/content-scripts/doubao-content.ts src/content-scripts/deepseek-content.ts src/shared/messages.ts src/types/index.ts src/background/service-worker.ts src/chat/chat.ts src/chat/platform-message-route.ts tests/unit/diagnostic-client.test.ts tests/unit/chatgpt-adapter.test.ts tests/unit/gemini-adapter.test.ts tests/unit/claude-adapter.test.ts tests/unit/doubao-adapter.test.ts tests/unit/deepseek-adapter.test.ts tests/unit/platform-message-route.test.ts tests/unit/remote-selector-config.test.ts
git commit -m "feat: trace send stages across all AI platforms"
```

提交前运行 `git diff --cached --name-only`，确认没有把无关文件或用户未完成的其它改动误带入；如果 `chat.ts`、路由文件与现有修改重叠，按函数级别暂存而不是覆盖。

---

### Task 6: 回答状态变化、稀疏检查点和最终错误原因

**Files:**
- Create: `src/chat/response-diagnostic.ts`
- Modify: `src/chat/chat.ts`
- Modify: `src/types/index.ts`
- Test: `tests/unit/response-diagnostic.test.ts`
- Test: `tests/unit/response-capture.test.ts`

**Interfaces:**
- Consumes: `DiagnosticReporter`, `ConversationState`, baseline lengths and response capture decisions。
- Produces: `createResponseDiagnosticTracker(reporter, startedAt)` with `observe()` and `finish()`。

- [ ] **Step 1: 写失败测试覆盖去重、检查点和最终统计**

```ts
it('emits state changes and sparse checkpoints but not every poll', () => {
  const tracker = createResponseDiagnosticTracker(reporter, 0)
  tracker.observe({ now: 3_000, status: 'streaming', responseLength: 10, baselineLength: 0, stopButtonDetected: true })
  tracker.observe({ now: 4_000, status: 'streaming', responseLength: 20, baselineLength: 0, stopButtonDetected: true })
  tracker.observe({ now: 5_000, status: 'streaming', responseLength: 30, baselineLength: 0, stopButtonDetected: true })
  expect(reporter.emit).toHaveBeenCalledTimes(2) // first state + 5s checkpoint
})

it('records a specific capture timeout summary without response text', () => {
  tracker.finish({ outcome: 'timed-out', errorCode: 'response-capture-timeout', now: 60_000 })
  expect(reporter.emit).toHaveBeenLastCalledWith(expect.objectContaining({
    runOutcome: 'timed-out', pollCount: 3, lastObservedState: 'streaming',
  }))
  expect(JSON.stringify(reporter.emit.mock.calls)).not.toContain('完整回答')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/unit/response-diagnostic.test.ts`

Expected: FAIL，tracker 模块不存在。

- [ ] **Step 3: 实现 tracker**

```ts
const CHECKPOINTS_MS = [5_000, 15_000, 30_000, 60_000]

export function createResponseDiagnosticTracker(reporter: DiagnosticReporter, startedAt: number) {
  let pollCount = 0
  let stateChangeCount = 0
  let lastStatus: StreamStatus | undefined
  const emittedCheckpoints = new Set<number>()
  return {
    observe(input: ResponseObservation) {
      pollCount += 1
      const elapsed = input.now - startedAt
      const statusChanged = input.status !== lastStatus
      if (statusChanged) stateChangeCount += 1
      const checkpoint = CHECKPOINTS_MS.find((value) => elapsed >= value && !emittedCheckpoints.has(value))
      if (statusChanged || checkpoint !== undefined) reporter.emit(toSafeObservation(input, checkpoint))
      if (checkpoint !== undefined) emittedCheckpoints.add(checkpoint)
      lastStatus = input.status
    },
    finish(input: ResponseFinish) {
      reporter.emit({ ...toSafeFinish(input), pollCount, stateChangeCount, lastObservedState: lastStatus })
    },
  }
}
```

同一文件中明确定义输入类型：

```ts
export interface ResponseObservation {
  now: number
  status: StreamStatus
  responseLength: number
  baselineLength: number
  stopButtonDetected: boolean
}

export interface ResponseFinish {
  now: number
  outcome: DiagnosticRunOutcome
  errorCode?: DiagnosticErrorCode
}
```

- [ ] **Step 4: 接入 backfill 链路**

在 `scheduleSessionResponseBackfill()` 和 `backfillSessionResponses()` 传递每平台 reporter/tracker，并维护当前活跃 `platformRunId` 集合供导出时判断 abandoned。将当前 `backfill-timeout` 对应为 `response-capture-timeout`；state 请求无响应对应 `state-request-timeout`；文本为空、等于 baseline、仍 streaming 分别记录固定原因。`stopButtonDetected` 使用 Task 5 新增的明确字段。不要改变当前 3 秒轮询、20 次上限和完成判断。

- [ ] **Step 5: 运行回答抓取测试**

Run: `npm test -- tests/unit/response-diagnostic.test.ts tests/unit/response-capture.test.ts tests/unit/session-record.test.ts tests/unit/send-lock.test.ts`

Expected: PASS，现有发送锁和历史回填行为不变。

- [ ] **Step 6: 提交回答诊断**

```bash
git add src/chat/response-diagnostic.ts src/chat/chat.ts src/types/index.ts tests/unit/response-diagnostic.test.ts tests/unit/response-capture.test.ts
git commit -m "feat: diagnose response capture outcomes"
```

---

### Task 7: 诊断设置、分组查看、预览、复制、下载和清空

**Files:**
- Create: `src/lib/diagnostic-export.ts`
- Modify: `src/chat/chat.html`
- Modify: `src/chat/chat.css`
- Modify: `src/chat/chat.ts`
- Modify: `src/lib/i18n.ts`
- Test: `tests/unit/chat-html.test.ts`
- Create: `tests/unit/diagnostic-export.test.ts`

**Interfaces:**
- Consumes: Task 2 export serializer、Task 3 snapshot/clear runtime messages、Task 4 settings。
- Produces: `PreparedDiagnosticExport`、`prepareDiagnosticExport()`、设置页 UI 和相同字节的 preview/copy/download 字符串。

- [ ] **Step 1: 写 HTML 失败测试**

```ts
it('renders local diagnostic controls and privacy disclosure', () => {
  document.body.innerHTML = html
  expect(document.querySelector('#setting-diagnostic-enabled')).toBeTruthy()
  expect(document.querySelector('#btn-diagnostic-view')).toBeTruthy()
  expect(document.querySelector('#btn-diagnostic-copy-failure')).toBeTruthy()
  expect(document.querySelector('#btn-diagnostic-download')).toBeTruthy()
  expect(document.querySelector('#btn-diagnostic-clear')).toBeTruthy()
  expect(document.querySelector('#diagnostic-export-preview')).toBeInstanceOf(HTMLTextAreaElement)
  expect(document.querySelector('#diagnostic-local-disclosure')?.textContent).toContain('只保存在本机')
})
```

- [ ] **Step 2: 写导出一致性失败测试**

```ts
it('reuses one serialized string for preview copy and download', async () => {
  const prepared = prepareDiagnosticExport(payload)
  expect(prepared.previewText).toBe(prepared.clipboardText)
  expect(await prepared.blob.text()).toBe(prepared.previewText)
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test -- tests/unit/chat-html.test.ts tests/unit/diagnostic-export.test.ts`

Expected: FAIL，因为控件和 export helper 尚不存在。

- [ ] **Step 4: 实现诊断设置区域**

在现有 diagnostics panel 中增加开关、统计、按 batch/run 折叠列表、摘要和只读 `<textarea>`。所有可变内容用 `textContent` 或 `textarea.value`，禁止 `innerHTML`。首次提示通过 `diagnosticNoticeVersionSeen` 控制；关闭开关时询问保留或清空已有记录。

- [ ] **Step 5: 实现同一字符串的预览、复制和 Blob 下载**

```ts
function prepareDiagnosticExport(payload: DiagnosticExportPayload) {
  const text = serializeDiagnosticExport(payload)
  return {
    previewText: text,
    clipboardText: text,
    blob: new Blob([text], { type: 'application/json;charset=utf-8' }),
  }
}
```

把函数放在 `src/lib/diagnostic-export.ts` 并导出明确类型：

```ts
export interface PreparedDiagnosticExport {
  previewText: string
  clipboardText: string
  blob: Blob
}

export function prepareDiagnosticExport(payload: DiagnosticExportPayload): PreparedDiagnosticExport
```

点击下载时创建 object URL、触发 `<a download>`、删除元素并立即 `URL.revokeObjectURL(url)`。文件名使用 `chatduel-diagnostics-YYYY-MM-DD.json`，不调用 `chrome.downloads`。

- [ ] **Step 6: 实现最近最终失败批次筛选和清空**

最近失败只匹配 run 最终 outcome 为 failed/timed-out/interrupted；attempt 失败后恢复成功的批次不匹配。导出命中 run 的完整 batch。清空前调用 `confirm()`，确认后发送 `diagnostic:clear` 并刷新计数。

- [ ] **Step 7: 添加中文和现有全部语言的文案键**

为本地记录开关、隐私说明、查看、最近失败、预览、复制、下载、清空、无记录、未观测终结、截断和写入失败状态增加 i18n 键；中文使用用户确认的隐私表达，其他语言使用准确直译，不改现有 key。

- [ ] **Step 8: 运行 UI 测试**

Run: `npm test -- tests/unit/chat-html.test.ts tests/unit/diagnostic-export.test.ts tests/unit/user-settings.test.ts`

Expected: PASS。

- [ ] **Step 9: 提交诊断 UI**

```bash
git add src/lib/diagnostic-export.ts src/chat/chat.html src/chat/chat.css src/chat/chat.ts src/lib/i18n.ts tests/unit/chat-html.test.ts tests/unit/diagnostic-export.test.ts
git commit -m "feat: add local diagnostic viewer and export"
```

---

### Task 8: 隐私披露、清单校验和全量验证

**Files:**
- Modify: `docs/store/privacy-policy.md`
- Modify: `tests/unit/chat-html.test.ts`
- Create: `tests/unit/diagnostic-manifest.test.ts`

**Interfaces:**
- Consumes: 完成后的诊断字段、保留上限和 UI 文案。
- Produces: 与扩展行为一致的商店隐私披露和权限回归测试。

- [ ] **Step 1: 写 manifest 失败测试**

```ts
it('does not add permissions or diagnostic upload hosts', () => {
  const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../manifest.json'), 'utf8'))
  expect(manifest.permissions).not.toContain('downloads')
  expect(JSON.stringify(manifest)).not.toContain('diagnostic-upload')
})
```

- [ ] **Step 2: 更新隐私政策**

在“扩展在本地保存的内容”中明确增加：技术阶段、稳定错误码、等待时间、状态、版本、有限字符数；说明不含正文/摘要/哈希/附件名/URL/账号数据；说明默认开启、用户可关闭/清空、最多 7 天及硬上限、不会自动上传、只有用户主动复制或下载才离开设备。

将现有“请替换为你的联系邮箱”占位符替换为用户提供的正式联系邮箱；如果实施时仍未提供邮箱，停止此步骤并向用户索取，不能带占位符发布。

- [ ] **Step 3: 运行针对性测试**

Run: `npm test -- tests/unit/diagnostic-types.test.ts tests/unit/diagnostic-retention.test.ts tests/unit/diagnostic-writer.test.ts tests/unit/diagnostic-client.test.ts tests/unit/response-diagnostic.test.ts tests/unit/diagnostic-export.test.ts tests/unit/user-settings.test.ts tests/unit/chat-html.test.ts tests/unit/diagnostic-manifest.test.ts`

Expected: PASS。

- [ ] **Step 4: 运行类型检查、全量测试和构建**

Run: `npm run typecheck`

Expected: PASS，无 TypeScript 错误。

Run: `npm test`

Expected: PASS，全部 Vitest 测试通过。

Run: `npm run build`

Expected: PASS，Vite/CRX 构建完成。

- [ ] **Step 5: 人工检查构建产物和日志隐私**

在开发版扩展执行一次五平台群发和一次人为制造的 iframe 超时，确认：

- 正常发送未因诊断写入变慢或失败。
- 设置页按 batch/run 展示完整轨迹。
- JSON 不含实际问题、回答、附件名、URL 或原始错误。
- 最近失败导出包含完整批次和失败平台标记。
- 关闭记录后不再新增事件，重新加载扩展仍保持关闭。

- [ ] **Step 6: 提交隐私和验证改动**

```bash
git add docs/store/privacy-policy.md tests/unit/diagnostic-manifest.test.ts tests/unit/chat-html.test.ts
git commit -m "docs: disclose local diagnostic records"
```

---

## Final Review Checklist

- [ ] `git status --short` 只显示预期改动；用户原有未提交修改均被保留。
- [ ] 每个持久化事件都有 `schemaVersion`、`batchId`、`platformRunId`、`runSequence`、`storageSequence`。
- [ ] Service Worker 重启测试证明序号严格续接。
- [ ] 五个平台都有发送阶段和回答结果记录。
- [ ] storage/schema 内部错误不会递归写入。
- [ ] 单 run、单 batch、总量、体积和时间限制全部有测试。
- [ ] 预览、复制、下载复用相同字符串。
- [ ] manifest 没有新增权限或上传域名。
- [ ] 隐私政策、设置页说明和实际字段一致。
- [ ] `npm run typecheck`、`npm test`、`npm run build` 全部通过。
