import type { AIPlatform, Session } from '../types'

export interface TransferSourceOption {
  id: string
  source: 'history' | 'current'
  platform: AIPlatform
  sessionId?: string
  createdAt: number
  prompt: string
  text: string
  selected: boolean
}

export interface BuildTransferSourceOptionsInput {
  currentResponse?: string
  now?: number
  limit?: number
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function isSameResponse(a: string, b: string): boolean {
  return normalizeText(a) === normalizeText(b)
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

function compactPrompt(prompt: string, max = 80): string {
  const line = prompt.replace(/\s+/g, ' ').trim()
  if (!line) return '空问题'
  return line.length > max ? `${line.slice(0, max)}...` : line
}

export function buildTransferSourceOptions(
  platform: AIPlatform,
  sessions: Session[],
  input: BuildTransferSourceOptionsInput = {},
): TransferSourceOption[] {
  const limit = input.limit ?? 10
  const historyOptions = sessions
    .filter((session) => session.targetPlatforms.includes(platform))
    .sort((a, b) => b.createdAt - a.createdAt)
    .flatMap((session): TransferSourceOption[] => {
      const response = session.responses[platform]
      const text = response?.status === 'captured' ? response.text.trim() : ''
      if (!text) return []
      return [{
        id: `${session.id}:${platform}`,
        source: 'history',
        platform,
        sessionId: session.id,
        createdAt: session.createdAt,
        prompt: session.prompt,
        text,
        selected: false,
      }]
    })
    .slice(0, limit)

  const options: TransferSourceOption[] = [...historyOptions]
  const currentText = input.currentResponse?.trim()
  if (currentText && !historyOptions.some((option) => isSameResponse(option.text, currentText))) {
    options.unshift({
      id: `current:${platform}`,
      source: 'current',
      platform,
      createdAt: input.now ?? Date.now(),
      prompt: '当前页面最新回答',
      text: currentText,
      selected: false,
    })
  }

  if (options[0]) options[0].selected = true
  return options
}

export function buildTransferContent(options: TransferSourceOption[], platformLabel: string): string {
  const selected = options.filter((option) => option.selected)
  if (selected.length === 0) return ''
  if (selected.length === 1) return selected[0].text

  return [
    `以下是 ${platformLabel} 的 ${selected.length} 条回答，请综合参考。`,
    '',
    ...selected.flatMap((option, index) => [
      `【回答 ${index + 1}｜${platformLabel}｜${formatTime(option.createdAt)}】`,
      `问题：${compactPrompt(option.prompt, 120)}`,
      '',
      option.text,
      '',
      '---',
      '',
    ]),
  ].join('\n').trim()
}
