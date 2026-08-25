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

// 各类"内容前面的小工具栏/标签"噪音：代码块头部工具栏（语言标签 + 复制/下载/运行按钮）、
// 表格头部工具栏（"表格"标签 + 导出按钮）等。DeepSeek/豆包/Gemini 都把这类工具栏做成普通
// div/span（不是语义化的 <button>），绕过上面的 IGNORED_TAGS，工具栏文案会泄漏进抓取
// 结果——CAP-09（issue #21）真机确认。跟 THINKING_NODE_SELECTOR 一样用通配选择器而不是
// 具体 class 名，因为那类 class 会随官网改版变化：
//   - DeepSeek 代码块工具栏真机验证：class 里带 "code-block-banner" 这个语义片段（`md-code-block-banner-wrap`）。
//   - 豆包代码块工具栏真机验证：包装节点自带 `data-copy-ignore="true"`，是豆包自己标记的"复制时忽略"。
//   - 豆包表格工具栏真机验证（2026-08-25，CAP-14/issue #26）：真实对话里表格前会插入
//     `<div class="table-header-qH9Ajf"><div class="title-JhOBP1">表格</div>...导出按钮...</div>`，
//     容器 class 带 "table-header" 语义片段，没有 data-copy-ignore，"表格"两个字会当成
//     独立一行泄漏到真正的表格内容前面。
//   - Gemini 代码块工具栏真机验证（2026-08-25，CAP-20/issue #38）：语言标签 + 下载/复制
//     按钮包在 `<div class="code-block-decoration header-formatted ...">` 里，跟 <pre>
//     是同一父节点下的兄弟节点（不是 <pre> 的子孙），class 带 "code-block-decoration"
//     语义片段。这里过滤后，语言名文本改由 codeBlockMarkdown() 专门去这个兄弟节点里读，
//     不能让它跟 DeepSeek/豆包那两种banner一样被直接丢弃——语言名要保留进围栏代码块的
//     ```<lang> 标记，不是纯噪音。选择器字符串抽成常量给 codeBlockMarkdown() 复用，
//     避免两处各写一份、以后改一处漏改另一处。
const CODE_BLOCK_DECORATION_SELECTOR = '[class*="code-block-decoration" i]'
const BANNER_NODE_SELECTOR = `[class*="code-block-banner" i], [data-copy-ignore], [class*="table-header" i], ${CODE_BLOCK_DECORATION_SELECTOR}`

