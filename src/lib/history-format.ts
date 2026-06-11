import type { AIPlatform, Session, SessionAttachment, SessionResponse } from '../types'

const PLATFORM_LABELS: Record<AIPlatform, string> = {
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
}

function firstLine(text: string, max = 60): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) return '未命名记录'
  return line.length > max ? `${line.slice(0, max)}...` : line
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
    .map((platform) => `${PLATFORM_LABELS[platform]} ${responseStatusLabel(session.responses[platform])}`)
    .join(' / ')
}

function formatAttachment(attachment: SessionAttachment): string {
  return `- ${attachment.name} · ${attachment.mime || '未知类型'} · ${formatBytes(attachment.size)}`
}

export function formatSessionMarkdown(session: Session): string {
  const parts: string[] = [
    `# ${firstLine(session.prompt)}`,
    '',
    `- 创建时间: ${new Date(session.createdAt).toLocaleString()}`,
    `- 目标: ${session.targetPlatforms.map((p) => PLATFORM_LABELS[p]).join(' / ')}`,
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
    const label = PLATFORM_LABELS[platform]
    const response = session.responses[platform]
    parts.push('', `## ${label} 回答`, '')
    if (response?.status === 'captured' && response.text.trim()) {
      parts.push(response.text)
    } else {
      parts.push(responseStatusLabel(response))
    }
  }

  return parts.join('\n')
}
