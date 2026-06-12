import type { AIPlatform } from '../types'
import { MIN_ACTIVE_PLATFORMS, SUPPORTED_PLATFORMS } from './ai-platforms'
import { getDefaultTemplates } from './prompt-template'

export interface UserSettings {
  enabledPlatforms: Record<AIPlatform, boolean>
  promptTemplates: {
    transfer: string
    summary: string
  }
}

type PartialUserSettings = Partial<Omit<UserSettings, 'enabledPlatforms' | 'promptTemplates'>> & {
  enabledPlatforms?: Partial<Record<AIPlatform, boolean>>
  promptTemplates?: Partial<UserSettings['promptTemplates']>
}

const STORAGE_KEY = 'userSettings'

export const DEFAULT_USER_SETTINGS: UserSettings = {
  enabledPlatforms: {
    chatgpt: true,
    gemini: true,
    doubao: false,
  },
  promptTemplates: {
    transfer: getDefaultTemplates().transfer,
    summary: getDefaultTemplates().summary,
  },
}

function normalizeSettings(value: PartialUserSettings | undefined): UserSettings {
  const enabledPlatforms = {
    ...DEFAULT_USER_SETTINGS.enabledPlatforms,
    ...(value?.enabledPlatforms ?? {}),
  } as Record<AIPlatform, boolean>
  const promptTemplates = {
    ...DEFAULT_USER_SETTINGS.promptTemplates,
    ...(value?.promptTemplates ?? {}),
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
  if (promptTemplates.summary.trim().length === 0) {
    promptTemplates.summary = DEFAULT_USER_SETTINGS.promptTemplates.summary
  }

  return { enabledPlatforms, promptTemplates }
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
