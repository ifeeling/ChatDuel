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
// 这份清单没有对着 DeepSeek/豆包的真实登录后页面逐条验证过——那两个官网需要登录，
// 而扩展不能代用户登录（见 CLAUDE.md 的账号/密码红线），所以只能参照 ai-arena 已验证过的
// Claude/Gemini 选择器风格做同类通配猜测。如果之后发现思考内容仍然漏进历史记录，
// 从回答抓取调试日志里看实际 class/aria 再扩充这份清单，不要凭感觉扩大匹配范围。
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

// "已深度思考(用时 12 秒)" / "Thought for 12s" 这类折叠触发文案：短、且以固定前缀开头。
// 只匹配短文本，避免误删恰好以类似词开头的正式回答长段落。
const THINKING_LABEL_RE = /^(Thought for\s+\d|Thinking\b|已深度思考|深度思考|正在思考|思考中|推理过程)/i
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
