import { describe, expect, it } from 'vitest'
import { choosePlatformMessageRoute } from '../../src/chat/platform-message-route'

describe('platform message route', () => {
  it('uses official tab routing when an embedded panel is blocked by chrome error page', () => {
    expect(choosePlatformMessageRoute({
      platform: 'copilot',
      iframeReady: false,
      iframeUrl: 'chrome-error://chromewebdata/',
      supportsEmbed: true,
    })).toBe('official-tab')
  })

  it('keeps iframe routing for ready embedded platforms', () => {
    expect(choosePlatformMessageRoute({
      platform: 'grok',
      iframeReady: true,
      iframeUrl: 'https://grok.com/',
      supportsEmbed: true,
    })).toBe('iframe')
  })

  it('keeps Copilot on iframe routing while it is still loading', () => {
    expect(choosePlatformMessageRoute({
      platform: 'copilot',
      iframeReady: false,
      iframeUrl: 'https://copilot.microsoft.com/',
      supportsEmbed: true,
    })).toBe('iframe')
  })
})
