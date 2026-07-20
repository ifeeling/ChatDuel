import { describe, expect, it, vi } from 'vitest'
import type { DiagnosticEventDraft } from '../../src/lib/diagnostic-types'
import {
  DIAGNOSTIC_STORAGE_KEY,
  createDiagnosticWriter,
  handleDiagnosticWriterMessage,
  type DiagnosticStorageArea,
} from '../../src/background/diagnostic-writer'

const NOW = Date.now()

function draft(index: number): DiagnosticEventDraft {
  return {
    schemaVersion: 1,
    timestamp: NOW + index,
    batchId: `batch_${Math.floor(index / 10)}`,
    platformRunId: `run_${Math.floor(index / 10)}`,
    producerId: 'p_test_1',
    producerSequence: index + 1,
    platform: 'chatgpt',
    component: 'platform-adapter',
    operation: 'send-click',
    stage: 'clicked',
    eventStatus: 'succeeded',
  }
}

function memoryStorage(initial: Record<string, unknown> = {}): DiagnosticStorageArea & {
  state: Record<string, unknown>
} {
  const state = { ...initial }
  return {
    state,
    async get(key) {
      return { [key]: state[key] }
    },
    async set(items) {
      Object.assign(state, items)
    },
    async remove(key) {
      delete state[key]
    },
  }
}

describe('diagnostic writer', () => {
  it('serializes concurrent appends without losing events', async () => {
    const writer = createDiagnosticWriter(memoryStorage(), '0.4.13', vi.fn())
    await Promise.all(Array.from({ length: 100 }, (_, index) => writer.append(draft(index))))

    const snapshot = await writer.snapshot()
    expect(snapshot.events).toHaveLength(100)
    expect(new Set(snapshot.events.map((event) => event.storageSequence)).size).toBe(100)
  })

  it('continues storage sequence after a worker restart', async () => {
    const storage = memoryStorage()
    const first = createDiagnosticWriter(storage, '0.4.13', vi.fn())
    await first.append(draft(0))

    const restarted = createDiagnosticWriter(storage, '0.4.13', vi.fn())
    await restarted.append(draft(1))

    expect((await restarted.snapshot()).events.map((event) => event.storageSequence)).toEqual([1, 2])
  })

  it('does not recurse or repeatedly warn when storage keeps failing', async () => {
    const storage = memoryStorage()
    storage.set = vi.fn().mockRejectedValue(new Error('quota'))
    const warn = vi.fn()
    const writer = createDiagnosticWriter(storage, '0.4.13', warn)

    await expect(writer.append(draft(0))).resolves.toEqual({ ok: false })
    await expect(writer.append(draft(1))).resolves.toEqual({ ok: false })

    expect(storage.set).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(writer.getInternalStatus()).toMatchObject({ storageError: true })
  })

  it('reports an invalid event in memory without persisting the failure', async () => {
    const storage = memoryStorage()
    storage.set = vi.fn(storage.set)
    const writer = createDiagnosticWriter(storage, '0.4.13', vi.fn())

    await expect(writer.append({ schemaVersion: 1, rawError: 'PRIVATE_PROMPT' })).resolves.toEqual({ ok: false })

    expect(storage.set).not.toHaveBeenCalled()
    expect(writer.getInternalStatus()).toMatchObject({ schemaError: true })
  })

  it('falls back safely from a damaged envelope', async () => {
    const storage = memoryStorage({
      [DIAGNOSTIC_STORAGE_KEY]: { schemaVersion: 999, events: 'broken' },
    })
    const writer = createDiagnosticWriter(storage, '0.4.13', vi.fn())

    await writer.append(draft(0))

    expect((await writer.snapshot()).events).toHaveLength(1)
    expect((await writer.snapshot()).events[0].storageSequence).toBe(1)
    expect(writer.getInternalStatus()).toMatchObject({ schemaError: true })
  })

  it('serializes append, snapshot, and clear on one command queue', async () => {
    const writer = createDiagnosticWriter(memoryStorage(), '0.4.13', vi.fn())
    const beforeClear = writer.append(draft(0))
    const clear = writer.clear()
    const afterClear = writer.append(draft(1))
    await Promise.all([beforeClear, clear, afterClear])

    const snapshot = await writer.snapshot()
    expect(snapshot.events).toHaveLength(1)
    expect(snapshot.events[0].storageSequence).toBe(1)
    expect(snapshot.events[0].producerSequence).toBe(2)
  })

  it('returns a summary without exposing the event array', async () => {
    const writer = createDiagnosticWriter(memoryStorage(), '0.4.13', vi.fn())
    await writer.append(draft(0))

    const summary = await writer.summary()

    expect(summary).toMatchObject({ eventCount: 1, batchCount: 1, runCount: 1, earliestTimestamp: NOW })
    expect(summary).not.toHaveProperty('events')
  })

  it('handles only the four diagnostic runtime message types', async () => {
    const writer = createDiagnosticWriter(memoryStorage(), '0.4.13', vi.fn())

    await expect(handleDiagnosticWriterMessage(writer, {
      type: 'diagnostic:append',
      event: draft(0),
    })).resolves.toEqual({ ok: true })
    await expect(handleDiagnosticWriterMessage(writer, { type: 'diagnostic:summary' }))
      .resolves.toMatchObject({ ok: true, summary: { eventCount: 1 } })
    await expect(handleDiagnosticWriterMessage(writer, { type: 'diagnostic:snapshot' }))
      .resolves.toMatchObject({ ok: true, envelope: { events: [expect.any(Object)] } })
    await expect(handleDiagnosticWriterMessage(writer, { type: 'diagnostic:clear' }))
      .resolves.toEqual({ ok: true })
    expect(handleDiagnosticWriterMessage(writer, { type: 'unrelated' })).toBeNull()
  })
})
