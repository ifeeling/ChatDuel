// 问题发送协调器（领域词见 CONTEXT.md；边界决策见 docs/adr/0003）。
//
// 目标：把「问题发送」的编排从页面主文件收拢到这个深模块——页面只通过
// 提交入口与事件订阅和它交互，投递计划、会话记录、诊断、结果映射等
// 全部收进实现内部。
//
// 票 1（预重构）先收拢了提问发送、总结、总结重试三处共用的构件：
//   - 「结果→面板状态」映射：单一实现，页面负责翻译文案键与渲染；
//   - 回答收集基础依赖装配：计时、基线、读取与历史存储的默认实现。
//
// 票 2（Issue #30）接管提问发送路径：
//   - 页面提交入口走 submitFromComposer（门禁：总结互斥 / 队列暂停 / 入队 / 立即发送）；
//   - 队列补发（含任务结束后的自动补发）走 dispatchQueued；
//   - 投递计划、诊断上下文、发送锁起锁、会话记录、回答收集任务装配与收尾、
//     队列转移、会话网址快照全部收进实现内部；
//   - 协调器不触碰 DOM、不查文案：只播报语义事件，翻译与渲染由页面负责。
//
// 票 3（Issue #12）在 dispatch 最前面插入发送前风险扫描（本地规则，见
// pre-send-risk-scan.ts）：命中时播报一次 warn 级 toast，不阻断发送。

import type { AIPlatform, ConversationEntry, Session, SessionAttachment } from '../types'
import {
  buildAttachmentDeliveryPlan,
  buildInlineTextPrompt,
  type PreparedAttachment,
} from '../lib/file-handler'
import { createSessionRecord } from '../lib/session-record'
import {
  type PendingQuestion,
  type PendingQuestionDraft,
  type PendingQuestionQueue,
  type QueuePauseReason,
} from '../lib/pending-question-queue'
import { dispatchPendingQuestion } from './pending-question-composer'
import { scanForSendRisk, type SendRiskFindingType } from '../lib/pre-send-risk-scan'
import { isSpecificConversationUrl } from '../lib/conversation-store'
import {
  createDiagnosticBatchId,
  createDiagnosticContext,
  createDiagnosticProducerId,
  createDiagnosticReporter,
} from '../lib/diagnostic-client'
import type { DiagnosticContext } from '../lib/diagnostic-types'
import { createResponseDiagnosticTracker } from './response-diagnostic'
import {
  runAnswerCollectionTask,
  type AnswerCollectionHistory,
  type AnswerCollectionPlatformResult,
  type AnswerCollectionRead,
  type AnswerCollectionSendResult,
  type AnswerCollectionTaskDependencies,
} from '../lib/answer-collection-task'
import {
  iframeWriteResultTimeoutMs,
  routeTimeoutErrorCode,
  type PlatformCommunication,
  type ResponseReadResult,
} from './platform-communication'

/** 一次面板状态更新：哪个平台、什么级别、哪条文案键。翻译与渲染由页面负责。 */
export interface PanelStatusUpdate {
  platform: AIPlatform
  level: 'ok' | 'warn' | 'err'
  messageKey: string
}

/** 发送阶段结算的单平台映射：成功→等待回答；失败→发送失败。 */
export function panelStatusForSendResult(
  result: Pick<AnswerCollectionSendResult, 'platform' | 'ok'>,
): PanelStatusUpdate {
  return result.ok
    ? { platform: result.platform, level: 'warn', messageKey: 'send.statusWaiting' }
    : { platform: result.platform, level: 'err', messageKey: 'send.statusFailed' }
}

/** 发送阶段结算的批量映射，保持输入顺序。 */
export function mapSendResultsToPanelStatuses(
  results: ReadonlyArray<Pick<AnswerCollectionSendResult, 'ok' | 'platform'>>,
): PanelStatusUpdate[] {
  return results.map((result) => panelStatusForSendResult(result))
}

