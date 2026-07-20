import { describe, expect, it, vi } from 'vitest'
import {
  classifyResponseCaptureWait,
  createResponseDiagnosticTracker,
} from '../../src/chat/response-diagnostic'

function reporter() {
  return { emit: vi.fn() }
}

describe('response diagnostic tracker', () => {
  it('classifies the last safe reason for a response capture timeout', () => {
    expect(classifyResponseCaptureWait({
      stateRequestTimedOut: true,
      status: 'idle',
      responseLength: 0,
      differsFromBaseline: false,
    })).toBe('state-request-timeout')
    expect(classifyResponseCaptureWait({
      stateRequestTimedOut: false,
      status: 'idle',
      responseLength: 0,
      differsFromBaseline: false,
    })).toBe('response-selector-empty')
    expect(classifyResponseCaptureWait({
      stateRequestTimedOut: false,
      status: 'idle',
      responseLength: 10,
      differsFromBaseline: false,
    })).toBe('response-equals-baseline')
    expect(classifyResponseCaptureWait({
      stateRequestTimedOut: false,
      status: 'streaming',
      responseLength: 10,
      differsFromBaseline: true,
    })).toBe('response-still-streaming')
  })
  it('emits state changes and sparse checkpoints but not every poll', () => {
    const trace = reporter()
    const tracker = createResponseDiagnosticTracker(trace, 0)

    tracker.observe({
      now: 3_000, status: 'streaming', responseLength: 10, baselineLength: 0,
      differsFromBaseline: true, stopButtonDetected: true,
    })
    tracker.observe({
      now: 4_000, status: 'streaming', responseLength: 20, baselineLength: 0,
      differsFromBaseline: true, stopButtonDetected: true,
    })
    tracker.observe({
      now: 5_000, status: 'streaming', responseLength: 30, baselineLength: 0,
      differsFromBaseline: true, stopButtonDetected: true,
    })

    expect(trace.emit).toHaveBeenCalledTimes(2)
    expect(trace.emit.mock.calls[1][0]).toMatchObject({
      stage: 'checkpoint', waitedMs: 5_000, responseCharacterCount: 30,
    })
  })

  it('records the last safe observation in a capture timeout', () => {
    const trace = reporter()
    const tracker = createResponseDiagnosticTracker(trace, 0)
    tracker.observe({
      now: 3_000, status: 'streaming', responseLength: 30, baselineLength: 5,
      differsFromBaseline: true, stopButtonDetected: true,
    })

    tracker.finish({ outcome: 'timed-out', errorCode: 'response-capture-timeout', now: 60_000 })

    expect(trace.emit).toHaveBeenLastCalledWith(expect.objectContaining({
      runOutcome: 'timed-out',
      eventStatus: 'timed-out',
      pollCount: 1,
      lastObservedState: 'streaming',
      responseCharacterCount: 30,
      baselineCharacterCount: 5,
      differsFromBaseline: true,
      stopButtonDetected: true,
      waitedMs: 60_000,
    }))
    expect(JSON.stringify(trace.emit.mock.calls)).not.toContain('完整回答')
  })

  it('does not invent observation fields when finishing before the first poll', () => {
    const trace = reporter()
    const tracker = createResponseDiagnosticTracker(trace, 100)

    tracker.finish({ outcome: 'interrupted', errorCode: 'tab-closed', now: 200 })

    const event = trace.emit.mock.calls[0][0]
    expect(event).not.toHaveProperty('responseCharacterCount')
    expect(event).not.toHaveProperty('stopButtonDetected')
  })
})
