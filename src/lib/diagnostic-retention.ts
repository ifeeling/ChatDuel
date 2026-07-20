import {
  DIAGNOSTIC_ABANDONED_AFTER_MS,
  DIAGNOSTIC_SCHEMA_VERSION,
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  MAX_DIAGNOSTIC_AGE_MS,
  MAX_DIAGNOSTIC_BATCHES,
  MAX_DIAGNOSTIC_BYTES,
  MAX_DIAGNOSTIC_EVENTS,
  MAX_DIAGNOSTIC_RUNS,
  MAX_RUN_EVENTS,
  MAX_STORAGE_SEQUENCE,
  sanitizeDiagnosticEventDraft,
  type DiagnosticEvent,
  type DiagnosticRunOutcome,
} from './diagnostic-types'

export const DIAGNOSTIC_ENVELOPE_SCHEMA_VERSION = 1 as const
export const DIAGNOSTIC_EXPORT_SCHEMA_VERSION = 1 as const
export const DIAGNOSTIC_FIELD_DEFINITIONS_VERSION = 1 as const
export const DIAGNOSTIC_EXPORT_NOTICE = 'Diagnostic events are partial technical observations, not a complete conversation snapshot.' as const

export interface DiagnosticTruncation {
  eventsTruncated: true
  droppedEventCount: number
  droppedRunCount?: number
}

export interface DiagnosticEnvelope {
  schemaVersion: typeof DIAGNOSTIC_ENVELOPE_SCHEMA_VERSION
  nextStorageSequence: number
  events: DiagnosticEvent[]
  truncation: {
    runs: Record<string, DiagnosticTruncation>
    batches: Record<string, DiagnosticTruncation>
  }
}

export interface DiagnosticLimits {
  maxBatches: number
  maxRuns: number
  maxEvents: number
  maxBytes: number
  maxAgeMs: number
  maxBatchEvents: number
  maxBatchBytes: number
  maxRunEvents: number
}

export const DEFAULT_DIAGNOSTIC_LIMITS: DiagnosticLimits = {
  maxBatches: MAX_DIAGNOSTIC_BATCHES,
  maxRuns: MAX_DIAGNOSTIC_RUNS,
  maxEvents: MAX_DIAGNOSTIC_EVENTS,
  maxBytes: MAX_DIAGNOSTIC_BYTES,
  maxAgeMs: MAX_DIAGNOSTIC_AGE_MS,
  maxBatchEvents: MAX_BATCH_EVENTS,
  maxBatchBytes: MAX_BATCH_BYTES,
  maxRunEvents: MAX_RUN_EVENTS,
}

export type DiagnosticStructuralWarning = 'invalid-terminal-owner' | 'multiple-terminal-events'

export interface DiagnosticExportRun {
  platformRunId: string
  finalOutcome?: DiagnosticRunOutcome
  derivedOutcome?: 'abandoned'
  derivedReason?: 'missing-terminal-event'
  structuralWarnings: DiagnosticStructuralWarning[]
  truncation?: DiagnosticTruncation
  events: DiagnosticEvent[]
}

export interface DiagnosticExportBatch {
  batchId: string
  truncation?: DiagnosticTruncation
  runs: DiagnosticExportRun[]
}

export interface DiagnosticExportPayload {
  exportSchemaVersion: typeof DIAGNOSTIC_EXPORT_SCHEMA_VERSION
  exportedAt: number
  extensionVersion: string
  notice: typeof DIAGNOSTIC_EXPORT_NOTICE
  retention: {
    maxAgeDays: 7
    maxBatches: number
    maxRuns: number
    maxEvents: number
    maxBytes: number
  }
  fieldDefinitionsVersion: typeof DIAGNOSTIC_FIELD_DEFINITIONS_VERSION
  batches: DiagnosticExportBatch[]
}