/**
 * 回答收集结算的面板映射：
 * captured→完成；三类真正失败（超时/被打断/用户停止）→发送失败；
 * uncertain（platform 状态不确定，为安全起见暂不认定完成，不代表真的发送失败——
 * 语义上更接近 ai-arena `EXTRACT_STALE` 那类"还在等新内容"，不是发送失败）→
 * 单独一档警示级文案，不跟真正的失败共用同一句"发送失败"/错误红色样式；
 * 其它状态（observed-unsaved、send-failed）不改变面板，返回 null。
 */
export function mapSettledResultToPanelStatus(
  platform: AIPlatform,
  result: Pick<AnswerCollectionPlatformResult, 'status'>,
): PanelStatusUpdate | null {
  if (result.status === 'captured') {
    return { platform, level: 'ok', messageKey: 'send.statusDone' }
  }
  if (result.status === 'uncertain') {
    return { platform, level: 'warn', messageKey: 'send.statusUncertain' }
  }
  if (
    result.status === 'capture-timeout'
    || result.status === 'capture-interrupted'
    || result.status === 'user-stopped'
  ) {
    return { platform, level: 'err', messageKey: 'send.statusFailed' }
  }
  return null
}

/** 平台开始回答（首次 streaming 或出现新回答文字）时的面板状态：切「回答中」。 */
export function responseStartedPanelStatus(platform: AIPlatform): PanelStatusUpdate {
  return { platform, level: 'warn', messageKey: 'send.statusResponding' }
}

export interface AnswerCollectionBaseDependenciesOptions {
  communication: Pick<PlatformCommunication, 'readConversationState' | 'readLastResponse'>
  history: AnswerCollectionHistory
}

/**
 * 回答收集基础依赖装配：提问发送、总结与总结重试共用。
 * read 优先使用会话状态里自带的最新回答，没有时再补读一次；
 * 读取报错时状态记为 error，超时与诊断错误码两侧合并（状态侧优先）。
 */
export function createAnswerCollectionBaseDependencies(
  options: AnswerCollectionBaseDependenciesOptions,
): Pick<AnswerCollectionTaskDependencies, 'now' | 'wait' | 'captureBaseline' | 'read' | 'history'> {
  const read = async (platform: AIPlatform): Promise<AnswerCollectionRead> => {
    const state = await options.communication.readConversationState(platform, 1500)
    const responseRead: ResponseReadResult = state.lastResponse
      ? { text: state.lastResponse }
      : await options.communication.readLastResponse(platform, 1500)
    return {
      text: responseRead.text,
      status: responseRead.error ? 'error' : state.status,
      stopButtonDetected: state.stopButtonDetected,
      completionActionBarDetected: state.completionActionBarDetected,
      requestTimedOut: state.requestTimedOut || responseRead.requestTimedOut,
      diagnosticErrorCode: state.diagnosticErrorCode ?? responseRead.diagnosticErrorCode,
    }
  }
  return {
    now: () => Date.now(),
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    captureBaseline: async (platform) => (
      await options.communication.readLastResponse(platform, 1500)
    ).text,
    read,
    history: options.history,
  }
}

// ---------- 票 2：提问发送编排 ----------

/** 提示级别：与页面 toast 的四种视觉级别一致。 */
export type CoordinatorToastLevel = 'info' | 'success' | 'warn' | 'err'

/**
 * 语义提示事件：协调器只描述「要提示什么」，翻译与渲染由页面负责。
 * - text：动态文本（如平台返回的错误串），页面原样展示；
 * - messageKey：文案键，页面用 t()/uiText() 翻译；
 * - params：文案键带的参数（走页面的参数替换翻译）。
 * text 与 messageKey 同时存在时，页面优先展示 text（动态错误串优先于兜底文案键）。
 */
export interface CoordinatorToast {
  level: CoordinatorToastLevel
  durationMs: number
  text?: string
  messageKey?: string
  params?: Record<string, string | number>
}

