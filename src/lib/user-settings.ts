import type { AIPlatform } from '../types'
import { MIN_ACTIVE_PLATFORMS, SUPPORTED_PLATFORMS } from './ai-platforms'
import { getDefaultTemplates } from './prompt-template'

export type UserLanguage = 'zh-CN' | 'en-US'

export type UserPromptTemplateKey =
  | 'transfer'
  | 'summaryFinalAnswer'
  | 'summaryDifferences'
  | 'summaryShort'
  | 'summaryOpinionDigest'

export type UserPromptTemplates = Record<UserPromptTemplateKey, string>

export interface UserSettings {
  enabledPlatforms: Record<AIPlatform, boolean>
  platformOrder: AIPlatform[]
  language: UserLanguage
  promptTemplates: UserPromptTemplates
}

type PartialUserSettings = Partial<Omit<UserSettings, 'enabledPlatforms' | 'promptTemplates'>> & {
  enabledPlatforms?: Partial<Record<AIPlatform, boolean>>
  platformOrder?: AIPlatform[]
  promptTemplates?: Partial<UserPromptTemplates & { summary: string }>
}

const STORAGE_KEY = 'userSettings'
const SUPPORTED_LANGUAGES: UserLanguage[] = ['zh-CN', 'en-US']

export const DEFAULT_USER_SETTINGS: UserSettings = {
  enabledPlatforms: {
    chatgpt: true,
    gemini: true,
    doubao: false,
  },
  platformOrder: ['gemini', 'chatgpt', 'doubao'],
  language: 'zh-CN',
  promptTemplates: {
    transfer: getDefaultTemplates().transfer,
    summaryFinalAnswer: getDefaultTemplates().summary,
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
      '## 共同意见',
    ].join('\n'),
  },
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
  const language = SUPPORTED_LANGUAGES.includes(value?.language as UserLanguage)
    ? value?.language as UserLanguage
    : DEFAULT_USER_SETTINGS.language
  const legacySummary = value?.promptTemplates?.summary
  const promptTemplates = {
    ...DEFAULT_USER_SETTINGS.promptTemplates,
    ...(value?.promptTemplates ?? {}),
    ...(legacySummary ? { summaryFinalAnswer: legacySummary } : {}),
  }

  const activeCount = SUPPORTED_PLATFORMS.filter((platform) => enabledPlatforms[platform]).length
  if (activeCount < MIN_ACTIVE_PLATFORMS) {
    for (const platform of SUPPORTED_PLATFORMS) {
      enabledPlatforms[platform] = DEFAULT_USER_SETTINGS.enabledPlatforms[platform]
    }
  }

  if (promptTemplates.transfer.trim().length === 0) {
    promptTemplates.transfer = DEFAULT_USER_SETTINGS.promptTemplates.transfer
  }
  for (const key of Object.keys(DEFAULT_USER_SETTINGS.promptTemplates) as UserPromptTemplateKey[]) {
    if (promptTemplates[key].trim().length === 0) {
      promptTemplates[key] = DEFAULT_USER_SETTINGS.promptTemplates[key]
    }
  }

  return { enabledPlatforms, platformOrder, language, promptTemplates }
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
