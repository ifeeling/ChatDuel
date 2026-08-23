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

// 代码块头部工具栏（语言标签 + 复制/下载/运行按钮）：DeepSeek/豆包都把它做成普通
// div/span（不是语义化的 <button>），绕过上面的 IGNORED_TAGS，工具栏文案会泄漏进抓取
// 结果——CAP-09（issue #21）真机确认。跟 THINKING_NODE_SELECTOR 一样用通配选择器而不是
// 具体 class 名，因为那类 class 会随官网改版变化：
//   - DeepSeek 真机验证：class 里带 "code-block-banner" 这个语义片段（`md-code-block-banner-wrap`）。
//   - 豆包真机验证：包装节点自带 `data-copy-ignore="true"`，是豆包自己标记的"复制时忽略"。
const CODE_BLOCK_BANNER_SELECTOR = '[class*="code-block-banner" i], [data-copy-ignore]'

function isCodeBlockBannerNode(el: HTMLElement): boolean {
  return el.matches(CODE_BLOCK_BANNER_SELECTOR)
}

function normalizeText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim()
}

function inlineChildren(node: Node): string {
  return [...node.childNodes].map(inlineText).join('')
}

function wrapInline(node: HTMLElement, marker: string): string {
  const inner = inlineChildren(node).trim()
  return inner ? `${marker}${inner}${marker}` : ''
}

// 豆包会把分步计算里的算式用 KaTeX 渲染：真正的数字全在
// <span class="katex"><span aria-hidden="true" class="katex-html">...</span></span> 里，
// 下面 aria-hidden 判定会把这整棵子树当"不该读"跳过，数字随之消失（issue #17/CAP-06 真机
// 确认的根因）。KaTeX 外层包装节点上的 `copy-text` 属性携带豆包"复制"功能自用的纯 LaTeX
// 文本（如 `\(20 + 12 + 4 = 36\)`），是唯一可靠的纯文本来源，优先读取、不再往下递归。
function normalizeMathCopyText(raw: string): string {
  return raw
    .trim()
    .replace(/^\\[([]/, '')
    .replace(/\\[)\]]$/, '')
    .replace(/\\times/g, '×')
    .replace(/\\div/g, '÷')
    .trim()
}

function inlineText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (!(node instanceof HTMLElement)) return ''
  const copyText = node.getAttribute('copy-text')
  if (copyText) return normalizeMathCopyText(copyText)
  if (IGNORED_TAGS.has(node.tagName) || node.hidden || node.getAttribute('aria-hidden') === 'true') return ''
  if (isCodeBlockBannerNode(node)) return ''
  if (node.tagName === 'BR') return '\n'

  if (node.tagName === 'STRONG' || node.tagName === 'B') return wrapInline(node, '**')
  if (node.tagName === 'EM' || node.tagName === 'I') return wrapInline(node, '*')
  if (node.tagName === 'DEL' || node.tagName === 'S' || node.tagName === 'STRIKE') return wrapInline(node, '~~')
  if (node.tagName === 'CODE') {
    const inner = (node.textContent ?? '').trim()
    return inner ? `\`${inner}\`` : ''
  }
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? ''
    const inner = inlineChildren(node).trim()
    if (!href || !inner || href.startsWith('javascript:') || href.startsWith('#')) return inner
    return `[${inner}](${href})`
  }

  return inlineChildren(node)
}

// 参与"这个容器要不要按块级递归"判定的标签集合：除了 BLOCK_TAGS 里那些纯容器型
// 标签，代码块/表格/分隔线也算块级——它们各自有专门的 markdown 重建规则，
// 不能被父容器当成内联内容直接拍平。
function isStructuralBlock(el: HTMLElement): boolean {
  if (BLOCK_TAGS.has(el.tagName) || el.tagName === 'PRE' || el.tagName === 'TABLE' || el.tagName === 'HR') {
    return true
  }
  const role = el.getAttribute('role')
  return role === 'table' || role === 'grid'
}

function hasBlockChildren(el: HTMLElement): boolean {
  return [...el.children].some((child) => child instanceof HTMLElement && isStructuralBlock(child))
}

function headingMarkdown(el: HTMLElement): string {
  const level = Number(el.tagName.slice(1))
  return `${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${normalizeText(inlineText(el))}`.trim()
}

// 列表项本身可能包住代码块/表格这类块级内容（例如"分步骤说明+代码片段"），
// 不能像纯文字列表项那样直接 inlineText 拍平——那样会把 <pre><code> 当成
// 单行内联代码，多行原始文本硬塞进一对反引号里，破坏 markdown 语法。
// 有块级子节点时改走 blocksFromNode 递归，续行按 marker 宽度缩进对齐。
function listItemMarkdown(item: HTMLElement, marker: string): string {
  const text = hasBlockChildren(item)
    ? [...item.childNodes].flatMap(blocksFromNode).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
    : normalizeText(inlineText(item))
  if (!text) return ''

  const [firstLine, ...restLines] = text.split('\n')
  const indent = ' '.repeat(marker.length + 1)
  return [`${marker} ${firstLine}`, ...restLines.map((line) => (line ? `${indent}${line}` : ''))].join('\n')
}

function listMarkdown(el: HTMLElement): string {
  const ordered = el.tagName === 'OL'
  const items = [...el.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.tagName === 'LI')
  return items
    .map((item, index) => listItemMarkdown(item, ordered ? `${index + 1}.` : '-'))
    .filter(Boolean)
    .join('\n')
}

