import type { AIPlatform, Session, StreamStatus } from '../types'
import { logCaptureDebug, textPreview } from './capture-debug'
import type { DiagnosticErrorCode, DiagnosticRunOutcome } from './diagnostic-types'
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
} from './session-record'

export interface AnswerCollectionSendResult {
  platform: AIPlatform
  ok: boolean
  error?: string
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
  onSendComplete?(results: AnswerCollectionSendResult[]): void
  onPlatformSettled?(
    platform: AIPlatform,
    result: AnswerCollectionPlatformResult,
  ): void
}

export interface AnswerCollectionTaskInput {
  id: string
  session: Session
}

export type AnswerCollectionPlatformResult =
  | { status: 'captured'; text: string }
  | { status: 'observed-unsaved'; text: string; error: string }
  | { status: 'send-failed'; error: string }
  | { status: 'capture-timeout'; error: string }
  | { status: 'capture-interrupted'; error: string }

export interface AnswerCollectionTaskResult {
  id: string
  session: Session
  platforms: Partial<Record<AIPlatform, AnswerCollectionPlatformResult>>
  historyStatus: 'saved' | 'unsaved'
}

const POLL_INTERVAL_MS = 3_000
const REQUIRED_STABLE_POLLS = 2
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

async function updateHistoryWithRetry(
  session: Session,
  dependencies: AnswerCollectionTaskDependencies,
): Promise<{ session: Session; saved: boolean }> {
  try {
    await dependencies.history.update(session)
    return { session, saved: true }
  } catch {
    await dependencies.wait(HISTORY_RETRY_DELAY_MS)
    const latest = await dependencies.history.get(session.id).catch(() => undefined)
    const merged = latest ? mergeTaskSession(latest, session) : session
    try {
      await dependencies.history.update(merged)
      return { session: merged, saved: true }
    } catch {
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
    await dependencies.wait(HISTORY_RETRY_DELAY_MS)
    const existing = await dependencies.history.get(session.id).catch(() => undefined)
    if (existing) return true
    try {
      await dependencies.history.add(session)
      return true
    } catch {
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

  const progress: Partial<Record<AIPlatform, ResponseCaptureProgress>> = {}
  while (pending.size > 0) {
    await dependencies.wait(POLL_INTERVAL_MS)
    const captured: Partial<Record<AIPlatform, string>> = {}
    const failures: Partial<Record<AIPlatform, string>> = {}

    await Promise.all([...pending].map(async (platform) => {
      let probe: AnswerCollectionRead
      try {
        probe = await dependencies.read(platform)
      } catch {
        const error = 'response capture interrupted'
        failures[platform] = error
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
      const observedAt = dependencies.now()
      const text = probe.text.trim()
      const baseline = (baselines[platform] ?? '').trim()
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
        completionActionBarDetected: probe.completionActionBarDetected === true,
      })
      if (decision.shouldCapture && isNewCapturedResponse(decision.text, baselines[platform])) {
        captured[platform] = decision.text
        const platformResult: AnswerCollectionPlatformResult = {
          status: 'captured',
          text: decision.text,
        }
        platforms[platform] = platformResult
        pending.delete(platform)
        invokeObserverSafely(() => dependencies.onPlatformSettled?.(platform, platformResult))
        finishDiagnostic(platform, {
          outcome: probe.status === 'paused' ? 'paused' : 'completed',
          now: dependencies.now(),
        })
      } else if (shouldResponseCaptureTimeout(decision.progress, dependencies.now())) {
        const error = 'response capture timed out'
        failures[platform] = error
        const platformResult: AnswerCollectionPlatformResult = { status: 'capture-timeout', error }
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
