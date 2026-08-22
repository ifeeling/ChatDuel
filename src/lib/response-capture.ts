import type { StreamStatus } from '../types'
import { logCaptureDebug } from './capture-debug'
import type { DiagnosticErrorCode } from './diagnostic-types'

export interface ResponseProbe {
  text?: string
  status?: StreamStatus
  stopButtonDetected?: boolean
}

export interface ResponseCaptureProgress {
  lastText: string
  stableCount: number
  firstObservedAt: number
  lastActivityAt?: number
  lastActivityText?: string
  /** `lastText` 从什么时候开始保持不变，用于强制完成阈值判定。与 `lastActivityAt` 是两回事：
   * `lastActivityAt` 在 `activeGenerationObserved` 时会持续刷新（即使文本没变），
   * `textStableSinceAt` 只看文本本身是否变化，不受 stop 按钮信号影响。 */
  textStableSinceAt: number
  /** 本轮回答期间文本是否真的变化过（至少观察到两个不同的非空文本快照）。 */
  everTextChanged: boolean
}

export interface ResponseCaptureDecision {
  shouldCapture: boolean
  text: string
  progress: ResponseCaptureProgress
  /** `shouldCapture` 是否是通过「isActive 强制完成」分支得出的，而非常规 !isActive 快路径。
   * 下游用它判断这次抓取是否只是「文本足够久没变」的推断，不是网站本身确认已完成——
   * 用于决定要不要暂停自动发送队列，见 `pending-question-queue.ts` 的 `pauseReasonFor`。 */
  forceCaptured: boolean
}

export interface ResponseCaptureWaitState {
  stateRequestTimedOut: boolean
  status: StreamStatus
  responseLength: number
  differsFromBaseline: boolean
}

const ACTIVE_STATUSES: StreamStatus[] = ['queued', 'sending', 'streaming']
export const RESPONSE_NO_PROGRESS_TIMEOUT_MS = 60_000
export const RESPONSE_ABSOLUTE_TIMEOUT_MS = 10 * 60_000

/**
 * 强制完成阈值（Issue #7）：`status` 报告仍处于 active（如 `streaming`）但文本已连续
 * 多轮未变化时，不再无条件相信这个单一状态信号，按文本本身有没有真正变化过分两档强制收下：
 * - `FORCE_CAPTURE_STABLE_MS`：文本从第一次出现起就没变过，更可能是 `status`/`stopButtonDetected`
 *   陈旧或误报（例如 `hasStopGeneratingButton` 命中历史轮次残留按钮），稳定这么久后直接强制收下。
 * - `FORCE_CAPTURE_STABLE_MS_CONFIRMED_ACTIVE`：文本曾经真实增长过、之后才停下来，更可能是
 *   模型仍在思考/组织下一段，为避免打断，给到与既有 `RESPONSE_NO_PROGRESS_TIMEOUT_MS` 无进展兜底
 *   相同的时间——到点后把已读到的文本强制收下，而不是像过去那样判为 uncertain 直接丢弃。
 *
 * 判定用的是「文本是否真的变化过」而不是 `stopButtonDetected`：核对各平台 adapter
 * （如 `adapters/claude/adapter.ts` 的 `hasStopGeneratingButton`）后发现 `stopButtonDetected`
 * 和 `status: 'streaming'` 在主检测路径上是同一次 DOM 查询的两个字段，两者会一起误报，
 * 不能当独立证据用来分档，否则残留 stop 按钮这个 issue 原文点名的坑仍然会一直落进慢档，
 * 慢档阈值又和旧的无进展兜底一样长，等于没修。
 *
 * 初始值为保守估计；需要用 `logCaptureDebug` 的 `evaluate-capture` / `status-active-force-capture`
 * 事件收集真实流量后重新校准，不能照抄参考实现（ai-arena-extension）的具体秒数。
 */
export const FORCE_CAPTURE_STABLE_MS = 15_000
export const FORCE_CAPTURE_STABLE_MS_CONFIRMED_ACTIVE = RESPONSE_NO_PROGRESS_TIMEOUT_MS

export function classifyResponseCaptureWait(state: ResponseCaptureWaitState): DiagnosticErrorCode {
  if (state.stateRequestTimedOut) return 'state-request-timeout'
  if (state.responseLength === 0) return 'response-selector-empty'
  if (!state.differsFromBaseline) return 'response-equals-baseline'
  if (ACTIVE_STATUSES.includes(state.status)) return 'response-still-streaming'
  return 'response-capture-timeout'
}

