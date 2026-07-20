import { describe, expect, it, vi } from 'vitest'
import {
  createDiagnosticBatchId,
  createAdapterDiagnostics,
  createDiagnosticContext,
  createDiagnosticProducerId,
  createDiagnosticReporter,
} from '../../src/lib/diagnostic-client'

const context = { batchId: 'batch_1', platformRunId: 'run_1' }

describe('diagnostic client', () => {
  it('increments the producer sequence without waiting for persistence', () => {
    const pending = new Promise(() => undefined)
    const sender = vi.fn((_message: unknown) => pending)
    const reporter = createDiagnosticReporter(context, 'chatgpt', 'p_adapter_1', sender)

    reporter.emit({
      component: 'platform-adapter',
      operation: 'send-click',
      stage: 'clicked',
      eventStatus: 'succeeded',
    })
    reporter.emit({
      component: 'platform-adapter',
      operation: 'send-ack',
      stage: 'accepted',
      eventStatus: 'succeeded',
    })

    expect(sender).toHaveBeenCalledTimes(2)
    expect(sender.mock.calls.map(([message]) => (
      message as { event: { producerSequence: number } }
    ).event.producerSequence)).toEqual([1, 2])
  })

  it('does not throw when runtime messaging throws synchronously', () => {
    const sender = vi.fn(() => { throw new Error('Extension context invalidated') })
    const reporter = createDiagnosticReporter(context, 'chatgpt', 'p_chat_1', sender)

    expect(() => reporter.emit({
      component: 'chat-ui',
      operation: 'route-select',
      stage: 'started',
      eventStatus: 'observed',
    })).not.toThrow()
  })

  it('swallows an asynchronously rejected runtime message', async () => {
    const sender = vi.fn(() => Promise.reject(new Error('port closed')))
    const reporter = createDiagnosticReporter(context, 'chatgpt', 'p_chat_1', sender)

    reporter.emit({
      component: 'chat-ui',
      operation: 'route-select',
      stage: 'started',
      eventStatus: 'observed',
    })

    await Promise.resolve()
    expect(sender).toHaveBeenCalledOnce()
  })

  it('creates a distinct safe producer id for every reporter instance', () => {
    const first = createDiagnosticProducerId('platform-adapter')
    const second = createDiagnosticProducerId('platform-adapter')

    expect(first).not.toBe(second)
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,80}$/)
    expect(second).toMatch(/^[A-Za-z0-9_-]{1,80}$/)
  })

  it('creates one safe batch id and distinct platform run ids', () => {
    const batchId = createDiagnosticBatchId()
    const first = createDiagnosticContext(batchId)
    const second = createDiagnosticContext(batchId)

    expect(first.batchId).toBe(batchId)
    expect(second.batchId).toBe(batchId)
    expect(first.platformRunId).not.toBe(second.platformRunId)
    expect(JSON.stringify([first, second])).toMatch(/^[\[\]{},:"A-Za-z0-9_-]+$/)
  })

  it('never includes arbitrary event keys in the runtime message', () => {
    const sender = vi.fn(() => Promise.resolve())
    const reporter = createDiagnosticReporter(context, 'chatgpt', 'p_chat_1', sender)

    reporter.emit({
      component: 'chat-ui',
      operation: 'route-select',
      stage: 'started',
      eventStatus: 'observed',
      privateText: 'PRIVATE_PROMPT',
    } as never)

    expect(JSON.stringify(sender.mock.calls)).not.toContain('PRIVATE_PROMPT')
  })

  it('creates adapter diagnostics only from a valid cross-frame context', () => {
    expect(createAdapterDiagnostics('chatgpt', context, '2026.07')).toMatchObject({
      selectorConfigVersion: '2026.07',
      reporter: { emit: expect.any(Function) },
    })
    expect(createAdapterDiagnostics('chatgpt', { batchId: 'bad id' }, '2026.07')).toBeUndefined()
  })
})
