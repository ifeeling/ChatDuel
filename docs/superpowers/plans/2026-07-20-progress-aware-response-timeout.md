# Progress-Aware Response Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让持续生成且内容仍增长的 AI 回答不再于约 60 秒被误报为发送失败，同时让无回答、无进度和绝对超长等待仍能自动结束。

**Architecture:** 在 `response-capture.ts` 的平台级进度中记录首次观察时间与最近内容增长时间，并由纯函数决定每个平台是否超时。`chat.ts` 使用该决策把同一群发中的平台拆成“继续等待”和“已超时”，先安全落盘超时结果，再继续轮询其它平台。

**Tech Stack:** TypeScript、Vitest、Chrome Manifest V3

## Global Constraints

- 没有新回答或连续 60 秒没有内容增长时超时。
- 内容持续增长时继续等待，但单个平台最长 10 分钟。
- 一个群发中的平台分别判断，互不影响。
- 用户主动停止、两次稳定读取、历史保存和 2 分钟输入框安全解锁行为保持不变。
- 不新增依赖、权限、网络请求或持久化字段。
- 不覆盖工作区中已有的 DNR 生命周期修改。

---

### Task 1: 平台级进度时间与超时策略

**Files:**
- Modify: `src/lib/response-capture.ts`
- Test: `tests/unit/response-capture.test.ts`

**Interfaces:**
- Produces: `RESPONSE_NO_PROGRESS_TIMEOUT_MS = 60_000`
- Produces: `RESPONSE_ABSOLUTE_TIMEOUT_MS = 600_000`
- Produces: `shouldResponseCaptureTimeout(progress: ResponseCaptureProgress | undefined, now: number): boolean`
- Produces: `partitionResponseCapturePlatforms<T extends string>(platforms: T[], progress: Partial<Record<T, ResponseCaptureProgress>>, now: number): { waiting: T[]; timedOut: T[] }`
- Extends: `ResponseCaptureProgress` with `firstObservedAt` and optional `lastActivityAt`
- Extends: `evaluateResponseCapture(..., observedAt?: number)` without breaking existing callers

- [ ] **Step 1: Write failing unit tests**

Add tests proving that a response which changes after 60 seconds stays active, a response with no activity for 60 seconds expires, new content resets the inactivity window, the 10-minute absolute limit always expires, and two platforms can be partitioned independently.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run tests/unit/response-capture.test.ts`

Expected: FAIL because the timing fields and timeout functions do not exist.

- [ ] **Step 3: Implement the minimal pure policy**

Update each `evaluateResponseCapture` return path so `firstObservedAt` is preserved from the first poll and `lastActivityAt` changes only when non-baseline response text changes. Implement the 60-second inactivity and 10-minute absolute checks, then partition platforms by that decision.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- --run tests/unit/response-capture.test.ts`

Expected: all response capture tests pass.

### Task 2: 在回答回填中按平台应用超时

**Files:**
- Modify: `src/chat/chat.ts`
- Test: `tests/unit/chat-html.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `partitionResponseCapturePlatforms` 与带时间字段的 `evaluateResponseCapture`
- Preserves: `scheduleSessionResponseBackfill(...)` 和 `backfillSessionResponses(...)` 的现有调用入口

- [ ] **Step 1: Write a failing integration guard test**

Add a source-level guard asserting `chat.ts` no longer uses `RESPONSE_BACKFILL_MAX_ATTEMPTS`, imports `partitionResponseCapturePlatforms`, and passes one shared `observedAt` value to diagnostic observation and `evaluateResponseCapture`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- --run tests/unit/chat-html.test.ts tests/unit/response-capture.test.ts`

Expected: FAIL because `chat.ts` still uses the fixed 20-attempt batch timeout.

- [ ] **Step 3: Replace the fixed batch timeout**

At each scheduling boundary, partition pending platforms. Finalize only timed-out platforms, preserving their diagnostic error code and history failure state. After that storage update completes, schedule the waiting platforms for the next poll. During polling, capture `observedAt = Date.now()` once and use it for both diagnostics and response progress evaluation.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -- --run tests/unit/chat-html.test.ts tests/unit/response-capture.test.ts tests/unit/session-record.test.ts tests/unit/send-lock.test.ts && npm run typecheck`

Expected: all focused tests and TypeScript checks pass.

- [ ] **Step 5: Run full verification**

Run: `npm test && npm run build`

Expected: all unit tests pass and the production build completes.

- [ ] **Step 6: Commit only this bug fix**

Stage `src/lib/response-capture.ts`, `tests/unit/response-capture.test.ts`, `tests/unit/chat-html.test.ts`, and only the response-backfill hunks from the already-modified `src/chat/chat.ts`. Do not stage the user's DNR lifecycle hunks.

Commit message: `fix: keep waiting while responses make progress`
