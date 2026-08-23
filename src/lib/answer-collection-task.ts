import type { AIPlatform, Session, StreamStatus } from '../types'
import { logCaptureDebug, textPreview } from './capture-debug'
import type {
  DiagnosticErrorCode,
  DiagnosticEventStatus,
  DiagnosticRunOutcome,
} from './diagnostic-types'
import type { DiagnosticReporter } from './diagnostic-client'
import {
  classifyResponseCaptureWait,
  evaluateResponseCapture,
  shouldResponseCaptureTimeout,
  type ResponseCaptureProgress,
} from './response-capture'
import {
  applyCaptureFailures,
  applyCapturedResponses,
  applySendResults,
  isNewCapturedResponse,
  type CaptureFailure,
} from './session-record'

export interface AnswerCollectionSendResult {
  platform: AIPlatform
  ok: boolean
  error?: string
  /**
   * 发送未成功时的原因：
   * - 'rejected'：平台明确拒绝（可安全重发）；
   * - 'timeout'：通信超时、未收到回执（结果未知，不得自动重发）。
   * 缺省按 'rejected' 处理，兼容未区分原因的调用方。
   */
  reason?: 'rejected' | 'timeout'
}

export interface AnswerCollectionRead {
  text: string
  status: StreamStatus
  stopButtonDetected?: boolean
  completionActionBarDetected?: boolean
  requestTimedOut?: boolean
  diagnosticErrorCode?: DiagnosticErrorCode
}

export interface AnswerCollectionDiagnosticTracker {
  observe(observation: {
    now: number
    status: StreamStatus
    responseLength: number
    baselineLength: number
    differsFromBaseline: boolean
    stopButtonDetected: boolean
    completionActionBarDetected?: boolean
  }): void
  finish(result: {
    now: number
    outcome: DiagnosticRunOutcome
    errorCode?: DiagnosticErrorCode
  }): void
}

export interface AnswerCollectionHistory {
  add(session: Session): Promise<void>
  get(id: string): Promise<Session | undefined>
  update(session: Session): Promise<void>
}

export interface AnswerCollectionTaskDependencies {
  now(): number
  wait(milliseconds: number): Promise<void>
  captureBaseline(platform: AIPlatform): Promise<string>
  send(platform: AIPlatform): Promise<AnswerCollectionSendResult>
  read(platform: AIPlatform): Promise<AnswerCollectionRead>
  history: AnswerCollectionHistory
  createDiagnosticTracker?(
    platform: AIPlatform,
    startedAt: number,
  ): AnswerCollectionDiagnosticTracker | undefined
  createHistoryReporter?(
    platform: AIPlatform,
  ): DiagnosticReporter | undefined
  onSendComplete?(results: AnswerCollectionSendResult[]): void
  onPlatformSettled?(
    platform: AIPlatform,
    result: AnswerCollectionPlatformResult,
  ): void
  /**
   * 当任务首次观察到平台进入 streaming，或出现区别于发送前基线的新回答文字时触发一次。
   * 供 UI 把顶部进度状态从「等待回答」切到「回答中」。
   * 与「回答完成确认」（onPlatformSettled）相互独立。
   */
  onResponseStarted?(
    platform: AIPlatform,
  ): void
}

export interface AnswerCollectionTaskInput {
  id: string
  session: Session
  signal?: AbortSignal
}

export type AnswerCollectionPlatformResult =
  | {
      status: 'captured'
      text: string
      /**
       * 是否经由「isActive 强制完成」抓到（Issue #7）：网站自身状态在抓取时刻仍报告 active，
       * 是靠文本长时间不变推断出来的，不是网站明确确认已完成。
       * `pending-question-queue.ts` 的 `pauseReasonFor` 用它决定要不要暂停自动发送队列——
       * 已保存进历史不代表可以放心自动发下一条问题，保持与文档里「任何不确定情况一律判为不安全」
       * 的既有队列安全策略一致。
       */
      forceCaptured?: boolean
    }
  | { status: 'observed-unsaved'; text: string; error: string }
  | { status: 'send-failed'; error: string }
  | { status: 'capture-timeout'; error: string }
  | { status: 'capture-interrupted'; error: string }
  | { status: 'uncertain'; error: string }
  | { status: 'user-stopped'; error: string }

