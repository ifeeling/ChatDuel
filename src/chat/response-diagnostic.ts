import type { StreamStatus } from '../types'
import type { DiagnosticReporter } from '../lib/diagnostic-client'
import type { DiagnosticErrorCode, DiagnosticRunOutcome } from '../lib/diagnostic-types'

const RESPONSE_CHECKPOINTS_MS = [5_000, 15_000, 30_000, 60_000] as const

export interface ResponseDiagnosticObservation {
  now: number
  status: StreamStatus
  responseLength: number
  baselineLength: number
  differsFromBaseline: boolean
  stopButtonDetected: boolean
}

export interface ResponseDiagnosticFinish {
  now: number
  outcome: DiagnosticRunOutcome
  errorCode?: DiagnosticErrorCode
}

export interface ResponseDiagnosticTracker {
  observe(observation: ResponseDiagnosticObservation): void
  finish(result: ResponseDiagnosticFinish): void
}

function waitedMs(now: number, startedAt: number): number {
  return Math.max(0, Math.trunc(now - startedAt))
}

function safeObservationFields(observation: ResponseDiagnosticObservation) {
  return {
    stateStatus: observation.status,
    responseCharacterCount: observation.responseLength,
    baselineCharacterCount: observation.baselineLength,
    differsFromBaseline: observation.differsFromBaseline,
    stopButtonDetected: observation.stopButtonDetected,
  }
}

export function createResponseDiagnosticTracker(
  reporter: DiagnosticReporter,
  startedAt: number,
): ResponseDiagnosticTracker {
  let pollCount = 0
  let stateChangeCount = 0
  let nextCheckpointIndex = 0
  let lastObservation: ResponseDiagnosticObservation | undefined
  let finished = false

  return {
    observe(observation) {
      if (finished) return
      pollCount += 1

      const stateChanged = !lastObservation
        || lastObservation.status !== observation.status
        || lastObservation.differsFromBaseline !== observation.differsFromBaseline
        || lastObservation.stopButtonDetected !== observation.stopButtonDetected
      lastObservation = observation

      if (stateChanged) {
        stateChangeCount += 1
        reporter.emit({
          component: 'response-capture',
          operation: 'state-read',
          stage: 'state-changed',
          eventStatus: 'observed',
          waitedMs: waitedMs(observation.now, startedAt),
          pollCount,
          stateChangeCount,
          ...safeObservationFields(observation),
        })
      }

      const elapsed = waitedMs(observation.now, startedAt)
      while (nextCheckpointIndex < RESPONSE_CHECKPOINTS_MS.length
        && elapsed >= RESPONSE_CHECKPOINTS_MS[nextCheckpointIndex]) {
        const checkpoint = RESPONSE_CHECKPOINTS_MS[nextCheckpointIndex]
        nextCheckpointIndex += 1
        reporter.emit({
          component: 'response-capture',
          operation: 'state-read',
          stage: 'checkpoint',
          eventStatus: 'observed',
          waitedMs: checkpoint,
          pollCount,
          stateChangeCount,
          ...safeObservationFields(observation),
        })
      }
    },

    finish(result) {
      if (finished) return
      finished = true

      const terminal = result.outcome === 'completed'
        ? { stage: 'completed' as const, eventStatus: 'succeeded' as const }
        : result.outcome === 'paused'
          ? { stage: 'paused' as const, eventStatus: 'observed' as const }
          : result.outcome === 'timed-out'
            ? { stage: 'timed-out' as const, eventStatus: 'timed-out' as const }
            : result.outcome === 'interrupted'
              ? { stage: 'interrupted' as const, eventStatus: 'failed' as const }
              : { stage: 'failed' as const, eventStatus: 'failed' as const }

      reporter.emit({
        component: 'response-capture',
        operation: 'response-read',
        ...terminal,
        runOutcome: result.outcome,
        errorCode: result.errorCode,
        waitedMs: waitedMs(result.now, startedAt),
        pollCount,
        stateChangeCount,
        ...(lastObservation
          ? {
              lastObservedState: lastObservation.status,
              ...safeObservationFields(lastObservation),
            }
          : {}),
      })
    },
  }
}
