import type { AIPlatform, Session, SessionAttachment, SessionResponse } from '../types'
import { getPlatformMeta } from './ai-platforms'

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
  if (response.status === 'failed') return '发送失败'
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
      parts.push(formatCapturedMarkdownText(response.text))
    } else {
      parts.push(responseStatusLabel(response))
    }
  }

  return parts.join('\n')
}

export function buildSessionMarkdownExport(session: Session): { filename: string; mime: string; content: string } {
  return {
    filename: `AIChatRoom-${safeFilename(session.prompt)}.md`,
    mime: 'text/markdown;charset=utf-8',
    content: formatSessionMarkdown(session),
  }
}
