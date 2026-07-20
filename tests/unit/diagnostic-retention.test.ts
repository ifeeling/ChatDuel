import { describe, expect, it } from 'vitest'
import type { DiagnosticEvent } from '../../src/lib/diagnostic-types'
import { DIAGNOSTIC_ABANDONED_AFTER_MS } from '../../src/lib/diagnostic-types'
import {
  DEFAULT_DIAGNOSTIC_LIMITS,
  appendDiagnosticEvents,
  createEmptyDiagnosticEnvelope,
  deriveDiagnosticExport,
  sanitizeDiagnosticEnvelope,
} from '../../src/lib/diagnostic-retention'

const NOW = 1_000_000

function event(
  batchId: string,
  platformRunId: string,
  storageSequence: number,
  overrides: Partial<DiagnosticEvent> = {},
): DiagnosticEvent {
  return {
    schemaVersion: 1,
    timestamp: NOW - 1_000 + storageSequence,
    batchId,
    platformRunId,
    producerId: 'p_response_1',
    producerSequence: storageSequence,
    storageSequence,
    extensionVersion: '0.4.13',
    platform: 'chatgpt',
    component: 'response-capture',
    operation: 'state-read',
    stage: 'state-changed',
    eventStatus: 'observed',
    ...overrides,
  }
}

