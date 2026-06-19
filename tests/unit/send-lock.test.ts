import { describe, expect, it } from 'vitest'
import {
  SEND_LOCK_TIMEOUT_MS,
  createSendLock,
  markSendLockSubmitted,
  markSendLockPlatformDone,
  shouldUnlockInsteadOfSend,
  shouldSendLockTimeout,
} from '../../src/lib/send-lock'

describe('send-lock', () => {
  it('stays locked until every target platform is done', () => {
    const lock = createSendLock(['chatgpt', 'gemini'], 1000)

    const afterChatGPT = markSendLockPlatformDone(lock, 'chatgpt', 2000)

    expect(afterChatGPT.status).toBe('waiting')
    expect(afterChatGPT.pendingPlatforms).toEqual(['gemini'])

    const afterGemini = markSendLockPlatformDone(afterChatGPT, 'gemini', 3000)

    expect(afterGemini.status).toBe('done')
    expect(afterGemini.pendingPlatforms).toEqual([])
    expect(afterGemini.completedAt).toBe(3000)
  })

  it('times out after the wait limit while preserving pending platforms', () => {
    const lock = createSendLock(['chatgpt', 'gemini'], 1000)
    const partial = markSendLockPlatformDone(lock, 'chatgpt', 2000)

    expect(shouldSendLockTimeout(partial, 1000 + SEND_LOCK_TIMEOUT_MS - 1)).toBe(false)
    expect(shouldSendLockTimeout(partial, 1000 + SEND_LOCK_TIMEOUT_MS)).toBe(true)
    expect(partial.pendingPlatforms).toEqual(['gemini'])
  })

  it('tracks when the current prompt has been submitted while responses are still pending', () => {
    const lock = createSendLock(['chatgpt', 'gemini'], 1000)

    const submitted = markSendLockSubmitted(lock, 1500)

    expect(submitted.phase).toBe('waiting-response')
    expect(submitted.submittedAt).toBe(1500)
    expect(submitted.pendingPlatforms).toEqual(['chatgpt', 'gemini'])
  })

  it('uses the first send attempt during response waiting as an unlock action', () => {
    const lock = markSendLockSubmitted(createSendLock(['chatgpt'], 1000), 1500)

    expect(shouldUnlockInsteadOfSend(lock)).toBe(true)
    expect(shouldUnlockInsteadOfSend(createSendLock(['chatgpt'], 1000))).toBe(false)
  })
})
