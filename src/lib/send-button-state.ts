import type { SendLockPhase } from './send-lock'

export type SendButtonKind = 'empty' | 'ready' | 'queue' | 'submitting'

export interface SendButtonStateInput {
  hasContent: boolean
  lockPhase: SendLockPhase | null
}

export interface SendButtonState {
  kind: SendButtonKind
  icon: 'send' | 'stop'
  disabled: boolean
  waiting: boolean
}

export function getSendButtonState(input: SendButtonStateInput): SendButtonState {
  if (input.lockPhase === 'submitting') {
    return { kind: 'submitting', icon: 'stop', disabled: true, waiting: false }
  }
  if (input.lockPhase === 'waiting-response') {
    return { kind: 'queue', icon: 'send', disabled: false, waiting: true }
  }
  if (!input.hasContent) {
    return { kind: 'empty', icon: 'send', disabled: true, waiting: false }
  }
  return { kind: 'ready', icon: 'send', disabled: false, waiting: false }
}
