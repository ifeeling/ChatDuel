export type AIPlatform = 'chatgpt' | 'gemini'

export type StreamStatus =
  | 'idle'
  | 'queued'
  | 'sending'
  | 'streaming'
  | 'paused'
  | 'finished'
  | 'error'

export interface SessionFollowUp {
  from: 'user' | 'chatgpt' | 'gemini'
  to: 'chatgpt' | 'gemini'
  text: string
  timestamp: number
}

export interface SessionStats {
  wordCount: { chatgpt?: number; gemini?: number }
  durationMs: { chatgpt?: number; gemini?: number }
  ttftMs: { chatgpt?: number; gemini?: number }
}

export interface Session {
  id: string
  createdAt: number
  prompt: string
  responses: { chatgpt?: string; gemini?: string }
  followUps: SessionFollowUp[]
  summary?: string
  stats?: SessionStats
}

export type StreamEvent =
  | { type: 'started'; platform: AIPlatform; timestamp: number }
  | { type: 'token'; platform: AIPlatform; text: string; timestamp: number }
  | { type: 'paused'; platform: AIPlatform; timestamp: number }
  | { type: 'finished'; platform: AIPlatform; text: string; timestamp: number }
  | { type: 'error'; platform: AIPlatform; message: string; timestamp: number }
  | { type: 'rate-limit'; platform: AIPlatform; timestamp: number }

export interface ConversationState {
  status: StreamStatus
  lastResponse?: string
  errorMessage?: string
}
