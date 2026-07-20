import type { AIPlatform, StreamStatus } from '../types'

export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const
export const MAX_DIAGNOSTIC_BATCHES = 20
export const MAX_DIAGNOSTIC_RUNS = 100
export const MAX_DIAGNOSTIC_EVENTS = 1_000
export const MAX_DIAGNOSTIC_BYTES = 1_000_000
export const MAX_BATCH_EVENTS = 200
export const MAX_BATCH_BYTES = 256_000
export const MAX_RUN_EVENTS = 50
export const MAX_DIAGNOSTIC_AGE_MS = 7 * 24 * 60 * 60 * 1_000
export const DIAGNOSTIC_ABANDONED_AFTER_MS = 10 * 60 * 1_000
export const MAX_CHARACTER_COUNT = 100_000
export const MAX_DIAGNOSTIC_ID_LENGTH = 80
export const MAX_SELECTOR_VERSION_LENGTH = 40
export const MAX_PRODUCER_SEQUENCE = 100_000
export const MAX_STORAGE_SEQUENCE = Number.MAX_SAFE_INTEGER
export const MAX_WAIT_MS = 3_600_000
export const MAX_RETRY_COUNT = 100

const PLATFORMS = ['chatgpt', 'gemini', 'doubao', 'deepseek', 'claude'] as const
const COMPONENTS = [
  'chat-ui',
  'background',
  'content-script',
  'iframe-bridge',
  'official-tab',
  'platform-adapter',
  'response-capture',
] as const
const OPERATIONS = [
  'route-select',
  'input-locate',
  'input-write',
  'attachment-prepare',
  'send-click',
  'send-ack',
  'state-read',
  'response-read',
  'response-compare',
  'result-return',
] as const
const STAGES = [
  'started',
  'routed',
  'located',
  'written',
  'preparing',
  'prepared',
  'clicked',
  'waiting',
  'accepted',
  'state-changed',
  'checkpoint',
  'response-observed',
  'completed',
  'paused',
  'failed',
  'timed-out',
  'skipped',
  'interrupted',
] as const
const EVENT_STATUSES = ['observed', 'succeeded', 'failed', 'timed-out', 'skipped'] as const
const RUN_OUTCOMES = ['completed', 'paused', 'failed', 'timed-out', 'interrupted'] as const
const ROUTES = ['iframe', 'official-tab'] as const
const STREAM_STATUSES = ['idle', 'queued', 'sending', 'streaming', 'paused', 'finished', 'error'] as const
const ERROR_CODES = [
  'input-box-not-found',
  'send-button-not-found',
  'send-button-not-ready',
  'send-ack-timeout',
  'message-not-accepted',
  'iframe-result-timeout',
  'official-tab-unavailable',
  'message-route-unavailable',
  'state-request-timeout',
  'response-selector-empty',
  'response-still-streaming',
  'response-equals-baseline',
  'response-capture-timeout',
  'content-script-unavailable',
  'extension-context-invalidated',
  'tab-closed',
  'tab-navigation-detected',
  'input-write-failed',
  'send-click-failed',
  'attachment-preparation-timeout',
  'adapter-unsupported-page',
  'unexpected-error',
] as const

export type DiagnosticComponent = typeof COMPONENTS[number]
export type DiagnosticOperation = typeof OPERATIONS[number]
export type DiagnosticStage = typeof STAGES[number]
export type DiagnosticEventStatus = typeof EVENT_STATUSES[number]
export type DiagnosticRunOutcome = typeof RUN_OUTCOMES[number]
export type DiagnosticErrorCode = typeof ERROR_CODES[number]
export type DiagnosticProducerId = string

export interface DiagnosticContext {
  batchId: string
  platformRunId: string
}

export interface DiagnosticEventDraft extends DiagnosticContext {
  schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION
  timestamp: number
  producerId: DiagnosticProducerId
  producerSequence: number
  platform: AIPlatform
  component: DiagnosticComponent
  operation: DiagnosticOperation
  stage: DiagnosticStage
  eventStatus: DiagnosticEventStatus
  runOutcome?: DiagnosticRunOutcome
  errorCode?: DiagnosticErrorCode
  route?: typeof ROUTES[number]
  retryNumber?: number
  retryCount?: number
  waitedMs?: number
  timeoutMs?: number
  stateStatus?: StreamStatus
  lastObservedState?: StreamStatus
  selectorConfigVersion?: string
  inputCharacterCount?: number
  responseCharacterCount?: number
  baselineCharacterCount?: number
  hasAttachment?: boolean
  stopButtonDetected?: boolean
  differsFromBaseline?: boolean
  pollCount?: number
  stateChangeCount?: number
}

export interface DiagnosticEvent extends DiagnosticEventDraft {
  storageSequence: number
  extensionVersion: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEnumValue<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && values.includes(value as T[number])
}

