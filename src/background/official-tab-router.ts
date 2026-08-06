import { SUPPORTED_PLATFORMS } from '../lib/ai-platforms'
import { mapDiagnosticError } from '../lib/diagnostic-types'
import type { PlatformCommandResult } from '../shared/messages'
import type { AIPlatform } from '../types'

/**
 * 官方标签页命令的纯路由。
 *
 * 只理解信封上的 platform（用来找目标标签页），不理解 command 与 payload：
 * 信封原样转发给命令桥，命令的识别与执行全部在命令桥一侧。
 * 新增平台命令时这里无需改动。
 */

export interface OfficialTabRouterDependencies {
  findOfficialTab(platform: AIPlatform): Promise<{ id?: number } | null>
  sendToTab(tabId: number, message: unknown): Promise<unknown>
}

export async function routeOfficialTabCommand(
  message: Readonly<Record<string, unknown>>,
  dependencies: OfficialTabRouterDependencies,
): Promise<PlatformCommandResult> {
  const platform = (typeof message.platform === 'string'
    ? message.platform
    : '') as AIPlatform
  const command = typeof message.command === 'string' ? message.command : ''
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    return {
      platform,
      command,
      ok: false,
      error: `不支持的平台：${platform}`,
      diagnosticErrorCode: 'official-tab-unavailable',
    }
  }
  try {
    const tab = await dependencies.findOfficialTab(platform)
    if (!tab?.id) {
      return {
        platform,
        command,
        ok: false,
        error: `${platform} 官方标签页没有打开`,
        diagnosticErrorCode: 'official-tab-unavailable',
      }
    }
    const response = await dependencies.sendToTab(tab.id, message)
    if (response) return response as PlatformCommandResult
    // 命令桥没有应答：页面还未注入新版命令桥，按官方页不可用处理。
    return {
      platform,
      command,
      ok: false,
      error: '官方标签页命令桥没有响应，请刷新该 AI 官网页面',
      diagnosticErrorCode: 'official-tab-unavailable',
    }
  } catch (error) {
    const mappedError = mapDiagnosticError(error)
    return {
      platform,
      command,
      ok: false,
      error: String(error),
      diagnosticErrorCode: mappedError === 'unexpected-error'
        ? 'official-tab-unavailable'
        : mappedError,
    }
  }
}
