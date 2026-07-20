export type AIPlatform = 'chatgpt' | 'gemini' | 'doubao' | 'deepseek' | 'claude'

export type StreamStatus =
  | 'idle'
  | 'queued'
  | 'sending'
  | 'streaming'
  | 'paused'
  | 'finished'
  | 'error'

export interface SessionFollowUp {
  type?: 'transfer' | 'quote' | 'manual'
  from: 'user' | AIPlatform
  to: AIPlatform
  text: string
  promptTemplate?: string
  status?: 'pending' | 'sent' | 'captured' | 'failed'
  result?: string
  timestamp: number
  capturedAt?: number
  error?: string
}

export interface SessionStats {
  wordCount: Partial<Record<AIPlatform, number>>
  durationMs: Partial<Record<AIPlatform, number>>
  ttftMs: Partial<Record<AIPlatform, number>>
}

export interface Session {
  id: string
  conversationId?: string
  createdAt: number
  updatedAt: number
  prompt: string
  sentPrompt: string
  targetPlatforms: AIPlatform[]
  responses: Partial<Record<AIPlatform, SessionResponse>>
  attachments: SessionAttachment[]
  followUps: SessionFollowUp[]
  summaries: SessionSummary[]
  summary?: string
  stats?: SessionStats
}

export interface ConversationEntry {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  enabledPlatforms: AIPlatform[]
  platformOrder?: AIPlatform[]
  platformUrls: Partial<Record<AIPlatform, string>>
}

export interface SessionResponse {
  text: string
  status: 'pending' | 'captured' | 'failed'
  capturedAt?: number
  error?: string
}

export interface SessionAttachment {
  id: string
  name: string
  mime: string
  size: number
  kind: 'image' | 'text' | 'document'
  handling: 'inline-text' | 'file-upload' | 'manual'
  inlinedText?: string
  uploadStatus?: 'pending' | 'ready' | 'failed' | 'manual'
  error?: string
}

export interface SessionSummary {
  id: string
  target: AIPlatform
  range: SummaryRange
  mode: SummaryMode
  prompt: string
  status: 'pending' | 'sent' | 'captured' | 'failed'
  result?: string
  sourceSessionIds: string[]
  timestamp: number
  sentAt?: number
  capturedAt?: number
  error?: string
}

export type SummaryRange = 'latest-1' | 'latest-3' | 'latest-5' | 'manual'
export type SummaryMode = 'final-answer' | 'differences' | 'short-summary' | 'opinion-digest'

export type StreamEvent =
  | { type: 'started'; platform: AIPlatform; timestamp: number }
  | { type: 'token'; platform: AIPlatform; text: string; timestamp: number }
  | { type: 'paused'; platform: AIPlatform; timestamp: number }
  | { type: 'finished'; platform: AIPlatform; text: string; timestamp: number }
  | { type: 'error'; platform: AIPlatform; message: string; timestamp: number }
  | { type: 'rate-limit'; platform: AIPlatform; message: string; timestamp: number }

export interface ConversationState {
  status: StreamStatus
  lastResponse?: string
  errorMessage?: string
  stopButtonDetected?: boolean
}
