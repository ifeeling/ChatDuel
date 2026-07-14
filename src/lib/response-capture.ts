import type { StreamStatus } from '../types'
import { logCaptureDebug } from './capture-debug'

export interface ResponseProbe {
  text?: string
  status?: StreamStatus
}

export interface ResponseCaptureProgress {
  lastText: string
  stableCount: number
}

export interface ResponseCaptureDecision {
  shouldCapture: boolean
  text: string
  progress: ResponseCaptureProgress
}

const ACTIVE_STATUSES: StreamStatus[] = ['queued', 'sending', 'streaming']

export function evaluateResponseCapture(
  probe: ResponseProbe,
  baseline: string | undefined,
  previous: ResponseCaptureProgress | undefined,
  requiredStableCount = 2,
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
      progress: { lastText: text, stableCount: 0 },
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
      progress: { lastText: text, stableCount: 0 },
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
    progress: { lastText: text, stableCount },
  }
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
