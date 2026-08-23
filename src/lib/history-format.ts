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
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/([^\n])\s+(#{2,6}\s+)/g, '$1\n\n$2')
    .replace(/(#{2,6}\s+[^\n]+?)\s+(?=(?:#{2,6}\s+)|(?:[-*]\s+)|(?:\d+[.)]\s+)|[^#\n])/g, '$1\n\n')
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

export function formatSessionHtml(session: Session): string {
  const title = firstLine(session.prompt)
  const cards = session.targetPlatforms.map((platform) => {
    const label = platformLabel(platform)
    const response = session.responses[platform]
    const hasText = response?.status === 'captured' && Boolean(response.text.trim())
    const text = hasText ? normalizeCapturedResponse(platform, response!.text) : ''
    const wordCountLabel = hasText ? `<span class="word-count">${countWords(text)} 字</span>` : ''
    const body = hasText
      ? escapeHtml(formatCapturedMarkdownText(text))
      : escapeHtml(responseStatusLabel(response))
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
  .body { white-space: pre-wrap; line-height: 1.6; font-size: 14px; }
  @media (prefers-color-scheme: dark) {
    body { background: #17181c; color: #e6e6e6; }
    .card { background: #22242b; border-color: #33353d; }
    .word-count, .meta { color: #9a9a9a; }
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
