// DeepSeek 与豆包适配器之间逐字复制（或仅差一个参数）的通用 DOM 原语。
//
// 这批函数来自候选 5 的 T4 抽取（issue #39）：两平台原先各自保有一份副本，行为一致。
// 本模块把它们收敛为单一实现，两平台改为引用此处。函数体零平台名分支，平台差异
// （混淆 class 上的用户消息标记、回车事件派发序列、contenteditable 是否读 textContent）
// 一律以参数表达，调用方各自传入，从而不悄悄改变任一平台的发送与回答捕获结果。
//
// 说明：本模块只承载两平台「行为完全一致」的助手函数。选择器配置、回答候选评分、
// 附件挂载、视觉模式切换等平台专属逻辑仍各自保留在适配器内，不属于此处范围。

// 按优先级在 document 中查找第一个命中的元素。DeepSeek 与豆包通用，无平台分支。
export function queryFirst<T extends Element = Element>(selectors: string[]): T | null {
  for (const selector of selectors) {
    const el = document.querySelector<T>(selector)
    if (el) return el
  }
  return null
}

// 往原生 textarea 写值：走 prototype 上的 value setter（绕过 React 受控拦截），
// 再派发 input 事件让框架内部 state 同步。行为与原两平台副本一致。
export function writeNativeTextareaValue(el: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(el, text)
  el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }))
}

// 通过鼠标按下/抬起 + click 触发控件（发送按钮等）。两平台副本逐字相同。
export function activateControl(button: HTMLElement): void {
  const mouseInit: MouseEventInit = { bubbles: true, cancelable: true, composed: true }
  button.dispatchEvent(new MouseEvent('mousedown', mouseInit))
  button.dispatchEvent(new MouseEvent('mouseup', mouseInit))
  button.click()
}

function normalizeProseWhitespace(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
}

const FENCED_CODE_BLOCK_RE = /```[\s\S]*?```/g

// 把 text 按围栏代码块（```...```）切开，只对围栏外的散文片段跑 transform，
// 围栏本身原样拼回去、不经过 transform。两平台各自的回答清洗函数
// （cleanDeepSeekResponseText/cleanDoubaoResponseText）在按行 trim/过滤噪音行时
// 都需要这个保护——见 normalizeText 下面的说明和 CAP-09（issue #21）。
export function mapProseOutsideFencedCode(text: string, transform: (prose: string) => string): string {
  const fences = text.match(FENCED_CODE_BLOCK_RE) ?? []
  const prose = text.split(FENCED_CODE_BLOCK_RE).map(transform)
  let result = prose[0]
  for (let i = 0; i < fences.length; i += 1) {
    result += fences[i] + prose[i + 1]
  }
  return result
}

// 文本归一化：统一不间断空格、压缩多余空白与空行。两平台副本逐字相同。
//
// 围栏代码块（```...```）内部的换行/缩进是内容本身，不能套用上面这套"清理 HTML 排版
// 噪音"的空白折叠规则——CAP-09（issue #21）真机确认过：DeepSeek/豆包的回答清洗
// （cleanDeepSeekResponseText/cleanDoubaoResponseText）都会把 elementToMarkdownText
// 已经正确重建出缩进的代码块，在这一步经由 \n[ \t]+ → \n 这条规则把缩进洗掉。
// 围栏内的内容原样保留，只清洗围栏外的散文部分。
export function normalizeText(text: string): string {
  return mapProseOutsideFencedCode(text, normalizeProseWhitespace).trim()
}

// 元素是否隐藏（hidden 属性 / aria-hidden / display:none / visibility:hidden）。
// 两平台副本逐字相同。
export function isHidden(el: HTMLElement): boolean {
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true
  const style = window.getComputedStyle?.(el)
  return style?.display === 'none' || style?.visibility === 'hidden'
}

// 取元素的「标记」文本：data-testid / data-role / className / aria-label 拼接。
// 两平台副本逐字相同，供 isUserMessage / element 评分等复用。
export function elementMarker(el: HTMLElement): string {
  return [
    el.getAttribute('data-testid') ?? '',
    el.getAttribute('data-role') ?? '',
    el.className?.toString() ?? '',
    el.getAttribute('aria-label') ?? '',
  ].join(' ')
}

// 元素是否为回答区的操作条（复制/重新生成/点赞等）。两平台副本逐字相同。
export function isResponseActionBar(el: HTMLElement): boolean {
  const marker = elementMarker(el)
  if (/\b(action|toolbar|operate|feedback|copy|regenerate)\b/i.test(marker)) return true
  const buttonText = normalizeText(el.textContent ?? '')
  return /复制|重新生成|点赞|点踩|分享|copy|regenerate/i.test(buttonText)
}

// 元素的直接子节点里是否含有操作条。两平台副本逐字相同。
export function hasDirectResponseActions(el: HTMLElement): boolean {
  return [...el.children].some((child) => child instanceof HTMLElement && isResponseActionBar(child))
}

