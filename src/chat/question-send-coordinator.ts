// 问题发送协调器（领域词见 CONTEXT.md；边界决策见 docs/adr/0003）。
//
// 目标：把「问题发送」的编排从页面主文件收拢到这个深模块——页面只通过
// 提交入口与事件订阅和它交互，投递计划、会话记录、诊断、结果映射等
// 全部收进实现内部。
//
// 当前阶段（票 1，预重构）：先收拢提问发送、总结、总结重试三处共用的构件：
//   - 「结果→面板状态」映射：单一实现，页面负责翻译文案键与渲染；
//   - 回答收集基础依赖装配：计时、基线、读取与历史存储的默认实现。

import type { AIPlatform } from '../types'
import type {
  AnswerCollectionHistory,
  AnswerCollectionPlatformResult,
  AnswerCollectionRead,
  AnswerCollectionSendResult,
  AnswerCollectionTaskDependencies,
} from '../lib/answer-collection-task'
import type {
  PlatformCommunication,
  ResponseReadResult,
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
  results: ReadonlyArray<Pick<AnswerCollectionSendResult, 'platform' | 'ok'>>,
): PanelStatusUpdate[] {
  return results.map((result) => panelStatusForSendResult(result))
}

/**
 * 回答收集结算的面板映射：
 * captured→完成；四类失败状态（超时/被打断/不确定/用户停止）→发送失败；
 * 其它状态（observed-unsaved、send-failed）不改变面板，返回 null。
 */
export function mapSettledResultToPanelStatus(
  platform: AIPlatform,
  result: Pick<AnswerCollectionPlatformResult, 'status'>,
): PanelStatusUpdate | null {
  if (result.status === 'captured') {
    return { platform, level: 'ok', messageKey: 'send.statusDone' }
  }
  if (
    result.status === 'capture-timeout'
    || result.status === 'capture-interrupted'
    || result.status === 'uncertain'
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
