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
- Create `src/lib/diagnostic-client.ts`: 生产者侧 fire-and-forget reporter 和 `producerSequence` 管理。
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

### Task 0: 工作区基线与现有行为确认

**Files:**
- Read only: `src/background/service-worker.ts`
- Read only: `src/chat/chat.ts`
- Read only: `src/chat/platform-message-route.ts`
- Read only: `src/background/embed-rule-lifecycle.ts`
- Read only: `manifest.json`

**Interfaces:**
- Produces: 当前用户改动清单、现有测试/类型/构建基线、现有权限精确基线。
- Consumes: 无。

- [ ] **Step 1: 阅读并记录工作区现有改动**

Run: `git status --short`

Run: `git diff -- src/background/service-worker.ts src/chat/chat.ts src/chat/platform-message-route.ts src/background/embed-rule-lifecycle.ts`

Expected: 看清并保留用户当前四处改动；不 stash、不 reset、不 restore。

- [ ] **Step 2: 记录源码 manifest 精确权限基线**

Run: `node -e "const m=require('./manifest.json'); console.log(JSON.stringify({permissions:[...(m.permissions||[])].sort(),host_permissions:[...(m.host_permissions||[])].sort(),optional_permissions:[...(m.optional_permissions||[])].sort()},null,2))"`

Expected: 输出当前权限集合，后续 Task 8 逐项比较，不能只检查某个字符串。

- [ ] **Step 3: 运行实现前基线验证**

Run: `npm run typecheck`

Run: `npm test`

Run: `npm run build`

Expected: 三条命令均 PASS；如果现有工作区已经失败，先记录原始失败并向用户报告，不把它误归因于诊断功能。

- [ ] **Step 4: 确认设置保存和五平台 adapter 基线**

Run: `npm test -- tests/unit/user-settings.test.ts tests/unit/chatgpt-adapter.test.ts tests/unit/gemini-adapter.test.ts tests/unit/claude-adapter.test.ts tests/unit/doubao-adapter.test.ts tests/unit/deepseek-adapter.test.ts`

Expected: PASS。Task 0 不修改文件、不创建提交。

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
      producerId: 'chat-ui',
      producerSequence: 2,
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
      producerId: 'chat-ui',
      producerSequence: 2,
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
export const DIAGNOSTIC_ABANDONED_AFTER_MS = 10 * 60 * 1000
export const MAX_CHARACTER_COUNT = 100_000
export const MAX_DIAGNOSTIC_ID_LENGTH = 80
export const MAX_SELECTOR_VERSION_LENGTH = 40
export const MAX_PRODUCER_SEQUENCE = 100_000
export const MAX_STORAGE_SEQUENCE = Number.MAX_SAFE_INTEGER
export const MAX_WAIT_MS = 3_600_000
export const MAX_RETRY_COUNT = 100

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
}

export type DiagnosticProducerId = string

