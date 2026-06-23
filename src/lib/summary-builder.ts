import type { AIPlatform, Session, SummaryMode } from '../types'
import { getPlatformMeta } from './ai-platforms'
import { renderTemplate } from './prompt-template'

const SUMMARY_MODE_INSTRUCTIONS: Partial<Record<SummaryMode, string>> = {
  'final-answer': [
    '综合各 AI 的回答，输出一版可以直接使用的最终结论。',
    '先合并共识，再处理分歧和需要确认的点。',
    '去掉重复内容、客套话和不确定表达。',
  ].join('\n'),
  differences: [
    '只输出各 AI 之间不一致、互相补充或重点不同的地方。',
    '不要重新完整总结全部内容，也不要复述相同观点。',
    '按“分歧点 / 各 AI 观点 / 我的判断”整理。',
  ].join('\n'),
  'short-summary': [
    '用尽量短的篇幅给出结论。',
    '只保留最重要的 3-5 条信息。',
    '不要展开长篇解释，不要保留客套话。',
  ].join('\n'),
  'opinion-digest': [
    '只提取各 AI 提出的意见、建议、风险提醒和待确认点。',
    '不要保留寒暄、客套话、自我介绍、重复背景说明。',
    '按 AI 来源分组列出，例如“ChatGPT 的意见”“Gemini 的意见”。',
    '如果多个 AI 的意见相同，可以在最后用“共同意见”合并，不要重复堆文字。',
  ].join('\n'),
}

function capturedText(session: Session, platform: AIPlatform): string {
  const response = session.responses[platform]
  if (response?.status === 'captured' && response.text.trim()) return response.text.trim()
  if (response?.status === 'failed') return response.error || '发送失败，未获取到回答。'
  return '未获取到回答。'
}

export function hasCapturedResponses(session: Session): boolean {
  return session.targetPlatforms.some((platform) => {
    const response = session.responses[platform]
    return response?.status === 'captured' && response.text.trim().length > 0
  })
}

export interface SummaryHistoryOptions {
  includedPlatforms?: AIPlatform[]
}

export function buildHistoryBlock(sessionOrSessions: Session | Session[], options: SummaryHistoryOptions = {}): string {
  const sessions = Array.isArray(sessionOrSessions) ? sessionOrSessions : [sessionOrSessions]
  return sessions.map((session, index) => buildSingleHistoryBlock(session, index + 1, options)).join('\n\n')
}

function buildSingleHistoryBlock(session: Session, round: number, options: SummaryHistoryOptions): string {
  const included = options.includedPlatforms ? new Set(options.includedPlatforms) : null
  const parts: string[] = [
    `### 第 ${round} 轮`,
    '',
    '【用户问题】',
    session.sentPrompt || session.prompt || '空',
    '',
  ]

  for (const platform of session.targetPlatforms) {
    if (included && !included.has(platform)) continue
    const label = getPlatformMeta(platform)?.label ?? platform
    parts.push(`【${label} 回答】`, capturedText(session, platform), '')
  }

  return parts.join('\n').trim()
}

export interface SummaryPromptOptions {
  targetLabel?: string
  modeLabel?: string
  mode?: SummaryMode
  includedPlatforms?: AIPlatform[]
}

export function buildSummaryPrompt(template: string, sessionOrSessions: Session | Session[], options: SummaryPromptOptions = {}): string {
  const sessions = Array.isArray(sessionOrSessions) ? sessionOrSessions : [sessionOrSessions]
  const modeInstruction = options.mode ? SUMMARY_MODE_INSTRUCTIONS[options.mode] ?? '' : ''
  const templateWithModeInstruction = modeInstruction && !template.includes('{{modeInstruction}}')
    ? `${template}\n\n【总结方式补充要求】\n{{modeInstruction}}`
    : template
  return renderTemplate(templateWithModeInstruction, {
    historyBlock: buildHistoryBlock(sessions, { includedPlatforms: options.includedPlatforms }),
    modeInstruction,
    targetLabel: options.targetLabel ?? 'AI',
    rangeLabel: sessions.length === 1 ? '已选择 1 条历史' : `已选择 ${sessions.length} 条历史`,
    modeLabel: options.modeLabel ?? '最终结论',
  })
}
