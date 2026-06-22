import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_USER_SETTINGS, getDefaultUserPromptTemplates, loadUserSettings, saveUserSettings, swapPlatformOrder } from '../../src/lib/user-settings'

beforeEach(() => {
  const store: Record<string, unknown> = {}
  vi.stubGlobal('chrome', {
    i18n: {
      getUILanguage: vi.fn(() => 'zh-CN'),
    },
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

  it('uses the browser language when no language has been saved', async () => {
    vi.mocked(chrome.i18n.getUILanguage).mockReturnValue('en-US')

    await expect(loadUserSettings()).resolves.toMatchObject({
      language: 'en-US',
      promptTemplates: getDefaultUserPromptTemplates('en-US'),
    })
  })

  it('keeps the saved language instead of the browser language', async () => {
    vi.mocked(chrome.i18n.getUILanguage).mockReturnValue('en-US')

    const saved = await saveUserSettings({ language: 'fr-FR' })

    expect(saved.language).toBe('fr-FR')
    await expect(loadUserSettings()).resolves.toMatchObject({ language: 'fr-FR' })
  })

  it('saves enabled platform preferences', async () => {
    const saved = await saveUserSettings({
      enabledPlatforms: { chatgpt: false, gemini: true, doubao: true },
    })
    expect(saved.enabledPlatforms).toEqual({ chatgpt: false, gemini: true, doubao: true, deepseek: false })
    expect(saved.promptTemplates.transfer).toBe(DEFAULT_USER_SETTINGS.promptTemplates.transfer)
    expect(saved.promptTemplates.summaryFinalAnswer).toBe(DEFAULT_USER_SETTINGS.promptTemplates.summaryFinalAnswer)
    await expect(loadUserSettings()).resolves.toEqual(saved)
  })

  it('saves platform display order', async () => {
    const saved = await saveUserSettings({
      platformOrder: ['gemini', 'doubao', 'chatgpt'],
    })

    expect(saved.platformOrder).toEqual(['gemini', 'doubao', 'chatgpt', 'deepseek'])
    await expect(loadUserSettings()).resolves.toEqual(saved)
  })

  it('saves the preferred language', async () => {
    const saved = await saveUserSettings({
      language: 'en-US',
    })

    expect(saved.language).toBe('en-US')
    await expect(loadUserSettings()).resolves.toEqual(saved)
  })

  it('accepts the requested European languages', async () => {
    const saved = await saveUserSettings({ language: 'fr-FR' })
    expect(saved.language).toBe('fr-FR')
  })

  it('tracks whether prompt templates are customized by the user', async () => {
    const saved = await saveUserSettings({
      promptTemplates: { transfer: 'Custom {{content}}' },
      promptTemplateCustomizations: { transfer: true },
    })

    expect(saved.promptTemplates.transfer).toBe('Custom {{content}}')
    expect(saved.promptTemplateCustomizations.transfer).toBe(true)
    expect(saved.promptTemplateCustomizations.summaryFinalAnswer).toBe(false)
  })

  it('does not keep legacy saved default prompts as custom prompts after language changes', async () => {
    const saved = await saveUserSettings({
      language: 'en-US',
      promptTemplates: DEFAULT_USER_SETTINGS.promptTemplates,
    })

    expect(saved.promptTemplates.transfer).toBe(getDefaultUserPromptTemplates('en-US').transfer)
    expect(saved.promptTemplates.transfer).not.toMatch(/[\u4e00-\u9fff]/)
    expect(saved.promptTemplateCustomizations.transfer).toBe(false)
  })

  it('keeps legacy saved prompts when they are different from known defaults', async () => {
    const saved = await saveUserSettings({
      language: 'en-US',
      promptTemplates: { transfer: 'Custom legacy prompt {{content}}' },
    })

    expect(saved.promptTemplates.transfer).toBe('Custom legacy prompt {{content}}')
    expect(saved.promptTemplateCustomizations.transfer).toBe(true)
  })

  it('normalizes missing platform order entries', async () => {
    const saved = await saveUserSettings({
      platformOrder: ['doubao', 'chatgpt'],
    })

    expect(saved.platformOrder).toEqual(['doubao', 'chatgpt', 'gemini', 'deepseek'])
  })

  it('swaps platform display order when changing a panel to an active platform', () => {
    expect(swapPlatformOrder(['gemini', 'chatgpt', 'doubao'], 'chatgpt', 'doubao'))
      .toEqual(['gemini', 'doubao', 'chatgpt', 'deepseek'])
  })

  it('fills missing platform preferences from defaults', async () => {
    const saved = await saveUserSettings({
      enabledPlatforms: { chatgpt: true, gemini: true },
    })
    expect(saved.enabledPlatforms).toEqual({ chatgpt: true, gemini: true, doubao: false, deepseek: false })
  })

  it('keeps DeepSeek disabled by default while normalizing platform order', async () => {
    const saved = await saveUserSettings({
      platformOrder: ['deepseek', 'chatgpt'],
    })

    expect(saved.enabledPlatforms.deepseek).toBe(false)
    expect(saved.platformOrder).toEqual(['deepseek', 'chatgpt', 'gemini', 'doubao'])
  })

  it('falls back to defaults when fewer than two platforms are enabled', async () => {
    const saved = await saveUserSettings({
      enabledPlatforms: { chatgpt: false, gemini: false, doubao: true },
    })
    expect(saved.enabledPlatforms).toEqual(DEFAULT_USER_SETTINGS.enabledPlatforms)
  })

  it('saves transfer prompt template', async () => {
    const saved = await saveUserSettings({
      promptTemplates: { transfer: '请审查 {{fromLabel}}：{{content}}' },
    })
    expect(saved.promptTemplates.transfer).toBe('请审查 {{fromLabel}}：{{content}}')
  })

  it('saves separate summary prompt templates', async () => {
    const saved = await saveUserSettings({
      promptTemplates: {
        summaryFinalAnswer: '最终：{{historyBlock}}',
        summaryDifferences: '分歧：{{historyBlock}}',
        summaryShort: '简短：{{historyBlock}}',
        summaryOpinionDigest: '意见：{{historyBlock}}',
      },
    })
    expect(saved.promptTemplates.summaryFinalAnswer).toBe('最终：{{historyBlock}}')
    expect(saved.promptTemplates.summaryDifferences).toBe('分歧：{{historyBlock}}')
    expect(saved.promptTemplates.summaryShort).toBe('简短：{{historyBlock}}')
    expect(saved.promptTemplates.summaryOpinionDigest).toBe('意见：{{historyBlock}}')
  })

  it('migrates a legacy summary prompt to the final-answer template', async () => {
    const saved = await saveUserSettings({
      promptTemplates: { summary: '旧总结：{{historyBlock}}' },
    })

    expect(saved.promptTemplates.summaryFinalAnswer).toBe('旧总结：{{historyBlock}}')
    expect(saved.promptTemplates.summaryDifferences).toBe(DEFAULT_USER_SETTINGS.promptTemplates.summaryDifferences)
  })

  it('falls back when transfer prompt is empty', async () => {
    const saved = await saveUserSettings({
      promptTemplates: { transfer: '   ' },
    })
    expect(saved.promptTemplates.transfer).toBe(DEFAULT_USER_SETTINGS.promptTemplates.transfer)
  })

  it('falls back when a summary prompt is empty', async () => {
    const saved = await saveUserSettings({
      promptTemplates: { summaryOpinionDigest: '   ' },
    })
    expect(saved.promptTemplates.summaryOpinionDigest).toBe(DEFAULT_USER_SETTINGS.promptTemplates.summaryOpinionDigest)
  })
})
