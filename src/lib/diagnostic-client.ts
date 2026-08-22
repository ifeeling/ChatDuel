import type { AIPlatform } from '../types'
import { AI_PLATFORMS } from './ai-platforms'
import {
  DIAGNOSTIC_SCHEMA_VERSION,
  sanitizeDiagnosticContext,
  sanitizeDiagnosticEventDraft,
  type DiagnosticContext,
  type DiagnosticErrorCode,
  type DiagnosticEventDraft,
  type DiagnosticProducerId,
} from './diagnostic-types'
import { notifyDebugAlert } from './debug-fallback-notify'

// 这三个错误码是唯一真正对应"在页面上查了个选择器、一个都没找到"的情况——也就是
// remote-selector-config.ts 里能被服务器端热更新覆盖的 inputBox/sendButton/response
// 三个字段。stopButton 故意不在这里：它合法地经常查不到（平台没在生成时本来就该
// 查不到），不是"选择器坏了"的信号，doubao/adapter.ts 已经用更精确的完成判定
// 状态机（打断按钮/操作栏跳变）单独处理了它，不能套用这套"查不到就报警"的逻辑，
// 否则平台空闲时就会一直误报。
const SELECTOR_NOT_FOUND_ERROR_CODES: ReadonlySet<DiagnosticErrorCode> = new Set([
  'input-box-not-found',
  'send-button-not-found',
  'response-selector-empty',
])

const SELECTOR_FIELD_LABEL: Partial<Record<DiagnosticErrorCode, string>> = {
  'input-box-not-found': '输入框',
  'send-button-not-found': '发送按钮',
  'response-selector-empty': '回答容器',
}

function notifySelectorNotFoundIfDebugEnabled(platform: AIPlatform, errorCode: DiagnosticErrorCode): void {
  const platformLabel = AI_PLATFORMS[platform]?.label ?? platform
  const fieldLabel = SELECTOR_FIELD_LABEL[errorCode] ?? errorCode
  notifyDebugAlert(
    `${platformLabel}的${fieldLabel}选择器找不到目标元素`,
    `errorCode: ${errorCode}，可能是${platformLabel}又改版了，值得检查内置默认选择器或远程热更新配置。`,
  )
}

export type DiagnosticReporterEvent = Omit<
  DiagnosticEventDraft,
  | 'schemaVersion'
  | 'timestamp'
  | 'batchId'
  | 'platformRunId'
  | 'producerId'
  | 'producerSequence'
  | 'platform'
>

export interface DiagnosticReporter {
  emit(event: DiagnosticReporterEvent): void
}

export interface AdapterDiagnosticContext {
  reporter: DiagnosticReporter
  selectorConfigVersion: string
}

export type DiagnosticMessageSender = (message: {
  type: 'diagnostic:append'
  event: DiagnosticEventDraft
}) => unknown

function fallbackRandomId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? fallbackRandomId()
}

export function createDiagnosticBatchId(): string {
  return `b_${randomId()}`
}

export function createDiagnosticContext(batchId: string): DiagnosticContext {
  return { batchId, platformRunId: `r_${randomId()}` }
}

export function createDiagnosticProducerId(role: string): DiagnosticProducerId {
  const safeRole = role.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24) || 'producer'
  return `p_${safeRole}_${randomId()}`.slice(0, 80)
}

export function createAdapterDiagnostics(
  platform: AIPlatform,
  context: unknown,
  selectorConfigVersion: string,
): AdapterDiagnosticContext | undefined {
  const sanitizedContext = sanitizeDiagnosticContext(context)
  if (!sanitizedContext) return undefined
  const safeVersion = /^[A-Za-z0-9._-]{1,40}$/.test(selectorConfigVersion)
    ? selectorConfigVersion
    : 'local'
  return {
    reporter: createDiagnosticReporter(
      sanitizedContext,
      platform,
      createDiagnosticProducerId('platform-adapter'),
    ),
    selectorConfigVersion: safeVersion,
  }
}

export function createDiagnosticReporter(
  context: DiagnosticContext,
  platform: AIPlatform,
  producerId: DiagnosticProducerId,
  sender: DiagnosticMessageSender = (message) => chrome.runtime.sendMessage(message),
): DiagnosticReporter {
  let producerSequence = 0
  return {
    emit(event) {
      producerSequence += 1
      const sanitized = sanitizeDiagnosticEventDraft({
        ...event,
        ...context,
        platform,
        producerId,
        producerSequence,
        timestamp: Date.now(),
        schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      })
      if (!sanitized) return
      if (
        sanitized.eventStatus === 'failed'
        && sanitized.errorCode
        && SELECTOR_NOT_FOUND_ERROR_CODES.has(sanitized.errorCode)
      ) {
        notifySelectorNotFoundIfDebugEnabled(platform, sanitized.errorCode)
      }
      try {
        const result = sender({ type: 'diagnostic:append', event: sanitized })
        void Promise.resolve(result).catch(() => undefined)
      } catch {
        // 扩展重载时 runtime.sendMessage 可能同步抛错；诊断不能影响真实发送。
      }
    },
  }
}