function isId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= MAX_DIAGNOSTIC_ID_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(value)
}

export function sanitizeDiagnosticContext(value: unknown): DiagnosticContext | null {
  if (!isRecord(value) || !isId(value.batchId) || !isId(value.platformRunId)) return null
  return { batchId: value.batchId, platformRunId: value.platformRunId }
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function copyOptionalInteger(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
  max: number,
): void {
  const value = boundedInteger(source[key], 0, max)
  if (value !== undefined) target[key] = value
}

function copyOptionalBoolean(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  if (typeof source[key] === 'boolean') target[key] = source[key]
}

export function sanitizeDiagnosticEventDraft(value: unknown): DiagnosticEventDraft | null {
  if (!isRecord(value) || value.schemaVersion !== DIAGNOSTIC_SCHEMA_VERSION) return null
  if (!isId(value.batchId) || !isId(value.platformRunId) || !isId(value.producerId)) return null
  if (!isEnumValue(PLATFORMS, value.platform)) return null
  if (!isEnumValue(COMPONENTS, value.component)) return null
  if (!isEnumValue(OPERATIONS, value.operation)) return null
  if (!isEnumValue(STAGES, value.stage)) return null
  if (!isEnumValue(EVENT_STATUSES, value.eventStatus)) return null

  const timestamp = boundedInteger(value.timestamp, 0, Number.MAX_SAFE_INTEGER)
  const producerSequence = boundedInteger(value.producerSequence, 1, MAX_PRODUCER_SEQUENCE)
  if (timestamp === undefined || producerSequence === undefined || producerSequence !== value.producerSequence) {
    return null
  }

  const result: Record<string, unknown> = {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    timestamp,
    batchId: value.batchId,
    platformRunId: value.platformRunId,
    producerId: value.producerId,
    producerSequence,
    platform: value.platform,
    component: value.component,
    operation: value.operation,
    stage: value.stage,
    eventStatus: value.eventStatus,
  }

  if (isEnumValue(RUN_OUTCOMES, value.runOutcome)) result.runOutcome = value.runOutcome
  if (isEnumValue(ERROR_CODES, value.errorCode)) result.errorCode = value.errorCode
  if (isEnumValue(ROUTES, value.route)) result.route = value.route
  if (isEnumValue(STREAM_STATUSES, value.stateStatus)) result.stateStatus = value.stateStatus
  if (isEnumValue(STREAM_STATUSES, value.lastObservedState)) result.lastObservedState = value.lastObservedState
  if (typeof value.selectorConfigVersion === 'string'
    && value.selectorConfigVersion.length >= 1
    && value.selectorConfigVersion.length <= MAX_SELECTOR_VERSION_LENGTH
    && /^[A-Za-z0-9._-]+$/.test(value.selectorConfigVersion)) {
    result.selectorConfigVersion = value.selectorConfigVersion
  }

  copyOptionalInteger(result, value, 'retryNumber', MAX_RETRY_COUNT)
  copyOptionalInteger(result, value, 'retryCount', MAX_RETRY_COUNT)
  copyOptionalInteger(result, value, 'waitedMs', MAX_WAIT_MS)
  copyOptionalInteger(result, value, 'timeoutMs', MAX_WAIT_MS)
  copyOptionalInteger(result, value, 'inputCharacterCount', MAX_CHARACTER_COUNT)
  copyOptionalInteger(result, value, 'responseCharacterCount', MAX_CHARACTER_COUNT)
  copyOptionalInteger(result, value, 'baselineCharacterCount', MAX_CHARACTER_COUNT)
  copyOptionalInteger(result, value, 'pollCount', MAX_PRODUCER_SEQUENCE)
  copyOptionalInteger(result, value, 'stateChangeCount', MAX_PRODUCER_SEQUENCE)
  copyOptionalBoolean(result, value, 'hasAttachment')
  copyOptionalBoolean(result, value, 'stopButtonDetected')
  copyOptionalBoolean(result, value, 'differsFromBaseline')

  return result as unknown as DiagnosticEventDraft
}

export function mapDiagnosticError(error: unknown): DiagnosticErrorCode {
  const message = error instanceof Error
    ? error.message
    : isRecord(error) && typeof error.message === 'string'
      ? error.message
      : ''
  const normalized = message.toLowerCase()
  if (normalized.includes('extension context invalidated')) return 'extension-context-invalidated'
  if (normalized.includes('receiving end does not exist')
    || normalized.includes('could not establish connection')
    || normalized.includes('message port closed')) {
    return 'content-script-unavailable'
  }
  if (normalized.includes('no tab with id') || normalized.includes('tab was closed')) return 'tab-closed'
  return 'unexpected-error'
}