export interface AnswerCollectionTaskResult {
  id: string
  session: Session
  platforms: Partial<Record<AIPlatform, AnswerCollectionPlatformResult>>
  historyStatus: 'saved' | 'unsaved'
}

export const POLL_INTERVAL_MS = 3_000
export const REQUIRED_STABLE_POLLS = 2
const HISTORY_RETRY_DELAY_MS = 500

function mergeTaskSession(latest: Session, taskSession: Session): Session {
  return {
    ...latest,
    updatedAt: Math.max(latest.updatedAt, taskSession.updatedAt),
    responses: {
      ...latest.responses,
      ...taskSession.responses,
    },
  }
}

function emitHistorySaveEvent(
  dependencies: AnswerCollectionTaskDependencies,
  session: Session,
  params: {
    eventStatus: DiagnosticEventStatus
    errorCode?: DiagnosticErrorCode
    retryNumber?: number
    waitedMs?: number
    runOutcome?: DiagnosticRunOutcome
  },
): void {
  for (const platform of session.targetPlatforms) {
    const reporter = dependencies.createHistoryReporter?.(platform)
    if (!reporter) continue
    reporter.emit({
      component: 'history-store',
      operation: 'history-write',
      stage: 'history-save',
      eventStatus: params.eventStatus,
      ...(params.errorCode !== undefined ? { errorCode: params.errorCode } : {}),
      ...(params.retryNumber !== undefined ? { retryNumber: params.retryNumber } : {}),
      ...(params.waitedMs !== undefined ? { waitedMs: params.waitedMs } : {}),
      ...(params.runOutcome !== undefined ? { runOutcome: params.runOutcome } : {}),
    })
  }
}

async function updateHistoryWithRetry(
  session: Session,
  dependencies: AnswerCollectionTaskDependencies,
): Promise<{ session: Session; saved: boolean }> {
  try {
    await dependencies.history.update(session)
    return { session, saved: true }
  } catch {
    emitHistorySaveEvent(dependencies, session, {
      eventStatus: 'failed',
      errorCode: 'history-update-failed',
      retryNumber: 0,
    })
    await dependencies.wait(HISTORY_RETRY_DELAY_MS)
    const latest = await dependencies.history.get(session.id).catch(() => undefined)
    const merged = latest ? mergeTaskSession(latest, session) : session
    try {
      await dependencies.history.update(merged)
      emitHistorySaveEvent(dependencies, session, {
        eventStatus: 'succeeded',
        retryNumber: 1,
        waitedMs: HISTORY_RETRY_DELAY_MS,
      })
      return { session: merged, saved: true }
    } catch {
      emitHistorySaveEvent(dependencies, session, {
        eventStatus: 'failed',
        errorCode: 'history-update-failed',
        retryNumber: 1,
        waitedMs: HISTORY_RETRY_DELAY_MS,
        runOutcome: 'failed',
      })
      return { session: merged, saved: false }
    }
  }
}

async function addHistoryWithRetry(
  session: Session,
  dependencies: AnswerCollectionTaskDependencies,
): Promise<boolean> {
  try {
    await dependencies.history.add(session)
    return true
  } catch {
    emitHistorySaveEvent(dependencies, session, {
      eventStatus: 'failed',
      errorCode: 'history-add-failed',
      retryNumber: 0,
    })
    await dependencies.wait(HISTORY_RETRY_DELAY_MS)
    const existing = await dependencies.history.get(session.id).catch(() => undefined)
    if (existing) {
      emitHistorySaveEvent(dependencies, session, {
        eventStatus: 'succeeded',
        retryNumber: 1,
        waitedMs: HISTORY_RETRY_DELAY_MS,
      })
      return true
    }
    try {
      await dependencies.history.add(session)
      emitHistorySaveEvent(dependencies, session, {
        eventStatus: 'succeeded',
        retryNumber: 1,
        waitedMs: HISTORY_RETRY_DELAY_MS,
      })
      return true
    } catch {
      emitHistorySaveEvent(dependencies, session, {
        eventStatus: 'failed',
        errorCode: 'history-add-failed',
        retryNumber: 1,
        waitedMs: HISTORY_RETRY_DELAY_MS,
        runOutcome: 'failed',
      })
      return false
    }
  }
}