export interface HasStopGeneratingButtonOptions {
  /** 是否要求按钮可见（向上遍历祖先检查 hidden/aria-hidden/display/visibility/opacity）。默认 false。 */
  requireVisible?: boolean
  /** 显式选择器未命中时，是否用「停止/中止/取消/stop/cancel」文案兜底扫描所有 button。默认 true（与 DeepSeek/豆包原版一致）。 */
  textFallback?: boolean
}

// 元素是否可见：向上遍历祖先，遇 hidden / aria-hidden / display:none / visibility:hidden / opacity:0 即判不可见。
// 平台无关；claude 原先内联一份相同实现，已上提至此共用。
export function isVisibleElement(el: HTMLElement): boolean {
  let current: HTMLElement | null = el
  while (current) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false
    const style = getComputedStyle(current)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    current = current.parentElement
  }
  return true
}

// 是否出现「停止生成」按钮。stopButton 接受 string | string[]，兼容各平台选择器字段类型。
// - 默认先按显式 stopButton 选择器命中（textFallback 默认 true，未命中再用「停止/中止/取消/stop/cancel」
//   文案兜底扫描所有 button，与 DeepSeek/豆包原版一致）；
// - requireVisible 默认 false：chatgpt/gemini 传默认即可（与它们原版「仅查询选择器」一致）；
//   claude 须传 requireVisible:true，否则会把隐藏的停止按钮误判为「已停止」。
export function hasStopGeneratingButton(
  selectors: { stopButton: string | string[] },
  options: HasStopGeneratingButtonOptions = {},
): boolean {
  const { requireVisible = false, textFallback = true } = options
  const stopButtons = typeof selectors.stopButton === 'string' ? [selectors.stopButton] : selectors.stopButton

  for (const sel of stopButtons) {
    const matches = Array.from(document.querySelectorAll<HTMLElement>(sel))
    if (requireVisible ? matches.some(isVisibleElement) : matches.length > 0) return true
  }

  if (textFallback) {
    return [...document.querySelectorAll<HTMLElement>('button, [role="button"]')].some((button) => {
      const marker = [
        button.getAttribute('aria-label') ?? '',
        button.getAttribute('title') ?? '',
        button.getAttribute('data-testid') ?? '',
        button.className?.toString() ?? '',
        button.textContent ?? '',
      ].join(' ')
      return /停止|中止|取消|stop|cancel/i.test(marker)
    })
  }
  return false
}

// 元素是否为用户消息。两平台都基于 elementMarker 的 user/question 等词判断，
// 差异仅在 DeepSeek 的混淆 class（_9663006 / d29f3d7d）也视为用户消息——
// 以 extraClassPattern 参数表达。该参数为必填：调用方必须显式声明自己的语义，
// 不允许「默认按某平台行为」静默生效（否则漏传会在另一平台悄悄改变捕获结果）。
export interface UserMessageOptions {
  extraClassPattern?: RegExp
}

export function isUserMessage(el: HTMLElement, options: UserMessageOptions): boolean {
  const marker = elementMarker(el)
  if (options.extraClassPattern && options.extraClassPattern.test(marker)) return true
  return /\b(user|human|question|query)\b/i.test(marker) && !/\b(assistant|answer)\b/i.test(marker)
}

// 回车键发送：部分平台需要完整 keydown/keypress/keyup 序列（DeepSeek），
// 豆包只需 keydown。以 mode 参数表达差异，必填——不允许默认按某平台序列，
// 否则漏传会在另一平台静默多派发按键事件。
export type EnterDispatchMode = 'keydown-keypress-keyup' | 'keydown-only'

export function dispatchEnter(el: HTMLElement, mode: EnterDispatchMode): void {
  const init: KeyboardEventInit = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
    composed: true,
  }
  el.dispatchEvent(new KeyboardEvent('keydown', init))
  if (mode === 'keydown-only') return
  el.dispatchEvent(new KeyboardEvent('keypress', init))
  el.dispatchEvent(new KeyboardEvent('keyup', init))
}

// 输入框是否仍有待发内容。差异：DeepSeek 仅读 textarea.value（contenteditable
// 视为空），豆包对 textarea/input 读 value、其余读 textContent。以
// readsEditableTextContent 参数表达，行为与原两平台副本一致。
export function hasPendingContent(
  selectors: { inputBox: string[] },
  readsEditableTextContent: boolean,
): boolean {
  const box = queryFirst<HTMLElement>(selectors.inputBox)
  if (!box) return false
  let text = ''
  if (box instanceof HTMLTextAreaElement || box instanceof HTMLInputElement) {
    text = box.value?.trim() ?? ''
  } else if (readsEditableTextContent) {
    text = box.textContent?.trim() ?? ''
  }
  return text.length > 0
}
