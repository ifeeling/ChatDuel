import { describe, expect, it } from 'vitest'
import { getSendButtonState } from '../../src/lib/send-button-state'

describe('send-button-state', () => {
  it('disables sending when there is no message or attachment', () => {
    expect(getSendButtonState({ hasContent: false, lockPhase: null })).toEqual({
      kind: 'empty',
      icon: 'send',
      disabled: true,
      waiting: false,
    })
  })

  it('uses a blue send state when content is ready', () => {
    expect(getSendButtonState({ hasContent: true, lockPhase: null })).toEqual({
      kind: 'ready',
      icon: 'send',
      disabled: false,
      waiting: false,
    })
  })

  it('uses a stop icon while waiting for AI responses but remains clickable', () => {
    expect(getSendButtonState({ hasContent: true, lockPhase: 'waiting-response' })).toEqual({
      kind: 'waiting-response',
      icon: 'stop',
      disabled: false,
      waiting: true,
    })
  })

  it('uses a disabled stop icon while submitting the current message', () => {
    expect(getSendButtonState({ hasContent: true, lockPhase: 'submitting' })).toEqual({
      kind: 'submitting',
      icon: 'stop',
      disabled: true,
      waiting: false,
    })
  })
})