function nextProgress(
  text: string,
  baselineText: string,
  stableCount: number,
  previous: ResponseCaptureProgress | undefined,
  observedAt: number,
  activeGenerationObserved: boolean,
): ResponseCaptureProgress {
  const hasNewTextActivity = !!text && text !== baselineText && text !== previous?.lastActivityText
  const hasNewActivity = hasNewTextActivity || activeGenerationObserved
  const textUnchanged = !!previous && previous.lastText === text
  const everTextChanged = previous?.everTextChanged === true
    || (!!previous && previous.lastText !== '' && previous.lastText !== text)
  return {
    lastText: text,
    stableCount,
    firstObservedAt: previous?.firstObservedAt ?? observedAt,
    lastActivityAt: hasNewActivity ? observedAt : previous?.lastActivityAt,
    lastActivityText: hasNewTextActivity ? text : previous?.lastActivityText,
    textStableSinceAt: textUnchanged ? (previous?.textStableSinceAt ?? observedAt) : observedAt,
    everTextChanged,
  }
}

export function evaluateResponseCapture(
  probe: ResponseProbe,
  baseline: string | undefined,
  previous: ResponseCaptureProgress | undefined,
  requiredStableCount = 2,
  observedAt = Date.now(),
): ResponseCaptureDecision {
  const text = probe.text?.trim() ?? ''
  const baselineText = baseline?.trim() ?? ''
  const isActive = probe.status ? ACTIVE_STATUSES.includes(probe.status) : false
  const activeGenerationObserved = isActive && probe.stopButtonDetected === true

  if (!text || text === baselineText) {
    logCaptureDebug({
      platform: undefined,
      event: 'evaluate-capture',
      reason: !text ? 'text-empty' : 'text-equals-baseline',
      textLength: text.length,
      baselineLength: baselineText.length,
      isActive,
      shouldCapture: false,
    })
    return {
      shouldCapture: false,
      text,
      progress: nextProgress(text, baselineText, 0, previous, observedAt, activeGenerationObserved),
      forceCaptured: false,
    }
  }

  if (isActive) {
    const activeProgress = nextProgress(text, baselineText, 0, previous, observedAt, activeGenerationObserved)
    const stableSinceMs = observedAt - activeProgress.textStableSinceAt
    const forceThresholdMs = activeProgress.everTextChanged
      ? FORCE_CAPTURE_STABLE_MS_CONFIRMED_ACTIVE
      : FORCE_CAPTURE_STABLE_MS
    const shouldForceCapture = stableSinceMs >= forceThresholdMs
    logCaptureDebug({
      platform: undefined,
      event: 'evaluate-capture',
      reason: shouldForceCapture ? 'status-active-force-capture' : 'status-active',
      status: probe.status,
      textLength: text.length,
      stableSinceMs,
      forceThresholdMs,
      everTextChanged: activeProgress.everTextChanged,
      shouldCapture: shouldForceCapture,
    })
    return {
      shouldCapture: shouldForceCapture,
      text,
      progress: activeProgress,
      forceCaptured: shouldForceCapture,
    }
  }

  const stableCount = previous?.lastText === text ? previous.stableCount + 1 : 1
  const shouldCapture = stableCount >= requiredStableCount
  logCaptureDebug({
    platform: undefined,
    event: 'evaluate-capture',
    reason: shouldCapture ? 'stable-enough' : 'stable-pending',
    textLength: text.length,
    stableCount,
    requiredStableCount,
    shouldCapture,
  })
  return {
    shouldCapture,
    text,
    progress: nextProgress(text, baselineText, stableCount, previous, observedAt, activeGenerationObserved),
    forceCaptured: false,
  }
}

export function shouldResponseCaptureTimeout(
  progress: ResponseCaptureProgress | undefined,
  now: number,
): boolean {
  if (!progress) return false
  if (now - progress.firstObservedAt >= RESPONSE_ABSOLUTE_TIMEOUT_MS) return true
  const lastProgressAt = progress.lastActivityAt ?? progress.firstObservedAt
  return now - lastProgressAt >= RESPONSE_NO_PROGRESS_TIMEOUT_MS
}

export function partitionResponseCapturePlatforms<T extends string>(
  platforms: T[],
  progress: Partial<Record<T, ResponseCaptureProgress>>,
  now: number,
): { waiting: T[]; timedOut: T[] } {
  const waiting: T[] = []
  const timedOut: T[] = []
  for (const platform of platforms) {
    if (shouldResponseCaptureTimeout(progress[platform], now)) timedOut.push(platform)
    else waiting.push(platform)
  }
  return { waiting, timedOut }
}

export function isResponseCompleteForUnlock(probe: ResponseProbe, baseline: string | undefined): boolean {
  const text = probe.text?.trim() ?? ''
  const baselineText = baseline?.trim() ?? ''
  const isActive = probe.status ? ACTIVE_STATUSES.includes(probe.status) : false
  const result = !!text && text !== baselineText && !isActive
  logCaptureDebug({
    platform: undefined,
    event: 'complete-for-unlock',
    textLength: text.length,
    baselineLength: baselineText.length,
    status: probe.status,
    isActive,
    result,
    reason: !text ? 'text-empty' : text === baselineText ? 'text-equals-baseline' : isActive ? 'status-active' : 'complete',
  })
  return result
}
