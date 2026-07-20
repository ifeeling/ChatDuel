import {
  appendDiagnosticEvents,
  createEmptyDiagnosticEnvelope,
  deriveDiagnosticExport,
  pruneDiagnosticEnvelope,
  sanitizeDiagnosticEnvelope,
  type DiagnosticEnvelope,
} from '../lib/diagnostic-retention'
import { sanitizeDiagnosticEventDraft } from '../lib/diagnostic-types'

export const DIAGNOSTIC_STORAGE_KEY = 'localDiagnosticLog'

export interface DiagnosticStorageArea {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(key: string): Promise<void>
}

export interface DiagnosticWriterInternalStatus {
  schemaError: boolean
  storageError: boolean
}

export interface DiagnosticSummary {
  eventCount: number
  batchCount: number
  runCount: number
  earliestTimestamp?: number
  hasFinalFailure: boolean
}

export function createDiagnosticWriter(
  storage: DiagnosticStorageArea,
  extensionVersion: string,
  warn: (message: string) => void,
  isEnabled: () => boolean | Promise<boolean> = () => true,
) {
  let commandChain: Promise<void> = Promise.resolve()
  let cachedEnvelope: DiagnosticEnvelope | null = null
  const lastWarningAt = { schema: 0, storage: 0 }
  const internalStatus: DiagnosticWriterInternalStatus = { schemaError: false, storageError: false }

  const warnLimited = (kind: keyof typeof lastWarningAt) => {
    const now = Date.now()
    if (now - lastWarningAt[kind] < 30_000) return
    lastWarningAt[kind] = now
    warn(kind === 'schema'
      ? '[ChatDuel diagnostic] invalid data dropped'
      : '[ChatDuel diagnostic] local storage operation failed')
  }

  const markFailure = (kind: keyof DiagnosticWriterInternalStatus) => {
    internalStatus[kind] = true
    warnLimited(kind === 'schemaError' ? 'schema' : 'storage')
  }

  const loadEnvelope = async (): Promise<DiagnosticEnvelope> => {
    if (cachedEnvelope) return cachedEnvelope
    const stored = await storage.get(DIAGNOSTIC_STORAGE_KEY)
    const raw = stored[DIAGNOSTIC_STORAGE_KEY]
    if (raw === undefined) {
      cachedEnvelope = createEmptyDiagnosticEnvelope()
      return cachedEnvelope
    }
    const sanitized = sanitizeDiagnosticEnvelope(raw)
    if (!sanitized) {
      markFailure('schemaError')
      cachedEnvelope = createEmptyDiagnosticEnvelope()
      return cachedEnvelope
    }
    cachedEnvelope = sanitized
    return cachedEnvelope
  }

  const enqueue = <T>(command: () => Promise<T>): Promise<T> => {
    const result = commandChain.then(command)
    commandChain = result.then(() => undefined, () => undefined)
    return result
  }

  const loadRetainedEnvelope = async (): Promise<DiagnosticEnvelope> => {
    const envelope = await loadEnvelope()
    const retained = pruneDiagnosticEnvelope(envelope)
    if (retained.events.length !== envelope.events.length) {
      await storage.set({ [DIAGNOSTIC_STORAGE_KEY]: retained })
      cachedEnvelope = retained
    }
    return cachedEnvelope ?? retained
  }

  const append = (value: unknown): Promise<{ ok: boolean }> => {
    const sanitized = sanitizeDiagnosticEventDraft(value)
    if (!sanitized) {
      markFailure('schemaError')
      return Promise.resolve({ ok: false })
    }
    return enqueue(async () => {
      try {
        if (!await isEnabled()) return { ok: true }
        const envelope = await loadEnvelope()
        const storageSequence = envelope.nextStorageSequence
        const next = appendDiagnosticEvents(envelope, [{
          ...sanitized,
          storageSequence,
          extensionVersion,
        }])
        next.nextStorageSequence = storageSequence + 1
        await storage.set({ [DIAGNOSTIC_STORAGE_KEY]: next })
        cachedEnvelope = next
        return { ok: true }
      } catch {
        markFailure('storageError')
        return { ok: false }
      }
    })
  }

  const snapshot = (): Promise<DiagnosticEnvelope> => enqueue(async () => {
    try {
      return structuredClone(await loadRetainedEnvelope())
    } catch {
      markFailure('storageError')
      return createEmptyDiagnosticEnvelope()
    }
  })

  const summary = (): Promise<DiagnosticSummary> => enqueue(async () => {
    try {
      const envelope = await loadRetainedEnvelope()
      const eventCount = envelope.events.length
      const batchCount = new Set(envelope.events.map((event) => event.batchId)).size
      const runCount = new Set(envelope.events.map((event) => event.platformRunId)).size
      const earliestTimestamp = eventCount > 0
        ? Math.min(...envelope.events.map((event) => event.timestamp))
        : undefined
      const exported = deriveDiagnosticExport(envelope, {
        now: Date.now(),
        activePlatformRunIds: new Set(),
      })
      const hasFinalFailure = exported.batches.some((batch) => batch.runs.some((run) =>
        run.finalOutcome === 'failed'
          || run.finalOutcome === 'timed-out'
          || run.finalOutcome === 'interrupted'))
      return {
        eventCount,
        batchCount,
        runCount,
        ...(earliestTimestamp === undefined ? {} : { earliestTimestamp }),
        hasFinalFailure,
      }
    } catch {
      markFailure('storageError')
      return { eventCount: 0, batchCount: 0, runCount: 0, hasFinalFailure: false }
    }
  })

  const clear = (): Promise<{ ok: boolean }> => enqueue(async () => {
    try {
      await storage.remove(DIAGNOSTIC_STORAGE_KEY)
      cachedEnvelope = createEmptyDiagnosticEnvelope()
      return { ok: true }
    } catch {
      markFailure('storageError')
      return { ok: false }
    }
  })

  const getInternalStatus = (): DiagnosticWriterInternalStatus => ({ ...internalStatus })

  return { append, summary, snapshot, clear, getInternalStatus }
}

export type DiagnosticWriter = ReturnType<typeof createDiagnosticWriter>

export function handleDiagnosticWriterMessage(
  writer: DiagnosticWriter,
  message: unknown,
): Promise<unknown> | null {
  if (typeof message !== 'object' || message === null || !('type' in message)) return null
  const typedMessage = message as { type?: unknown; event?: unknown }
  if (typedMessage.type === 'diagnostic:append') return writer.append(typedMessage.event)
  if (typedMessage.type === 'diagnostic:summary') {
    return writer.summary().then((summary) => ({
      ok: true,
      summary,
      internalStatus: writer.getInternalStatus(),
    }))
  }
  if (typedMessage.type === 'diagnostic:snapshot') {
    return writer.snapshot().then((envelope) => ({ ok: true, envelope }))
  }
  if (typedMessage.type === 'diagnostic:clear') return writer.clear()
  return null
}
