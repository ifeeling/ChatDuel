import type { AIPlatform } from '../types'
import {
  DIAGNOSTIC_SCHEMA_VERSION,
  sanitizeDiagnosticContext,
  sanitizeDiagnosticEventDraft,
  type DiagnosticContext,
  type DiagnosticEventDraft,
  type DiagnosticProducerId,
} from './diagnostic-types'

export type DiagnosticReporterEvent = Omit<
  DiagnosticEventDraft,
  | 'schemaVersion'
  | 'timestamp'
  | 'batchId'
  | 'platformRunId'
  | 'producerId'
  | 'producerSequence'
  | 'platform'
>

export interface DiagnosticReporter {
  emit(event: DiagnosticReporterEvent): void
}

export interface AdapterDiagnosticContext {
  reporter: DiagnosticReporter
  selectorConfigVersion: string
}

export type DiagnosticMessageSender = (message: {
  type: 'diagnostic:append'
  event: DiagnosticEventDraft
}) => unknown

function fallbackRandomId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? fallbackRandomId()
}

export function createDiagnosticBatchId(): string {
  return `b_${randomId()}`
}

export function createDiagnosticContext(batchId: string): DiagnosticContext {
  return { batchId, platformRunId: `r_${randomId()}` }
}

export function createDiagnosticProducerId(role: string): DiagnosticProducerId {
  const safeRole = role.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24) || 'producer'
  return `p_${safeRole}_${randomId()}`.slice(0, 80)
}

export function createAdapterDiagnostics(
  platform: AIPlatform,
  context: unknown,
  selectorConfigVersion: string,
): AdapterDiagnosticContext | undefined {
  const sanitizedContext = sanitizeDiagnosticContext(context)
  if (!sanitizedContext) return undefined
  const safeVersion = /^[A-Za-z0-9._-]{1,40}$/.test(selectorConfigVersion)
    ? selectorConfigVersion
    : 'local'
  return {
    reporter: createDiagnosticReporter(
      sanitizedContext,
      platform,
      createDiagnosticProducerId('platform-adapter'),
    ),
    selectorConfigVersion: safeVersion,
  }
}

export function createDiagnosticReporter(
  context: DiagnosticContext,
  platform: AIPlatform,
  producerId: DiagnosticProducerId,
  sender: DiagnosticMessageSender = (message) => chrome.runtime.sendMessage(message),
): DiagnosticReporter {
  let producerSequence = 0
  return {
    emit(event) {
      producerSequence += 1
      const sanitized = sanitizeDiagnosticEventDraft({
        ...event,
        ...context,
        platform,
        producerId,
        producerSequence,
        timestamp: Date.now(),
        schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      })
      if (!sanitized) return
      try {
        const result = sender({ type: 'diagnostic:append', event: sanitized })
        void Promise.resolve(result).catch(() => undefined)
      } catch {
        // 扩展重载时 runtime.sendMessage 可能同步抛错；诊断不能影响真实发送。
      }
    },
  }
}
