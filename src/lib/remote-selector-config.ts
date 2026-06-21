import type { AIPlatform } from '../types'

export const REMOTE_SELECTOR_CONFIG_URL = 'https://chatduel.ifeeling.app/api/extension/config'
export const REMOTE_SELECTOR_CONFIG_STORAGE_KEY = 'remoteSelectorConfig'

type SelectorValue = string | string[]
export type SelectorOverrideMap = Record<string, SelectorValue>

export interface RemoteSelectorConfig {
  version: string
  expiresAt: string
  platforms: Partial<Record<AIPlatform, { selectors: SelectorOverrideMap }>>
}

const ALLOWED_SELECTOR_KEYS: Record<AIPlatform, Set<string>> = {
  chatgpt: new Set([
    'inputBox',
    'sendButton',
    'messageContainer',
    'lastResponse',
    'userMessage',
    'rateLimitToast',
    'continueButton',
    'stopButton',
    'loggedIn',
    'fileInput',
  ]),
  gemini: new Set([
    'inputBox',
    'sendButton',
    'messageContainer',
    'lastResponse',
    'userMessage',
    'rateLimitToast',
    'continueButton',
    'stopButton',
    'loggedIn',
    'fileInput',
  ]),
  doubao: new Set(['inputBox', 'sendButton', 'response']),
  deepseek: new Set(['inputBox', 'sendButton', 'response']),
  copilot: new Set(['inputBox', 'sendButton', 'response']),
  grok: new Set(['inputBox', 'sendButton', 'response']),
}

const SUPPORTED_PLATFORMS = Object.keys(ALLOWED_SELECTOR_KEYS) as AIPlatform[]
const MAX_SELECTOR_LENGTH = 500
const MAX_SELECTORS_PER_FIELD = 20

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeSelectorString(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const selector = value.trim()
  if (!selector || selector.length > MAX_SELECTOR_LENGTH) return false
  if (/javascript:|https?:\/\/|<\s*\/?\s*script\b|eval\s*\(|new\s+Function\b/i.test(selector)) return false
  return true
}

function sanitizeSelectorValue(value: unknown, allowArray: boolean): SelectorValue | null {
  if (isSafeSelectorString(value)) {
    const selector = value.trim()
    return allowArray ? [selector] : selector
  }
  if (!allowArray || !Array.isArray(value)) return null
  if (value.length === 0 || value.length > MAX_SELECTORS_PER_FIELD) return null
  const selectors = value.map((item) => (isSafeSelectorString(item) ? item.trim() : null))
  if (selectors.some((item) => item === null)) return null
  return selectors as string[]
}

export function sanitizeRemoteSelectorConfig(value: unknown, now = Date.now()): RemoteSelectorConfig | null {
  if (!isPlainObject(value)) return null
  if (typeof value.version !== 'string' || !/^\d{4}\.\d{2}(\.\d+)?$/.test(value.version)) return null
  if (typeof value.expiresAt !== 'string') return null

  const expiresAt = Date.parse(value.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null
  if (!isPlainObject(value.platforms)) return null

  const platforms: RemoteSelectorConfig['platforms'] = {}
  let validSelectorCount = 0

  for (const platform of SUPPORTED_PLATFORMS) {
    const platformConfig = value.platforms[platform]
    if (!isPlainObject(platformConfig) || !isPlainObject(platformConfig.selectors)) continue

    const allowedKeys = ALLOWED_SELECTOR_KEYS[platform]
    const allowArray = platform === 'doubao' || platform === 'deepseek' || platform === 'copilot' || platform === 'grok'
    const selectors: SelectorOverrideMap = {}
    for (const [key, rawSelector] of Object.entries(platformConfig.selectors)) {
      if (!allowedKeys.has(key)) continue
      const selector = sanitizeSelectorValue(rawSelector, allowArray)
      if (!selector) return null
      selectors[key] = selector
      validSelectorCount += Array.isArray(selector) ? selector.length : 1
    }
    if (Object.keys(selectors).length > 0) {
      platforms[platform] = { selectors }
    }
  }

  if (validSelectorCount === 0) return null
  return {
    version: value.version,
    expiresAt: new Date(expiresAt).toISOString(),
    platforms,
  }
}

export function mergeSelectorOverrides<T extends Record<string, SelectorValue>>(
  defaults: T,
  overrides?: SelectorOverrideMap | null,
): T {
  if (!overrides) return { ...defaults }
  return { ...defaults, ...overrides } as T
}

export async function getStoredSelectorOverrides(platform: AIPlatform): Promise<SelectorOverrideMap | undefined> {
  try {
    const result = await chrome.storage.local.get(REMOTE_SELECTOR_CONFIG_STORAGE_KEY)
    const config = sanitizeRemoteSelectorConfig(result[REMOTE_SELECTOR_CONFIG_STORAGE_KEY])
    return config?.platforms[platform]?.selectors
  } catch {
    return undefined
  }
}
