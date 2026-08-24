/**
 * 平台无关的登录 / 状态探针工厂，被全部 5 个平台的 content-script 共用。
 *
 * 各家的 hasUsableComposer / looksLikeLoginPage / getProbeState 原先逐字重复，
 * 差异仅三点：平台显示名、登录页 URL 关键词、登录页正文正则。
 * 这里把差异收敛为参数，函数体不含任何平台名分支。
 */
import type { AIAdapter } from '../base'
import type {
  ContentScriptCommandExtensionHandler,
  ContentScriptCommandExtensionResult,
} from '../../content-scripts/content-script-command-bridge'
import type { ConversationState } from '../../types'

export interface LoginProbeOptions {
  /** 平台显示名，用于报错文案（如 'DeepSeek' / '豆包'）。 */
  platformName: string
  /** URL 命中即视为登录页的关键词（按小写比对）。 */
  loginUrlKeywords: string[]
  /** 页面正文命中即视为登录页的正则。 */
  loginBodyPattern: RegExp
}

export interface LoginProbe {
  hasUsableComposer(): boolean
  looksLikeLoginPage(): boolean
  getProbeState(): ConversationState
}

export function createLoginProbe(opts: LoginProbeOptions): LoginProbe {
  function hasUsableComposer(): boolean {
    return !!document.querySelector(['textarea', '[contenteditable="true"]', '[role="textbox"]'].join(','))
  }

  function looksLikeLoginPage(): boolean {
    const url = location.href.toLowerCase()
    if (opts.loginUrlKeywords.some((k) => url.includes(k))) return true

    const bodyText = (document.body?.innerText ?? '').slice(0, 2000)
    return opts.loginBodyPattern.test(bodyText) && !hasUsableComposer()
  }

  // 英文平台名（如 DeepSeek）与中文间需一个空格分隔；中文平台名（如豆包）则不需要。
  // 用「是否以 ASCII 字母开头」判断，复刻两家原版文案的空格差异。
  const sep = /^[A-Za-z]/.test(opts.platformName) ? ' ' : ''

  function getProbeState(): ConversationState {
    if (looksLikeLoginPage()) {
      return { status: 'error', errorMessage: `可能未登录${sep}${opts.platformName}`, needsLogin: true }
    }
    if (hasUsableComposer()) {
      return { status: 'idle' }
    }
    return { status: 'queued', errorMessage: `${opts.platformName}${sep}页面已注入，但尚未识别到输入框` }
  }

  return { hasUsableComposer, looksLikeLoginPage, getProbeState }
}

/**
 * `get-state` 命令处理器工厂：adapter 探测失败或明确报错时，退回登录探针判断。
 *
 * 5 个平台 content-script 里对 get-state 的处理原先逐字重复（仅探针 options 不同）；
 * 这里把"拿 adapter 状态、失败退回探针、error 状态也用探针复核"这段收敛成一个工厂，
 * 直接匹配 `BootContentScriptOptions.createExtensionHandler` 的签名，可以整体赋值。
 * 需要额外命令（如 DeepSeek 的 get-conversation-url）的 content-script 自行包一层。
 */
export function createLoginProbeExtensionHandler(
  opts: LoginProbeOptions,
): (adapter: Pick<AIAdapter, 'getConversationState'>) => ContentScriptCommandExtensionHandler {
  const probe = createLoginProbe(opts)
  return (adapter) => async ({ command }): Promise<ContentScriptCommandExtensionResult> => {
    if (command !== 'get-state') return { handled: false }
    const state = await adapter.getConversationState().catch(() => probe.getProbeState())
    return {
      handled: true,
      data: state.status === 'error' ? probe.getProbeState() : state,
    }
  }
}
