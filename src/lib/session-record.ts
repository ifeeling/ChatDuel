import type { AIPlatform, Session, SessionAttachment, SessionResponse, SessionSummary } from '../types'

export interface CreateSessionRecordInput {
  prompt: string
  sentPrompt: string
  targetPlatforms: AIPlatform[]
  attachments?: SessionAttachment[]
  now?: number
  id?: string
}

export interface SendResult {
  p: AIPlatform
  ok: boolean
  error?: string
}

export interface CreateSummarySessionRecordInput {
  title: string
  prompt: string
  target: AIPlatform
  summary: SessionSummary
  now?: number
  id?: string
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function pendingResponses(targetPlatforms: AIPlatform[]): Partial<Record<AIPlatform, SessionResponse>> {
  return Object.fromEntries(
    targetPlatforms.map((p) => [p, { text: '', status: 'pending' }]),
  ) as Partial<Record<AIPlatform, SessionResponse>>
}

export function normalizeCapturedResponse(platform: AIPlatform, text: string): string {
  return text.trim()
}

export function isMoreCompleteCapturedResponse(next: string, current: string | undefined): boolean {
  const nextText = next.trim()
  const currentText = current?.trim() ?? ''
  if (!nextText || nextText === currentText) return false
  if (!currentText) return true
  if (nextText.includes(currentText)) return true
  return nextText.length >= currentText.length + 30
}

export function createSessionRecord(input: CreateSessionRecordInput): Session {
  const now = input.now ?? Date.now()
  return {
    id: input.id ?? makeId(),
    createdAt: now,
    updatedAt: now,
    prompt: input.prompt,
    sentPrompt: input.sentPrompt,
    targetPlatforms: input.targetPlatforms,
    responses: pendingResponses(input.targetPlatforms),
    attachments: input.attachments ?? [],
    followUps: [],
    summaries: [],
  }
}

export function createSummarySessionRecord(input: CreateSummarySessionRecordInput): Session {
  const now = input.now ?? Date.now()
  return {
    id: input.id ?? makeId(),
    createdAt: now,
    updatedAt: now,
    prompt: input.title,
    sentPrompt: input.prompt,
    targetPlatforms: [input.target],
    responses: pendingResponses([input.target]),
    attachments: [],
    followUps: [],
    summaries: [input.summary],
  }
}

/**
 * 把总结的最新状态写回 session.summaries：
 * 已存在同 id 的条目就原位替换，否则插到最前面。不修改 updatedAt，由调用方决定。
 */
export function applySummaryToSession(session: Session, summary: SessionSummary): Session {
  const summaries = session.summaries ?? []
  const index = summaries.findIndex((item) => item.id === summary.id)
  const next = index >= 0
    ? summaries.map((item, i) => (i === index ? summary : item))
    : [summary, ...summaries]
  return {
    ...session,
    summaries: next,
  }
}

export function applySendResults(session: Session, results: SendResult[], now = Date.now()): Session {
  const responses = { ...session.responses }
  for (const result of results) {
    responses[result.p] = result.ok
      ? (responses[result.p] ?? { text: '', status: 'pending' })
      : { text: '', status: 'failed', error: result.error || 'send failed' }
  }
  return {
    ...session,
    updatedAt: now,
    responses,
  }
}

export function applyCapturedResponses(
  session: Session,
  captured: Partial<Record<AIPlatform, string>>,
  now = Date.now(),
): Session {
  const responses = { ...session.responses }
  let changed = false
  for (const platform of session.targetPlatforms) {
    if (responses[platform]?.status === 'captured') continue
    const rawText = captured[platform]?.trim()
    const text = rawText ? normalizeCapturedResponse(platform, rawText) : ''
    if (!isMoreCompleteCapturedResponse(text, responses[platform]?.text)) continue
    responses[platform] = {
      text,
      status: 'captured',
      capturedAt: now,
    }
    changed = true
  }
  if (!changed) return session
  return {
    ...session,
    updatedAt: now,
    responses,
  }
}

export interface CaptureFailure {
  status: 'failed' | 'uncertain'
  error: string
}

export function applyCaptureFailures(
  session: Session,
  failures: Partial<Record<AIPlatform, CaptureFailure>>,
  now = Date.now(),
): Session {
  const responses = { ...session.responses }
  let changed = false
  for (const platform of session.targetPlatforms) {
    if (responses[platform]?.status !== 'pending') continue
    const failure = failures[platform]
    const error = failure?.error.trim()
    if (!failure || !error) continue
    responses[platform] = {
      text: responses[platform]?.text ?? '',
      status: failure.status,
      error,
    }
    changed = true
  }
  if (!changed) return session
  return {
    ...session,
    updatedAt: now,
    responses,
  }
}

/**
 * sentPrompt 为可选参数：调用方能提供「本轮实际发送的问题文本」时，多做一层
 * 兜底——抓到的内容如果跟发送内容一字不差，大概率是把用户提问误当成了 AI
 * 回答（CAP-05：Claude 输入框偶发提交失败，回答区回显出刚发的问题），不能
 * 当作有效新回答保存。省略或传空白字符串时行为与之前一致。
 */
export function isNewCapturedResponse(
  text: string | undefined,
  baseline: string | undefined,
  sentPrompt?: string,
): boolean {
  const next = text?.trim() ?? ''
  if (!next) return false
  if (next === (baseline?.trim() ?? '')) return false
  const sent = sentPrompt?.trim()
  if (sent && next === sent) return false
  return true
}
