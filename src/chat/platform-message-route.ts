import type { AIPlatform } from '../types'

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