describe('diagnostic retention', () => {
  it('evicts whole oldest batches instead of cutting a run', () => {
    const envelope = createEmptyDiagnosticEnvelope()
    envelope.events = [
      event('batch_old', 'run_old', 1),
      event('batch_old', 'run_old', 2),
      event('batch_new', 'run_new', 3),
    ]
    envelope.nextStorageSequence = 4

    const next = appendDiagnosticEvents(
      envelope,
      [event('batch_latest', 'run_latest', 4)],
      { ...DEFAULT_DIAGNOSTIC_LIMITS, maxEvents: 2 },
      NOW,
    )

    expect(next.events.map((item) => item.batchId)).toEqual(['batch_new', 'batch_latest'])
  })

  it('folds an oversized run while retaining acceptance and terminal outcome', () => {
    const events = Array.from({ length: 70 }, (_, index) => event('batch_1', 'run_1', index + 1, {
      producerSequence: index + 1,
      ...(index === 2
        ? { operation: 'send-ack', stage: 'accepted', eventStatus: 'succeeded', component: 'platform-adapter' as const }
        : {}),
      ...(index === 69
        ? { runOutcome: 'timed-out' as const, eventStatus: 'timed-out' as const, stage: 'timed-out' as const }
        : {}),
    }))

    const next = appendDiagnosticEvents(createEmptyDiagnosticEnvelope(), events, DEFAULT_DIAGNOSTIC_LIMITS, NOW)
    const retained = next.events.filter((item) => item.platformRunId === 'run_1')

    expect(retained).toHaveLength(50)
    expect(retained.some((item) => item.stage === 'accepted')).toBe(true)
    expect(retained.some((item) => item.runOutcome === 'timed-out')).toBe(true)
    expect(next.truncation.runs.run_1).toEqual({ eventsTruncated: true, droppedEventCount: 20 })
  })

  it('removes truncation metadata when its whole batch is evicted', () => {
    const envelope = createEmptyDiagnosticEnvelope()
    envelope.events = [event('batch_old', 'run_old', 1)]
    envelope.nextStorageSequence = 2
    envelope.truncation.runs.run_old = { eventsTruncated: true, droppedEventCount: 5 }
    envelope.truncation.batches.batch_old = { eventsTruncated: true, droppedEventCount: 5 }

    const next = appendDiagnosticEvents(
      envelope,
      [event('batch_new', 'run_new', 2)],
      { ...DEFAULT_DIAGNOSTIC_LIMITS, maxBatches: 1 },
      NOW,
    )

    expect(next.events.map((item) => item.batchId)).toEqual(['batch_new'])
    expect(next.truncation.runs).not.toHaveProperty('run_old')
    expect(next.truncation.batches).not.toHaveProperty('batch_old')
  })

  it('uses response capture as terminal owner after send acceptance', () => {
    const envelope = createEmptyDiagnosticEnvelope()
    envelope.events = [
      event('batch_1', 'run_1', 1, {
        component: 'platform-adapter', operation: 'send-ack', stage: 'accepted', eventStatus: 'succeeded',
      }),
      event('batch_1', 'run_1', 2, {
        component: 'platform-adapter', stage: 'failed', eventStatus: 'failed', runOutcome: 'failed',
      }),
      event('batch_1', 'run_1', 3, {
        component: 'response-capture', stage: 'completed', eventStatus: 'succeeded', runOutcome: 'completed',
      }),
    ]

    const exported = deriveDiagnosticExport(envelope, { now: NOW, activePlatformRunIds: new Set() })
    const run = exported.batches[0].runs[0]

    expect(run.finalOutcome).toBe('completed')
    expect(run.structuralWarnings).toContain('invalid-terminal-owner')
  })

  it('uses response capture as terminal owner after an unconfirmed send acknowledgement', () => {
    const envelope = createEmptyDiagnosticEnvelope()
    envelope.events = [
      event('batch_1', 'run_1', 1, {
        component: 'platform-adapter', operation: 'send-ack', stage: 'waiting', eventStatus: 'observed',
      }),
      event('batch_1', 'run_1', 2, {
        component: 'response-capture', stage: 'timed-out', eventStatus: 'timed-out',
        runOutcome: 'timed-out', errorCode: 'response-selector-empty',
      }),
    ]

    const run = deriveDiagnosticExport(envelope, { now: NOW, activePlatformRunIds: new Set() }).batches[0].runs[0]
    expect(run.finalOutcome).toBe('timed-out')
    expect(run.structuralWarnings).toEqual([])
  })

  it('does not pick a winner when a run has multiple valid terminal events', () => {
    const envelope = createEmptyDiagnosticEnvelope()
    envelope.events = [
      event('batch_1', 'run_1', 1, {
        component: 'platform-adapter', stage: 'failed', eventStatus: 'failed', runOutcome: 'failed',
      }),
      event('batch_1', 'run_1', 2, {
        component: 'content-script', stage: 'timed-out', eventStatus: 'timed-out', runOutcome: 'timed-out',
      }),
    ]

    const run = deriveDiagnosticExport(envelope, { now: NOW, activePlatformRunIds: new Set() }).batches[0].runs[0]
    expect(run.finalOutcome).toBeUndefined()
    expect(run.structuralWarnings).toContain('multiple-terminal-events')
  })

  it('derives abandoned without forging a stored event', () => {
    const envelope = createEmptyDiagnosticEnvelope()
    envelope.events = [event('batch_1', 'run_1', 1, { timestamp: 0 })]

    const exported = deriveDiagnosticExport(envelope, {
      now: DIAGNOSTIC_ABANDONED_AFTER_MS + 1,
      activePlatformRunIds: new Set(),
    })

    expect(exported.batches[0].runs[0]).toMatchObject({
      derivedOutcome: 'abandoned',
      derivedReason: 'missing-terminal-event',
    })
    expect(envelope.events[0].runOutcome).toBeUndefined()
  })

  it('exports the whole batch containing the most recent final failure', () => {
    const envelope = createEmptyDiagnosticEnvelope()
    envelope.events = [
      event('batch_1', 'run_ok', 1, {
        component: 'platform-adapter', stage: 'completed', eventStatus: 'succeeded', runOutcome: 'completed',
      }),
      event('batch_1', 'run_failed', 2, {
        component: 'platform-adapter', stage: 'failed', eventStatus: 'failed', runOutcome: 'failed',
      }),
    ]

    const exported = deriveDiagnosticExport(envelope, {
      now: NOW,
      activePlatformRunIds: new Set(),
      latestFailureOnly: true,
    })

    expect(exported.batches).toHaveLength(1)
    expect(exported.batches[0].runs.map((run) => run.platformRunId)).toEqual(['run_ok', 'run_failed'])
  })

  it('sanitizes persisted envelopes and repairs the next sequence', () => {
    const sanitized = sanitizeDiagnosticEnvelope({
      schemaVersion: 1,
      nextStorageSequence: 1,
      events: [
        event('batch_1', 'run_1', 5),
        { ...event('batch_1', 'run_1', 5), storageSequence: 5 },
        { schemaVersion: 0, privateText: 'PRIVATE_PROMPT' },
      ],
      truncation: { runs: {}, batches: {}, privateText: 'PRIVATE_PROMPT' },
    })

    expect(sanitized?.events).toHaveLength(1)
    expect(sanitized?.nextStorageSequence).toBe(6)
    expect(JSON.stringify(sanitized)).not.toContain('PRIVATE_PROMPT')
    expect(sanitizeDiagnosticEnvelope({ schemaVersion: 999, events: [] })).toBeNull()
    expect(sanitizeDiagnosticEnvelope({ events: [] })).toBeNull()
  })
})