/** 发送锁端口：页面把现有发送锁包装函数绑上来，协调器只按阶段调用。 */
export interface SendLockPort {
  begin(targets: AIPlatform[]): void
  markSubmitted(): void
  finishPlatform(platform: AIPlatform): void
  resetUi(): void
}

/** 页面提交的问题输入：text 为输入框原值（入队逐字保存；立即发送内部 trim 后投递）。 */
export interface QuestionComposerInput {
  text: string
  targets: AIPlatform[]
  attachment: PreparedAttachment | null
}

export type QuestionSubmitRejectionReason =
  | 'summary-running'
  | `queue-paused:${QueuePauseReason}`
  | 'enqueue-failed'
  | 'empty-composer'
  | 'no-text-targets'
  | 'dispatch-not-started'

export type QuestionSubmitOutcome =
  | { kind: 'dispatched' }
  | { kind: 'enqueued' }
  | { kind: 'rejected'; reason?: QuestionSubmitRejectionReason }

/** 入队端口草稿：不含 text（入队实现直接读输入框原值，保证逐字一致）。 */
export type ComposerEnqueueDraft = Omit<PendingQuestionDraft, 'text'>

/** 内部投递输入：text 已 trim，直接作为提示词与会话标题。 */
interface InternalDispatchInput {
  text: string
  targets: AIPlatform[]
  attachment: PreparedAttachment | null
  clearComposerOnSendComplete: boolean
  taskAlreadyStarted: boolean
  sessionId?: string
  taskId?: string
}

export interface QuestionSendCoordinatorDependencies {
  /** 平台通信：投递、读取与取得会话网址。 */
  communication: Pick<
    PlatformCommunication,
    'writeAndSend' | 'routeFor' | 'readConversationState' | 'readLastResponse' | 'readConversationUrl'
  >
  /** 本机历史存储（会话记录读写）。 */
  history: AnswerCollectionHistory
  /** 待发送问题队列：任务位、暂停与恢复的状态机。 */
  queue: PendingQuestionQueue
  /** 发送锁端口。 */
  sendLock: SendLockPort
  /** 总结任务是否在运行（发送门禁用；不搬总结编排本身）。 */
  isSummaryRunning(): boolean
  /** 诊断上报是否启用。 */
  isDiagnosticEnabled(): boolean
  /** 平台是否支持 iframe 嵌入（会话网址快照过滤用）。 */
  supportsEmbed(platform: AIPlatform): boolean
  /** 平台展示名（手动上传提示里的平台列表用）。 */
  getPlatformLabel(platform: AIPlatform): string
  /** 发送前风险扫描命中类型的展示名（风险提示文案用）。 */
  getRiskFindingLabel(type: SendRiskFindingType): string
  /** 当前平台顺序（写入官网会话记录）。 */
  getPlatformOrder(): AIPlatform[]
  /** 会话标题压缩（空标题的兜底文案由页面翻译）。 */
  compactConversationTitle(title: string): string
  /** 官网会话记录落盘。 */
  saveConversationEntry(entry: ConversationEntry): Promise<unknown>
  /** 入队端口：页面实现继续读输入框原值并在成功时清附件。 */
  enqueueFromComposer(draft: ComposerEnqueueDraft): ReturnType<PendingQuestionQueue['enqueue']>
  // ---------- 语义事件 ----------
  /** 面板状态更新：页面翻译文案键并渲染。 */
  onPanelStatus(update: PanelStatusUpdate): void
  /** 提示：页面翻译文案键/参数后调 toast。 */
  onToast(toast: CoordinatorToast): void
  /** 立即发送路径发送阶段结算后触发：页面清输入框与附件。 */
  onComposerConsumed(): void
  /** 队列被协调器变动后触发：页面重绘队列区。 */
  onQueueChanged(): void
  /** 任务结束而历史未保存：页面暂存会话并保留既有日志。 */
  onHistoryUnsaved(payload: { taskId: string; session: Session }): void
  // ---------- 仅测试用的计时覆盖，生产默认使用真实计时 ----------
  now?(): number
  wait?(milliseconds: number): Promise<void>
}

