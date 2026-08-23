import type { AIPlatform, Session, SessionAttachment, SessionResponse } from '../types'
import { getPlatformMeta } from './ai-platforms'
import { normalizeCapturedResponse } from './session-record'
import { countWords } from './stats'

function platformLabel(platform: AIPlatform): string {
  return getPlatformMeta(platform)?.label ?? platform
}

function firstLine(text: string, max = 60): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) return '未命名记录'
  return line.length > max ? `${line.slice(0, max)}...` : line
}

function safeFilename(text: string, max = 40): string {
  const name = firstLine(text, max)
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return name || '未命名记录'
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function responseStatusLabel(response?: SessionResponse): string {
  if (!response) return '未发送'
  if (response.status === 'captured') return '已记录'
  if (response.status === 'uncertain') return '状态不确定，可能仍在生成'
  if (response.status === 'failed') return response.error || '发送失败'
  return '待回填'
}

export function summarizeSessionTargets(session: Session): string {
  return session.targetPlatforms
    .map((platform) => `${platformLabel(platform)} ${responseStatusLabel(session.responses[platform])}`)
    .join(' / ')
}

function formatAttachment(attachment: SessionAttachment): string {
  return `- ${attachment.name} · ${attachment.mime || '未知类型'} · ${formatBytes(attachment.size)}`
}

export function formatCapturedMarkdownText(text: string): string {
  // 「标题后面缺换行」修复只在原文完全没有 \n\n 时才做：这条规则是给彻底被压扁成
  // 一整行的文本兜底的（标题和正文之间只剩一个空格），它没法区分“标题本身带空格”
  // （如“版本 1”“Step 2”）和“标题结束、正文开始”，一旦原文已经有 \n\n 说明排版本来
  // 就不是压扁状态，贸然套用这条规则会把带空格的标题自己拦腰切断。
  const alreadyHasParagraphBreaks = text.includes('\n\n')
  let normalized = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/([^\n])\s+(#{2,6}\s+)/g, '$1\n\n$2')
  if (!alreadyHasParagraphBreaks) {
    normalized = normalized.replace(/(#{2,6}\s+[^\n]+?)\s+(?=(?:#{2,6}\s+)|(?:[-*]\s+)|(?:\d+[.)]\s+)|[^#\n])/g, '$1\n\n')
  }
  return normalized
    .replace(/([。！？.!?])\s+([-*]\s+)/g, '$1\n$2')
    .replace(/([。！？.!?])\s+(\d+[.)]\s+)/g, '$1\n$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function formatSessionMarkdown(session: Session): string {
  const parts: string[] = [
    `# ${firstLine(session.prompt)}`,
    '',
    `- 创建时间: ${new Date(session.createdAt).toLocaleString()}`,
    `- 目标: ${session.targetPlatforms.map(platformLabel).join(' / ')}`,
    '',
    '## 用户问题',
    '',
    session.prompt || '空',
  ]

  if (session.sentPrompt && session.sentPrompt !== session.prompt) {
    parts.push('', '## 实际发送内容', '', session.sentPrompt)
  }

  if (session.attachments.length > 0) {
    parts.push('', '## 附件', '', ...session.attachments.map(formatAttachment))
  }

  for (const platform of session.targetPlatforms) {
    const label = platformLabel(platform)
    const response = session.responses[platform]
    parts.push('', `## ${label} 回答`, '')
    if (response?.status === 'captured' && response.text.trim()) {
      parts.push(formatCapturedMarkdownText(normalizeCapturedResponse(platform, response.text)))
    } else {
      parts.push(responseStatusLabel(response))
    }
  }

  return parts.join('\n')
}

export function buildSessionMarkdownExport(session: Session): { filename: string; mime: string; content: string } {
  return {
    filename: `ChatDuel-${safeFilename(session.prompt)}.md`,
    mime: 'text/markdown;charset=utf-8',
    content: formatSessionMarkdown(session),
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// escapeHtml 不会动 markdown 语法字符（*、`、#、-），所以可以先转义再在转义后的
// 字符串上做语法替换：语法标记两侧插入的标签不会被内容里的原始 <>&"' 干扰。
function renderInlineMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    // URL 允许一层括号嵌套（如维基百科链接 .../Foo_(bar)），否则正则遇到 URL
    // 自带的右括号就提前收尾，截断链接、留下多余的 `)` 泄漏到正文里。
    // 协议按白名单放行（http/https/mailto）——分享卡导出的是静态 HTML 文件，
    // 直接输出 <a href> 可点击，不能放行 javascript:/data: 这类协议；不放行的
    // 链接直接退化成纯文字，不保留原始 markdown 语法。
    .replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^)\s]*\))+)\)/g, (match, label: string, url: string) =>
      /^(https?:|mailto:)/i.test(url) ? `<a href="${url}">${label}</a>` : label)
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