export function createEmptyDiagnosticEnvelope(): DiagnosticEnvelope {
  return {
    schemaVersion: DIAGNOSTIC_ENVELOPE_SCHEMA_VERSION,
    nextStorageSequence: 1,
    events: [],
    truncation: { runs: {}, batches: {} },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeId(value: string): boolean {
  return value.length >= 1 && value.length <= 80 && /^[A-Za-z0-9_-]+$/.test(value)
}

function safePositiveInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 1 || value > max) return undefined
  return value
}

function sanitizeStoredEvent(value: unknown): DiagnosticEvent | null {
  if (!isRecord(value)) return null
  const draft = sanitizeDiagnosticEventDraft(value)
  const storageSequence = safePositiveInteger(value.storageSequence, MAX_STORAGE_SEQUENCE)
  if (!draft || storageSequence === undefined) return null
  if (typeof value.extensionVersion !== 'string'
    || value.extensionVersion.length < 1
    || value.extensionVersion.length > 40
    || !/^[A-Za-z0-9._-]+$/.test(value.extensionVersion)) {
    return null
  }
  return { ...draft, storageSequence, extensionVersion: value.extensionVersion }
}

function sanitizeTruncationMap(value: unknown): Record<string, DiagnosticTruncation> {
  if (!isRecord(value)) return {}
  const result: Record<string, DiagnosticTruncation> = {}
  for (const [id, candidate] of Object.entries(value)) {
    if (!isSafeId(id) || !isRecord(candidate) || candidate.eventsTruncated !== true) continue
    const droppedEventCount = safePositiveInteger(candidate.droppedEventCount, MAX_STORAGE_SEQUENCE)
    if (droppedEventCount === undefined) continue
    const droppedRunCount = safePositiveInteger(candidate.droppedRunCount, MAX_STORAGE_SEQUENCE)
    result[id] = {
      eventsTruncated: true,
      droppedEventCount,
      ...(droppedRunCount === undefined ? {} : { droppedRunCount }),
    }
  }
  return result
}

export function sanitizeDiagnosticEnvelope(value: unknown): DiagnosticEnvelope | null {
  if (!isRecord(value) || value.schemaVersion !== DIAGNOSTIC_ENVELOPE_SCHEMA_VERSION) return null
  if (!Array.isArray(value.events)) return null

  const seenSequences = new Set<number>()
  const events: DiagnosticEvent[] = []
  for (const candidate of value.events) {
    const sanitized = sanitizeStoredEvent(candidate)
    if (!sanitized || seenSequences.has(sanitized.storageSequence)) continue
    seenSequences.add(sanitized.storageSequence)
    events.push(sanitized)
  }
  events.sort((a, b) => a.storageSequence - b.storageSequence)

  const runIds = new Set(events.map((event) => event.platformRunId))
  const batchIds = new Set(events.map((event) => event.batchId))
  const truncationValue = isRecord(value.truncation) ? value.truncation : {}
  const runs = sanitizeTruncationMap(truncationValue.runs)
  const batches = sanitizeTruncationMap(truncationValue.batches)
  for (const id of Object.keys(runs)) if (!runIds.has(id)) delete runs[id]
  for (const id of Object.keys(batches)) if (!batchIds.has(id)) delete batches[id]

  const maxSequence = events.reduce((max, event) => Math.max(max, event.storageSequence), 0)
  const storedNext = safePositiveInteger(value.nextStorageSequence, MAX_STORAGE_SEQUENCE) ?? 1
  return {
    schemaVersion: DIAGNOSTIC_ENVELOPE_SCHEMA_VERSION,
    nextStorageSequence: Math.max(storedNext, maxSequence + 1),
    events,
    truncation: { runs, batches },
  }
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const id = key(item)
    const group = groups.get(id)
    if (group) group.push(item)
    else groups.set(id, [item])
  }
  return groups
}

