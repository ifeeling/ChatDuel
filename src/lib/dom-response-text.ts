const IGNORED_TAGS = new Set(['BUTTON', 'SVG', 'IMG', 'STYLE', 'SCRIPT'])
const BLOCK_TAGS = new Set([
  'ARTICLE',
  'BLOCKQUOTE',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'MAIN',
  'MESSAGE-CONTENT',
  'MODEL-RESPONSE',
  'OL',
  'P',
  'SECTION',
  'UL',
])

function normalizeText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim()
}

function inlineText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (!(node instanceof HTMLElement)) return ''
  if (IGNORED_TAGS.has(node.tagName) || node.hidden || node.getAttribute('aria-hidden') === 'true') return ''
  if (node.tagName === 'BR') return '\n'
  return [...node.childNodes].map(inlineText).join('')
}

function hasBlockChildren(el: HTMLElement): boolean {
  return [...el.children].some((child) => child instanceof HTMLElement && BLOCK_TAGS.has(child.tagName))
}

function headingMarkdown(el: HTMLElement): string {
  const level = Number(el.tagName.slice(1))
  return `${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${normalizeText(inlineText(el))}`.trim()
}

function listMarkdown(el: HTMLElement): string {
  const ordered = el.tagName === 'OL'
  const items = [...el.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.tagName === 'LI')
  return items
    .map((item, index) => {
      const marker = ordered ? `${index + 1}.` : '-'
      return `${marker} ${normalizeText(inlineText(item))}`.trim()
    })
    .filter(Boolean)
    .join('\n')
}

function blocksFromElement(el: HTMLElement): string[] {
  if (IGNORED_TAGS.has(el.tagName) || el.hidden || el.getAttribute('aria-hidden') === 'true') return []

  if (/^H[1-6]$/.test(el.tagName)) {
    const text = headingMarkdown(el)
    return text ? [text] : []
  }

  if (el.tagName === 'UL' || el.tagName === 'OL') {
    const text = listMarkdown(el)
    return text ? [text] : []
  }

  if (el.tagName === 'P' || el.tagName === 'LI' || !hasBlockChildren(el)) {
    const text = normalizeText(inlineText(el))
    return text ? [text] : []
  }

  return [...el.childNodes].flatMap(blocksFromNode)
}

function blocksFromNode(node: Node): string[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = normalizeText(node.textContent ?? '')
    return text ? [text] : []
  }
  if (node instanceof HTMLElement) return blocksFromElement(node)
  return []
}

export function elementToMarkdownText(el: HTMLElement): string {
  return blocksFromElement(el)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// 各家官网把"思考过程"渲染成可折叠区块，用的 class/aria 标记不同但风格类似
// （原生 <details>、标了 thinking/reasoning 关键词的 class 或 aria-label、
// 无障碍专用的 .sr-only）。这里用通配选择器覆盖，不针对某个官网的具体混淆 class名，
// 因为那类 class 会随官网改版变化（参考 RESPONSE_CAPTURE_MAINTENANCE.md）。
//
// DeepSeek 已经用真实登录页面验证过：深度思考的折叠触发文案和折叠正文都没有任何
// thinking/reasoning 语义标记，class 是纯哈希（例如 `_74c0879`），这份通配选择器
// 抓不到它们，也没有安全的通用兜底能补上——见下面 stripThinkingNodes 里的说明。
const THINKING_NODE_SELECTOR = [
  'details',
  '[data-testid*="thinking" i]',
  '[data-testid*="reasoning" i]',
  '[class*="thinking" i]',
  '[class*="reasoning" i]',
  '[aria-label*="thinking" i]',
  '[aria-label*="reasoning" i]',
  '[aria-label*="思考" i]',
  '[aria-label*="推理" i]',
  '.sr-only',
].join(', ')

// "已深度思考(用时 12 秒)" / "已思考（用时 8 秒）" / "已完成思考" / "Thought for 12s" 这类折叠
// 触发文案：短、且以固定前缀开头。"已思考"是 DeepSeek 真机验证到的实际文案（不是"已深度思考"），
// "已完成思考"是豆包真机验证到的实际文案。
// 故意不含"推理过程"——真机验证过，豆包会把这四个字当成正式回答里"分步推理"内容的
// 标题来用（用户明确要求"说明推理过程"时），删掉它虽然只丢一个标题词、不算严重，
// 但也没有证据证明它真的是哪个平台的思考折叠触发词，保留只有下行风险没有上行收益。
// 只匹配短文本，避免误删恰好以类似词开头的正式回答长段落。
const THINKING_LABEL_RE = /^(Thought for\s+\d|Thinking\b|已深度思考|已思考|已完成思考|深度思考|正在思考|思考中)/i
const THINKING_LABEL_MAX_LENGTH = 80

function isThinkingLabelNode(el: HTMLElement): boolean {
  const text = (el.textContent ?? '').trim()
  return text.length > 0 && text.length <= THINKING_LABEL_MAX_LENGTH && THINKING_LABEL_RE.test(text)
}

// 在拍平成文字之前，从 DOM 里整块删除思考/推理折叠区。
// 必须先做这一步再转文字——文字拍平后思考块和正式回答的 DOM 边界就丢失了，
// 没法再用行过滤干净切开（这是 CAP-02 的根因，见 issue #8）。
// 就地修改传入的元素（调用方需自行 cloneNode，不要传活的页面 DOM）。
export function stripThinkingNodes(root: HTMLElement): HTMLElement {
  const originalHTML = root.innerHTML
  const originalText = (root.textContent ?? '').trim()
  if (!originalText) return root

  root.querySelectorAll<HTMLElement>(THINKING_NODE_SELECTOR).forEach((node) => node.remove())
  // 只删触发文案节点本身，不提升到父节点删除——真机验证过，DeepSeek 和豆包的折叠
  // 触发标题跟"父节点还有没有其它有意义内容"这件事，从纯 DOM 结构和文本长度上
  // 长得一模一样：DeepSeek 里父节点的另一部分是真思考正文（该删），豆包"已完成思考"
  // 折叠标题的父节点的另一部分却是"推理过程"正式回答本身（不能删，思考草稿在豆包
  // 默认根本不渲染进折叠状态的 DOM）。两个平台在这一点上给出了相反的正确答案，
  // 说明"父节点更长就提升删除"这个启发式不可靠，宁可留一点触发文案噪音，
  // 也不能有把正式回答一起删掉的风险。
  root.querySelectorAll<HTMLElement>('button, summary, h1, h2, h3, h4, h5, h6, div, span, p').forEach((node) => {
    if (root.contains(node) && isThinkingLabelNode(node)) node.remove()
  })

  // 兜底：如果整段都被判定成"思考内容"删空了，很可能是通配选择器命中了
  // 包住正式回答的外层容器（过度删除），而不是真的整段都在思考。
  // 保留原文本比返回空更安全——宁可偶尔漏一点思考内容，也不能让真正的
  // 回答内容整段从历史记录里消失。
  if (!(root.textContent ?? '').trim()) root.innerHTML = originalHTML
  return root
}

// clone + stripThinkingNodes 的组合在多个 adapter 里重复出现，抽成一个入口。
export function cloneWithoutThinking(el: HTMLElement): HTMLElement {
  return stripThinkingNodes(el.cloneNode(true) as HTMLElement)
}
