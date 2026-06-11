import type { AIPlatform, Session, SessionAttachment, SessionResponse } from '../types'

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
    const text = captured[platform]?.trim()
    if (!text) continue
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