function eventPriority(event: DiagnosticEvent, firstSequences: Set<number>): number {
  if (event.runOutcome) return 0
  if (event.eventStatus === 'failed' || event.eventStatus === 'timed-out') return 1
  if (event.stage === 'accepted' || firstSequences.has(event.storageSequence)) return 2
  if (event.stage === 'state-changed') return 3
  if (event.stage === 'checkpoint') return 4
  return 5
}

function selectEvents(events: DiagnosticEvent[], maxEvents: number): DiagnosticEvent[] {
  if (events.length <= maxEvents) return [...events].sort((a, b) => a.storageSequence - b.storageSequence)
  const firstSequences = new Set<number>()
  for (const producerEvents of groupBy(events, (event) => event.producerId).values()) {
    firstSequences.add(Math.min(...producerEvents.map((event) => event.storageSequence)))
  }
  return [...events]
    .sort((a, b) => {
      const priority = eventPriority(a, firstSequences) - eventPriority(b, firstSequences)
      return priority || b.storageSequence - a.storageSequence
    })
    .slice(0, Math.max(0, maxEvents))
    .sort((a, b) => a.storageSequence - b.storageSequence)
}

function addTruncation(
  map: Record<string, DiagnosticTruncation>,
  id: string,
  droppedEventCount: number,
  droppedRunCount?: number,
): void {
  if (droppedEventCount <= 0 && !droppedRunCount) return
  const current = map[id]
  map[id] = {
    eventsTruncated: true,
    droppedEventCount: (current?.droppedEventCount ?? 0) + Math.max(0, droppedEventCount),
    ...((current?.droppedRunCount ?? 0) + (droppedRunCount ?? 0) > 0
      ? { droppedRunCount: (current?.droppedRunCount ?? 0) + (droppedRunCount ?? 0) }
      : {}),
  }
}

function fitWithinBytes(events: DiagnosticEvent[], maxBytes: number): DiagnosticEvent[] {
  let selected = [...events]
  while (selected.length > 0 && byteLength(selected) > maxBytes) {
    selected = selectEvents(selected, selected.length - 1)
  }
  return selected
}

function countRuns(events: DiagnosticEvent[]): number {
  return new Set(events.map((event) => event.platformRunId)).size
}

function pruneWholeBatches(
  envelope: DiagnosticEnvelope,
  limits: DiagnosticLimits,
): DiagnosticEnvelope {
  let events = [...envelope.events]
  const batchOrder = [...groupBy(events, (event) => event.batchId).entries()]
    .sort(([, left], [, right]) => left[0].storageSequence - right[0].storageSequence)
    .map(([batchId]) => batchId)

  const exceedsLimits = () => new Set(events.map((event) => event.batchId)).size > limits.maxBatches
    || countRuns(events) > limits.maxRuns
    || events.length > limits.maxEvents
    || byteLength({ ...envelope, events }) > limits.maxBytes

  while (events.length > 0 && exceedsLimits()) {
    const oldestBatchId = batchOrder.shift()
    if (!oldestBatchId) break
    events = events.filter((event) => event.batchId !== oldestBatchId)
    delete envelope.truncation.batches[oldestBatchId]
    for (const runId of Object.keys(envelope.truncation.runs)) {
      if (!events.some((event) => event.platformRunId === runId)) delete envelope.truncation.runs[runId]
    }
  }
  return { ...envelope, events }
}

