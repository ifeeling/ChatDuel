import type { AIPlatform } from '../types'
import { MIN_ACTIVE_PLATFORMS, SUPPORTED_PLATFORMS } from './ai-platforms'
import { isSupportedLanguage, SUPPORTED_LANGUAGE_CODES, type UserLanguage } from './i18n'
import { getDefaultTemplatesForLanguage } from './prompt-template'

export type UserPromptTemplateKey =
  | 'transfer'
  | 'summaryFinalAnswer'
  | 'summaryDifferences'
  | 'summaryShort'
  | 'summaryOpinionDigest'

export type UserPromptTemplates = Record<UserPromptTemplateKey, string>
export type UserPromptTemplateCustomizations = Record<UserPromptTemplateKey, boolean>

export interface UserSettings {
  enabledPlatforms: Record<AIPlatform, boolean>
  platformOrder: AIPlatform[]
  language: UserLanguage
  captureDebug: boolean
  promptTemplates: UserPromptTemplates
  promptTemplateCustomizations: UserPromptTemplateCustomizations
}

type PartialUserSettings = Partial<Omit<UserSettings, 'enabledPlatforms' | 'promptTemplates' | 'promptTemplateCustomizations'>> & {
  enabledPlatforms?: Partial<Record<AIPlatform, boolean>>
  platformOrder?: AIPlatform[]
  promptTemplates?: Partial<UserPromptTemplates & { summary: string }>
  promptTemplateCustomizations?: Partial<UserPromptTemplateCustomizations>
}

const STORAGE_KEY = 'userSettings'

export function getDefaultUserPromptTemplates(language: UserLanguage): UserPromptTemplates {
  const defaults = getDefaultTemplatesForLanguage(language)
  if (language === 'zh-CN') {
    return {
      transfer: defaults.transfer,
      summaryFinalAnswer: defaults.summary,
      summaryDifferences: [
        '下面是多个 AI 关于同一个问题的回答记录。',
        '',
        '请只分析这些回答之间的分歧、矛盾、互相补充或侧重点不同的地方。',
        '不要重新完整总结全部内容，也不要复述相同观点。',
        '',
        '【历史记录】',
        '{{historyBlock}}',
        '',
        '请按下面结构输出：',
        '',
        '## 分歧点',
        '',
        '## 各 AI 的不同观点',
        '',
        '## 我的判断',
      ].join('\n'),
      summaryShort: [
        '下面是多个 AI 关于同一个问题的回答记录。',
        '',
        '请用尽量短的篇幅给出结论，只保留最重要的 3-5 条信息。',
        '不要展开长篇解释，不要保留寒暄和客套话。',
        '',
        '【历史记录】',
        '{{historyBlock}}',
        '',
        '请直接输出简短摘要。',
      ].join('\n'),
      summaryOpinionDigest: [
        '下面是多个 AI 关于同一个问题的回答记录。',
        '',
        '请只提取各 AI 提出的意见、建议、风险提醒和待确认点。',
        '不要保留寒暄、客套话、自我介绍、重复背景说明。',
        '',
        '【历史记录】',
        '{{historyBlock}}',
        '',
        '请按下面结构输出：',
        '',
        '## ChatGPT 的意见',
        '',
        '## Gemini 的意见',
        '',
        '## 豆包的意见',
        '',
        '## DeepSeek 的意见',
        '',
        '## 共同意见',
      ].join('\n'),
    }
  }

  return {
    transfer: defaults.transfer,
    summaryFinalAnswer: defaults.summary,
    summaryDifferences: [
      'Here are response records from multiple AIs about the same question.',
      '',
      'Analyze only the differences, contradictions, complementary points, and different priorities.',
      'Do not fully summarize everything again and do not repeat shared points.',
      '',
      '[Records]',
      '{{historyBlock}}',
      '',
      'Use this structure:',
      '',
      '## Differences',
      '',
      '## Different views by AI',
      '',
      '## My judgment',
    ].join('\n'),
    summaryShort: [
      'Here are response records from multiple AIs about the same question.',
      '',
      'Give a very short summary with only the 3-5 most important points.',
      'Do not include long explanations, greetings, or filler.',
      '',
      '[Records]',
      '{{historyBlock}}',
      '',
      'Output the short summary directly.',
    ].join('\n'),
    summaryOpinionDigest: [
      'Here are response records from multiple AIs about the same question.',
      '',
      'Extract only opinions, suggestions, risk notes, and open questions from each AI.',
      'Remove greetings, self-introductions, repeated background, and filler.',
      '',
      '[Records]',
      '{{historyBlock}}',
      '',
      'Use this structure:',
      '',
      '## ChatGPT opinions',
      '',
      '## Gemini opinions',
      '',
      '## Doubao opinions',
      '',
      '## DeepSeek opinions',
      '',
      '## Shared opinions',
    ].join('\n'),
  }
}

const DEFAULT_PROMPT_CUSTOMIZATIONS: UserPromptTemplateCustomizations = {
  transfer: false,
  summaryFinalAnswer: false,
  summaryDifferences: false,
  summaryShort: false,
  summaryOpinionDigest: false,
}

const BROWSER_LANGUAGE_FALLBACKS: Record<string, UserLanguage> = {
  zh: 'zh-CN',
  en: 'en-US',
  fr: 'fr-FR',
  de: 'de-DE',
  sv: 'sv-SE',
  nb: 'nb-NO',
  no: 'nb-NO',
  nl: 'nl-NL',
  ja: 'ja-JP',
  ko: 'ko-KR',
}

