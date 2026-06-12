import type { AIPlatform, Session } from '../types'
import { renderTemplate } from './prompt-template'

const PLATFORM_LABELS: Record<AIPlatform, string> = {
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
}

function capturedText(session: Session, platform: AIPlatform): string {
  const response = session.responses[platform]
  if (response?.status === 'captured' && response.text.trim()) return response.text.trim()
  if (response?.status === 'failed') return '发送失败，未获取到回答。'
  return '未获取到回答。'
}

export function hasCapturedResponses(session: Session): boolean {
  return session.targetPlatforms.some((platform) => {
    const response = session.responses[platform]
    return response?.status === 'captured' && response.text.trim().length > 0
  })
}

export function buildHistoryBlock(sessionOrSessions: Session | Session[]): string {
  const sessions = Array.isArray(sessionOrSessions) ? sessionOrSessions : [sessionOrSessions]
  return sessions.map((session, index) => buildSingleHistoryBlock(session, index + 1)).join('\n\n')
}

function buildSingleHistoryBlock(session: Session, round: number): string {
  const parts: string[] = [
    `### 第 ${round} 轮`,
    '',
    '【用户问题】',
    session.sentPrompt || session.prompt || '空',
    '',
  ]

  for (const platform of session.targetPlatforms) {
    const label = PLATFORM_LABELS[platform]
    parts.push(`【${label} 回答】`, capturedText(session, platform), '')
  }

  return parts.join('\n').trim()
}

export interface SummaryPromptOptions {
  targetLabel?: string
  modeLabel?: string
}

export function buildSummaryPrompt(template: string, sessionOrSessions: Session | Session[], options: SummaryPromptOptions = {}): string {
  const sessions = Array.isArray(sessionOrSessions) ? sessionOrSessions : [sessionOrSessions]
  return renderTemplate(template, {
    historyBlock: buildHistoryBlock(sessions),
    targetLabel: options.targetLabel ?? 'AI',
    rangeLabel: sessions.length === 1 ? '已选择 1 条历史' : `已选择 ${sessions.length} 条历史`,
    modeLabel: options.modeLabel ?? '最终结论',
  })
}