// `<pre><code class="language-xxx">...</code></pre>` → ```xxx\n...\n``` 围栏。
// 语言从 <code> 或 <pre> 的 class 里找 `language-`/`lang-` 前缀，两处都没有就留空围栏。
// 用 textContent 而不是 normalizeText，代码块的换行/缩进是内容的一部分，不能被拍平。
function codeBlockMarkdown(pre: HTMLElement): string {
  const codeEl = pre.querySelector('code') ?? pre
  const raw = codeEl.textContent ?? ''
  if (!raw.trim()) return ''
  const text = raw.replace(/\n+$/, '')
  const classSource = `${codeEl.className ?? ''} ${pre.className ?? ''}`
  const match = classSource.match(/(?:language|lang)-([\w+#-]+)/i)
  const lang = match ? match[1] : ''
  return `\`\`\`${lang}\n${text}\n\`\`\``
}

function tableCellsFromRows(rows: HTMLElement[], cellSelector: string): string[][] {
  return rows.map((row) =>
    [...row.querySelectorAll<HTMLElement>(cellSelector)].map((cell) =>
      normalizeText(inlineText(cell)).replace(/\|/g, '\\|'),
    ),
  )
}

// 表头/表体单元格数不一致时按最长的一行补空单元格，避免参差的 markdown 表格错位。
function tableMarkdownFromCells(cells: string[][]): string {
  if (!cells.length || !cells[0]?.length) return ''
  const colCount = Math.max(...cells.map((row) => row.length))
  const pad = (row: string[]) => {
    const padded = [...row]
    while (padded.length < colCount) padded.push('')
    return padded
  }
  const header = pad(cells[0])
  const body = cells.slice(1).map(pad)
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ]
  return lines.join('\n')
}

function nativeTableMarkdown(table: HTMLElement): string {
  const rows = [...table.querySelectorAll<HTMLElement>('tr')]
  return tableMarkdownFromCells(tableCellsFromRows(rows, 'th, td'))
}

// 元宝/腾讯系等平台用 div[role="table"] 模拟表格而非原生 <table>，
// 不覆盖会被通用 inlineText 拍平成单列（真机验证过的 bug）。
function ariaTableMarkdown(table: HTMLElement): string {
  const rows = [...table.querySelectorAll<HTMLElement>('[role="row"]')]
  return tableMarkdownFromCells(
    tableCellsFromRows(rows, '[role="cell"], [role="columnheader"], [role="gridcell"], [role="rowheader"]'),
  )
}

function blockquoteMarkdown(el: HTMLElement): string {
  const inner = [...el.childNodes]
    .flatMap(blocksFromNode)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!inner) return ''
  return inner
    .split('\n')
    .map((line) => (line ? `> ${line}` : ''))
    .join('\n')
}

function blocksFromElement(el: HTMLElement): string[] {
  if (IGNORED_TAGS.has(el.tagName) || el.hidden || el.getAttribute('aria-hidden') === 'true') return []
  if (isCodeBlockBannerNode(el)) return []

  if (/^H[1-6]$/.test(el.tagName)) {
    const text = headingMarkdown(el)
    return text ? [text] : []
  }

  if (el.tagName === 'UL' || el.tagName === 'OL') {
    const text = listMarkdown(el)
    return text ? [text] : []
  }

  if (el.tagName === 'PRE') {
    const text = codeBlockMarkdown(el)
    return text ? [text] : []
  }

  if (el.tagName === 'TABLE') {
    const text = nativeTableMarkdown(el)
    return text ? [text] : []
  }

  const role = el.getAttribute('role')
  if (role === 'table' || role === 'grid') {
    const text = ariaTableMarkdown(el)
    return text ? [text] : []
  }

  if (el.tagName === 'HR') return ['---']

  if (el.tagName === 'BLOCKQUOTE') {
    const text = blockquoteMarkdown(el)
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

function joinBlocks(el: HTMLElement): string {
  return blocksFromElement(el)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// 护栏思路借鉴自 ai-arena 的 extractTextSafe 损坏检测（见 issue #10 背景研究），
// 但保护的失效模式不完全一样：ai-arena 是 cloneNode 出的游离 DOM 上调用 .innerText
// 不可靠（背景标签页/深嵌套布局经常返回空），这个文件从头到尾只用 node.textContent
// 读取文本、不调用 .innerText，架构上不会踩那个坑。这里的护栏防的是更窄的一类问题：
// 新增的某个块级分支（代码块/表格/引用等）写错、提前 return 空字符串或漏判某个
// 子节点，导致结构化结果比"逐节点拍平的内联文本"基线还短——用同一套 IGNORED_TAGS
// 过滤的 inlineText 做基线，而非裸 textContent，避免被按钮/svg 之类本就该丢弃的
// 噪音文本触发误判。
const STRUCTURED_MIN_RATIO = 0.7

// 注意：elementToMarkdownText 的输出会被 deepseek adapter 的 rawResponseText
// 直接复用做候选打分（responseCandidateScore 里 score += text.length/100，
// 见 docs/RESPONSE_CAPTURE_MAINTENANCE.md）。这次改动普遍拉长了输出（多了
// **/~~/``` /表格分隔线等标记字符），已跑过 deepseek-adapter.test.ts 全部
// 打分相关回归用例并确认仍然通过，未观察到候选排序被改变。
export function elementToMarkdownText(el: HTMLElement): string {
  const structured = joinBlocks(el)
  const plain = normalizeText(inlineText(el))
  if (plain && structured.length < plain.length * STRUCTURED_MIN_RATIO) return plain
  return structured
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
