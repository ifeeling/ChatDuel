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

export function applySendResults(session: Session, results: SendResult[], now = Date.now()): Session {
  const responses = { ...session.responses }
  for (const result of results) {
    responses[result.p] = result.ok
      ? (responses[result.p] ?? { text: '', status: 'pending' })
      : { text: '', status: 'failed', error: 'send failed' }
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

export function applyCaptureFailures(
  session: Session,
  failures: Partial<Record<AIPlatform, string>>,
  now = Date.now(),
): Session {
  const responses = { ...session.responses }
  let changed = false
  for (const platform of session.targetPlatforms) {
    if (responses[platform]?.status !== 'pending') continue
    const error = failures[platform]?.trim()
    if (!error) continue
    responses[platform] = {
      text: responses[platform]?.text ?? '',
      status: 'failed',
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

export function isNewCapturedResponse(text: string | undefined, baseline: string | undefined): boolean {
  const next = text?.trim() ?? ''
  if (!next) return false
  return next !== (baseline?.trim() ?? '')
}
