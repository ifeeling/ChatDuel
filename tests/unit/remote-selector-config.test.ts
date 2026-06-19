import { describe, expect, it } from 'vitest'
import {
  REMOTE_SELECTOR_CONFIG_STORAGE_KEY,
  mergeSelectorOverrides,
  sanitizeRemoteSelectorConfig,
} from '../../src/lib/remote-selector-config'

const NOW = Date.parse('2026-06-16T00:00:00Z')

describe('remote selector config', () => {
  it('uses a stable chrome.storage key', () => {
    expect(REMOTE_SELECTOR_CONFIG_STORAGE_KEY).toBe('remoteSelectorConfig')
  })

  it('accepts pure selector JSON and strips unknown keys', () => {
    const config = sanitizeRemoteSelectorConfig({
      version: '2026.06.16',
      expiresAt: '2026-06-17T00:00:00Z',
      platforms: {
        chatgpt: {
          selectors: {
            inputBox: '#composer',
            stopButton: 'button[data-testid="stop-button"]',
            unknownKey: '.should-not-pass',
          },
        },
        doubao: {
          selectors: {
            inputBox: ['textarea', '[role="textbox"]'],
          },
        },
      },
    }, NOW)

    expect(config?.platforms.chatgpt?.selectors.inputBox).toBe('#composer')
    expect(config?.platforms.chatgpt?.selectors.stopButton).toBe('button[data-testid="stop-button"]')
    expect(config?.platforms.chatgpt?.selectors).not.toHaveProperty('unknownKey')
    expect(config?.platforms.doubao?.selectors.inputBox).toEqual(['textarea', '[role="textbox"]'])
  })

  it('rejects expired config', () => {
    const config = sanitizeRemoteSelectorConfig({
      version: '2026.06.15',
      expiresAt: '2026-06-15T00:00:00Z',
      platforms: {
        gemini: {
          selectors: {
            inputBox: 'div.ql-editor',
          },
        },
      },
    }, NOW)

    expect(config).toBeNull()
  })

  it('rejects URL-like or script-like selector values', () => {
    const config = sanitizeRemoteSelectorConfig({
      version: '2026.06.16',
      expiresAt: '2026-06-17T00:00:00Z',
      platforms: {
        chatgpt: {
          selectors: {
            inputBox: 'javascript:alert(1)',
            sendButton: 'https://example.com/script.js',
          },
        },
      },
    }, NOW)

    expect(config).toBeNull()
  })

  it('rejects array selectors for single-selector platforms', () => {
    const config = sanitizeRemoteSelectorConfig({
      version: '2026.06.16',
      expiresAt: '2026-06-17T00:00:00Z',
      platforms: {
        chatgpt: {
          selectors: {
            inputBox: ['#composer', '#prompt-textarea'],
          },
        },
      },
    }, NOW)

    expect(config).toBeNull()
  })

  it('merges valid overrides without dropping local fallbacks', () => {
    const merged = mergeSelectorOverrides(
      {
        inputBox: '#prompt-textarea',
        sendButton: 'button[data-testid="send-button"]',
      },
      {
        inputBox: '#composer',
      },
    )

    expect(merged).toEqual({
      inputBox: '#composer',
      sendButton: 'button[data-testid="send-button"]',
    })
  })
})
