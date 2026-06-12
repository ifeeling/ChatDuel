// AI 平台元数据 + DOM 派生。
//
// 设计原则:
//   - 元数据(key → label/icon/url/capabilities)在这里单点维护
//   - @ 候选、总结目标、转移目标由 enabled platform + capabilities 派生
//     也就是"页面显示"和"能力可用"分开判断
//   - 加新 AI 流程:
//       1) types/index.ts 的 AIPlatform 联合加上新 key(让 TS 在 protocol 层卡住)
//       2) adapters/<name>/adapter.ts + selectors.json
//       3) AI_PLATFORMS 加新元数据
//       4) chat.html 加 <section class="panel" data-platform="<name>">
//     支持哪些功能由 capabilities 控制,避免在 chat.ts 里写平台特判

import type { AIPlatform } from '../types'

export interface AIPlatformMeta {
  /** 类型层 key,跟 types/index.ts AIPlatform 联合里的字符串字面量一致 */
  readonly key: AIPlatform
  /** 候选里显示的中文/英文名 */
  readonly label: string
  /** 一个小图标(emoji 或 1-2 字符) */
  readonly icon: string
  /** 官方网页入口 */
  readonly url: string
  /** 平台当前已验证能力 */
  readonly capabilities: AIPlatformCapabilities
}

export interface AIPlatformCapabilities {
  readonly supportsEmbed: boolean
  readonly supportsText: boolean
  readonly supportsImageUpload: boolean
  readonly supportsFileUpload: boolean
  readonly supportsLastResponse: boolean
}

export const MIN_ACTIVE_PLATFORMS = 2
export const MAX_ACTIVE_PLATFORMS = 3
export const SUPPORTED_PLATFORMS: AIPlatform[] = ['chatgpt', 'gemini', 'doubao']

/** 元数据表(key 必须跟 types/index.ts AIPlatform 联合一致) */
export const AI_PLATFORMS: Record<AIPlatform, AIPlatformMeta> = {
  chatgpt: {
    key: 'chatgpt',
    label: 'ChatGPT',
    icon: '✨',
    url: 'https://chatgpt.com/',
    capabilities: {
      supportsEmbed: true,
      supportsText: true,
      supportsImageUpload: true,
      supportsFileUpload: false,
      supportsLastResponse: true,
    },
  },
  gemini: {
    key: 'gemini',
    label: 'Gemini',
    icon: '✦',
    url: 'https://gemini.google.com/',
    capabilities: {
      supportsEmbed: true,
      supportsText: true,
      supportsImageUpload: true,
      supportsFileUpload: true,
      supportsLastResponse: true,
    },
  },
  doubao: {
    key: 'doubao',
    label: '豆包',
    icon: '豆',
    url: 'https://www.doubao.com/chat/',
    capabilities: {
      supportsEmbed: true,
      supportsText: true,
      supportsImageUpload: false,
      supportsFileUpload: false,
      supportsLastResponse: false,
    },
  },
}

/**
 * 前台实际打开的 AI 面板(从 DOM 派生)。
 * 顺序:HTML 里 <section class="panel" data-platform="..."> 出现的顺序。
 * 过滤掉:不在 AI_PLATFORMS 元数据表里的(防止 HTML 写了未注册的 key)。
 */
export function activePlatforms(): AIPlatform[] {
  if (typeof document === 'undefined') return []
  const panels = document.querySelectorAll<HTMLElement>('.panel[data-platform]')
  const result: AIPlatform[] = []
  const seen = new Set<string>()
  panels.forEach((el) => {
    if (el.hidden) return
    const k = el.dataset.platform
    if (!k || seen.has(k)) return
    if (!(k in AI_PLATFORMS)) return
    seen.add(k)
    result.push(k as AIPlatform)
  })
  return result
}

/**
 * 给候选列表里的第 N 项计算数字快捷键。
 * 索引 0-8 → '1'..'9';索引 9 → '0';超出 9 → null(只能用箭头/鼠标)
 */
export function shortcutKey(index: number): string | null {
  if (index < 0 || index > 9) return null
  return index === 9 ? '0' : String(index + 1)
}

/** 元数据查询(没注册时返回 undefined,调用方自行决定 fallback) */
export function getPlatformMeta(key: string): AIPlatformMeta | undefined {
  return (AI_PLATFORMS as Record<string, AIPlatformMeta | undefined>)[key]
}

export function getPlatformCapabilities(key: AIPlatform): AIPlatformCapabilities {
  return AI_PLATFORMS[key].capabilities
}

export function platformsWithCapability(capability: keyof AIPlatformCapabilities, platforms = activePlatforms()): AIPlatform[] {
  return platforms.filter((platform) => AI_PLATFORMS[platform].capabilities[capability])
}
