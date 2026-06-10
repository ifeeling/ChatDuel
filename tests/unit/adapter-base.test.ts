import { describe, it, expect } from 'vitest'
import type { AIAdapter } from '../../src/adapters/base'

describe('AIAdapter interface', () => {
  it('can be implemented with all required methods', () => {
    const adapter: AIAdapter = {
      isLoggedIn: async () => true,
      writeText: async () => {},
      triggerSend: async () => {},
      sendMessage: async () => {},
      attachImage: async () => {},
      getLastResponse: async () => '',
      getConversationState: async () => ({ status: 'idle' }),
      onStreamEvent: () => () => {},
      detectRateLimit: async () => false,
    }
    expect(adapter).toBeDefined()
  })
})
