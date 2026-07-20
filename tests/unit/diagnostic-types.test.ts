import { describe, expect, it } from 'vitest'
import {
  DIAGNOSTIC_SCHEMA_VERSION,
  mapDiagnosticError,
  sanitizeDiagnosticContext,
  sanitizeDiagnosticEventDraft,
} from '../../src/lib/diagnostic-types'

function validDraft(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    timestamp: 100,
    batchId: 'batch_1',
    platformRunId: 'run_1',
    producerId: 'p_chat_1',
    producerSequence: 2,
    platform: 'chatgpt',
    component: 'response-capture',
    operation: 'response-read',
    stage: 'state-changed',
    eventStatus: 'observed',
    ...overrides,
  }
}

describe('diagnostic types', () => {
  it('keeps only whitelisted bounded fields', () => {
    const result = sanitizeDiagnosticEventDraft(validDraft({
      responseCharacterCount: 999_999,
      waitedMs: -20,
      retryCount: 500,
      completionActionBarDetected: true,
      unknownSecret: 'https://chatgpt.com/c/private-prompt',
    }))

    expect(result).toMatchObject({
      responseCharacterCount: 100_000,
      waitedMs: 0,
      retryCount: 100,
      completionActionBarDetected: true,
    })
    expect(JSON.stringify(result)).not.toContain('private-prompt')
    expect(result).not.toHaveProperty('unknownSecret')
  })

  it('rejects records without a supported schema version', () => {
    expect(sanitizeDiagnosticEventDraft(validDraft({ schemaVersion: undefined }))).toBeNull()
    expect(sanitizeDiagnosticEventDraft(validDraft({ schemaVersion: 999 }))).toBeNull()
  })

  it('sanitizes an untrusted cross-frame diagnostic context', () => {
    expect(sanitizeDiagnosticContext({
      batchId: 'batch_1',
      platformRunId: 'run_1',
      privateText: 'PRIVATE_PROMPT',
    })).toEqual({ batchId: 'batch_1', platformRunId: 'run_1' })
    expect(sanitizeDiagnosticContext({ batchId: 'bad id', platformRunId: 'run_1' })).toBeNull()
  })

  it('rejects invalid required ids, enums, and producer sequences', () => {
    expect(sanitizeDiagnosticEventDraft(validDraft({ batchId: 'contains spaces' }))).toBeNull()
    expect(sanitizeDiagnosticEventDraft(validDraft({ platform: 'unknown-ai' }))).toBeNull()
    expect(sanitizeDiagnosticEventDraft(validDraft({ producerSequence: 0 }))).toBeNull()
  })

  it('drops invalid optional values without rejecting an otherwise valid event', () => {
    const result = sanitizeDiagnosticEventDraft(validDraft({
      selectorConfigVersion: 'https://private.example/config',
      stateStatus: 'not-a-state',
      errorCode: 'raw-private-error',
    }))

    expect(result).not.toHaveProperty('selectorConfigVersion')
    expect(result).not.toHaveProperty('stateStatus')
    expect(result).not.toHaveProperty('errorCode')
  })

  it('maps runtime errors to stable codes without returning their message', () => {
    expect(mapDiagnosticError(new Error('Extension context invalidated: PRIVATE_PROMPT')))
      .toBe('extension-context-invalidated')
    expect(mapDiagnosticError(new Error('Could not establish connection. Receiving end does not exist.')))
      .toBe('content-script-unavailable')
    expect(mapDiagnosticError(new Error('No tab with id: 8'))).toBe('tab-closed')
    expect(mapDiagnosticError(new Error('PRIVATE_PROMPT'))).toBe('unexpected-error')
  })
})