function normalizeBrowserLanguage(language: string | undefined): UserLanguage {
  if (isSupportedLanguage(language)) return language
  const languagePrefix = language?.split('-')[0]?.toLowerCase()
  return BROWSER_LANGUAGE_FALLBACKS[languagePrefix ?? ''] ?? DEFAULT_USER_SETTINGS.language
}

function getDefaultLanguage(): UserLanguage {
  return normalizeBrowserLanguage(chrome.i18n?.getUILanguage?.())
}

function isKnownDefaultPromptTemplate(key: UserPromptTemplateKey, value: string): boolean {
  return SUPPORTED_LANGUAGE_CODES.some((language) => getDefaultUserPromptTemplates(language)[key] === value)
}

function normalizePromptTemplateCustomizations(
  providedPromptTemplates: Partial<UserPromptTemplates & { summary: string }>,
  providedCustomizations: Partial<UserPromptTemplateCustomizations> | undefined,
): UserPromptTemplateCustomizations {
  const customizations = {
    ...DEFAULT_PROMPT_CUSTOMIZATIONS,
    ...(providedCustomizations ?? {}),
  }

  if (providedCustomizations) return customizations

  for (const key of Object.keys(DEFAULT_PROMPT_CUSTOMIZATIONS) as UserPromptTemplateKey[]) {
    const provided = providedPromptTemplates[key]
    if (typeof provided !== 'string') continue
    customizations[key] = !isKnownDefaultPromptTemplate(key, provided)
  }

  return customizations
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  enabledPlatforms: {
    chatgpt: true,
    gemini: true,
    doubao: false,
    deepseek: false,
  },
  platformOrder: ['gemini', 'chatgpt', 'doubao', 'deepseek'],
  language: 'zh-CN',
  captureDebug: false,
  promptTemplates: getDefaultUserPromptTemplates('zh-CN'),
  promptTemplateCustomizations: DEFAULT_PROMPT_CUSTOMIZATIONS,
}

function normalizePlatformOrder(order: AIPlatform[] | undefined): AIPlatform[] {
  const result: AIPlatform[] = []
  const seen = new Set<AIPlatform>()
  for (const platform of order ?? DEFAULT_USER_SETTINGS.platformOrder) {
    if (!SUPPORTED_PLATFORMS.includes(platform) || seen.has(platform)) continue
    seen.add(platform)
    result.push(platform)
  }
  for (const platform of DEFAULT_USER_SETTINGS.platformOrder) {
    if (seen.has(platform)) continue
    seen.add(platform)
    result.push(platform)
  }
  return result
}

export function swapPlatformOrder(order: AIPlatform[], from: AIPlatform, to: AIPlatform): AIPlatform[] {
  const normalized = normalizePlatformOrder(order)
  const fromIndex = normalized.indexOf(from)
  const toIndex = normalized.indexOf(to)
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return normalized
  const next = [...normalized]
  next[fromIndex] = to
  next[toIndex] = from
  return next
}

function normalizeSettings(value: PartialUserSettings | undefined): UserSettings {
  const enabledPlatforms = {
    ...DEFAULT_USER_SETTINGS.enabledPlatforms,
    ...(value?.enabledPlatforms ?? {}),
  } as Record<AIPlatform, boolean>
  const platformOrder = normalizePlatformOrder(value?.platformOrder)
  const language = isSupportedLanguage(value?.language)
    ? value.language
    : getDefaultLanguage()
  const defaultPromptTemplates = getDefaultUserPromptTemplates(language)
  const providedPromptTemplates = value?.promptTemplates ?? {}
  const promptTemplateCustomizations = normalizePromptTemplateCustomizations(
    providedPromptTemplates,
    value?.promptTemplateCustomizations,
  )
  const legacySummary = value?.promptTemplates?.summary
  if (legacySummary) {
    promptTemplateCustomizations.summaryFinalAnswer = !isKnownDefaultPromptTemplate('summaryFinalAnswer', legacySummary)
  }
  const promptTemplates = { ...defaultPromptTemplates }
  for (const key of Object.keys(defaultPromptTemplates) as UserPromptTemplateKey[]) {
    const provided = key === 'summaryFinalAnswer' && legacySummary
      ? legacySummary
      : value?.promptTemplates?.[key]
    if (promptTemplateCustomizations[key] && typeof provided === 'string') {
      promptTemplates[key] = provided
    }
  }

  const activeCount = SUPPORTED_PLATFORMS.filter((platform) => enabledPlatforms[platform]).length
  if (activeCount < MIN_ACTIVE_PLATFORMS) {
    for (const platform of SUPPORTED_PLATFORMS) {
      enabledPlatforms[platform] = DEFAULT_USER_SETTINGS.enabledPlatforms[platform]
    }
  }

  if (promptTemplates.transfer.trim().length === 0) {
    promptTemplates.transfer = defaultPromptTemplates.transfer
    promptTemplateCustomizations.transfer = false
  }
  for (const key of Object.keys(defaultPromptTemplates) as UserPromptTemplateKey[]) {
    if (promptTemplates[key].trim().length === 0) {
      promptTemplates[key] = defaultPromptTemplates[key]
      promptTemplateCustomizations[key] = false
    }
  }

  return {
    enabledPlatforms,
    platformOrder,
    language,
    captureDebug: value?.captureDebug === true,
    promptTemplates,
    promptTemplateCustomizations,
  }
}

export async function loadUserSettings(): Promise<UserSettings> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  return normalizeSettings(result[STORAGE_KEY] as PartialUserSettings | undefined)
}

export async function saveUserSettings(settings: PartialUserSettings): Promise<UserSettings> {
  const normalized = normalizeSettings(settings)
  await chrome.storage.local.set({ [STORAGE_KEY]: normalized })
  return normalized
}
