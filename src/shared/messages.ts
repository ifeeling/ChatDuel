import type { AIPlatform, ConversationState, StreamEvent } from '../types'
import type { DiagnosticContext, DiagnosticEventDraft } from '../lib/diagnostic-types'

export type DiagnosticToSw =
  | { type: 'diagnostic:append'; event: DiagnosticEventDraft }
  | { type: 'diagnostic:summary' }
  | { type: 'diagnostic:snapshot' }
  | { type: 'diagnostic:clear' }

export type PopupToSw =
  | { type: 'send-message'; platforms: AIPlatform[]; text: string; imageDataUrl?: string; imageMime?: string; imageName?: string }
  | { type: 'transfer'; from: AIPlatform; to: AIPlatform; promptTemplateId: string }
  | { type: 'get-conversation-state'; platform: AIPlatform }
  | { type: 'quote-last'; from: AIPlatform }
  | { type: 'request-summary'; target: AIPlatform }

export type SwToContent =
  | { type: 'write-and-send'; text: string; imageDataUrl?: string; imageMime?: string; imageName?: string; diagnostics?: DiagnosticContext }
  | { type: 'get-state' }
  | { type: 'get-last-response' }

export type ContentToSw =
  | { type: 'state'; platform: AIPlatform; state: ConversationState }
  | { type: 'stream-event'; event: StreamEvent }
  | { type: 'last-response'; platform: AIPlatform; text: string }

export type SwToPopup =
  | { type: 'state-update'; platform: AIPlatform; state: ConversationState }
  | { type: 'stream-event'; event: StreamEvent }
  | { type: 'last-response'; platform: AIPlatform; text: string }
  | { type: 'error'; platform: AIPlatform; message: string }
