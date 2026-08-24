import type { AIPlatform } from '../types'
import type { DiagnosticContext, DiagnosticErrorCode } from '../lib/diagnostic-types'

/**
 * 平台命令词汇的单一出处。
 *
 * chat 页通过「平台通信」向 AI 平台官方页面发出平台命令，由页面上的命令桥
 * 执行并返回统一回执。两条通道（iframe 直连、经 service worker 的官方标签页
 * 中继）都携带同一个信封 PlatformCommandEnvelope；service worker 不理解命令，
 * 只按平台做纯路由。
 *
 * 新增平台命令时：只需在 PlatformCommandPayloadMap 里加一项，然后让命令桥
 * 执行它、平台通信包装它；service worker 无需任何改动。
 */

/** 每个平台命令携带的参数；命令词汇本身由该表的键推导，只存在于这一处。 */
export interface PlatformCommandPayloadMap {
  'write-and-send': WriteAndSendPayload
  'get-state': Record<string, never>
  'get-last-response': Record<string, never>
  'get-conversation-url': Record<string, never>
  'ping': Record<string, never>
}

export type PlatformCommand = keyof PlatformCommandPayloadMap

/** write-and-send 的参数：问题文本、可选单张图片附件与诊断上下文。 */
export interface WriteAndSendPayload {
  text: string
  imageDataUrl?: string
  imageMime?: string
  imageName?: string
  diagnostics?: DiagnosticContext
}

/** 贯穿两条通道的统一信封：哪个平台 + 哪个命令 + 什么参数。 */
export interface PlatformCommandEnvelope<C extends PlatformCommand = PlatformCommand> {
  platform: AIPlatform
  command: C
  payload: PlatformCommandPayloadMap[C]
}

/** 官方标签页通道的 runtime 消息类型；service worker 据此识别并原样转发信封。 */
export const OFFICIAL_TAB_COMMAND_MESSAGE_TYPE = 'official-tab-command'

export type OfficialTabCommandMessage = {
  type: typeof OFFICIAL_TAB_COMMAND_MESSAGE_TYPE
} & PlatformCommandEnvelope

/** iframe 通道消息：信封外加 source 防干扰与 requestId 请求关联。 */
export interface IframeCommandMessage extends PlatformCommandEnvelope {
  source: 'aichatroom-parent'
  requestId: string
}

/**
 * 命令桥执行平台命令后的统一回执，两条通道同形。
 * command 保留 string：回执要如实回显线上收到的命令，包括无法识别的命令。
 */
export type PlatformCommandResult =
  | { platform: AIPlatform; command: string; ok: true; data: unknown }
  | { platform: AIPlatform; command: string; ok: false; error: string; diagnosticErrorCode?: DiagnosticErrorCode }