export function appendDiagnosticEvents(
  envelope: DiagnosticEnvelope,
  incoming: DiagnosticEvent[],
  limits = DEFAULT_DIAGNOSTIC_LIMITS,
  now = Date.now(),
): DiagnosticEnvelope {
  const next: DiagnosticEnvelope = {
    schemaVersion: DIAGNOSTIC_ENVELOPE_SCHEMA_VERSION,
    nextStorageSequence: envelope.nextStorageSequence,
    events: [...envelope.events, ...incoming].sort((a, b) => a.storageSequence - b.storageSequence),
    truncation: {
      runs: { ...envelope.truncation.runs },
      batches: { ...envelope.truncation.batches },
    },
  }

  const newestByBatch = new Map<string, number>()
  for (const item of next.events) {
    newestByBatch.set(item.batchId, Math.max(newestByBatch.get(item.batchId) ?? 0, item.timestamp))
  }
  const cutoff = now - limits.maxAgeMs
  next.events = next.events.filter((item) => (newestByBatch.get(item.batchId) ?? 0) >= cutoff)

  const runGroups = groupBy(next.events, (item) => item.platformRunId)
  next.events = []
  for (const [runId, runEvents] of runGroups) {
    const retained = selectEvents(runEvents, limits.maxRunEvents)
    addTruncation(next.truncation.runs, runId, runEvents.length - retained.length)
    next.events.push(...retained)
  }
  next.events.sort((a, b) => a.storageSequence - b.storageSequence)

  const batchGroups = groupBy(next.events, (item) => item.batchId)
  next.events = []
  for (const [batchId, batchEvents] of batchGroups) {
    let retained = selectEvents(batchEvents, limits.maxBatchEvents)
    retained = fitWithinBytes(retained, limits.maxBatchBytes)
    addTruncation(next.truncation.batches, batchId, batchEvents.length - retained.length)
    next.events.push(...retained)
  }
  next.events.sort((a, b) => a.storageSequence - b.storageSequence)

  const pruned = pruneWholeBatches(next, limits)
  const retainedRunIds = new Set(pruned.events.map((item) => item.platformRunId))
  const retainedBatchIds = new Set(pruned.events.map((item) => item.batchId))
  for (const runId of Object.keys(pruned.truncation.runs)) {
    if (!retainedRunIds.has(runId)) delete pruned.truncation.runs[runId]
  }
  for (const batchId of Object.keys(pruned.truncation.batches)) {
    if (!retainedBatchIds.has(batchId)) delete pruned.truncation.batches[batchId]
  }

  const largestSeenSequence = [...envelope.events, ...incoming]
    .reduce((max, item) => Math.max(max, item.storageSequence), 0)
  pruned.nextStorageSequence = Math.max(envelope.nextStorageSequence, largestSeenSequence + 1)
  return pruned
}

export function pruneDiagnosticEnvelope(
  envelope: DiagnosticEnvelope,
  limits = DEFAULT_DIAGNOSTIC_LIMITS,
  now = Date.now(),
): DiagnosticEnvelope {
  return appendDiagnosticEvents(envelope, [], limits, now)
}

function terminalAnalysis(events: DiagnosticEvent[]): {
  outcome?: DiagnosticRunOutcome
  terminalSequence?: number
  warnings: DiagnosticStructuralWarning[]
} {
  const warnings: DiagnosticStructuralWarning[] = []
  const accepted = events.find((event) => event.operation === 'send-ack' && event.stage === 'accepted')
  const acceptancePending = events.find((event) => event.operation === 'send-ack' && event.stage === 'waiting')
  const responseOwnerStart = accepted ?? acceptancePending
  const terminals = events.filter((event) => event.runOutcome !== undefined)
  const hasAdapterTerminalAfterPending = !accepted && acceptancePending
    && terminals.some((event) => event.storageSequence > acceptancePending.storageSequence
      && event.component !== 'response-capture')
  const valid: DiagnosticEvent[] = []
  for (const terminal of terminals) {
    const validOwner = hasAdapterTerminalAfterPending
      ? terminal.storageSequence > acceptancePending!.storageSequence
        && terminal.component !== 'response-capture'
      : responseOwnerStart
      ? terminal.storageSequence > responseOwnerStart.storageSequence && terminal.component === 'response-capture'
      : terminal.component !== 'response-capture'
        && terminal.runOutcome !== 'completed'
        && terminal.runOutcome !== 'paused'
    if (validOwner) valid.push(terminal)
    else if (!warnings.includes('invalid-terminal-owner')) warnings.push('invalid-terminal-owner')
  }
  if (valid.length > 1) warnings.push('multiple-terminal-events')
  if (valid.length !== 1) return { warnings }
  return {
    outcome: valid[0].runOutcome,
    terminalSequence: valid[0].storageSequence,
    warnings,
  }
}

