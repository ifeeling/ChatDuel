import type { AIPlatform, Session, SessionSummary, SummaryMode } from '../types'
import {
  runAnswerCollectionTask,
  type AnswerCollectionHistory,
  type AnswerCollectionSendResult,
  type AnswerCollectionTaskDependencies,
} from './answer-collection-task'
import { applySummaryToSession, createSummarySessionRecord } from './session-record'

/**
 * 总结任务 module（Issue #18 P0.1）
 *
 * 一个高层入口承担总结的发送、回答收集、历史更新和诊断结算：
 * - 调用者只提供总结内容和平台通信依赖，不再自行宣称发送成功；
 * - 复用普通提问的回答收集任务（runAnswerCollectionTask），共享稳定读取与超时规则；
 * - 发送前先落盘 pending 记录，只有平台明确确认成功后才把状态改为 sent 并写入 sentAt；
 * - 收集成功后更新同一条历史记录（不新增重复条目），并同步源 session 里的总结副本。
 */

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
> & {
  /**
   * 平台返回真实发送结果后触发一次（无论成败）。
   * 页面据此提示「已发送」——在此之前不允许对用户宣称发送成功。
   */
  onSendConfirmed?(results: AnswerCollectionSendResult[]): void
}

export type SummaryTaskOutcome =
  /** 发送成功且回答已捕获并保存。 */
  | 'captured'
  /** 平台明确拒绝或发送超时，没有产生 sentAt。 */
  | 'send-failed'
  /** 已确认发送成功，但回答收集超时 / 中断 / 状态不确定。 */
  | 'capture-failed'
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

export async function runSummaryTask(
  input: SummaryTaskInput,
  dependencies: SummaryTaskDependencies,
): Promise<SummaryTaskResult> {
  const startedAt = dependencies.now()
  // 总结状态由本 module 独占维护，初始必须是 pending：
  // 调用者拿不到中途修改状态的入口，因此无法提前宣称「已发送」。
  let summary: SessionSummary = {
    id: input.summaryId ?? makeSummaryId(),
    target: input.target,
    range: 'manual',
    mode: input.mode,
    prompt: input.prompt,
    status: 'pending',
    sourceSessionIds: [...input.sourceSessionIds],
    timestamp: startedAt,
  }
  const summarySession = createSummarySessionRecord({
    id: input.sessionId,
    title: input.title,
    prompt: input.prompt,
    target: input.target,
    summary,
    now: startedAt,
  })
  const taskId = input.taskId ?? `summary-task-${summarySession.id}`

  // 源 session 同步是尽力而为的镜像：失败不阻断总结任务本身，
  // 总结记录的权威状态始终在 summarySession 里。
  const syncSourceSessions = async (): Promise<void> => {
    for (const sourceId of input.sourceSessionIds) {
      if (sourceId === summarySession.id) continue
      try {
        const source = await dependencies.history.get(sourceId)
        if (!source) continue
        await dependencies.history.update({
          ...applySummaryToSession(source, summary),
          updatedAt: dependencies.now(),
        })
      } catch {
        // 镜像写入失败不影响任务推进。
      }
    }
  }

  // 历史装饰器：共享回答收集任务的每一次落盘都注入当前总结状态，
  // 这样「pending → sent → captured/failed」永远和发送/收集事实同步。
  const decorate = (session: Session): Session =>
    session.id === summarySession.id ? applySummaryToSession(session, summary) : session
  const history: AnswerCollectionHistory = {
    add: (session) => dependencies.history.add(decorate(session)),
    get: (id) => dependencies.history.get(id),
    update: (session) => dependencies.history.update(decorate(session)),
  }

  // 发送前先把 pending 副本写进源 session（总结记录本身由收集任务在发送前落盘）。
  await syncSourceSessions()

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
        // 只有平台明确确认成功才标记 sent + sentAt；失败立即记为 failed。
        summary = result.ok
          ? { ...summary, status: 'sent', sentAt: dependencies.now() }
          : { ...summary, status: 'failed', error: result.error || 'send failed' }
        return result
      },
      onSendComplete: (results) => {
        dependencies.onSendConfirmed?.(results)
      },
      onPlatformSettled: (platform, result) => {
        if (platform !== input.target) return
        if (result.status === 'captured' || result.status === 'observed-unsaved') {
          summary = {
            ...summary,
            status: 'captured',
            result: result.text,
            capturedAt: dependencies.now(),
          }
        } else if (result.status !== 'send-failed') {
          // send-failed 已在 send 包装里结算；其余都是收集阶段的失败。
          summary = { ...summary, status: 'failed', error: result.error }
        }
      },
    },
  )

  // 结算后把最终状态同步进源 session 副本。
  await syncSourceSessions()

  const platformResult = collectionResult.platforms[input.target]
  const finalSession = applySummaryToSession(collectionResult.session, summary)
  const error = platformResult && 'error' in platformResult ? platformResult.error : undefined

  let outcome: SummaryTaskOutcome
  if (collectionResult.historyStatus === 'unsaved') {
    outcome = 'history-unsaved'
  } else if (platformResult?.status === 'captured') {
    outcome = 'captured'
  } else if (platformResult?.status === 'send-failed') {
    outcome = 'send-failed'
  } else {
    outcome = 'capture-failed'
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
      // P0.1 策略：任务结算（无论成功、失败还是异常）即释放任务位并解锁；
      // 父 Issue #17 的「结果未知继续占位」将在状态条/重试落地时收紧。
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
  }
}
