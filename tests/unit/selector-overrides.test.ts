import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSelectorConfig } from '../../src/content-scripts/selector-overrides'

describe('selector override loader', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(),
      },
    })
  })

  it('returns the remote selector version with its overrides', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      ok: true,
      selectors: { inputBox: '#remote-composer' },
      version: '2026.07.1',
    })

    await expect(loadSelectorConfig('chatgpt', '2026.06')).resolves.toEqual({
      selectors: { inputBox: '#remote-composer' },
      version: '2026.07.1',
    })
  })

  it('uses the local selector version when the remote config is unavailable', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockRejectedValue(new Error('worker unavailable'))

    await expect(loadSelectorConfig('chatgpt', '2026.06')).resolves.toEqual({
      selectors: undefined,
      version: '2026.06',
    })
  })
})