export function deriveDiagnosticExport(
  envelope: DiagnosticEnvelope,
  input: { now: number; activePlatformRunIds: Set<string>; latestFailureOnly?: boolean },
): DiagnosticExportPayload {
  const batchGroups = groupBy(envelope.events, (event) => event.batchId)
  const batches: Array<DiagnosticExportBatch & { latestFailureSequence?: number }> = []
  for (const [batchId, batchEvents] of batchGroups) {
    const runGroups = groupBy(batchEvents, (event) => event.platformRunId)
    const runs: DiagnosticExportRun[] = []
    let latestFailureSequence: number | undefined
    for (const [platformRunId, unsortedEvents] of runGroups) {
      const events = [...unsortedEvents].sort((a, b) => a.storageSequence - b.storageSequence)
      const terminal = terminalAnalysis(events)
      const lastEvent = events.at(-1)
      const run: DiagnosticExportRun = {
        platformRunId,
        structuralWarnings: terminal.warnings,
        events,
        ...(envelope.truncation.runs[platformRunId]
          ? { truncation: envelope.truncation.runs[platformRunId] }
          : {}),
      }
      if (terminal.outcome) run.finalOutcome = terminal.outcome
      if (!terminal.outcome && lastEvent
        && input.now - lastEvent.timestamp > DIAGNOSTIC_ABANDONED_AFTER_MS
        && !input.activePlatformRunIds.has(platformRunId)) {
        run.derivedOutcome = 'abandoned'
        run.derivedReason = 'missing-terminal-event'
      }
      if (terminal.terminalSequence !== undefined
        && (terminal.outcome === 'failed' || terminal.outcome === 'timed-out' || terminal.outcome === 'interrupted')) {
        latestFailureSequence = Math.max(latestFailureSequence ?? 0, terminal.terminalSequence)
      }
      runs.push(run)
    }
    batches.push({
      batchId,
      runs,
      ...(envelope.truncation.batches[batchId]
        ? { truncation: envelope.truncation.batches[batchId] }
        : {}),
      ...(latestFailureSequence === undefined ? {} : { latestFailureSequence }),
    })
  }

  let selectedBatches = batches
  if (input.latestFailureOnly) {
    const latest = [...batches]
      .filter((batch) => batch.latestFailureSequence !== undefined)
      .sort((a, b) => (b.latestFailureSequence ?? 0) - (a.latestFailureSequence ?? 0))[0]
    selectedBatches = latest ? [latest] : []
  }

  const extensionVersion = [...envelope.events]
    .sort((a, b) => b.storageSequence - a.storageSequence)[0]?.extensionVersion ?? 'unknown'
  return {
    exportSchemaVersion: DIAGNOSTIC_EXPORT_SCHEMA_VERSION,
    exportedAt: input.now,
    extensionVersion,
    notice: DIAGNOSTIC_EXPORT_NOTICE,
    retention: {
      maxAgeDays: 7,
      maxBatches: DEFAULT_DIAGNOSTIC_LIMITS.maxBatches,
      maxRuns: DEFAULT_DIAGNOSTIC_LIMITS.maxRuns,
      maxEvents: DEFAULT_DIAGNOSTIC_LIMITS.maxEvents,
      maxBytes: DEFAULT_DIAGNOSTIC_LIMITS.maxBytes,
    },
    fieldDefinitionsVersion: DIAGNOSTIC_FIELD_DEFINITIONS_VERSION,
    batches: selectedBatches.map(({ latestFailureSequence: _ignored, ...batch }) => batch),
  }
}

export function serializeDiagnosticExport(payload: DiagnosticExportPayload): string {
  return JSON.stringify(payload, null, 2)
}