export interface QuestionSendCoordinator {
  /**
   * 页面提交入口：先做发送门禁（总结互斥→拒绝；队列暂停→拒绝；
   * 有任务在收集→入队），否则立即发送。
   */
  submitFromComposer(input: QuestionComposerInput): Promise<QuestionSubmitOutcome>
  /**
   * 队列补发入口：跳过建任务，沿用问题自带的会话/任务标识，
   * 发送结算后不清输入框。供页面薄委托与内部自动补发共用。
   */
  dispatchQueued(question: PendingQuestion): Promise<boolean>
  /** 停止等待：暂停当前任务并打断回答收集；没有活动任务时返回 false。 */
  stopWaiting(): boolean
}

// File → base64 dataURL(给 iframe 端)
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })
}

/** 官网会话记录 id。 */
function conversationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `conversation-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** 待发送问题 id。 */
function queuedQuestionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `queued-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** 入队失败原因→提示（文案键、级别与时长与原页面逐条一致）。 */
function toastForEnqueueFailure(
  reason: 'attachments-too-large' | 'empty' | 'full' | 'no-targets',
): CoordinatorToast {
  const messageKey = reason === 'full'
    ? 'queue.full'
    : reason === 'attachments-too-large'
      ? 'queue.attachmentsTooLargeKept'
      : reason === 'no-targets'
        ? 'send.noTextTarget'
        : 'send.needTextOrAttachment'
  return { level: 'warn', durationMs: 5000, messageKey }
}

