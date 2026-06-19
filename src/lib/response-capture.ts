import type { StreamStatus } from '../types'

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
    return {
      shouldCapture: false,
      text,
      progress: { lastText: text, stableCount: 0 },
    }
  }

  if (isActive) {
    return {
      shouldCapture: false,
      text,
      progress: { lastText: text, stableCount: 0 },
    }
  }

  const stableCount = previous?.lastText === text ? previous.stableCount + 1 : 1
  return {
    shouldCapture: stableCount >= requiredStableCount,
    text,
    progress: { lastText: text, stableCount },
  }
}

export function isResponseCompleteForUnlock(probe: ResponseProbe, baseline: string | undefined): boolean {
  const text = probe.text?.trim() ?? ''
  const baselineText = baseline?.trim() ?? ''
  const isActive = probe.status ? ACTIVE_STATUSES.includes(probe.status) : false
  return !!text && text !== baselineText && !isActive
}
