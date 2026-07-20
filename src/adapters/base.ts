import type { ConversationState, StreamEvent } from '../types'
import type { DiagnosticReporter } from '../lib/diagnostic-client'

export interface AdapterDiagnostics {
  reporter: DiagnosticReporter
  selectorConfigVersion: string
}

export interface AIAdapter {
  isLoggedIn(): Promise<boolean>
  writeText(text: string): Promise<void>
  triggerSend(): Promise<void>
  sendMessage(text: string, image?: File, diagnostics?: AdapterDiagnostics): Promise<void>
  attachImage(file: File): Promise<void>
  getLastResponse(): Promise<string>
  getConversationState(): Promise<ConversationState>
  onStreamEvent(handler: (event: StreamEvent) => void): () => void
  detectRateLimit(): Promise<boolean>
}