export function createQuestionSendCoordinator(
  deps: QuestionSendCoordinatorDependencies,
): QuestionSendCoordinator {
  // 当前回答收集任务的打断控制器；stopWaiting 用它打断收集循环。
  let activeAbortController: AbortController | null = null

  // ---------- 会话网址快照 ----------
  // 发送结算后延时两次拍摄会话网址，落盘为官网会话记录。
  async function saveConversationSnapshot(title: string, platforms: AIPlatform[]): Promise<void> {
    const entries = await Promise.all(
      platforms.map(async (platform) => {
        if (platform === 'deepseek') {
          const url = await deps.communication.readConversationUrl('deepseek', 2000)
          return [platform, url] as const
        }
        return [platform, await deps.communication.readConversationUrl(platform)] as const
      }),
    )
    const platformUrls = Object.fromEntries(
      entries.filter(([platform, url]) => isSpecificConversationUrl(platform, url)),
    ) as Partial<Record<AIPlatform, string>>
    if (Object.keys(platformUrls).length === 0) return

    await deps.saveConversationEntry({
      id: conversationId(),
      title: deps.compactConversationTitle(title),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      enabledPlatforms: platforms,
      platformOrder: deps.getPlatformOrder(),
      platformUrls,
    })
  }

  function scheduleConversationSnapshot(title: string, platforms: AIPlatform[]): void {
    const activeTargets = platforms.filter((platform) => deps.supportsEmbed(platform))
    if (activeTargets.length === 0) return
    setTimeout(() => void saveConversationSnapshot(title, activeTargets), 1500)
    setTimeout(() => void saveConversationSnapshot(title, activeTargets), 4500)
  }

  // ---------- 投递 ----------
  async function dispatch(input: InternalDispatchInput): Promise<boolean> {
    const text = input.text
    let targets = [...input.targets]
    const attachment = input.attachment

    // 发送前风险扫描：只提醒，不阻断发送（本地规则扫描，见 pre-send-risk-scan.ts）。
    const riskFindings = scanForSendRisk(text)
    if (riskFindings.length > 0) {
      const labels = [...new Set(riskFindings.map((finding) => finding.type))]
        .map((type) => deps.getRiskFindingLabel(type))
        .join(' / ')
      deps.onToast({ level: 'warn', durationMs: 6000, messageKey: 'send.riskDetected', params: { labels } })
    }

    const deliveryPlan = buildAttachmentDeliveryPlan(
      targets,
      attachment?.classification ?? null,
      text.length > 0,
    )
    targets = deliveryPlan.sendTargets
    if (attachment?.classification.handling === 'file-upload') {
      if (deliveryPlan.manualUploadTargets.length > 0) {
        const labels = deliveryPlan.manualUploadTargets
          .map((platform) => deps.getPlatformLabel(platform))
          .join(' / ')
        deps.onToast({
          level: 'warn',
          durationMs: 6000,
          messageKey: text.length > 0 ? 'send.manualUploadWithText' : 'send.manualUploadOnly',
          params: { labels },
        })
      }
      if (targets.length === 0) {
        deps.onToast({ level: 'warn', durationMs: 6000, messageKey: 'send.noUploadTarget' })
        return false
      }
    }

    const diagnosticContexts: Partial<Record<AIPlatform, DiagnosticContext>> = {}
    if (deps.isDiagnosticEnabled()) {
      const batchId = createDiagnosticBatchId()
      for (const platform of targets) diagnosticContexts[platform] = createDiagnosticContext(batchId)
    }

    deps.sendLock.begin(targets)
    targets.forEach((platform) => deps.onPanelStatus({
      platform,
      level: 'warn',
      messageKey: 'send.statusSending',
    }))

    // 1. 准备附件:上传类转 dataURL,文本类拼进 prompt。
    let imageDataUrl: string | undefined
    let imageMime: string | undefined
    let imageName: string | undefined
    let textToSend = text
    if (attachment?.classification.handling === 'inline-text') {
      textToSend = buildInlineTextPrompt(attachment.file.name, attachment.textContent ?? '', text)
    }
    if (attachment?.classification.handling === 'file-upload') {
      try {
        imageDataUrl = await fileToDataUrl(attachment.file)
        imageMime = attachment.file.type
        imageName = attachment.file.name
      } catch (e) {
        console.error('[AIChatRoom chat] failed to read file as data URL', e)
      }
    }

    const attachments: SessionAttachment[] = attachment
      ? [{
          id: `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: attachment.file.name,
          mime: attachment.file.type,
          size: attachment.file.size,
          kind: attachment.classification.kind,
          handling: attachment.classification.handling,
          inlinedText: attachment.classification.handling === 'inline-text' ? attachment.textContent : undefined,
          uploadStatus: attachment.classification.handling === 'file-upload' ? 'pending' : undefined,
        }]
      : []

    const currentSession = createSessionRecord({
      id: input.sessionId,
      prompt: text,
      sentPrompt: textToSend,
      targetPlatforms: targets,
      attachments,
    })
    const taskId = input.taskId ?? `answer-collection-${currentSession.id}`
    if (!input.taskAlreadyStarted && !deps.queue.startTask(taskId, targets)) {
      deps.sendLock.resetUi()
      return false
    }
    const abortController = new AbortController()
    activeAbortController = abortController
    deps.onQueueChanged()
    const sentAttachmentHandling = attachment?.classification.handling

    void runAnswerCollectionTask(
      {
        id: taskId,
        session: currentSession,
        signal: abortController.signal,
      },
      {
        ...createAnswerCollectionBaseDependencies({
          communication: deps.communication,
          history: deps.history,
        }),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.wait ? { wait: deps.wait } : {}),
        send: async (platform) => {
          const shouldUploadFile = deliveryPlan.autoUploadTargets.includes(platform)
          const diagnosticContext = diagnosticContexts[platform]
          const reporter = diagnosticContext
            ? createDiagnosticReporter(
              diagnosticContext,
              platform,
              createDiagnosticProducerId('chat-ui'),
            )
            : undefined
          const route = deps.communication.routeFor(platform)
          reporter?.emit({
            component: 'chat-ui',
            operation: 'route-select',
            stage: 'routed',
            eventStatus: 'succeeded',
            route,
            inputCharacterCount: textToSend.length,
            hasAttachment: shouldUploadFile,
          })
          const result = await deps.communication.writeAndSend(platform, {
            text: textToSend,
            imageDataUrl: shouldUploadFile ? imageDataUrl : undefined,
            imageMime: shouldUploadFile ? imageMime : undefined,
            imageName: shouldUploadFile ? imageName : undefined,
            diagnostics: diagnosticContext,
          })
          if (!result.ok) {
            const timedOutWithoutReply = !result.error
            const terminalErrorCode = result.diagnosticErrorCode
              ?? (timedOutWithoutReply ? routeTimeoutErrorCode(route) : undefined)
            reporter?.emit({
              component: route === 'iframe' ? 'iframe-bridge' : 'official-tab',
              operation: 'result-return',
              stage: timedOutWithoutReply ? 'timed-out' : 'failed',
              eventStatus: timedOutWithoutReply ? 'timed-out' : 'failed',
              route,
              ...(terminalErrorCode
                ? {
                    runOutcome: timedOutWithoutReply ? 'timed-out' : 'failed',
                    errorCode: terminalErrorCode,
                    timeoutMs: route === 'iframe'
                      ? iframeWriteResultTimeoutMs({
                          imageDataUrl: shouldUploadFile ? imageDataUrl : undefined,
                        })
                      : undefined,
                  }
                : {}),
            })
          }
          return {
            platform,
            ok: result.ok,
            error: result.error,
          }
        },
        createDiagnosticTracker: (platform, startedAt) => {
          const context = diagnosticContexts[platform]
          if (!context) return undefined
          return createResponseDiagnosticTracker(
            createDiagnosticReporter(
              context,
              platform,
              createDiagnosticProducerId('response-capture'),
            ),
            startedAt,
          )
        },
        createHistoryReporter: (platform) => {
          const context = diagnosticContexts[platform]
          if (!context) return undefined
          return createDiagnosticReporter(
            context,
            platform,
            createDiagnosticProducerId('history-store'),
          )
        },
        onSendComplete: (results) => {
          deps.sendLock.markSubmitted()
          deps.onQueueChanged()
          for (const result of results) {
            deps.onPanelStatus(panelStatusForSendResult(result))
            if (!result.ok) {
              deps.sendLock.finishPlatform(result.platform)
            }
          }
          scheduleConversationSnapshot(
            text,
            results.filter((result) => result.ok).map((result) => result.platform),
          )

          const okCount = results.filter((result) => result.ok).length
          const firstError = results.find((result) => !result.ok && result.error)?.error
          if (sentAttachmentHandling === 'file-upload') {
            if (okCount === results.length && results.length > 0) {
              deps.onToast({ level: 'success', durationMs: 2500, messageKey: 'send.fileAllSent' })
            } else if (okCount > 0) {
              deps.onToast({ level: 'warn', durationMs: 6000, messageKey: 'send.filePartial' })
            } else {
              deps.onToast({
                level: 'err',
                durationMs: 6000,
                ...(firstError ? { text: firstError } : {}),
                messageKey: 'send.fileFailed',
              })
            }
          } else if (okCount === 0 && results.length > 0) {
            deps.onToast({
              level: 'err',
              durationMs: 3000,
              ...(firstError ? { text: firstError } : {}),
              messageKey: 'send.failed',
            })
          } else {
            deps.onToast({ level: 'success', durationMs: 1200, messageKey: 'send.success' })
          }

          if (input.clearComposerOnSendComplete) {
            deps.onComposerConsumed()
          }
        },
        onPlatformSettled: (platform, result) => {
          const update = mapSettledResultToPanelStatus(platform, result)
          if (update) {
            deps.onPanelStatus(update)
            deps.sendLock.finishPlatform(platform)
          }
        },
        // 平台首次进入 streaming，或任务首次观察到区别于发送前 baseline 的新回答文字时，
        // 统一由回答收集任务通知页面切换到「回答中」。
        onResponseStarted: (platform) => {
          deps.onPanelStatus(responseStartedPanelStatus(platform))
        },
      },
    ).then((result) => {
      if (activeAbortController === abortController) {
        activeAbortController = null
      }
      if (result.historyStatus === 'unsaved') {
        deps.onHistoryUnsaved({ taskId: result.id, session: result.session })
      }
      const transition = deps.queue.finishTask(taskId, result)
      deps.onQueueChanged()
      if (transition.kind === 'dispatch') {
        void redispatchQueued(transition.next, '[AIChatRoom chat] queued question failed to start')
      }
    }).catch((error) => {
      if (activeAbortController === abortController) {
        activeAbortController = null
      }
      deps.queue.pauseForTaskFailure(taskId)
      deps.sendLock.resetUi()
      deps.onQueueChanged()
      console.error('[AIChatRoom chat] answer collection task failed', error)
    })
    return true
  }

  /** 队列转移后自动补发下一条（沿用入队时的会话/任务标识，失败时暂停并重置发送锁）。 */
  function redispatchQueued(next: PendingQuestion, failureMessage: string): Promise<void> {
    return dispatchPendingQuestion(deps.queue, next, (queuedInput) =>
      dispatch({
        text: queuedInput.text,
        targets: queuedInput.targets,
        attachment: queuedInput.attachment,
        clearComposerOnSendComplete: queuedInput.clearComposerOnSendComplete,
        taskAlreadyStarted: queuedInput.taskAlreadyStarted,
        sessionId: queuedInput.sessionId,
        taskId: queuedInput.taskId,
      })).catch((error) => {
      deps.sendLock.resetUi()
      deps.onQueueChanged()
      console.error(failureMessage, error)
    })
  }

  return {
    async submitFromComposer(input: QuestionComposerInput): Promise<QuestionSubmitOutcome> {
      // 发送门禁：总结互斥与队列暂停优先于入队/发送判断（与原页面顺序一致）。
      if (deps.isSummaryRunning()) {
        return { kind: 'rejected', reason: 'summary-running' }
      }
      const queueSnapshot = deps.queue.snapshot()
      if (queueSnapshot.status === 'paused' && queueSnapshot.pauseReason) {
        return { kind: 'rejected', reason: `queue-paused:${queueSnapshot.pauseReason}` }
      }
      if (queueSnapshot.activeTaskId) {
        const id = queuedQuestionId()
        const enqueueResult = deps.enqueueFromComposer({
          id,
          taskId: `answer-collection-${id}`,
          targetPlatforms: input.targets,
          attachment: input.attachment,
        })
        if (!enqueueResult.ok) {
          deps.onToast(toastForEnqueueFailure(enqueueResult.reason))
          return { kind: 'rejected', reason: 'enqueue-failed' }
        }
        deps.onQueueChanged()
        deps.onToast({ level: 'success', durationMs: 1800, messageKey: 'queue.added' })
        return { kind: 'enqueued' }
      }

      // 与原页面顺序一致：空内容 / 无文本目标在门禁与入队分支之后才检查。
      const trimmedText = input.text.trim()
      if (!trimmedText && !input.attachment) {
        return { kind: 'rejected', reason: 'empty-composer' }
      }
      if (input.targets.length === 0) {
        return { kind: 'rejected', reason: 'no-text-targets' }
      }

      const dispatched = await dispatch({
        text: trimmedText,
        targets: input.targets,
        attachment: input.attachment,
        clearComposerOnSendComplete: true,
        taskAlreadyStarted: false,
      })
      return dispatched
        ? { kind: 'dispatched' }
        : { kind: 'rejected', reason: 'dispatch-not-started' }
    },

    async dispatchQueued(question: PendingQuestion): Promise<boolean> {
      return dispatch({
        text: question.text,
        targets: [...question.targetPlatforms],
        attachment: question.attachment ?? null,
        clearComposerOnSendComplete: false,
        taskAlreadyStarted: true,
        sessionId: question.id,
        taskId: question.taskId,
      })
    },

    stopWaiting(): boolean {
      const taskId = deps.queue.snapshot().activeTaskId
      if (!taskId || !deps.queue.pauseForUserStop(taskId)) return false
      activeAbortController?.abort()
      return true
    },
  }
}
