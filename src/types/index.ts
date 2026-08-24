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
  // uncertain: 平台已确认发送成功，但回答收集超时时平台仍在生成中，状态不确定（不等于收集失败）。
  status: 'pending' | 'captured' | 'failed' | 'uncertain'
  capturedAt?: number
  error?: string
}

export interface SessionAttachment {
  id: string
  name: string
  mime: string
  size: number
  kind: 'image' | 'text' | 'document' | 'markup' | 'unknown'
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
  // pending: 已落盘、待发送
  // sent: 平台明确确认发送成功
  // captured: 回答已收集并保存
  // failed: 平台明确拒绝（可安全重发）或收集明确失败（capture-failed）
  // unknown: 发送超时、结果未知（不得自动重发，需二次确认）
  // uncertain: 平台已确认发送成功，但回答收集在平台仍在生成时超时、状态不确定（提供「重新检查」，不重发）
  // history-unsaved: 发送前或发送后历史保存失败（只需重新保存，不得重发）
  status: 'pending' | 'sent' | 'captured' | 'failed' | 'unknown' | 'uncertain' | 'history-unsaved'
  // 发送前的会话基线（对话中已有的内容），供「重新检查」判断目标 AI 是否产生了新的安全回答。
  baseline?: string
  result?: string
  sourceSessionIds: string[]
  timestamp: number
  sentAt?: number
  capturedAt?: number
  error?: string
  /** 重试次数（不含首次尝试），正常历史只展示当前状态与这个计数。 */
  retryCount?: number
  /** 每次尝试的时间、结果与错误，供诊断回溯，不进入正常历史展示。 */
  attempts?: SummaryAttempt[]
  /** 需要用户介入时存在的恢复入口；为空表示任务已正常结束、无需操作。 */
  recovery?: SummaryRecovery
}

/** 一次总结尝试的诊断记录（不进入正常历史展示）。 */
export interface SummaryAttempt {
  /** 第几次尝试，0 为首次。 */
  index: number
  /** 尝试发生时间（毫秒）。 */
  at: number
  /** 本次尝试的结果分类。 */
  result:
    | 'pending'
    | 'sent'
    | 'captured'
    | 'send-failed'
    | 'send-unknown'
    | 'capture-failed'
    | 'answer-uncertain'
    | 'history-unsaved'
  error?: string
}

/** 需要用户介入的恢复入口描述。 */
export interface SummaryRecovery {
  /** resend: 重新发送（原提示词与平台）；resave: 重新保存（不重发）；recheck: 只读重新检查（不重发）。 */
  action: 'resend' | 'resave' | 'recheck'
  /**
   * 是否需要二次确认：
   * - 明确失败重发不需要确认；
   * - 结果未知的重发必须先确认重复发送风险；
   * - 「重新检查」是只读安全检查，不重发，无需确认。
   */
  needsConfirm: boolean
  reason: 'send-failed' | 'send-unknown' | 'answer-uncertain' | 'history-unsaved'
}

export type SummaryRange = 'latest-1' | 'latest-3' | 'latest-5' | 'manual'
export type SummaryMode = 'final-answer' | 'differences' | 'short-summary' | 'opinion-digest'

export interface ConversationState {
  status: StreamStatus
  lastResponse?: string
  errorMessage?: string
  stopButtonDetected?: boolean
  completionActionBarDetected?: boolean
  /** 登录探针判定为登录页时置真；供体检等场景区分"未登录"与其它错误，不靠 errorMessage 文案匹配。 */
  needsLogin?: boolean
}