function isBannerNode(el: HTMLElement): boolean {
  return el.matches(BANNER_NODE_SELECTOR)
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

// 豆包/Gemini 都会把行内算式用 KaTeX 渲染：真正的数字/公式全在
// <span class="katex"><span aria-hidden="true" class="katex-html">...</span></span> 里，
// 下面 aria-hidden 判定会把这整棵子树当"不该读"跳过，公式内容随之消失（豆包见 issue
// #17/CAP-06；Gemini 同一根因，真机确认于 2026-08-25，issue #38/CAP-20，样本
// "O(1) 时间复杂度"丢成"时间复杂度"）。两家官网都在 KaTeX 外层包装节点上放了一份
// 供各自"复制"功能自用的纯 LaTeX 文本，只是属性名不同——豆包用 `copy-text`（带
// `\(...\)` 包裹，如 `\(20 + 12 + 4 = 36\)`），Gemini 用 `data-math`（不带包裹，
// 如 `O(\log n)`）——是唯一可靠的纯文本来源，优先读取、不再往下递归。
// 只翻译真机样本里实测出现过的 LaTeX 命令（\times/\div 是豆包样本，\log 是这次 Gemini
// 样本新增的），不写通用的"剥掉任意反斜杠命令"兜底——本文件一贯的做法是没有真机证据
// 就不处理（见 issue #17/CAP-06 那次对 \frac 的取舍），未验证过的命令（如 \sqrt、\alpha）
// 贸然转换成裸词反而可能比保留原始 LaTeX 更难辨认，等真的在真机上遇到再加。
function normalizeMathCopyText(raw: string): string {
  return raw
    .trim()
    .replace(/^\\[([]/, '')
    .replace(/\\[)\]]$/, '')
    .replace(/\\times/g, '×')
    .replace(/\\div/g, '÷')
    .replace(/\\log/g, 'log')
    .trim()
}

function inlineText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (!(node instanceof HTMLElement)) return ''
  const copyText = node.getAttribute('copy-text') ?? node.getAttribute('data-math')
  if (copyText) return normalizeMathCopyText(copyText)
  if (IGNORED_TAGS.has(node.tagName) || node.hidden || node.getAttribute('aria-hidden') === 'true') return ''
  if (isBannerNode(node)) return ''
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

// 参与"这个容器要不要按块级递归"判定的标签/选择器集合：除了 BLOCK_TAGS 里那些纯
// 容器型标签，代码块/表格/分隔线也算块级——它们各自有专门的 markdown 重建规则，
// 不能被父容器当成内联内容直接拍平。配合 querySelector 做深度查找（见 hasBlockChildren）。
const STRUCTURAL_BLOCK_SELECTOR = [...BLOCK_TAGS, 'PRE', 'TABLE', 'HR']
  .map((tag) => tag.toLowerCase())
  .concat(['[role="table"]', '[role="grid"]'])
  .join(', ')

// 只查直接子节点曾经漏判过真机场景：Gemini 真机验证到的实际结构（2026-08-25，
// CAP-19/issue #37）里，代码块和表格都被包在自定义标签套自定义标签的壳里——
// `<response-element><code-block><div class="code-block">...<pre>...`、
// `<response-element><table-block>...<table>...`——`response-element`/`code-block`/
// `table-block` 都不是语义化标签，不在 BLOCK_TAGS 里，只查直接子节点会判定"没有块级
// 子节点"，导致整棵子树被 inlineText 拍平：多行代码被压成单行反引号内联代码，表格单元格
// 之间完全没有分隔符地粘在一起。改成 querySelector 做深度查找，只要子树里任何深度存在
// 一个真正的结构化块（标题/列表/代码块/表格/引用/分隔线），就不能把这个容器当内联内容
// 拍平——不管中间隔了多少层不认识的包装标签。
// 刻意的取舍：这是一次全子树扫描，递归到子节点时会对更小的子树重复扫描，
// 比原来只看直接子节点更慢。AI 回答的 DOM 树规模有限（几百到几千节点封顶），
// 这里选择"宁可稍慢也不能漏读"，跟本文件一贯的"内容不能丢"优先级一致。
function hasBlockChildren(el: HTMLElement): boolean {
  return el.querySelector(STRUCTURAL_BLOCK_SELECTOR) !== null
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

// Gemini 不把语言名放进 class（真机验证于 2026-08-25，CAP-20/issue #38），而是渲染成
// <pre> 兄弟节点里工具栏上的一段纯文本（如 "Python"），跟下载/复制按钮挤在同一个
// `.code-block-decoration` 容器里。这里不走 inlineText()（那条路径专门处理"整棵响应树
// 拍平成 markdown"，不适合用来单独抠一个工具栏节点的文本），所以不能只指望 IGNORED_TAGS
// 生效——克隆后同时按标签名（真正的 <button>/<svg> 等）和 class 语义片段（豆包/Gemini
// 常把按钮包装成不带原生 <button> 标签的自定义元素，如 gem-icon-button）两种方式删除
// 按钮子树，只留语言名本身；统一转小写跟 class 来源的 `language-ts`/`language-python` 保持一致。
function decorationLanguageLabel(decoration: HTMLElement): string {
  const clone = decoration.cloneNode(true) as HTMLElement
  clone.querySelectorAll('button, svg, img, style, script, [class*="button" i]').forEach((n) => n.remove())
  return normalizeText(clone.textContent ?? '').toLowerCase()
}

// `<pre><code class="language-xxx">...</code></pre>` → ```xxx\n...\n``` 围栏。
// 语言优先从 <code>/<pre> 的 class 里找 `language-`/`lang-` 前缀；两处都没有时，
// 退而查找 <pre> 的直接兄弟节点里是否有 `.code-block-decoration`（Gemini 的语言标签
// 就放在那里，见上面 decorationLanguageLabel 的说明）——只看直接兄弟节点，不用
// querySelector 做深度查找，避免共享同一个更外层容器的多个代码块（例如列表里连续
// 几个代码片段）互相抢错兄弟节点的语言标签；都找不到就留空围栏。
// 用 textContent 而不是 normalizeText，代码块的换行/缩进是内容的一部分，不能被拍平。
function codeBlockMarkdown(pre: HTMLElement): string {
  const codeEl = pre.querySelector('code') ?? pre
  const raw = codeEl.textContent ?? ''
  if (!raw.trim()) return ''
  const text = raw.replace(/\n+$/, '')
  const classSource = `${codeEl.className ?? ''} ${pre.className ?? ''}`
  const match = classSource.match(/(?:language|lang)-([\w+#-]+)/i)
  let lang = match ? match[1] : ''
  if (!lang) {
    const decoration = [...(pre.parentElement?.children ?? [])].find(
      (sibling): sibling is HTMLElement => sibling instanceof HTMLElement && sibling.matches(CODE_BLOCK_DECORATION_SELECTOR),
    )
    if (decoration) lang = decorationLanguageLabel(decoration)
  }
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
  if (isBannerNode(el)) return []

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

  // 以前这里对 P/LI 直接拍平、不看 hasBlockChildren——多数情况下 <p>/<li> 确实只有
  // 内联子节点，结果一样，但真机验证到的 Gemini 结构说明"标签名"本身不能作为判定
  // 依据：改成统一交给 hasBlockChildren（深度查找）判断，能正确处理罕见的"标签名
  // 是 P/LI 但深层确实包着块级内容"的情况，常见的纯内联 P/LI 行为不变。
  if (!hasBlockChildren(el)) {
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

// 豆包多代码块回答里，围栏代码块标记有时会跟前后文字粘连、没有独立成行
// （CAP-14，issue #26）。真机确认过两次（issue 正文样本 + 2026-08-25 评论区样本），
// 症状是豆包自己的 markdown 渲染器没能把这段文本解析成真正的 <pre> 代码块，而是把
// 整段（含裸露的 \`\`\` 标记）当成一整块普通文字渲染成了单个 <p>——这不是本文件其它
// 分支能处理的"块级结构没识别出来"（那种情况走 hasBlockChildren 深度查找就够了），
// 是源头页面自己都没能正确解析成块级元素，DOM 里压根没有 <pre>/<h2> 可供识别，
// 我们能拿到的就是这坨裸文字本身。本次会话尝试用 patchright 对着真实 doubao.com
// 复现这个"未解析中间态"三次（含在生成过程中每 0.6 秒高频轮询），均未能重新抓到
// 发生瞬间的原始 DOM——细节见排查记录，跟 issue 里此前两次会话的复现历史一致，
// 触发条件目前看不受前端可控输入直接支配。这里改成对最终文本做后处理：不去猜测
// 也不依赖 DOM 结构，只保证每个 \`\`\` 标记（不管它是不是配对良好）都独立成行，
// 跟豆包分享卡导出渲染器"\`\`\` 必须在行首"这条硬性要求对齐。
//
// 只处理"粘连"的 \`\`\` （前面或后面紧跟非换行字符），已经独立成行的 \`\`\` 原样跳过——
// 保证格式良好的正常输出（例如本文件其它测试用例覆盖的场景）不受影响。"是否已在行首"
// 允许前面只有空格/制表符（不要求紧邻 \n）——嵌套在列表项里的代码块会用空格续行缩进
// ```（见 listItemMarkdown），这种缩进后的 \`\`\` 本来就是合法的行首，不能误判成粘连、
// 插入多余空行破坏列表续行格式（跑现有回归测试时发现这个坑，已修正）。语言标签
// 识别只认纯 ASCII 字母数字（跟 codeBlockMarkdown 从 class 提取语言名不同，那边允许
// +/#/- 是因为来源是可控的 CSS class 名；这里直接扫读紧跟在 \`\`\` 后面的裸文字，
// 必须收紧字符集——含 # 的话会把"\`\`\`## 标题"这种真实样本里的 Markdown 标题符号
// 误吞成"语言标签"，把标题跟围栏粘得更死，测试用真实样本验证过这个坑）。
const STICKY_FENCE = '```'
// "已在行首"允许 \`\`\` 前面只有空格/制表符（兼容 listItemMarkdown 的列表续行缩进），
// 不要求紧邻 \n 本身。
const FENCE_NOT_AT_LINE_START_RE = /(?<!\n[ \t]*)```/g
const FENCE_WITH_LANGUAGE_TAG_RE = /```([A-Za-z0-9]*)/g

// 把粘在前面文字后面的 \`\`\` 拆到独立一行（"1（基础版 v1）\`\`\`python" → 换行后独立成行）；
// 已经在行首（含缩进）的 \`\`\` 原样跳过。
function isolateFenceFromPrecedingText(text: string): string {
  // 前面垫一个 \n，让"字符串开头就是 \`\`\`"也能命中"已在行首"，不用再给正则叠一条
  // (?<!^[ \t]*) 分支；末尾 trim() 前统一收口，见调用方。
  return `\n${text}`.replace(FENCE_NOT_AT_LINE_START_RE, `\n\n${STICKY_FENCE}`)
}

// 把粘在 \`\`\` 后面的文字拆到独立一行（"\`\`\`## 版本" → \`\`\` 单独一行，"## 版本"另起一行）；
// 跳过可能存在的语言标签（"\`\`\`python"）——语言标签紧跟围栏是标准写法，不能拆开。
function isolateFenceFromFollowingText(text: string): string {
  return text.replace(FENCE_WITH_LANGUAGE_TAG_RE, (match, _lang: string, offset: number, full: string) => {
    const charAfterLanguageTag = full[offset + match.length]
    if (charAfterLanguageTag === undefined || charAfterLanguageTag === '\n') return match
    return `${match}\n\n`
  })
}

function normalizeStickyFenceMarkers(text: string): string {
  if (!text.includes(STICKY_FENCE)) return text
  return isolateFenceFromFollowingText(isolateFenceFromPrecedingText(text)).trim()
}

// 注意：elementToMarkdownText 的输出会被 deepseek adapter 的 rawResponseText
// 直接复用做候选打分（responseCandidateScore 里 score += text.length/100，
// 见 docs/RESPONSE_CAPTURE_MAINTENANCE.md）。这次改动普遍拉长了输出（多了
// **/~~/``` /表格分隔线等标记字符），已跑过 deepseek-adapter.test.ts 全部
// 打分相关回归用例并确认仍然通过，未观察到候选排序被改变。
export function elementToMarkdownText(el: HTMLElement): string {
  const structured = joinBlocks(el)
  const plain = normalizeText(inlineText(el))
  const result = plain && structured.length < plain.length * STRUCTURED_MIN_RATIO ? plain : structured
  return normalizeStickyFenceMarkers(result)
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
