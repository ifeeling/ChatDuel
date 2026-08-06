import type { ConversationState } from '../types'
import type { DiagnosticReporter } from '../lib/diagnostic-client'

export interface AdapterDiagnostics {
  reporter: DiagnosticReporter
  selectorConfigVersion: string
}

/**
 * 平台适配契约：命令桥真正使用的全部方法。
 *
 * 新增平台只需要实现这 3 个方法；写值、触发发送、附件、限流探测等
 * 一律降为适配器内部步骤，不属于跨平台契约。
 */
export interface AIAdapter {
  sendMessage(text: string, image?: File, diagnostics?: AdapterDiagnostics): Promise<void>
  getConversationState(): Promise<ConversationState>
  getLastResponse(): Promise<string>
}

/**
 * 发送链路的内部步骤。
 *
 * 不在 AIAdapter 契约之内，命令桥不会用到；保留为具名方法只是为了让
 * 各平台脆弱的 DOM 逻辑（输入框写入、发送按钮发现、图片上传兜底）
 * 能被单测直接覆盖。
 */
export interface AdapterSendInternals {
  writeText(text: string): Promise<void>
  triggerSend(): Promise<void>
  attachImage(file: File): Promise<void>
}