function invokeObserverSafely(callback: (() => void) | undefined): void {
  try {
    callback?.()
  } catch {
    // 页面通知失败不能中断回答和历史保存。
  }
}

export async function runAnswerCollectionTask(
  input: AnswerCollectionTaskInput,
  dependencies: AnswerCollectionTaskDependencies,
): Promise<AnswerCollectionTaskResult> {
  const targets = [...input.session.targetPlatforms]
  const baselineEntries = await Promise.all(
    targets.map(async (platform) => {
      const baseline = await dependencies.captureBaseline(platform).catch(() => '')
      return [platform, baseline] as const
    }),
  )
  const baselines = Object.fromEntries(baselineEntries) as Partial<Record<AIPlatform, string>>

  let session = input.session
  const unsavedPlatforms = new Set<AIPlatform>()
  let historyStatus: AnswerCollectionTaskResult['historyStatus'] = (
    await addHistoryWithRetry(session, dependencies)
  ) ? 'saved' : 'unsaved'

  const sendResults = await Promise.all(targets.map(async (platform) => {
    try {
      return await dependencies.send(platform)
    } catch {
      return { platform, ok: false, error: 'send failed' }
    }
  }))
  invokeObserverSafely(() => dependencies.onSendComplete?.(sendResults))
  session = applySendResults(
    session,
    sendResults.map((result) => ({
      p: result.platform,
      ok: result.ok,
      error: result.error,
    })),
    dependencies.now(),
  )
  const sendHistory = await updateHistoryWithRetry(session, dependencies)
  session = sendHistory.session
  historyStatus = sendHistory.saved ? 'saved' : 'unsaved'
  if (sendHistory.saved) {
    unsavedPlatforms.clear()
  } else {
    targets.forEach((platform) => unsavedPlatforms.add(platform))
  }

  const platforms: Partial<Record<AIPlatform, AnswerCollectionPlatformResult>> = {}
  const diagnosticTrackers: Partial<Record<AIPlatform, AnswerCollectionDiagnosticTracker>> = {}
  const finishedDiagnostics = new Set<AIPlatform>()
  const finishDiagnostic = (
    platform: AIPlatform,
    result: Parameters<AnswerCollectionDiagnosticTracker['finish']>[0],
  ) => {
    if (finishedDiagnostics.has(platform)) return
    finishedDiagnostics.add(platform)
    diagnosticTrackers[platform]?.finish(result)
  }
  const pending = new Set<AIPlatform>()
  for (const result of sendResults) {
    if (result.ok) {
      pending.add(result.platform)
      diagnosticTrackers[result.platform] = dependencies.createDiagnosticTracker?.(
        result.platform,
        dependencies.now(),
      )
    } else {
      const platformResult: AnswerCollectionPlatformResult = {
        status: 'send-failed',
        error: result.error || 'send failed',
      }
      platforms[result.platform] = platformResult
      invokeObserverSafely(() => dependencies.onPlatformSettled?.(result.platform, platformResult))
    }
  }

  const settleUserStoppedPlatforms = (): boolean => {
    if (!input.signal?.aborted) return false
    for (const platform of [...pending]) {
      const platformResult: AnswerCollectionPlatformResult = {
        status: 'user-stopped',
        error: 'answer collection stopped by user',
      }
      platforms[platform] = platformResult
      pending.delete(platform)
      invokeObserverSafely(() => dependencies.onPlatformSettled?.(platform, platformResult))
      finishDiagnostic(platform, {
        outcome: 'paused',
        now: dependencies.now(),
      })
    }
    return true
  }

  const progress: Partial<Record<AIPlatform, ResponseCaptureProgress>> = {}
  const startedPlatforms = new Set<AIPlatform>()
  // 通信中断快速检测（Issue #21 断网场景优化）：连续多轮所有待处理平台都返回
  // 请求超时，说明命令桥已不可达，无需傻等 60 秒无进展超时，提前结束为中断。
  let consecutiveTimeoutRounds = 0
  const CAPTURE_INTERRUPT_TIMEOUT_STREAK = 3
  while (pending.size > 0) {
    if (settleUserStoppedPlatforms()) break
    await dependencies.wait(POLL_INTERVAL_MS)
    if (settleUserStoppedPlatforms()) break
    const captured: Partial<Record<AIPlatform, string>> = {}
    const failures: Partial<Record<AIPlatform, CaptureFailure>> = {}
    const timedOutPlatforms = new Set<AIPlatform>()

    await Promise.all([...pending].map(async (platform) => {
      let probe: AnswerCollectionRead
      try {
        probe = await dependencies.read(platform)
      } catch {
        const error = 'response capture interrupted'
        failures[platform] = { status: 'failed', error }
        const platformResult: AnswerCollectionPlatformResult = { status: 'capture-interrupted', error }
        platforms[platform] = platformResult
        pending.delete(platform)
        invokeObserverSafely(() => dependencies.onPlatformSettled?.(platform, platformResult))
        finishDiagnostic(platform, {
          outcome: 'interrupted',
          errorCode: 'unexpected-error',
          now: dependencies.now(),
        })
        return
      }
      if (probe.requestTimedOut === true) {
        // 本轮该平台命令桥请求超时：累计到专用集合，循环末尾统一判定是否提前结束。
        timedOutPlatforms.add(platform)
      }
      const observedAt = dependencies.now()
      const text = probe.text.trim()
      const baseline = (baselines[platform] ?? '').trim()
      const observedNewAnswer = text.length > 0 && text !== baseline
      const responseStarted = probe.status === 'streaming' || observedNewAnswer
      if (responseStarted && !startedPlatforms.has(platform)) {
        startedPlatforms.add(platform)
        invokeObserverSafely(() => dependencies.onResponseStarted?.(platform))
      }
      if (probe.diagnosticErrorCode) {
        finishDiagnostic(platform, {
          outcome: 'interrupted',
          errorCode: probe.diagnosticErrorCode,
          now: observedAt,
        })
      }
      diagnosticTrackers[platform]?.observe({
        now: observedAt,
        status: probe.status,
        responseLength: text.length,
        baselineLength: baseline.length,
        differsFromBaseline: text !== baseline,
        stopButtonDetected: probe.stopButtonDetected === true,
        completionActionBarDetected: probe.completionActionBarDetected === true,
      })
      const decision = evaluateResponseCapture(
        probe,
        baselines[platform],
        progress[platform],
        REQUIRED_STABLE_POLLS,
        observedAt,
      )
      progress[platform] = decision.progress
      logCaptureDebug({
        platform,
        event: 'backfill-poll',
        taskId: input.id,
        sessionId: session.id,
        stateStatus: probe.status,
        textLength: text.length,
        textPreview: textPreview(probe.text),
        baselinePreview: textPreview(baselines[platform] ?? ''),
        nextStableCount: decision.progress.stableCount,
        requiredStableCount: REQUIRED_STABLE_POLLS,
        shouldCapture: decision.shouldCapture,
        forceCaptured: decision.forceCaptured,
        completionActionBarDetected: probe.completionActionBarDetected === true,
      })
      if (decision.shouldCapture && isNewCapturedResponse(decision.text, baselines[platform])) {
        captured[platform] = decision.text
        const platformResult: AnswerCollectionPlatformResult = {
          status: 'captured',
          text: decision.text,
          ...(decision.forceCaptured ? { forceCaptured: true } : {}),
        }
        platforms[platform] = platformResult
        pending.delete(platform)
        invokeObserverSafely(() => dependencies.onPlatformSettled?.(platform, platformResult))
        finishDiagnostic(platform, {
          outcome: probe.status === 'paused' ? 'paused' : 'completed',
          now: dependencies.now(),
        })
      } else if (shouldResponseCaptureTimeout(decision.progress, dependencies.now())) {
        // 超时瞬间平台仍在生成，属于「状态不确定」，不能冒险继续；
        // 若已回到 idle/paused 等终态仍未读到内容，则属于真正的收集超时。
        const stillGenerating = probe.status === 'streaming'
        const error = stillGenerating
          ? 'platform still generating at capture timeout'
          : 'response capture timed out'
        failures[platform] = { status: stillGenerating ? 'uncertain' : 'failed', error }
        const platformResult: AnswerCollectionPlatformResult = {
          status: stillGenerating ? 'uncertain' : 'capture-timeout',
          error,
        }
        platforms[platform] = platformResult
        pending.delete(platform)
        invokeObserverSafely(() => dependencies.onPlatformSettled?.(platform, platformResult))
        finishDiagnostic(platform, {
          outcome: 'timed-out',
          errorCode: probe.diagnosticErrorCode
            ?? classifyResponseCaptureWait({
              stateRequestTimedOut: probe.requestTimedOut === true,
              status: probe.status,
              responseLength: text.length,
              differsFromBaseline: text !== baseline,
            }),
          now: dependencies.now(),
        })
        logCaptureDebug({
          platform,
          event: 'backfill-timeout',
          taskId: input.id,
          sessionId: session.id,
          lastTextPreview: textPreview(decision.progress.lastText),
          lastStableCount: decision.progress.stableCount,
          requiredStableCount: REQUIRED_STABLE_POLLS,
        })
      }
    }))

    const capturedSession = applyCapturedResponses(session, captured, dependencies.now())
    const updated = applyCaptureFailures(capturedSession, failures, dependencies.now())
    if (updated !== session) {
      const captureHistory = await updateHistoryWithRetry(updated, dependencies)
      session = captureHistory.session
      historyStatus = captureHistory.saved ? 'saved' : 'unsaved'
      if (captureHistory.saved) {
        unsavedPlatforms.clear()
      } else {
        for (const platform of [
          ...Object.keys(captured),
          ...Object.keys(failures),
        ] as AIPlatform[]) {
          unsavedPlatforms.add(platform)
        }
      }
      for (const [platform, capturedText] of Object.entries(captured) as Array<[AIPlatform, string]>) {
        logCaptureDebug({
          platform,
          event: 'history-capture',
          taskId: input.id,
          sessionId: session.id,
          textLength: capturedText.trim().length,
          textPreview: textPreview(capturedText),
          historySaved: captureHistory.saved,
        })
      }
    }

    // 通信中断快速检测：本轮所有待处理平台都返回请求超时，累计达到阈值即提前结束。
    // 只要有一轮出现非超时（恢复正常或读到内容），计数重置，避免误杀偶发抖动。
    // 注意：必须放在上面的捕获落盘之后再判定，否则「本轮有平台刚捕获成功、另一平台
    // 仍超时」时提前 break，会把已捕获的回答一起丢掉。
    if (timedOutPlatforms.size > 0 && timedOutPlatforms.size === pending.size) {
      consecutiveTimeoutRounds += 1
      if (consecutiveTimeoutRounds >= CAPTURE_INTERRUPT_TIMEOUT_STREAK) {
        for (const platform of [...pending]) {
          const platformResult: AnswerCollectionPlatformResult = {
            status: 'capture-interrupted',
            error: 'response capture interrupted (communication timeout)',
          }
          platforms[platform] = platformResult
          pending.delete(platform)
          invokeObserverSafely(() => dependencies.onPlatformSettled?.(platform, platformResult))
          finishDiagnostic(platform, {
            outcome: 'interrupted',
            errorCode: 'state-request-timeout',
            now: dependencies.now(),
          })
        }
        break
      }
    } else {
      consecutiveTimeoutRounds = 0
    }
  }

  if (historyStatus === 'unsaved') {
    for (const platform of unsavedPlatforms) {
      const result = platforms[platform]
      if (result?.status !== 'captured') continue
      platforms[platform] = {
        status: 'observed-unsaved',
        text: result.text,
        error: 'history save failed',
      }
    }
  }

  return {
    id: input.id,
    session,
    platforms,
    historyStatus,
  }
}
