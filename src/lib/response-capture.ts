import type { StreamStatus } from '../types'
import { logCaptureDebug } from './capture-debug'

export interface ResponseProbe {
  text?: string
  status?: StreamStatus
}

export interface ResponseCaptureProgress {
  lastText: string
  stableCount: number
  firstObservedAt: number
  lastActivityAt?: number
  lastActivityText?: string
}

export interface ResponseCaptureDecision {
  shouldCapture: boolean
  text: string
  progress: ResponseCaptureProgress
}

const ACTIVE_STATUSES: StreamStatus[] = ['queued', 'sending', 'streaming']
export const RESPONSE_NO_PROGRESS_TIMEOUT_MS = 60_000
export const RESPONSE_ABSOLUTE_TIMEOUT_MS = 10 * 60_000

function nextProgress(
  text: string,
  baselineText: string,
  stableCount: number,
  previous: ResponseCaptureProgress | undefined,
  observedAt: number,
): ResponseCaptureProgress {
  const hasNewActivity = !!text && text !== baselineText && text !== previous?.lastActivityText
  return {
    lastText: text,
    stableCount,
    firstObservedAt: previous?.firstObservedAt ?? observedAt,
    lastActivityAt: hasNewActivity ? observedAt : previous?.lastActivityAt,
    lastActivityText: hasNewActivity ? text : previous?.lastActivityText,
  }
}

export function evaluateResponseCapture(
  probe: ResponseProbe,
  baseline: string | undefined,
  previous: ResponseCaptureProgress | undefined,
  requiredStableCount = 2,
  observedAt = Date.now(),
): ResponseCaptureDecision {
  const text = probe.text?.trim() ?? ''
  const baselineText = baseline?.trim() ?? ''
  const isActive = probe.status ? ACTIVE_STATUSES.includes(probe.status) : false

  if (!text || text === baselineText) {
    logCaptureDebug({
      platform: undefined,
      event: 'evaluate-capture',
      reason: !text ? 'text-empty' : 'text-equals-baseline',
      textLength: text.length,
      baselineLength: baselineText.length,
      isActive,
      shouldCapture: false,
    })
    return {
      shouldCapture: false,
      text,
      progress: nextProgress(text, baselineText, 0, previous, observedAt),
    }
  }

  if (isActive) {
    logCaptureDebug({
      platform: undefined,
      event: 'evaluate-capture',
      reason: 'status-active',
      status: probe.status,
      textLength: text.length,
      shouldCapture: false,
    })
    return {
      shouldCapture: false,
      text,
      progress: nextProgress(text, baselineText, 0, previous, observedAt),
    }
  }

  const stableCount = previous?.lastText === text ? previous.stableCount + 1 : 1
  const shouldCapture = stableCount >= requiredStableCount
  logCaptureDebug({
    platform: undefined,
    event: 'evaluate-capture',
    reason: shouldCapture ? 'stable-enough' : 'stable-pending',
    textLength: text.length,
    stableCount,
    requiredStableCount,
    shouldCapture,
  })
  return {
    shouldCapture,
    text,
    progress: nextProgress(text, baselineText, stableCount, previous, observedAt),
  }
}

export function shouldResponseCaptureTimeout(
  progress: ResponseCaptureProgress | undefined,
  now: number,
): boolean {
  if (!progress) return false
  if (now - progress.firstObservedAt >= RESPONSE_ABSOLUTE_TIMEOUT_MS) return true
  const lastProgressAt = progress.lastActivityAt ?? progress.firstObservedAt
  return now - lastProgressAt >= RESPONSE_NO_PROGRESS_TIMEOUT_MS
}

export function partitionResponseCapturePlatforms<T extends string>(
  platforms: T[],
  progress: Partial<Record<T, ResponseCaptureProgress>>,
  now: number,
): { waiting: T[]; timedOut: T[] } {
  const waiting: T[] = []
  const timedOut: T[] = []
  for (const platform of platforms) {
    if (shouldResponseCaptureTimeout(progress[platform], now)) timedOut.push(platform)
    else waiting.push(platform)
  }
  return { waiting, timedOut }
}

export function isResponseCompleteForUnlock(probe: ResponseProbe, baseline: string | undefined): boolean {
  const text = probe.text?.trim() ?? ''
  const baselineText = baseline?.trim() ?? ''
  const isActive = probe.status ? ACTIVE_STATUSES.includes(probe.status) : false
  const result = !!text && text !== baselineText && !isActive
  logCaptureDebug({
    platform: undefined,
    event: 'complete-for-unlock',
    textLength: text.length,
    baselineLength: baselineText.length,
    status: probe.status,
    isActive,
    result,
    reason: !text ? 'text-empty' : text === baselineText ? 'text-equals-baseline' : isActive ? 'status-active' : 'complete',
  })
  return result
}
