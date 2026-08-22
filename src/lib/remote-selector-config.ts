import type { AIPlatform } from '../types'

export const REMOTE_SELECTOR_CONFIG_URL =
  import.meta.env.VITE_REMOTE_SELECTOR_CONFIG_URL ?? 'https://chatduel.ifeeling.app/api/extension/config'
export const REMOTE_SELECTOR_CONFIG_STORAGE_KEY = 'remoteSelectorConfig'

type SelectorValue = string | string[]
export type SelectorOverrideMap = Record<string, SelectorValue>

export interface PromptOptimizationClientConfig {
  maxPromptLength: number
}

export interface RemoteSelectorConfig {
  version: string
  expiresAt: string
  platforms: Partial<Record<AIPlatform, { selectors: SelectorOverrideMap }>>
  promptOptimization?: PromptOptimizationClientConfig
}

export interface StoredSelectorConfig {
  selectors?: SelectorOverrideMap
  version?: string
}

// ⚠️ 这份客户端允许字段表只决定"接不接受服务器下发的这个 key"，不会自动让服务器
// 真的下发对应的值。加一个新 key 到这里之后，如果对应平台的选择器又出现改版失效，
// 记得同步登录 chatduel.ifeeling.app 的远程配置后台把这个字段的值也补上，
// 否则加了 key 也只是"允许热更新"，没有真的推送热更新，效果等于没加。
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
  ]),
  doubao: new Set(['inputBox', 'sendButton', 'response', 'stopButton']),
  deepseek: new Set(['inputBox', 'sendButton', 'response', 'stopButton']),
  claude: new Set([
    'inputBox',
    'sendButton',
    'messageContainer',
    'lastResponse',
    'userMessage',
    'rateLimitToast',
    'continueButton',
    'stopButton',
    'loggedIn',
  ]),
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

function sanitizePromptOptimizationConfig(value: unknown): PromptOptimizationClientConfig | undefined {
  if (!isPlainObject(value)) return undefined
  const { maxPromptLength } = value
  if (typeof maxPromptLength !== 'number' || !Number.isInteger(maxPromptLength) || maxPromptLength <= 0) return undefined
  return { maxPromptLength }
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
    const allowArray = platform === 'doubao' || platform === 'deepseek'
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
  const promptOptimization = sanitizePromptOptimizationConfig(value.promptOptimization)
  return {
    version: value.version,
    expiresAt: new Date(expiresAt).toISOString(),
    platforms,
    ...(promptOptimization ? { promptOptimization } : {}),
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
  return (await getStoredSelectorConfig(platform)).selectors
}

export async function getStoredPromptOptimizationConfig(): Promise<PromptOptimizationClientConfig | undefined> {
  try {
    const result = await chrome.storage.local.get(REMOTE_SELECTOR_CONFIG_STORAGE_KEY)
    return sanitizeRemoteSelectorConfig(result[REMOTE_SELECTOR_CONFIG_STORAGE_KEY])?.promptOptimization
  } catch {
    return undefined
  }
}

export async function getStoredSelectorConfig(platform: AIPlatform): Promise<StoredSelectorConfig> {
  try {
    const result = await chrome.storage.local.get(REMOTE_SELECTOR_CONFIG_STORAGE_KEY)
    const config = sanitizeRemoteSelectorConfig(result[REMOTE_SELECTOR_CONFIG_STORAGE_KEY])
    return {
      selectors: config?.platforms[platform]?.selectors,
      version: config?.platforms[platform] ? config.version : undefined,
    }
  } catch {
    return {}
  }
}
