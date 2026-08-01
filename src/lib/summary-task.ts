import type { AIPlatform, Session, SessionSummary, SummaryMode, SummaryAttempt } from '../types'
import {
  runAnswerCollectionTask,
  POLL_INTERVAL_MS as ANSWER_COLLECTION_POLL_INTERVAL_MS,
  REQUIRED_STABLE_POLLS as ANSWER_COLLECTION_REQUIRED_STABLE_POLLS,
  type AnswerCollectionHistory,
  type AnswerCollectionPlatformResult,
  type AnswerCollectionSendResult,
  type AnswerCollectionTaskDependencies,
} from './answer-collection-task'
import { applySummaryToSession, createSummarySessionRecord, isNewCapturedResponse } from './session-record'
import {
  evaluateResponseCapture,
  shouldResponseCaptureTimeout,
  type ResponseCaptureProgress,
} from './response-capture'

/**
 * 总结任务 module（Issue #18 P0.1 成功路径 + Issue #19 P0.2 失败恢复）
 *
 * 一个高层入口承担总结的发送、回答收集、历史更新和诊断结算：
 * - 调用者只提供总结内容和平台通信依赖，不再自行宣称发送成功；
 * - 复用普通提问的回答收集任务（runAnswerCollectionTask），共享稳定读取与超时规则；
 * - 发送前先落盘 pending 记录，只有平台明确确认成功后才把状态改为 sent 并写入 sentAt；
 * - 发送超时记为「结果未知」（unknown），不冒充明确失败，并继续只读探测迟到回答；
 * - 收集成功后更新同一条历史记录（不新增重复条目），并同步源 session 里的总结副本；
 * - 失败/未保存时设置 recovery 恢复入口，供输入框上方状态条与历史详情重试入口复用，刷新后仍可还原。
 */

/** 平台发送结果的三分类：成功 / 明确拒绝 / 超时未知。 */
export type SummarySendReason = 'ok' | 'rejected' | 'timeout'

export function summarizeSendReason(result: AnswerCollectionSendResult): SummarySendReason {
  if (result.ok) return 'ok'
  if (result.reason === 'timeout') return 'timeout'
  return 'rejected'
}

export interface SummaryTaskInput {
  /** 总结历史记录的标题（显示在历史列表里）。 */
  title: string
  /** 发送给目标 AI 的完整总结提示词。 */
  prompt: string
  target: AIPlatform
  mode: SummaryMode
  /** 参与总结的源 session id，任务会把总结状态副本同步进这些记录。 */
  sourceSessionIds: string[]
  /** 便于测试注入的固定 id；缺省自动生成。 */
  summaryId?: string
  sessionId?: string
  taskId?: string
  /** 第几次重试（不含首次），由重试调用方递增传入。 */
  retryCount?: number
  /** 之前的尝试诊断记录，重试时整体保留并追加本次结果。 */
  attempts?: SummaryAttempt[]
}

export type SummaryTaskDependencies = Pick<
  AnswerCollectionTaskDependencies,
  | 'now'
  | 'wait'
  | 'captureBaseline'
  | 'read'
  | 'send'
  | 'history'
  | 'createDiagnosticTracker'
  | 'createHistoryReporter'
  | 'onResponseStarted'
  | 'onSendComplete'
  | 'onPlatformSettled'
> & {
  /**
   * 平台返回真实发送结果后触发一次（无论成败）。
   * 页面据此提示「已发送」——在此之前不允许对用户宣称发送成功。
   * 发送超时时不会触发（结果未知，不能冒充实发成功）。
   */
  onSendConfirmed?(results: AnswerCollectionSendResult[]): void
}

export type SummaryTaskOutcome =
  /** 发送成功且回答已捕获并保存。 */
  | 'captured'
  /** 平台明确拒绝发送。 */
  | 'send-failed'
  /** 发送超时、结果未知，未确认是否到达目标 AI。 */
  | 'send-unknown'
  /** 已确认发送成功，但回答收集超时 / 中断 / 状态不确定。 */
  | 'capture-failed'
  /** 已确认发送成功，但回答收集在平台仍在生成时超时、状态不确定（提供「重新检查」）。 */
  | 'answer-uncertain'
  /** 总结历史记录始终无法保存（含回答已观察到但没保存成功）。 */
  | 'history-unsaved'