export interface DiagnosticEventDraft extends DiagnosticContext {
  schemaVersion: 1
  timestamp: number
  producerId: DiagnosticProducerId
  producerSequence: number
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

实现 `sanitizeDiagnosticEventDraft(value: unknown): DiagnosticEventDraft | null` 时逐字段构造新对象；禁止对象展开、禁止保存未知 key、禁止保存原始 `Error.message`。ID 只接受 1–80 个 `[A-Za-z0-9_-]` 字符；selector 版本只接受 1–40 个版本安全字符；`producerSequence` 限制 1–100000，长期持久化的 `storageSequence` 接受 1 到 `Number.MAX_SAFE_INTEGER`；等待时间限制 0–3600000；重试数限制 0–100。不能把 `storageSequence` 也限制为 100000，否则长期使用且未手动清空的用户最终会无法续号。`DiagnosticProducerId` 在 TypeScript 中虽是 string，但只能由 Task 5A 的工厂生成并再次经过 sanitizer，不能接受页面输入。明确业务分支由调用方直接给稳定错误码，只有 extension context invalidated、message port closed、tab missing 等 Chrome 异常才交给 `mapDiagnosticError()` 做少量匹配，其余返回 `unexpected-error`。

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
- Produces: `DiagnosticEnvelope`、`createEmptyDiagnosticEnvelope()`、`sanitizeDiagnosticEnvelope()`、`appendDiagnosticEvents()`、`deriveDiagnosticExport()`、`serializeDiagnosticExport()`。淘汰函数是 retention 模块内部实现，不暴露孤立的公开接口。

- [ ] **Step 1: 写失败测试覆盖完整批次淘汰和异常膨胀**

```ts
const NOW = 1_000_000

const makeEnvelope = (events: DiagnosticEvent[] = []): DiagnosticEnvelope => ({
  schemaVersion: 1,
  nextStorageSequence: events.length + 1,
  events,
  truncation: { runs: {}, batches: {} },
})

const event = (
  batchId: string,
  platformRunId: string,
  storageSequence: number,
  overrides: Partial<DiagnosticEvent> = {},
): DiagnosticEvent => ({
  schemaVersion: 1,
  timestamp: NOW - 1_000 + storageSequence,
  batchId,
  platformRunId,
  producerId: 'response-capture',
  producerSequence: storageSequence,
  storageSequence,
  extensionVersion: '0.4.13',
  platform: 'chatgpt',
  component: 'response-capture',
  operation: 'state-read',
  stage: 'state-changed',
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
  }, NOW)
  expect(next.events.map((item) => item.batchId)).toEqual(['batch-new', 'batch-latest'])
})

it('folds an oversized run and preserves its terminal outcome', () => {
  const events = Array.from({ length: 70 }, (_, index) =>
    event('batch-1', 'run-1', index + 1, index === 69 ? { runOutcome: 'timed-out' } : {}))
  const next = appendDiagnosticEvents(makeEnvelope(), events, DEFAULT_DIAGNOSTIC_LIMITS, NOW)
  expect(next.events.filter((item) => item.platformRunId === 'run-1').length).toBeLessThanOrEqual(50)
  expect(next.events.some((item) => item.runOutcome === 'timed-out')).toBe(true)
  expect(next.truncation.runs['run-1']).toMatchObject({ eventsTruncated: true, droppedEventCount: 20 })
})

it('derives abandoned without forging a stored event', () => {
  const stored = makeEnvelope([event('batch-1', 'run-1', 1, { timestamp: 0 })])
  const exported = deriveDiagnosticExport(stored, {
    now: DIAGNOSTIC_ABANDONED_AFTER_MS + 1,
    activePlatformRunIds: new Set(),
  })
  expect(exported.batches[0].runs[0].derivedOutcome).toBe('abandoned')
  expect(stored.events[0].runOutcome).toBeUndefined()
})

it('uses response capture as terminal owner after send acceptance', () => {
  const stored = makeEnvelope([
    event('batch-1', 'run-1', 1, { operation: 'send-ack', stage: 'accepted', eventStatus: 'succeeded' }),
    event('batch-1', 'run-1', 2, { component: 'platform-adapter', runOutcome: 'failed', stage: 'failed' }),
    event('batch-1', 'run-1', 3, { component: 'response-capture', runOutcome: 'completed', stage: 'completed' }),
  ])
  const exported = deriveDiagnosticExport(stored, { now: NOW, activePlatformRunIds: new Set() })
  expect(exported.batches[0].runs[0].finalOutcome).toBe('completed')
  expect(exported.batches[0].runs[0].structuralWarnings).toContain('invalid-terminal-owner')
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
  truncation: {
    runs: Record<string, { eventsTruncated: true; droppedEventCount: number }>
    batches: Record<string, { eventsTruncated: true; droppedEventCount: number; droppedRunCount?: number }>
  }
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
  derivedOutcome?: 'abandoned'
  derivedReason?: 'missing-terminal-event'
  structuralWarnings: Array<'invalid-terminal-owner' | 'multiple-terminal-events'>
  events: DiagnosticEvent[]
}

export interface DiagnosticExportPayload {
  exportSchemaVersion: 1
  exportedAt: number
  extensionVersion: string
  notice: 'Diagnostic events are partial technical observations, not a complete conversation snapshot.'
  retention: {
    maxAgeDays: 7
    maxBatches: 20
    maxRuns: 100
    maxEvents: 1000
    maxBytes: 1_000_000
  }
  fieldDefinitionsVersion: 1
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

每个写入批次只对不超过 1 MB 的候选 envelope 做一次 `TextEncoder().encode(JSON.stringify(value)).byteLength` 检查。截断优先级固定为：终结 > 失败/超时 > 每个 producer 起始 > 状态变化 > 首次检查点 > 最新普通事件；删除 batch 时同步删除 run/batch 截断元数据。`latestFailureOnly` 只匹配最终 outcome 为 failed/timed-out/interrupted 的 run，然后返回其完整 batch；paused、abandoned 和步骤内部重试不算最终失败。

发送确认前由发送链路拥有终结权；出现 send-ack/accepted 后，只有 response-capture 可以提供最终 outcome。导出时校验所有权和终结数量，结构冲突写入 `structuralWarnings`，不简单取最后一条。

`sanitizeDiagnosticEnvelope(value)` 必须覆盖非对象、缺失/未知 schema、events 非数组、损坏 truncation、重复或负 storageSequence、部分非法事件，以及 `nextStorageSequence` 小于已保存最大序号的情况；返回值把下一个序号修正为 `max(storedNext, maxSequence + 1)`。

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
- Produces: `createDiagnosticWriter(storage, extensionVersion, warn)` with `append()`, `summary()`, `snapshot()`, `clear()`, `getInternalStatus()`。
- Runtime messages: `diagnostic:append`, `diagnostic:summary`, `diagnostic:snapshot`, `diagnostic:clear`。`diagnostic:summary` 只返回数量、最早时间、最近失败是否存在和 `getInternalStatus()`，不返回完整事件数组。

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

it('reports a schema failure in memory without trying to persist that failure', async () => {
  const writer = createDiagnosticWriter(storage, '0.4.13', warn)
  await expect(writer.append({ schemaVersion: 1, rawError: 'PRIVATE_PROMPT' })).resolves.toEqual({ ok: false })
  expect(storage.set).not.toHaveBeenCalled()
  expect(writer.getInternalStatus()).toMatchObject({ schemaError: true })
})

it('falls back safely from a damaged envelope', async () => {
  storage.get.mockResolvedValue({ diagnosticLog: { schemaVersion: 999, events: 'broken' } })
  const writer = createDiagnosticWriter(storage, '0.4.13', warn)
  await writer.append(draft(1))
  expect((await writer.snapshot()).events).toHaveLength(1)
  expect((await writer.snapshot()).events[0].storageSequence).toBe(1)
})

it('serializes append snapshot and clear on one command queue', async () => {
  const writer = createDiagnosticWriter(storage, '0.4.13', warn)
  const beforeClear = writer.append(draft(1))
  const clear = writer.clear()
  const afterClear = writer.append(draft(2))
  await Promise.all([beforeClear, clear, afterClear])
  const snapshot = await writer.snapshot()
  expect(snapshot.events).toHaveLength(1)
  expect(snapshot.events[0].storageSequence).toBe(1)
})

it('returns a summary without exposing the full event array', async () => {
  const writer = createDiagnosticWriter(storage, '0.4.13', warn)
  await writer.append(draft(1))
  const summary = await writer.summary()
  expect(summary).toMatchObject({ eventCount: 1 })
  expect(summary).not.toHaveProperty('events')
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
  let commandChain = Promise.resolve()
  let cachedEnvelope: DiagnosticEnvelope | null = null
  let lastWarningAt = { schema: 0, storage: 0 }
  let internalStatus = { schemaError: false, storageError: false }

  const warnLimited = (kind: 'schema' | 'storage') => {
    const now = Date.now()
    if (now - lastWarningAt[kind] < 30_000) return
    lastWarningAt[kind] = now
    warn(kind === 'schema'
      ? '[ChatDuel diagnostic] invalid event dropped'
      : '[ChatDuel diagnostic] local write failed')
  }

  const loadEnvelope = async () => {
    if (cachedEnvelope) return cachedEnvelope
    const stored = await storage.get(DIAGNOSTIC_STORAGE_KEY)
    cachedEnvelope = sanitizeDiagnosticEnvelope(stored[DIAGNOSTIC_STORAGE_KEY])
      ?? createEmptyDiagnosticEnvelope()
    return cachedEnvelope
  }

  const enqueue = <T>(command: () => Promise<T>): Promise<T> => {
    const result = commandChain.then(command)
    commandChain = result.then(() => undefined, () => undefined)
    return result
  }

  const append = (value: unknown): Promise<{ ok: boolean }> => {
    const sanitized = sanitizeDiagnosticEventDraft(value)
    if (!sanitized) {
      internalStatus.schemaError = true
      warnLimited('schema')
      return Promise.resolve({ ok: false })
    }
    return enqueue(async () => {
      try {
        const envelope = await loadEnvelope()
        const storageSequence = envelope.nextStorageSequence
        const next = appendDiagnosticEvents(envelope, [{
          ...sanitized,
          storageSequence,
          extensionVersion,
        }])
        next.nextStorageSequence = storageSequence + 1
        await storage.set({ [DIAGNOSTIC_STORAGE_KEY]: next })
        cachedEnvelope = next
        return { ok: true }
      } catch {
        internalStatus.storageError = true
        warnLimited('storage')
        return { ok: false }
      }
    })
  }

  const summary = () => enqueue(async () => summarizeDiagnosticEnvelope(await loadEnvelope()))
  const snapshot = () => enqueue(async () => structuredClone(await loadEnvelope()))
  const clear = () => enqueue(async () => {
    await storage.remove(DIAGNOSTIC_STORAGE_KEY)
    cachedEnvelope = createEmptyDiagnosticEnvelope()
    return { ok: true }
  })
  const getInternalStatus = () => ({ ...internalStatus })
  return { append, summary, snapshot, clear, getInternalStatus }
}
```

事件已经按状态变化和稀疏检查点降频，不实现跨 runtime message 的定时合并。append、summary、snapshot 和 clear 都通过 `enqueue()` 进入同一命令链；clear 删除其之前的全部事件、重建 `nextStorageSequence: 1` 的空 envelope，之后入队的 append 正常保留。`getInternalStatus()` 只返回当前生命周期是否发生过 schema/storage 错误，不把错误再次写入诊断 storage，并通过 `diagnostic:summary` 在 Task 7 的诊断 UI 中展示。

Service Worker 的 `diagnostic:append` 分支在 writer 完成后调用 `sendResponse` 并返回 `true`；生产者不会 await 该响应，因此业务不阻塞，但 Chrome 会保持后台消息任务存活。

- [ ] **Step 4: 注册 runtime 消息并保留当前未提交的 DNR 改动**

在 `src/background/service-worker.ts` 顶部创建单例 writer；在现有 `chrome.runtime.onMessage` 中只增加四个分支，不改动 `enable-embed-rules`、`disable-embed-rules` 和 `official-tab-command` 的现有逻辑。

- [ ] **Step 5: 运行 writer 和现有后台相关测试**

Run: `npm test -- tests/unit/diagnostic-writer.test.ts tests/unit/platform-message-route.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交后台 writer**

```bash
git add src/background/diagnostic-writer.ts src/shared/messages.ts tests/unit/diagnostic-writer.test.ts
git add -p src/background/service-worker.ts
git commit -m "feat: persist diagnostics through one background writer"
```

提交前用 `git diff --cached -- src/background/service-worker.ts` 核对只暂存诊断 writer 注册；现有 DNR 生命周期改动继续保留在工作区。

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

### Task 5A: 诊断 reporter 与上下文跨层传递

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
- Test: `tests/unit/diagnostic-client.test.ts`
- Test: `tests/unit/platform-message-route.test.ts`
- Test: `tests/unit/remote-selector-config.test.ts`

**Interfaces:**
- Consumes: Task 1 types and Task 3 runtime append message。
- Produces: `DiagnosticReporter`、`createDiagnosticProducerId(role)` and `createDiagnosticReporter(context, platform, producerId, sender)`。
- Changes: `AIAdapter.sendMessage(text, image?, diagnostics?)`。
- Changes: `ConversationState.stopButtonDetected?: boolean` and selector loader returns `{ selectors, version }`。

- [ ] **Step 1: 写 reporter 失败测试**

```ts
it('increments producer sequence and never waits for runtime persistence', () => {
  const sender = vi.fn(() => Promise.resolve({ ok: true }))
  const reporter = createDiagnosticReporter(context, 'chatgpt', 'p_adapter_1', sender)
  reporter.emit({ component: 'platform-adapter', operation: 'send-click', stage: 'clicked', eventStatus: 'succeeded' })
  reporter.emit({ component: 'platform-adapter', operation: 'send-ack', stage: 'accepted', eventStatus: 'succeeded' })
  expect(sender).toHaveBeenCalledTimes(2)
  expect(sender.mock.calls.map(([message]) => message.event.producerSequence)).toEqual([1, 2])
})

it('creates a distinct producer id for every reporter instance', () => {
  expect(createDiagnosticProducerId('adapter')).not.toBe(createDiagnosticProducerId('adapter'))
})

it('never throws when runtime messaging throws synchronously', () => {
  const sender = vi.fn(() => { throw new Error('Extension context invalidated') })
  const reporter = createDiagnosticReporter(context, 'chatgpt', 'p_chat_1', sender)
  expect(() => reporter.emit({
    component: 'chat-ui', operation: 'route-select', stage: 'started', eventStatus: 'observed',
  })).not.toThrow()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/unit/diagnostic-client.test.ts`

Expected: FAIL，reporter 模块不存在。

- [ ] **Step 3: 实现 fire-and-forget reporter**

```ts
export interface DiagnosticReporter {
  emit(event: Omit<DiagnosticEventDraft,
    'schemaVersion' | 'timestamp' | 'batchId' | 'platformRunId' | 'producerId' | 'producerSequence' | 'platform'>): void
}

export function createDiagnosticProducerId(role: string): DiagnosticProducerId {
  return `p_${role}_${crypto.randomUUID()}`
}

export function createDiagnosticReporter(
  context: DiagnosticContext,
  platform: AIPlatform,
  producerId: DiagnosticProducerId,
  sender = (message: unknown) => chrome.runtime.sendMessage(message),
): DiagnosticReporter {
  let producerSequence = 0
  return {
    emit(event) {
      producerSequence += 1
      try {
        const result = sender({
          type: 'diagnostic:append',
          event: { ...event, ...context, platform, producerId, producerSequence, timestamp: Date.now(), schemaVersion: 1 },
        })
        void Promise.resolve(result).catch(() => undefined)
      } catch {
        // Extension context invalidated can throw synchronously; diagnostics must never affect sending.
      }
    },
  }
}
```

每次创建 reporter 时先创建一个 `producerId`，并在该 reporter 的整个生命周期中复用；不能把角色名本身当成 ID，也不能在每条事件上重新生成。角色信息由事件的 `component` 表达。这样不同执行上下文各自从 `producerSequence = 1` 开始时仍可区分，不会形成重复的 `(producerId, producerSequence)`。

- [ ] **Step 4: 给消息链增加诊断上下文**

把 `DiagnosticContext` 加入 iframe `postMessage` payload 和官方标签页 `SwToContent` 的 `write-and-send` 消息。`onSend()` 用 `crypto.randomUUID()` 创建 `b_<uuid>` 的 `batchId`，为每个平台创建 `r_<uuid>` 的 `platformRunId`。只有 `userSettings.diagnosticEnabled` 为 true 时才附带诊断上下文；关闭时 content script 不创建 reporter。禁止把 prompt、imageDataUrl、imageName 传入诊断 reporter。

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

- [ ] **Step 5: 运行 reporter、路由和 selector 配置测试**

Run: `npm test -- tests/unit/diagnostic-client.test.ts tests/unit/platform-message-route.test.ts tests/unit/remote-selector-config.test.ts`

Expected: PASS；现有发送行为断言保持不变，新断言覆盖诊断阶段。

- [ ] **Step 6: 提交 reporter 和上下文传递**

```bash
git add src/lib/diagnostic-client.ts src/lib/remote-selector-config.ts src/content-scripts/selector-overrides.ts src/adapters/base.ts src/shared/messages.ts src/types/index.ts tests/unit/diagnostic-client.test.ts tests/unit/platform-message-route.test.ts tests/unit/remote-selector-config.test.ts
git add -p src/background/service-worker.ts src/chat/chat.ts src/chat/platform-message-route.ts
git commit -m "feat: propagate diagnostic run context"
```

提交前运行 `git diff --cached --name-only`，确认没有把无关文件或用户未完成的其它改动误带入；如果 `chat.ts`、路由文件与现有修改重叠，按函数级别暂存而不是覆盖。

---

### Task 5B: ChatGPT 发送链端到端诊断

Task 5B–5F 统一采用以下 `skipped` 规则，避免各 adapter 自行解释：

| 阶段 | ChatGPT | Gemini | Claude | 豆包 | DeepSeek |
| --- | --- | --- | --- | --- | --- |
| 通用附件准备且本次无附件 | `skipped` | `skipped` | `skipped` | `skipped` | `skipped` |
| 本次有附件并执行附件准备 | 记录实际结果 | 记录实际结果 | 记录实际结果 | 记录实际结果 | 记录实际结果 |
| DeepSeek 识图模式 | 不生成事件 | 不生成事件 | 不生成事件 | 不生成事件 | 仅发送图片且实际需要检查/切换时记录 |

`skipped` 只用于“通用可选阶段已经被考虑，但本次无需执行”。平台根本不存在的阶段不生成事件；失败、未知和未观测状态均不能使用 `skipped`。

**Files:**
- Modify: `src/content-scripts/chatgpt-content.ts`
- Modify: `src/adapters/chatgpt/adapter.ts`
- Test: `tests/unit/chatgpt-adapter.test.ts`

**Interfaces:**
- Consumes: Task 5A `DiagnosticReporter`、诊断上下文和 selector 版本。
- Produces: ChatGPT 输入、附件、按钮重试、发送确认和发送前失败事件。

- [ ] **Step 1: 写 ChatGPT 失败测试**

测试 reporter 依次看到 input-locate、input-write、attachment-prepare、send-click 和 send-ack；首次点击未接受、第二次接受时 `retryNumber` 为 1/2，最终 `retryCount` 为 2。输入框不存在时由发送链写 `runOutcome: failed`；send-ack/accepted 后 adapter 不再写终结结果。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/unit/chatgpt-adapter.test.ts`

Expected: FAIL，新诊断事件尚未产生。

- [ ] **Step 3: 接入 ChatGPT adapter 和 content script**

`sendMessage(text, image, reporter?)` 在每个明确控制流分支直接写稳定错误码；只有 Chrome runtime 异常调用 `mapDiagnosticError()`。原始 `text`、文件名和 `String(error)` 不进入 reporter。无附件时唯一记录的 skipped 阶段是通用 `attachment-prepare`；不存在的 DeepSeek 识图步骤不在 ChatGPT 中生成 skipped 噪声。

- [ ] **Step 4: 运行 ChatGPT 测试并提交**

Run: `npm test -- tests/unit/chatgpt-adapter.test.ts tests/unit/diagnostic-client.test.ts`

Expected: PASS。

```bash
git add src/content-scripts/chatgpt-content.ts src/adapters/chatgpt/adapter.ts tests/unit/chatgpt-adapter.test.ts
git commit -m "feat: trace ChatGPT send diagnostics"
```

---

### Task 5C: Gemini 发送链诊断

**Files:**
- Modify: `src/content-scripts/gemini-content.ts`
- Modify: `src/adapters/gemini/adapter.ts`
- Test: `tests/unit/gemini-adapter.test.ts`

**Interfaces:**
- Consumes: Task 5A reporter contract。
- Produces: Gemini Quill 写入、附件路径、Enter 重试、按钮 fallback 和发送确认事件。

- [ ] **Step 1: 写 Gemini 失败测试**

覆盖 Enter 重试的 `retryNumber/retryCount`、paste/file-input 附件分支、无附件 skipped，以及最终接受后不由 adapter 写 runOutcome。

- [ ] **Step 2: 运行失败测试，最小接入并复测**

Run: `npm test -- tests/unit/gemini-adapter.test.ts`

Expected before implementation: FAIL。接入 reporter 后再次运行，Expected: PASS。

- [ ] **Step 3: 提交 Gemini 接入**

```bash
git add src/content-scripts/gemini-content.ts src/adapters/gemini/adapter.ts tests/unit/gemini-adapter.test.ts
git commit -m "feat: trace Gemini send diagnostics"
```

---

### Task 5D: Claude 发送链诊断

**Files:**
- Modify: `src/content-scripts/claude-content.ts`
- Modify: `src/adapters/claude/adapter.ts`
- Test: `tests/unit/claude-adapter.test.ts`

**Interfaces:**
- Consumes: Task 5A reporter contract。
- Produces: Claude 按钮/Enter fallback、上传等待和发送确认事件。

- [ ] **Step 1: 写 Claude 失败测试**

覆盖按钮点击后 composer 未清空、Enter fallback、三次步骤重试、最终 message-not-accepted，以及 accepted 后终结权转交 response tracker。

- [ ] **Step 2: 运行失败测试，最小接入并复测**

Run: `npm test -- tests/unit/claude-adapter.test.ts`

Expected before implementation: FAIL。接入 reporter 后再次运行，Expected: PASS。

- [ ] **Step 3: 提交 Claude 接入**

```bash
git add src/content-scripts/claude-content.ts src/adapters/claude/adapter.ts tests/unit/claude-adapter.test.ts
git commit -m "feat: trace Claude send diagnostics"
```

---

### Task 5E: 豆包发送链诊断

**Files:**
- Modify: `src/content-scripts/doubao-content.ts`
- Modify: `src/adapters/doubao/adapter.ts`
- Test: `tests/unit/doubao-adapter.test.ts`

**Interfaces:**
- Consumes: Task 5A reporter contract。
- Produces: 豆包 textarea/contenteditable、按钮或 Enter fallback、附件和发送结果事件。

- [ ] **Step 1: 写豆包失败测试**

覆盖 input-box-not-found、send-button-not-found、按钮存在、Enter fallback、附件 file-input/paste 分支和无附件 skipped。

- [ ] **Step 2: 运行失败测试，最小接入并复测**

Run: `npm test -- tests/unit/doubao-adapter.test.ts`

Expected before implementation: FAIL。接入 reporter 后再次运行，Expected: PASS。

- [ ] **Step 3: 提交豆包接入**

```bash
git add src/content-scripts/doubao-content.ts src/adapters/doubao/adapter.ts tests/unit/doubao-adapter.test.ts
git commit -m "feat: trace Doubao send diagnostics"
```

---

### Task 5F: DeepSeek 发送链诊断

**Files:**
- Modify: `src/content-scripts/deepseek-content.ts`
- Modify: `src/adapters/deepseek/adapter.ts`
- Test: `tests/unit/deepseek-adapter.test.ts`

**Interfaces:**
- Consumes: Task 5A reporter contract。
- Produces: DeepSeek 识图模式、附件准备、Enter 重试、按钮 fallback 和发送确认事件。

- [ ] **Step 1: 写 DeepSeek 失败测试**

覆盖图片模式校验、paste/file-input 附件分支、Enter 三次步骤重试、按钮 fallback、明确错误码和隐私诱饵。仅当发送图片且需要识图模式时记录该平台特有阶段；文本发送不生成“识图 skipped”。

- [ ] **Step 2: 运行失败测试，最小接入并复测**

Run: `npm test -- tests/unit/deepseek-adapter.test.ts`

Expected before implementation: FAIL。接入 reporter 后再次运行，Expected: PASS。

- [ ] **Step 3: 提交 DeepSeek 接入**

```bash
git add src/content-scripts/deepseek-content.ts src/adapters/deepseek/adapter.ts tests/unit/deepseek-adapter.test.ts
git commit -m "feat: trace DeepSeek send diagnostics"
```

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
    responseCharacterCount: 30, baselineCharacterCount: 0,
    differsFromBaseline: true, stopButtonDetected: true,
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

tracker 在内存中只保留最后一次 `ResponseObservation` 的安全字段，不保留回答文本。每条状态变化、稀疏检查点和最终事件都必须包含当时可用的 `responseCharacterCount`、`baselineCharacterCount`、`differsFromBaseline` 和 `stopButtonDetected`；`finish()` 没有任何观测时省略这些字段，不伪造 0 或 false。

- [ ] **Step 4: 接入 backfill 链路**

在 `scheduleSessionResponseBackfill()` 和 `backfillSessionResponses()` 传递每平台 reporter/tracker，并维护当前活跃 `platformRunId` 集合供导出时判断 abandoned。将当前 `backfill-timeout` 对应为 `response-capture-timeout`；state 请求无响应对应 `state-request-timeout`；文本为空、等于 baseline、仍 streaming 分别记录固定原因。`stopButtonDetected` 使用 Task 5 新增的明确字段。不要改变当前 3 秒轮询、20 次上限和完成判断。

发送层写入 `send-ack/accepted` 后终结权立即转交回答 tracker。发送确认前的失败由发送链终结；确认后的 completed、paused、failed、timed-out 或 interrupted 只能由 tracker 写入。`DIAGNOSTIC_ABANDONED_AFTER_MS` 只用于查看/导出时派生说明，不通过定时器补写终结事件。

- [ ] **Step 5: 运行回答抓取测试**

Run: `npm test -- tests/unit/response-diagnostic.test.ts tests/unit/response-capture.test.ts tests/unit/session-record.test.ts tests/unit/send-lock.test.ts`

Expected: PASS，现有发送锁和历史回填行为不变。

- [ ] **Step 6: 提交回答诊断**

```bash
git add src/chat/response-diagnostic.ts src/types/index.ts tests/unit/response-diagnostic.test.ts tests/unit/response-capture.test.ts
git add -p src/chat/chat.ts
git commit -m "feat: diagnose response capture outcomes"
```

提交前用 `git diff --cached -- src/chat/chat.ts` 核对只暂存回答诊断接入，不包含用户现有的其它 chat 页改动。

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
- Consumes: Task 2 export serializer、Task 3 summary/snapshot/clear runtime messages、Task 4 settings。
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

it('loads only a summary until the user expands or exports diagnostics', async () => {
  await openDiagnosticPanel()
  expect(sendRuntimeMessage).toHaveBeenCalledWith({ type: 'diagnostic:summary' })
  expect(sendRuntimeMessage).not.toHaveBeenCalledWith({ type: 'diagnostic:snapshot' })
  await clickViewDiagnostics()
  expect(sendRuntimeMessage).toHaveBeenCalledWith({ type: 'diagnostic:snapshot' })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test -- tests/unit/chat-html.test.ts tests/unit/diagnostic-export.test.ts`

Expected: FAIL，因为控件和 export helper 尚不存在。

- [ ] **Step 4: 实现诊断设置区域**

在现有 diagnostics panel 中增加开关、统计、按 batch/run 折叠列表、摘要和只读 `<textarea>`。打开设置区时只请求 `diagnostic:summary`；仅在用户点击“查看最近诊断”、展开批次、复制或下载时请求 `diagnostic:snapshot`。摘要同时显示 `getInternalStatus()` 暴露的当前后台生命周期写入状态。所有可变内容用 `textContent` 或 `textarea.value`，禁止 `innerHTML`。首次提示通过 `diagnosticNoticeVersionSeen` 控制；关闭开关时询问保留或清空已有记录。

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

点击下载时创建 object URL、触发 `<a download>`、删除元素并立即 `URL.revokeObjectURL(url)`。文件名使用 `chatduel-diagnostics-YYYY-MM-DD.json`，不调用 `chrome.downloads`。关闭预览、切换批次或清空记录时清除缓存的序列化字符串、Blob 和 textarea 内容；如果仍有未释放的 object URL，也必须释放，避免长 JSON 在页面生命周期内滞留。

- [ ] **Step 6: 实现最近最终失败批次筛选和清空**

最近失败只匹配 run 最终 outcome 为 failed/timed-out/interrupted；步骤内部重试后最终成功的批次不匹配。导出命中 run 的完整 batch。清空前调用 `confirm()`，确认后发送 `diagnostic:clear` 并刷新计数。

- [ ] **Step 7: 添加中文和现有全部语言的文案键**

为本地记录开关、隐私说明、查看、最近失败、预览、复制、下载、清空、无记录、未观测终结、截断和写入失败状态增加 i18n 键；中文使用用户确认的隐私表达，其他语言使用准确直译，不改现有 key。

- [ ] **Step 8: 运行 UI 测试**

Run: `npm test -- tests/unit/chat-html.test.ts tests/unit/diagnostic-export.test.ts tests/unit/user-settings.test.ts`

Expected: PASS。

- [ ] **Step 9: 提交诊断 UI**

```bash
git add src/lib/diagnostic-export.ts src/chat/chat.html src/chat/chat.css src/lib/i18n.ts tests/unit/chat-html.test.ts tests/unit/diagnostic-export.test.ts
git add -p src/chat/chat.ts
git commit -m "feat: add local diagnostic viewer and export"
```

提交前用 `git diff --cached -- src/chat/chat.ts` 核对只暂存诊断 UI，不包含用户现有的其它 chat 页改动。

---

### Task 8: 隐私披露、清单校验和全量验证

**Files:**
- Modify: `docs/store/privacy-policy.md`
- Modify: `tests/unit/chat-html.test.ts`
- Modify: `tests/unit/manifest.test.ts`

**Interfaces:**
- Consumes: 完成后的诊断字段、保留上限和 UI 文案。
- Produces: 与扩展行为一致的商店隐私披露和权限回归测试。

- [ ] **Step 1: 写 manifest 精确基线测试**

```ts
it('keeps the exact permission and host baseline', () => {
  expect([...manifest.permissions].sort()).toEqual([
    'alarms', 'declarativeNetRequest', 'storage', 'tabs', 'unlimitedStorage',
  ])
  expect([...(manifest.optional_permissions ?? [])].sort()).toEqual([])
  expect([...manifest.host_permissions].sort()).toEqual([
    'https://chat.deepseek.com/*',
    'https://chatduel.ifeeling.app/*',
    'https://chatgpt.com/*',
    'https://claude.ai/*',
    'https://doubao.com/*',
    'https://gemini.google.com/*',
    'https://www.doubao.com/*',
  ])
})
```

这是源码 `manifest.json` 的精确回归基线，不只检查某个假想上传域名是否缺失；任何新增权限或 host 都必须显式修改测试并重新审查用途。

- [ ] **Step 2: 更新隐私政策**

在“扩展在本地保存的内容”中明确增加：技术阶段、稳定错误码、等待时间、状态、版本、有限字符数；说明不含正文/摘要/哈希/附件名/URL/账号数据；说明默认开启、用户可关闭/清空、最多 7 天及硬上限、不会自动上传、只有用户主动复制或下载才离开设备。

将现有“请替换为你的联系邮箱”占位符替换为用户提供的正式联系邮箱。如果实施时仍未提供邮箱，只暂停隐私政策最终提交和商店发布；诊断代码、自动测试、类型检查和构建继续完成，不能因为文案占位符阻断技术验证，也不能带占位符发布。

- [ ] **Step 3: 运行针对性测试**

Run: `npm test -- tests/unit/diagnostic-types.test.ts tests/unit/diagnostic-retention.test.ts tests/unit/diagnostic-writer.test.ts tests/unit/diagnostic-client.test.ts tests/unit/response-diagnostic.test.ts tests/unit/diagnostic-export.test.ts tests/unit/user-settings.test.ts tests/unit/chat-html.test.ts tests/unit/manifest.test.ts`

Expected: PASS。

- [ ] **Step 4: 运行类型检查、全量测试和构建**

Run: `npm run typecheck`

Expected: PASS，无 TypeScript 错误。

Run: `npm test`

Expected: PASS，全部 Vitest 测试通过。

Run: `npm run build`

Expected: PASS，Vite/CRX 构建完成。

构建后读取 `dist/manifest.json`，对 `permissions`、`optional_permissions` 和 `host_permissions` 使用与源码测试相同的精确排序基线。Expected: 构建产物与源码基线完全一致；不能只验证 `downloads` 缺失。

- [ ] **Step 5: 人工检查构建产物和日志隐私**

在开发版扩展执行一次五平台群发和一次人为制造的 iframe 超时，确认：

- 正常发送未因诊断写入变慢或失败。
- 设置页按 batch/run 展示完整轨迹。
- JSON 不含实际问题、回答、附件名、URL 或原始错误。
- 最近失败导出包含完整批次和失败平台标记。
- 关闭记录后不再新增事件，重新加载扩展仍保持关闭。

- [ ] **Step 6: 提交隐私和验证改动**

```bash
git add docs/store/privacy-policy.md tests/unit/manifest.test.ts tests/unit/chat-html.test.ts
git commit -m "docs: disclose local diagnostic records"
```

如果正式联系邮箱仍缺失，不暂存 `docs/store/privacy-policy.md`，先提交已验证的 manifest 测试；在上架前取得邮箱后再单独完成并提交隐私政策。

---

## Final Review Checklist

- [ ] `git status --short` 只显示预期改动；用户原有未提交修改均被保留。
- [ ] 每个持久化事件都有 `schemaVersion`、`batchId`、`platformRunId`、`producerId`、`producerSequence`、`storageSequence`。
- [ ] Service Worker 重启测试证明序号严格续接。
- [ ] 五个平台都有发送阶段和回答结果记录。
- [ ] storage/schema 内部错误不会递归写入。
- [ ] 单 run、单 batch、总量、体积和时间限制全部有测试。
- [ ] 预览、复制、下载复用相同字符串。
- [ ] 源码和 `dist/manifest.json` 的权限、可选权限和 host 与既有精确基线一致。
- [ ] 隐私政策、设置页说明和实际字段一致。
- [ ] 正式联系邮箱已替换占位符；若尚未提供，代码验证已完成但不得发布。
- [ ] `npm run typecheck`、`npm test`、`npm run build` 全部通过。
