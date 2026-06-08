import type { ConversationState, StreamEvent } from '../types'

export interface AIAdapter {
  readonly platform: 'chatgpt' | 'gemini'

  isLoggedIn(): Promise<boolean>
  writeText(text: string): Promise<void>
  triggerSend(): Promise<void>
  sendMessage(text: string, image?: File): Promise<void>
  getLastResponse(): Promise<string>
  getConversationState(): Promise<ConversationState>
  onStreamEvent(handler: (event: StreamEvent) => void): () => void
  detectRateLimit(): Promise<boolean>
}
