import type { AIPlatform } from '../types'

export const CAPTURE_DEBUG_STORAGE_KEY = 'CHATDUEL_DEBUG_CAPTURE'
export const CAPTURE_DEBUG_PREFIX = '[ChatDuel capture debug]'
const USER_SETTINGS_STORAGE_KEY = 'userSettings'

export interface CaptureDebugElement {
  tag: string
  className: string
  testId: string
  role: string
  ariaLabel: string
  textPreview: string
}

export interface CaptureDebugCandidate extends CaptureDebugElement {
  index: number
  score: number
  isUserMessage: boolean
}

export interface CaptureDebugPayload {
  platform?: AIPlatform
  event: string
  candidates?: CaptureDebugCandidate[]
  selected?: CaptureDebugCandidate
  [key: string]: unknown
}

async function captureDebugEnabled(): Promise<boolean> {
  try {
    if (chrome?.storage?.local) {
      const result = await chrome.storage.local.get(USER_SETTINGS_STORAGE_KEY)
      const settings = result[USER_SETTINGS_STORAGE_KEY] as { captureDebug?: boolean } | undefined
      if (settings?.captureDebug === true) return true
    }
  } catch {
    /* fall back to localStorage below */
  }
  try {
    return globalThis.localStorage?.getItem(CAPTURE_DEBUG_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function textPreview(text: string, maxLength = 180): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact
}

export function describeCaptureElement(el: HTMLElement, text: string): CaptureDebugElement {
  return {
    tag: el.tagName.toLowerCase(),
    className: el.className?.toString() ?? '',
    testId: el.getAttribute('data-testid') ?? '',
    role: el.getAttribute('role') ?? '',
    ariaLabel: el.getAttribute('aria-label') ?? '',
    textPreview: textPreview(text),
  }
}

function safeJson(payload: CaptureDebugPayload): string {
  try {
    return JSON.stringify({
      time: new Date().toISOString(),
      ...payload,
    })
  } catch {
    return JSON.stringify({
      time: new Date().toISOString(),
      event: payload.event,
      platform: payload.platform,
      error: 'debug payload stringify failed',
    })
  }
}

export function logCaptureDebug(payload: CaptureDebugPayload): void {
  void (async () => {
    if (!(await captureDebugEnabled())) return
    console.log(CAPTURE_DEBUG_PREFIX, safeJson(payload))
  })()
}
