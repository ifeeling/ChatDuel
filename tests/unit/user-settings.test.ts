import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_USER_SETTINGS, loadUserSettings, saveUserSettings } from '../../src/lib/user-settings'

beforeEach(() => {
  const store: Record<string, unknown> = {}
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(store, obj)
        }),
      },
    },
  })
})

describe('user-settings', () => {
  it('loads defaults when no settings are saved', async () => {
    await expect(loadUserSettings()).resolves.toEqual(DEFAULT_USER_SETTINGS)
  })

  it('saves enabled platform preferences', async () => {
    const saved = await saveUserSettings({
      enabledPlatforms: { chatgpt: false, gemini: true },
    })
    expect(saved.enabledPlatforms).toEqual({ chatgpt: false, gemini: true })
    expect(saved.promptTemplates.transfer).toBe(DEFAULT_USER_SETTINGS.promptTemplates.transfer)
    expect(saved.promptTemplates.summary).toBe(DEFAULT_USER_SETTINGS.promptTemplates.summary)
    await expect(loadUserSettings()).resolves.toEqual(saved)
  })

  it('keeps at least one platform enabled', async () => {
    const saved = await saveUserSettings({
      enabledPlatforms: { chatgpt: false, gemini: false },
    })
    expect(saved.enabledPlatforms).toEqual({ chatgpt: true, gemini: false })
  })

  it('saves transfer prompt template', async () => {
    const saved = await saveUserSettings({
      promptTemplates: { transfer: '请审查 {{fromLabel}}：{{content}}' },
    })
    expect(saved.promptTemplates.transfer).toBe('请审查 {{fromLabel}}：{{content}}')
  })

  it('saves summary prompt template', async () => {
    const saved = await saveUserSettings({
      promptTemplates: { summary: '总结：{{historyBlock}}' },
    })
    expect(saved.promptTemplates.summary).toBe('总结：{{historyBlock}}')
  })

  it('falls back when transfer prompt is empty', async () => {
    const saved = await saveUserSettings({
      promptTemplates: { transfer: '   ' },
    })
    expect(saved.promptTemplates.transfer).toBe(DEFAULT_USER_SETTINGS.promptTemplates.transfer)
  })

  it('falls back when summary prompt is empty', async () => {
    const saved = await saveUserSettings({
      promptTemplates: { summary: '   ' },
    })
    expect(saved.promptTemplates.summary).toBe(DEFAULT_USER_SETTINGS.promptTemplates.summary)
  })
})
