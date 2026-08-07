/**
 * 平台无关的登录 / 状态探针工厂，被 DeepSeek 与豆包 content-script 共用。
 *
 * 两家的 hasUsableComposer / looksLikeLoginPage / getProbeState 原先逐字重复，
 * 差异仅三点：平台显示名、登录页 URL 关键词、登录页正文正则。
 * 这里把差异收敛为参数，函数体不含任何平台名分支。
 */
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
      return { status: 'error', errorMessage: `可能未登录${sep}${opts.platformName}` }
    }
    if (hasUsableComposer()) {
      return { status: 'idle' }
    }
    return { status: 'queued', errorMessage: `${opts.platformName}${sep}页面已注入，但尚未识别到输入框` }
  }

  return { hasUsableComposer, looksLikeLoginPage, getProbeState }
}
