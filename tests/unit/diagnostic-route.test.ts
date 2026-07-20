import { describe, expect, it } from 'vitest'
import { routeTimeoutErrorCode } from '../../src/chat/platform-message-route'

describe('diagnostic route errors', () => {
  it('maps a missing route reply to a stable diagnostic error code', () => {
    expect(routeTimeoutErrorCode('iframe')).toBe('iframe-result-timeout')
    expect(routeTimeoutErrorCode('official-tab')).toBe('official-tab-unavailable')
  })
})
