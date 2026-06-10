import type { AIPlatform } from '../types'
import { getDefaultTemplates } from './prompt-template'

export interface UserSettings {
  enabledPlatforms: Record<AIPlatform, boolean>
  promptTemplates: {
    transfer: string
  }
}

const STORAGE_KEY = 'userSettings'

export const DEFAULT_USER_SETTINGS: UserSettings = {
  enabledPlatforms: {
    chatgpt: true,
    gemini: true,
  },
  promptTemplates: {
    transfer: getDefaultTemplates().transfer,
  },
}

function normalizeSettings(value: Partial<UserSettings> | undefined): UserSettings {
  const enabledPlatforms = {
    ...DEFAULT_USER_SETTINGS.enabledPlatforms,
    ...(value?.enabledPlatforms ?? {}),
  }
  const promptTemplates = {
    ...DEFAULT_USER_SETTINGS.promptTemplates,
    ...(value?.promptTemplates ?? {}),
  }

  if (!enabledPlatforms.chatgpt && !enabledPlatforms.gemini) {
    enabledPlatforms.chatgpt = true
  }

  if (promptTemplates.transfer.trim().length === 0) {
    promptTemplates.transfer = DEFAULT_USER_SETTINGS.promptTemplates.transfer
  }

  return { enabledPlatforms, promptTemplates }
}

export async function loadUserSettings(): Promise<UserSettings> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  return normalizeSettings(result[STORAGE_KEY] as Partial<UserSettings> | undefined)
}

export async function saveUserSettings(settings: Partial<UserSettings>): Promise<UserSettings> {
  const normalized = normalizeSettings(settings)
  await chrome.storage.local.set({ [STORAGE_KEY]: normalized })
  return normalized
}