function isTableSeparatorLine(line: string): boolean {
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell))
}

// 分享卡需要给不熟悉 Markdown 的人看，所以把回答渲染成真正的标题/加粗/删除线/链接/
// 列表/引用/分隔线/代码块/表格，而不是像面板历史那样直接展示原始 Markdown 源码
// （面板历史配了「复制 Markdown」，目标读者本来就懂 Markdown；分享卡的目标读者不懂）。
// 覆盖范围以 dom-response-text.ts（捕获侧）实际会产出的语法为准，不追求完整
// CommonMark 覆盖——捕获侧不会产出的语法，这里也不需要认。
function renderMarkdownToHtml(rawText: string): string {
  const lines = formatCapturedMarkdownText(rawText).split('\n')
  const blocks: string[] = []
  let paragraph: string[] = []
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    blocks.push(`<p>${paragraph.map(renderInlineMarkdown).join('<br>')}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (!list) return
    const items = list.items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join('')
    blocks.push(`<${list.tag}>${items}</${list.tag}>`)
    list = null
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      flushParagraph()
      flushList()
      i += 1
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph()
      flushList()
      blocks.push('<hr>')
      i += 1
      continue
    }

    if (/^>\s?/.test(line)) {
      flushParagraph()
      flushList()
      const quoteLines: string[] = []
      // blockquoteMarkdown（捕获侧）用空行分隔引用内的多个段落，空行本身不带 `>` 前缀
      // （见 dom-response-text.ts）。只有紧跟着的下一行还是 `>` 开头时，才把这个空行
      // 当成引用内部的段落分隔符继续收（渲染成 <br><br>），否则空行就是引用真正的结束。
      while (i < lines.length) {
        if (/^>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^>\s?/, ''))
          i += 1
          continue
        }
        if (lines[i].trim() === '' && i + 1 < lines.length && /^>\s?/.test(lines[i + 1])) {
          quoteLines.push('')
          i += 1
          continue
        }
        break
      }
      const rendered = quoteLines.map((quoteLine) => (quoteLine ? renderInlineMarkdown(quoteLine) : '')).join('<br>')
      blocks.push(`<blockquote>${rendered}</blockquote>`)
      continue
    }

    if (/^```/.test(line)) {
      flushParagraph()
      flushList()
      const codeLines: string[] = []
      i += 1
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i])
        i += 1
      }
      i += 1
      blocks.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])) {
      flushParagraph()
      flushList()
      const headerCells = splitTableRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        rows.push(splitTableRow(lines[i]))
        i += 1
      }
      const thead = `<thead><tr>${headerCells.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join('')}</tr></thead>`
      const tbody = `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`
      blocks.push(`<table>${thead}${tbody}</table>`)
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushParagraph()
      flushList()
      const level = heading[1].length
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`)
      i += 1
      continue
    }

    const listItem = line.match(/^[-*]\s+(.*)$/) ?? line.match(/^\d+[.)]\s+(.*)$/)
    if (listItem) {
      flushParagraph()
      const tag = /^\d/.test(line) ? 'ol' : 'ul'
      if (!list || list.tag !== tag) {
        flushList()
        list = { tag, items: [] }
      }
      list.items.push(listItem[1])
      i += 1
      continue
    }

    flushList()
    paragraph.push(line)
    i += 1
  }
  flushParagraph()
  flushList()
  return blocks.join('\n')
}

export function formatSessionHtml(session: Session): string {
  const title = firstLine(session.prompt)
  const cards = session.targetPlatforms.map((platform) => {
    const label = platformLabel(platform)
    const response = session.responses[platform]
    const hasText = response?.status === 'captured' && Boolean(response.text.trim())
    const text = hasText ? normalizeCapturedResponse(platform, response!.text) : ''
    const wordCountLabel = hasText ? `<span class="word-count">${countWords(text)} 字</span>` : ''
    const body = hasText
      ? renderMarkdownToHtml(text)
      : `<p>${escapeHtml(responseStatusLabel(response))}</p>`
    return [
      '<section class="card">',
      `<h2>${escapeHtml(label)} ${wordCountLabel}</h2>`,
      `<div class="body">${body}</div>`,
      '</section>',
    ].join('\n')
  }).join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 24px; background: #f7f7f8; color: #1a1a1a; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #666; font-size: 13px; margin-bottom: 20px; }
  .card { background: #fff; border: 1px solid #e2e2e6; border-radius: 12px; padding: 16px 20px; margin-bottom: 16px; }
  .card h2 { font-size: 15px; margin: 0 0 10px; }
  .word-count { font-weight: normal; color: #888; font-size: 12px; }
  .body { line-height: 1.6; font-size: 14px; overflow-wrap: anywhere; }
  .body > *:first-child { margin-top: 0; }
  .body > *:last-child { margin-bottom: 0; }
  .body p { margin: 0 0 12px; }
  .body h1, .body h2, .body h3, .body h4, .body h5, .body h6 { margin: 16px 0 8px; line-height: 1.3; }
  .body ul, .body ol { margin: 0 0 12px; padding-left: 22px; }
  .body li { margin: 0 0 4px; }
  .body pre { margin: 0 0 12px; padding: 10px 12px; border-radius: 6px; overflow-x: auto; background: rgba(0, 0, 0, 0.05); }
  .body code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
  .body pre code { font-size: 0.85em; }
  .body table { border-collapse: collapse; margin: 0 0 12px; display: block; overflow-x: auto; white-space: nowrap; }
  .body th, .body td { border: 1px solid #e2e2e6; padding: 6px 10px; text-align: left; }
  .body th { background: rgba(0, 0, 0, 0.04); font-weight: 600; }
  .body hr { margin: 16px 0; border: none; border-top: 1px solid #e2e2e6; }
  .body blockquote { margin: 0 0 12px; padding: 4px 12px; border-left: 3px solid #d0d0d6; color: #555; }
  .body a { color: #2563eb; }
  @media (prefers-color-scheme: dark) {
    body { background: #17181c; color: #e6e6e6; }
    .card { background: #22242b; border-color: #33353d; }
    .word-count, .meta { color: #9a9a9a; }
    .body pre { background: rgba(255, 255, 255, 0.08); }
    .body th, .body td { border-color: #33353d; }
    .body th { background: rgba(255, 255, 255, 0.06); }
    .body hr { border-top-color: #33353d; }
    .body blockquote { border-left-color: #4a4c56; color: #b0b0b0; }
    .body a { color: #60a5fa; }
  }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="meta">${escapeHtml(new Date(session.createdAt).toLocaleString())} · ${escapeHtml(session.targetPlatforms.map(platformLabel).join(' / '))}</div>
${cards}
</body>
</html>
`
}

export function buildSessionHtmlExport(session: Session): { filename: string; mime: string; content: string } {
  return {
    filename: `ChatDuel-${safeFilename(session.prompt)}.html`,
    mime: 'text/html;charset=utf-8',
    content: formatSessionHtml(session),
  }
}
