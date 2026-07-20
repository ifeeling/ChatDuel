import type { AIPlatform } from '../types'
import type { DiagnosticErrorCode } from '../lib/diagnostic-types'

export type PlatformMessageRoute = 'iframe' | 'official-tab'

interface PlatformMessageRouteInput {
  platform: AIPlatform
  iframeReady: boolean
  iframeUrl: string
  supportsEmbed: boolean
}

export function choosePlatformMessageRoute(input: PlatformMessageRouteInput): PlatformMessageRoute {
  if (!input.supportsEmbed) return 'official-tab'
  if (input.iframeUrl.startsWith('chrome-error://')) return 'official-tab'
  return 'iframe'
}

export function iframeWriteResultTimeoutMs(payload: Record<string, unknown>): number {
  return typeof payload.imageDataUrl === 'string' && payload.imageDataUrl.length > 0
    ? 30000
    : 8000
}

export function routeTimeoutErrorCode(route: PlatformMessageRoute): DiagnosticErrorCode {
  return route === 'iframe' ? 'iframe-result-timeout' : 'official-tab-unavailable'
}

interface IframeReadyRetryInput {
  waitForReady: () => Promise<boolean>
  ensureRules: () => Promise<void>
  reload: () => void
}

export async function waitForIframeReadyWithRetry(input: IframeReadyRetryInput): Promise<boolean> {
  if (await input.waitForReady()) return true

  await input.ensureRules()
  input.reload()
  return input.waitForReady()
}
