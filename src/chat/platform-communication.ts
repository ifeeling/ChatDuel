import type { AIPlatform, ConversationState } from '../types'
import type { DiagnosticErrorCode } from '../lib/diagnostic-types'
import {
  OFFICIAL_TAB_COMMAND_MESSAGE_TYPE,
  type PlatformCommand,
  type PlatformCommandResult,
  type WriteAndSendPayload,
} from '../shared/messages'

export type PlatformMessageRoute = 'iframe' | 'official-tab'

export interface PlatformFrame {
  src: string
  contentWindow: {
    postMessage(message: unknown, targetOrigin: string): void
  } | null
}

export interface PlatformMessageHost {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

/** 写入并发送的参数；字段定义以 shared/messages.ts 的 WriteAndSendPayload 为准。 */
export type PlatformWritePayload = WriteAndSendPayload & Record<string, unknown>

export interface PlatformSendResult {
  platform: AIPlatform
  ok: boolean
  error?: string
  diagnosticErrorCode?: DiagnosticErrorCode
}

export interface ResponseReadResult {
  text: string
  error?: string
  requestTimedOut?: boolean
  diagnosticErrorCode?: DiagnosticErrorCode
}

export type ConversationStateResult = ConversationState & {
  requestTimedOut?: boolean
  diagnosticErrorCode?: DiagnosticErrorCode
}

export interface PlatformCommunicationDependencies {
  platforms: readonly AIPlatform[]
  messageHost: PlatformMessageHost
  getFrame(platform: AIPlatform): PlatformFrame
  getPlatformOrigin(platform: AIPlatform): string
  supportsEmbed(platform: AIPlatform): boolean
  ensureEmbedRules(): Promise<void>
  reload(platform: AIPlatform): void
  sendRuntimeMessage(message: unknown): Promise<unknown>
  createRequestId?(): string
  onTimeout?(event: {
    platform: AIPlatform
    operation: string
    timeoutMs: number
  }): void
}

export interface PlatformCommunication {
  markNotReady(platform: AIPlatform): void
  routeFor(platform: AIPlatform): PlatformMessageRoute
  prepare(platform: AIPlatform): Promise<boolean>
  writeAndSend(platform: AIPlatform, payload: PlatformWritePayload): Promise<PlatformSendResult>
  readLastResponse(platform: AIPlatform, timeoutMs?: number): Promise<ResponseReadResult>
  readConversationState(platform: AIPlatform, timeoutMs?: number): Promise<ConversationStateResult>
  readConversationUrl(platform: AIPlatform, timeoutMs?: number): Promise<string>
}

function chooseRoute(
  platform: AIPlatform,
  dependencies: PlatformCommunicationDependencies,
): PlatformMessageRoute {
  if (!dependencies.supportsEmbed(platform)) return 'official-tab'
  if (dependencies.getFrame(platform).src.startsWith('chrome-error://')) return 'official-tab'
  return 'iframe'
}

export function iframeWriteResultTimeoutMs(payload: Record<string, unknown>): number {
  return typeof payload.imageDataUrl === 'string' && payload.imageDataUrl.length > 0
    ? 30000
    : 8000
}

export function routeTimeoutErrorCode(route: PlatformMessageRoute): DiagnosticErrorCode {
  return route === 'iframe' ? 'iframe-result-timeout' : 'official-tab-unavailable'
}

export function createPlatformCommunication(
  dependencies: PlatformCommunicationDependencies,
): PlatformCommunication {
  let requestSequence = 0
  const ready = Object.fromEntries(
    dependencies.platforms.map((platform) => [platform, false]),
  ) as Record<AIPlatform, boolean>
  const readyWaiters = {} as Record<AIPlatform, Array<(value: boolean) => void>>
  for (const platform of dependencies.platforms) readyWaiters[platform] = []

  dependencies.messageHost.addEventListener('message', (event) => {
    const data = event.data as {
      source?: string
      event?: string
      platform?: AIPlatform
      action?: string
      ok?: boolean
      error?: string
    } | undefined
    if (data?.source !== 'aichatroom-content') return

    if (
      data.platform
      && dependencies.platforms.includes(data.platform)
      && event.source === dependencies.getFrame(data.platform).contentWindow
      && data.event === 'command-bridge-ready'
    ) {
      ready[data.platform] = true
      const waiters = readyWaiters[data.platform]
      readyWaiters[data.platform] = []
      for (const waiter of waiters) waiter(true)
      console.log('[AIChatRoom chat] ready:', data.platform)
    }
  })

  function markNotReady(platform: AIPlatform): void {
    ready[platform] = false
  }

  function waitUntilReady(platform: AIPlatform, timeoutMs = 5000): Promise<boolean> {
    if (ready[platform]) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        const index = readyWaiters[platform].indexOf(finish)
        if (index >= 0) readyWaiters[platform].splice(index, 1)
        resolve(value)
      }
      const timeoutId = setTimeout(() => finish(ready[platform]), timeoutMs)
      readyWaiters[platform].push(finish)
    })
  }

  function postToIframe(
    platform: AIPlatform,
    command: PlatformCommand,
    payload: Record<string, unknown>,
    requestId: string,
  ): boolean {
    const target = dependencies.getFrame(platform).contentWindow
    if (!target) return false
    target.postMessage(
      { source: 'aichatroom-parent', platform, command, payload, requestId },
      dependencies.getPlatformOrigin(platform),
    )
    return true
  }

  function waitForReply<T>(
    platform: AIPlatform,
    command: PlatformCommand,
    timeoutMs: number,
    matches: (
      event: MessageEvent,
      data: Record<string, unknown>,
      requestId: string,
    ) => boolean,
    read: (data: Record<string, unknown>) => T,
    fallback: T,
    timeoutOperation?: string,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    const target = dependencies.getFrame(platform).contentWindow
    if (!target) return Promise.resolve(fallback)
    const requestId = dependencies.createRequestId?.()
      ?? `${Date.now().toString(36)}-${(++requestSequence).toString(36)}`

    return new Promise((resolve) => {
      let settled = false
      const finish = (value: T) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        dependencies.messageHost.removeEventListener('message', onMessage)
        resolve(value)
      }
      const onMessage = (event: MessageEvent) => {
        const data = event.data as Record<string, unknown> | undefined
        if (!data || !matches(event, data, requestId)) return
        finish(read(data))
      }
      const timeoutId = setTimeout(() => {
        if (timeoutOperation) {
          dependencies.onTimeout?.({ platform, operation: timeoutOperation, timeoutMs })
        }
        finish(fallback)
      }, timeoutMs)
      dependencies.messageHost.addEventListener('message', onMessage)
      if (!postToIframe(platform, command, payload, requestId)) finish(fallback)
    })
  }

  function waitForCommandBridgeReply(
    platform: AIPlatform,
    command: PlatformCommand,
    timeoutMs: number,
    payload: Record<string, unknown> = {},
    timeoutOperation?: string,
  ): Promise<PlatformCommandResult | null> {
    return waitForReply(
      platform,
      command,
      timeoutMs,
      (event, data, requestId) => (
        event.source === dependencies.getFrame(platform).contentWindow
        && data.source === 'aichatroom-content'
        && data.event === 'command-result'
        && data.platform === platform
        && data.command === command
        && data.requestId === requestId
      ),
      (data) => data as PlatformCommandResult,
      null,
      timeoutOperation,
      payload,
    )
  }

  async function reestablishCommandBridge(platform: AIPlatform): Promise<boolean> {
    markNotReady(platform)
    try {
      await dependencies.ensureEmbedRules()
      dependencies.reload(platform)
      return waitUntilReady(platform)
    } catch {
      return false
    }
  }

  async function requestReadOnlyCommandBridge(
    platform: AIPlatform,
    command: PlatformCommand,
    timeoutMs: number,
    timeoutOperation: string,
  ): Promise<PlatformCommandResult | null> {
    const firstResult = await waitForCommandBridgeReply(
      platform,
      command,
      timeoutMs,
      {},
      timeoutOperation,
    )
    if (firstResult) return firstResult
    if (!await reestablishCommandBridge(platform)) return null
    return waitForCommandBridgeReply(
      platform,
      command,
      timeoutMs,
      {},
      timeoutOperation,
    )
  }

  function sendOfficialTabCommandWithTimeout<T>(
    platform: AIPlatform,
    command: PlatformCommand,
    timeoutMs: number,
    payload: Record<string, unknown> = {},
    timeoutOperation?: string,
  ): Promise<{ response: T | null; timedOut: boolean }> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (response: T | null, timedOut: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        resolve({ response, timedOut })
      }
      const timeoutId = setTimeout(() => {
        if (timeoutOperation) {
          dependencies.onTimeout?.({
            platform,
            operation: timeoutOperation,
            timeoutMs,
          })
        }
        finish(null, true)
      }, timeoutMs)
      Promise.resolve(dependencies.sendRuntimeMessage({
        type: OFFICIAL_TAB_COMMAND_MESSAGE_TYPE,
        platform,
        command,
        payload,
      })).then(
        (response) => finish((response ?? null) as T | null, false),
        () => finish(null, false),
      )
    })
  }

  async function requestReadOnlyOfficialTabCommand<T>(
    platform: AIPlatform,
    command: 'get-state' | 'get-last-response',
    timeoutMs: number,
    timeoutOperation: string,
  ): Promise<{ response: T | null; timedOut: boolean }> {
    const firstResult = await sendOfficialTabCommandWithTimeout<T>(
      platform,
      command,
      timeoutMs,
      {},
      timeoutOperation,
    )
    if (firstResult.response || !firstResult.timedOut) return firstResult
    return sendOfficialTabCommandWithTimeout<T>(
      platform,
      command,
      timeoutMs,
      {},
      timeoutOperation,
    )
  }

  async function prepare(platform: AIPlatform): Promise<boolean> {
    if (!dependencies.supportsEmbed(platform)) return false
    if (await waitUntilReady(platform)) return true

    await dependencies.ensureEmbedRules()
    markNotReady(platform)
    dependencies.reload(platform)
    return waitUntilReady(platform)
  }

  async function writeAndSend(
    platform: AIPlatform,
    payload: PlatformWritePayload,
  ): Promise<PlatformSendResult> {
    const route = chooseRoute(platform, dependencies)
    if (route === 'official-tab') {
      const { response } = await sendOfficialTabCommandWithTimeout<{
        ok?: boolean
        error?: string
        diagnosticErrorCode?: DiagnosticErrorCode
      }>(
        platform,
        'write-and-send',
        iframeWriteResultTimeoutMs(payload),
        payload,
        'write-and-send',
      )
      return {
        platform,
        ok: !!response?.ok,
        error: response?.error,
        diagnosticErrorCode: response?.diagnosticErrorCode
          ?? (!response ? routeTimeoutErrorCode(route) : undefined),
      }
    }

    const result = await waitForCommandBridgeReply(
      platform,
      'write-and-send',
      iframeWriteResultTimeoutMs(payload),
      payload,
    )
    if (!result) {
      return {
        platform,
        ok: false,
        diagnosticErrorCode: routeTimeoutErrorCode(route),
      }
    }
    return {
      platform,
      ok: result.ok,
      error: result.ok ? undefined : result.error,
    }
  }

  async function readLastResponse(
    platform: AIPlatform,
    timeoutMs = 3000,
  ): Promise<ResponseReadResult> {
    const route = chooseRoute(platform, dependencies)
    let result: PlatformCommandResult | null
    let timedOut = false
    if (route === 'official-tab') {
      const response = await requestReadOnlyOfficialTabCommand<PlatformCommandResult>(
        platform,
        'get-last-response',
        timeoutMs,
        'request-last-response',
      )
      result = response.response
      timedOut = response.timedOut
    } else {
      result = await requestReadOnlyCommandBridge(
        platform,
        'get-last-response',
        timeoutMs,
        'request-last-response',
      )
    }
    if (!result) {
      return {
        text: '',
        error: route === 'official-tab'
          ? '官方标签页命令桥不可用，请刷新对应 AI 官网页面'
          : '命令桥通信超时，请刷新对应 AI 官网页面',
        requestTimedOut: route === 'official-tab' ? timedOut || undefined : true,
        diagnosticErrorCode: routeTimeoutErrorCode(route),
      }
    }
    if (!result.ok) {
      return {
        text: '',
        error: result.error,
        diagnosticErrorCode: result.diagnosticErrorCode,
      }
    }
    return typeof result.data === 'string'
      ? { text: result.data }
      : { text: '', error: '命令桥返回了无效的回答结果' }
  }

  async function readConversationState(
    platform: AIPlatform,
    timeoutMs = 3000,
  ): Promise<ConversationStateResult> {
    const route = chooseRoute(platform, dependencies)
    let result: PlatformCommandResult | null
    let timedOut = false
    if (route === 'official-tab') {
      const response = await requestReadOnlyOfficialTabCommand<PlatformCommandResult>(
        platform,
        'get-state',
        timeoutMs,
        'request-conversation-state',
      )
      result = response.response
      timedOut = response.timedOut
    } else {
      result = await requestReadOnlyCommandBridge(
        platform,
        'get-state',
        timeoutMs,
        'request-conversation-state',
      )
    }
    if (!result) {
      return {
        status: 'error',
        errorMessage: route === 'official-tab'
          ? '官方标签页命令桥不可用，请刷新对应 AI 官网页面'
          : '命令桥通信超时，请刷新对应 AI 官网页面',
        requestTimedOut: route === 'official-tab' ? timedOut || undefined : true,
        diagnosticErrorCode: routeTimeoutErrorCode(route),
      }
    }
    if (!result.ok) {
      return {
        status: 'error',
        errorMessage: result.error,
        diagnosticErrorCode: result.diagnosticErrorCode,
      }
    }
    return typeof result.data === 'object' && result.data !== null
      ? result.data as ConversationState
      : {
          status: 'error',
          errorMessage: '命令桥返回了无效的状态结果',
        }
  }

  async function readConversationUrl(platform: AIPlatform, timeoutMs = 1500): Promise<string> {
    if (chooseRoute(platform, dependencies) === 'official-tab') {
      const { response: result } = await sendOfficialTabCommandWithTimeout<PlatformCommandResult>(
        platform,
        'get-conversation-url',
        timeoutMs,
      )
      return result?.ok && typeof result.data === 'string' ? result.data : ''
    }
    const result = await waitForCommandBridgeReply(
      platform,
      'get-conversation-url',
      timeoutMs,
    )
    return result?.ok && typeof result.data === 'string' ? result.data : ''
  }

  return {
    markNotReady,
    routeFor: (platform) => chooseRoute(platform, dependencies),
    prepare,
    writeAndSend,
    readLastResponse,
    readConversationState,
    readConversationUrl,
  }
}