export interface SummaryTaskResult {
  taskId: string
  session: Session
  summary: SessionSummary
  outcome: SummaryTaskOutcome
  error?: string
}

function makeSummaryId(): string {
  return `summary-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** 安全调用页面回调：UI 通知失败不得中断总结/收集任务的推进。 */
function invokeSafely(callback: (() => void) | undefined): void {
  try {
    callback?.()
  } catch {
    // 页面回调异常不影响任务本身。
  }
}

/**
 * 由已保存的总结记录构造一次重试所需的输入：
 * 复用原总结 id / 记录 id / 提示词 / 目标平台，重试计数 +1，并保留历史尝试诊断。
 */
export function buildSummaryRetryInput(
  session: Session,
  summary: SessionSummary,
): SummaryTaskInput {
  return {
    title: session.prompt,
    prompt: summary.prompt,
    target: summary.target,
    mode: summary.mode,
    sourceSessionIds: summary.sourceSessionIds,
    summaryId: summary.id,
    sessionId: session.id,
    taskId: `summary-task-${session.id}`,
    retryCount: (summary.retryCount ?? 0) + 1,
    attempts: summary.attempts ?? [],
  }
}

/** 根据总结状态与平台结果计算需要用户介入的恢复入口（无则任务已正常结束）。 */
function recoveryFor(
  summary: SessionSummary,
  platformResult: AnswerCollectionPlatformResult | undefined,
  historyStatus: 'saved' | 'unsaved',
): SessionSummary['recovery'] {
  if (summary.status === 'uncertain') {
    // 已确认发送成功，但回答状态不确定：只提供只读「重新检查」，绝不重发。
    return { action: 'recheck', needsConfirm: false, reason: 'answer-uncertain' }
  }
  if (summary.status === 'unknown') {
    // 结果未知：可重发，但必须先二次确认重复发送风险。
    return { action: 'resend', needsConfirm: true, reason: 'send-unknown' }
  }
  if (summary.status === 'failed' && platformResult?.status === 'send-failed') {
    // 平台明确拒绝：可安全重发，无需确认。
    return { action: 'resend', needsConfirm: false, reason: 'send-failed' }
  }
  if (summary.status === 'failed' && platformResult?.status === 'capture-interrupted') {
    // 收集阶段命令桥通信中断（断网）：发送已成功，AI 可能已生成或正在生成，
    // 提供只读「重新检查」而非重发，避免重复发送（#21 断网恢复）。
    return { action: 'recheck', needsConfirm: false, reason: 'answer-uncertain' }
  }
  if (historyStatus === 'unsaved' && (summary.status === 'sent' || summary.status === 'captured')) {
    // 已发送/已收集但历史保存失败：只重新保存，不得重发。
    return { action: 'resave', needsConfirm: false, reason: 'history-unsaved' }
  }
  return undefined
}

/** 由总结最终状态推导对外 outcome。 */
function decideOutcome(
  summary: SessionSummary,
  platformResult: AnswerCollectionPlatformResult | undefined,
  historyStatus: 'saved' | 'unsaved',
): SummaryTaskOutcome {
  if (summary.status === 'uncertain') return 'answer-uncertain'
  if (summary.status === 'unknown') return 'send-unknown'
  if (historyStatus === 'unsaved' && (summary.status === 'sent' || summary.status === 'captured')) {
    return 'history-unsaved'
  }
  if (summary.status === 'failed') {
    return platformResult?.status === 'send-failed' ? 'send-failed' : 'capture-failed'
  }
  if (summary.status === 'captured') return 'captured'
  return 'capture-failed'
}

export interface SummaryResaveResult {
  ok: boolean
  summary: SessionSummary
  session: Session
  error?: string
}

/**
 * 只重新保存总结历史记录，绝不触发平台发送（AC9）：
 * 用于「平台已确认发送 / 回答已收集，但历史保存失败」的恢复。
 * 成功时清除 recovery 并追加成功尝试诊断；失败时保留可恢复状态。
 * 注意：首次 pending 保存失败（status 为 history-unsaved）不走本函数，
 * 应重跑完整任务——保存成功后由同一任务继续发送（AC8）。
 */
export async function resaveSummaryHistory(
  session: Session,
  summary: SessionSummary,
  dependencies: Pick<SummaryTaskDependencies, 'now' | 'history'>,
): Promise<SummaryResaveResult> {
  const at = dependencies.now()
  const retryCount = (summary.retryCount ?? 0) + 1
  const savedSummary: SessionSummary = {
    ...summary,
    retryCount,
    recovery: undefined,
    attempts: [
      ...(summary.attempts ?? []),
      {
        index: retryCount,
        at,
        result: summary.status === 'captured' ? ('captured' as const) : ('sent' as const),
      },
    ],
  }
  const record: Session = {
    ...applySummaryToSession(session, savedSummary),
    updatedAt: at,
  }
  try {
    const existing = await dependencies.history.get(record.id).catch(() => undefined)
    if (existing) {
      await dependencies.history.update(record)
    } else {
      await dependencies.history.add(record)
    }
    return { ok: true, summary: savedSummary, session: record }
  } catch (e) {
    const error = e instanceof Error ? e.message : 'history save failed'
    // 保存仍失败：保留原 recovery（可再次重试），仅在内存里追加失败诊断。
    const failedSummary: SessionSummary = {
      ...summary,
      retryCount,
      attempts: [
        ...(summary.attempts ?? []),
        { index: retryCount, at, result: 'history-unsaved' as const, error },
      ],
    }
    return {
      ok: false,
      summary: failedSummary,
      session: applySummaryToSession(session, failedSummary),
      error,
    }
  }
}

/** 重新检查复用与普通回答收集任务完全相同的轮询与稳定读取参数（AC5：规则不变）。 */
const RECHECK_POLL_INTERVAL_MS = ANSWER_COLLECTION_POLL_INTERVAL_MS
const RECHECK_REQUIRED_STABLE_POLLS = ANSWER_COLLECTION_REQUIRED_STABLE_POLLS

export interface SummaryRecheckResult {
  /** captured=已确认安全回答并更新记录；still-uncertain=仍无法确认安全、保持原状态。 */
  outcome: 'captured' | 'still-uncertain'
  ok: boolean
  summary: SessionSummary
  session: Session
  error?: string
}

/**
 * 「重新检查」：对已确认发送但回答状态不确定的总结，执行安全的只读状态与回答检查。
 * 复用与普通回答收集相同的 3 秒轮询、60 秒无进展、10 分钟绝对超时与连续两次稳定读取规则（AC5），
 * 绝不调用平台发送。确认平台已停止生成且存在安全的新回答时，更新原历史记录为已收集、
 * 移除恢复入口；仍发现平台生成中或无法确认安全时，保持原记录与恢复入口不变。
 */
export async function recheckSummary(
  session: Session,
  summary: SessionSummary,
  dependencies: Pick<SummaryTaskDependencies, 'now' | 'wait' | 'read' | 'history'>,
): Promise<SummaryRecheckResult> {
  const target = summary.target
  const baseline = summary.baseline ?? ''
  const at = dependencies.now()
  const retryCount = (summary.retryCount ?? 0) + 1
  let progress: ResponseCaptureProgress | undefined

  while (true) {
    const probe = await dependencies.read(target)
    const decision = evaluateResponseCapture(
      probe,
      baseline,
      progress,
      RECHECK_REQUIRED_STABLE_POLLS,
      dependencies.now(),
    )
    progress = decision.progress
    if (decision.shouldCapture && isNewCapturedResponse(decision.text, baseline)) {
      // 平台已停止生成且存在安全的新回答：更新原记录为已收集，移除恢复入口。
      const capturedSummary: SessionSummary = {
        ...summary,
        status: 'captured',
        result: decision.text,
        capturedAt: dependencies.now(),
        recovery: undefined,
        retryCount,
        attempts: [
          ...(summary.attempts ?? []),
          { index: retryCount, at, result: 'captured' as const },
        ],
      }
      const record: Session = {
        ...applySummaryToSession(session, capturedSummary),
        updatedAt: dependencies.now(),
      }
      try {
        const existing = await dependencies.history.get(record.id).catch(() => undefined)
        if (existing) {
          await dependencies.history.update(record)
        } else {
          await dependencies.history.add(record)
        }
        return { ok: true, outcome: 'captured', summary: capturedSummary, session: record }
      } catch (e) {
        const error = e instanceof Error ? e.message : 'history save failed'
        // 保存失败：保留原可恢复状态，由用户稍后再次重新检查。
        return { ok: false, outcome: 'still-uncertain', summary, session, error }
      }
    }
    // 仍无法确认平台已停止生成或存在安全的新回答（含 60s 无进展 / 10 分钟绝对超时）：
    // 保持原记录与恢复入口不变，不重发、不解锁，交由状态条继续等待用户。
    if (shouldResponseCaptureTimeout(progress, dependencies.now())) {
      return { ok: false, outcome: 'still-uncertain', summary, session }
    }
    await dependencies.wait(RECHECK_POLL_INTERVAL_MS)
  }
}

/** 发送前保存 pending 记录（带一次重试）；保存失败返回 false，调用方不得继续发送。 */
async function savePendingWithRetry(
  session: Session,
  dependencies: SummaryTaskDependencies,
): Promise<boolean> {
  // 同一总结被重试时 session.id 会复用，必须 upsert：已存在则原地更新，
  // 避免产生重复历史条目（issue #22 历史列表点一条多条高亮）。
  const save = async (): Promise<boolean> => {
    const existing = await dependencies.history.get(session.id).catch(() => undefined)
    if (existing) {
      await dependencies.history.update(session)
      return true
    }
    await dependencies.history.add(session)
    return true
  }
  try {
    return await save()
  } catch {
    await dependencies.wait(300)
    try {
      return await save()
    } catch {
      return false
    }
  }
}

export async function runSummaryTask(
  input: SummaryTaskInput,
  dependencies: SummaryTaskDependencies,
): Promise<SummaryTaskResult> {
  const startedAt = dependencies.now()
  // 总结状态由本 module 独占维护，初始必须是 pending：
  // 调用者拿不到中途修改状态的入口，因此无法提前宣称「已发送」。
  const summaryId = input.summaryId ?? makeSummaryId()
  // 发送前捕获目标 AI 的会话基线（对话中已有内容），供「重新检查」判断
  // 平台是否产生了相对这次总结的新安全回答；捕获失败则退化为空基线。
  const baseline = await dependencies.captureBaseline(input.target).catch(() => '')
  let summary: SessionSummary = {
    id: summaryId,
    target: input.target,
    range: 'manual',
    mode: input.mode,
    prompt: input.prompt,
    status: 'pending',
    baseline,
    sourceSessionIds: [...input.sourceSessionIds],
    timestamp: startedAt,
    retryCount: input.retryCount ?? 0,
    attempts: input.attempts ?? [],
  }
  // 未显式提供 sessionId 时，让权威总结记录(id)与总结 id 一致，
  // 这样恢复时能用 summaryId 直接定位到该记录，避免误改源 session。
  const summarySession = createSummarySessionRecord({
    id: input.sessionId ?? summaryId,
    title: input.title,
    prompt: input.prompt,
    target: input.target,
    summary,
    now: startedAt,
  })
  const taskId = input.taskId ?? `summary-task-${summarySession.id}`

  // 源 session 同步是尽力而为的镜像：失败不阻断总结任务本身，
  // 总结记录的权威状态始终在 summarySession 里。镜像只同步状态/结果，
  // 不携带 recovery（恢复入口只属于权威总结记录，避免重复恢复入口）。
  const syncSourceSessions = async (): Promise<void> => {
    const mirroredSummary: SessionSummary = { ...summary, recovery: undefined }
    for (const sourceId of input.sourceSessionIds) {
      if (sourceId === summarySession.id) continue
      try {
        const source = await dependencies.history.get(sourceId)
        if (!source) continue
        await dependencies.history.update({
          ...applySummaryToSession(source, mirroredSummary),
          updatedAt: dependencies.now(),
        })
      } catch {
        // 镜像写入失败不影响任务推进。
      }
    }
  }

  // 历史装饰器：共享回答收集任务的每一次落盘都注入当前总结状态，
  // 这样「pending → sent → captured/failed」永远和发送/收集事实同步。
  // 这里把 add 处理成 upsert：重试时记录已存在则原地更新，避免产生重复条目。
  const decorate = (session: Session): Session =>
    session.id === summarySession.id ? applySummaryToSession(session, summary) : session
  const history: AnswerCollectionHistory = {
    add: async (session) => {
      const existing = await dependencies.history.get(session.id)
      if (existing) {
        await dependencies.history.update(session)
        return
      }
      await dependencies.history.add(session)
    },
    get: (id) => dependencies.history.get(id),
    update: (session) => dependencies.history.update(decorate(session)),
  }

  // 发送前先把 pending 副本写进源 session（总结记录本身由本 module 在发送前落盘）。
  await syncSourceSessions()

  // 发送前先保存 pending 记录；保存失败不得调用平台发送（AC8）。
  const pendingSaved = await savePendingWithRetry(summarySession, dependencies)
  if (!pendingSaved) {
    summary = {
      ...summary,
      status: 'history-unsaved',
      error: 'pending record save failed',
      recovery: { action: 'resave', needsConfirm: false, reason: 'history-unsaved' },
    }
    await syncSourceSessions()
    const attempts = [
      ...(summary.attempts ?? []),
      { index: summary.retryCount ?? 0, at: dependencies.now(), result: 'history-unsaved' as const, error: summary.error },
    ]
    summary = { ...summary, attempts }
    const finalSession = applySummaryToSession(summarySession, summary)
    return {
      taskId,
      session: finalSession,
      summary,
      outcome: 'history-unsaved',
      error: summary.error,
    }
  }

  // 发送超时抑制「已发送」提示：超时未确认，不能冒充实发成功。
  let sendConfirmSuppressed = false
  let sendConfirmedFired = false

  const collectionResult = await runAnswerCollectionTask(
    {
      id: taskId,
      session: summarySession,
    },
    {
      now: dependencies.now,
      wait: dependencies.wait,
      captureBaseline: dependencies.captureBaseline,
      read: dependencies.read,
      history,
      createDiagnosticTracker: dependencies.createDiagnosticTracker,
      createHistoryReporter: dependencies.createHistoryReporter,
      send: async (platform) => {
        const result = await dependencies.send(platform)
        const reason = summarizeSendReason(result)
        if (reason === 'ok') {
          summary = { ...summary, status: 'sent', sentAt: dependencies.now() }
        } else if (reason === 'timeout') {
          // 结果未知：先记为 unknown，仍让收集任务进入只读轮询探测迟到回答；
          // 向收集任务谎报 ok:true 以便它继续轮询，但绝不触发「已发送」提示。
          summary = { ...summary, status: 'unknown' }
          sendConfirmSuppressed = true
          return { platform, ok: true }
        } else {
          summary = { ...summary, status: 'failed', error: result.error || 'send failed' }
        }
        return result
      },
      onSendComplete: (results) => {
        if (sendConfirmSuppressed) return
        // 透传发送结果给页面（用于把面板状态从「发送中」切到「等待回答」）。
        invokeSafely(() => dependencies.onSendComplete?.(results))
        dependencies.onSendConfirmed?.(results)
      },
      onResponseStarted: (platform) => {
        // 透传「AI 开始回答」信号（用于把面板状态切到「回答中」）。
        invokeSafely(() => dependencies.onResponseStarted?.(platform))
      },
      onPlatformSettled: (platform, result) => {
        // 透传「回答落定」信号（用于把面板状态切到「已回复 / 失败」）。
        invokeSafely(() => dependencies.onPlatformSettled?.(platform, result))
        if (platform !== input.target) return
        if (result.status === 'captured' || result.status === 'observed-unsaved') {
          // 迟到回答确认了发送：升级 unknown → sent（不重发），并继续完成回答收集。
          const wasUnknown = summary.status === 'unknown'
          summary = {
            ...summary,
            status: 'captured',
            sentAt: summary.sentAt ?? dependencies.now(),
            result: result.text,
            capturedAt: dependencies.now(),
          }
          if (wasUnknown && !sendConfirmedFired) {
            sendConfirmedFired = true
            dependencies.onSendConfirmed?.([{ platform, ok: true }])
          }
          return
        }
        if (result.status === 'send-failed') {
          summary = { ...summary, status: 'failed', error: result.error }
          return
        }
        if (result.status === 'uncertain' && summary.status === 'sent') {
          // 平台已确认发送成功，但回答收集在平台仍在生成时超时 → 状态不确定，
          // 提供「重新检查」（只读、不重发），不降级为明确失败。
          summary = { ...summary, status: 'uncertain', error: result.error }
          return
        }
        // 其它收集阶段失败：正常路径记为 failed（区别于发送失败由 send 包装结算）；
        // 超时探测路径保持 unknown，不把不确定性伪装成明确失败。
        if (summary.status !== 'unknown') {
          summary = { ...summary, status: 'failed', error: result.error }
        }
      },
    },
  )

  // 结算后把最终状态同步进源 session 副本。
  await syncSourceSessions()

  const platformResult = collectionResult.platforms[input.target]
  const recovery = recoveryFor(summary, platformResult, collectionResult.historyStatus)
  summary = { ...summary, recovery }
  const outcome = decideOutcome(summary, platformResult, collectionResult.historyStatus)

  const attempts = [
    ...(summary.attempts ?? []),
    {
      index: summary.retryCount ?? 0,
      at: dependencies.now(),
      result: outcome,
      ...(summary.error !== undefined ? { error: summary.error } : {}),
    },
  ]
  summary = { ...summary, attempts }

  const finalSession = applySummaryToSession(collectionResult.session, summary)
  const error = platformResult && 'error' in platformResult ? platformResult.error : undefined

  // 收尾时确保最终状态（含 recovery / attempts）落盘：收集任务在结算前写入的
  // 是更早的摘要副本，这里用最终副本补一次更新，保证刷新后仍可还原恢复入口。
  try {
    await dependencies.history.update(finalSession)
  } catch {
    // 尽力保存，失败不阻断任务结算。
  }

  return {
    taskId,
    session: finalSession,
    summary,
    outcome,
    ...(error !== undefined ? { error } : {}),
  }
}

export interface SummaryTaskRunnerOptions {
  /** 任务占用/释放唯一任务位时通知页面（用于锁定输入控件）。 */
  onRunningChanged?(running: boolean): void
}

export interface SummaryTaskRunner {
  isRunning(): boolean
  /**
   * 启动一个总结任务；同一时间只允许一个。
   * 已有任务运行时返回 null，调用者不得再启动第二个。
   */
  start(
    input: SummaryTaskInput,
    dependencies: SummaryTaskDependencies,
  ): Promise<SummaryTaskResult> | null
  /**
   * 对已确认发送但回答状态不确定的总结执行只读「重新检查」；同一时间只允许一个总结任务。
   * 已有任务运行时返回 null。运行期间占用唯一任务位（保持输入锁），结束后释放。
   */
  recheck(
    session: Session,
    summary: SessionSummary,
    dependencies: Pick<SummaryTaskDependencies, 'now' | 'wait' | 'read' | 'history'>,
  ): Promise<SummaryRecheckResult> | null
}

export function createSummaryTaskRunner(
  options: SummaryTaskRunnerOptions = {},
): SummaryTaskRunner {
  let running = false

  const setRunning = (next: boolean) => {
    if (running === next) return
    running = next
    try {
      options.onRunningChanged?.(next)
    } catch {
      // 页面通知失败不影响任务位管理。
    }
  }

  return {
    isRunning: () => running,
    start(input, dependencies) {
      if (running) return null
      setRunning(true)
      const settle = () => setRunning(false)
      // P0.1 策略：任务结算（无论成功、失败还是异常）即释放任务位并解锁。
      // 发送结果未知时本 module 会在结算前完成只读探测，探测期间任务仍运行、输入锁保持；
      // 探测结束（仍 unknown）后释放，由输入框状态条提供带二次确认的重发入口（#19）。
      return runSummaryTask(input, dependencies).then(
        (result) => {
          settle()
          return result
        },
        (error) => {
          settle()
          throw error
        },
      )
    },
    recheck(session, summary, dependencies) {
      if (running) return null
      setRunning(true)
      const settle = () => setRunning(false)
      // 重新检查占用唯一任务位并保持输入锁：检查期间用户不能发起新内容或重发，
      // 确认安全后解锁，仍不确定时保持锁定直到用户再次检查或另行处理（#20）。
      return recheckSummary(session, summary, dependencies).then(
        (result) => {
          settle()
          return result
        },
        (error) => {
          settle()
          throw error
        },
      )
    },
  }
}
