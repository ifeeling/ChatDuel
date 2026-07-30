import type { AIPlatform, ConversationState } from '../types'
import type { DiagnosticContext, DiagnosticErrorCode } from '../lib/diagnostic-types'

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

export interface PlatformWritePayload extends Record<string, unknown> {
  text: string
  imageDataUrl?: string
  imageMime?: string
  imageName?: string
  diagnostics?: DiagnosticContext
}

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
  usesCommandBridge?(platform: AIPlatform): boolean
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

type OfficialTabCommand =
  | 'write-and-send'
  | 'get-state'
  | 'get-last-response'
  | 'get-conversation-url'

type CommandBridgeResult =
  | {
      platform: AIPlatform
      command: string
      ok: true
      data: unknown
    }
  | {
      platform: AIPlatform
      command: string
      ok: false
      error: string
      diagnosticErrorCode?: DiagnosticErrorCode
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
      && data.event === (
        dependencies.usesCommandBridge?.(data.platform)
          ? 'command-bridge-ready'
          : 'ready'
      )
    ) {
      ready[data.platform] = true
      const waiters = readyWaiters[data.platform]
      readyWaiters[data.platform] = []
      for (const waiter of waiters) waiter(true)
      console.log('[AIChatRoom chat] ready:', data.platform)
    }

    if (data.event === 'result' && data.action === 'write-and-send') {
      console.log(`[AIChatRoom chat] write-and-send result for ${data.platform}: ok=${data.ok} error=${data.error ?? ''}`)
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
    action: string,
    payload: Record<string, unknown> = {},
  ): boolean {
    const target = dependencies.getFrame(platform).contentWindow
    if (!target) return false
    target.postMessage(
      { source: 'aichatroom-parent', action, ...payload },
      dependencies.getPlatformOrigin(platform),
    )
    return true
  }

  function waitForReply<T>(
    platform: AIPlatform,
    action: string,
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
      if (!postToIframe(platform, action, { ...payload, requestId })) finish(fallback)
    })
  }

  function waitForCommandBridgeReply(
    platform: AIPlatform,
    command: string,
    timeoutMs: number,
    payload: Record<string, unknown> = {},
    timeoutOperation?: string,
  ): Promise<CommandBridgeResult | null> {
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
      (data) => data as CommandBridgeResult,
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
    command: string,
    timeoutMs: number,
    timeoutOperation: string,
  ): Promise<CommandBridgeResult | null> {
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

  async function sendOfficialTabCommand<T = unknown>(
    platform: AIPlatform,
    command: OfficialTabCommand,
    payload: Record<string, unknown> = {},
  ): Promise<T | null> {
    try {
      const response = await dependencies.sendRuntimeMessage({
        type: 'official-tab-command',
        platform,
        command,
        ...payload,
      })
      return (response ?? null) as T | null
    } catch {
      return null
    }
  }

  function sendOfficialTabCommandWithTimeout<T>(
    platform: AIPlatform,
    command: OfficialTabCommand,
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
        type: 'official-tab-command',
        platform,
        command,
        ...payload,
      })).then(
        (response) => finish((response ?? null) as T | null, false),
        () => finish(null, false),
      )
    })
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
      const response = dependencies.usesCommandBridge?.(platform)
        ? (await sendOfficialTabCommandWithTimeout<{
            ok?: boolean
            error?: string
            diagnosticErrorCode?: DiagnosticErrorCode
          }>(
            platform,
            'write-and-send',
            iframeWriteResultTimeoutMs(payload),
            payload,
            'write-and-send',
          )).response
        : await sendOfficialTabCommand<{
            ok?: boolean
            error?: string
            diagnosticErrorCode?: DiagnosticErrorCode
          }>(platform, 'write-and-send', payload)
      return {
        platform,
        ok: !!response?.ok,
        error: response?.error,
        diagnosticErrorCode: response?.diagnosticErrorCode
          ?? (!response ? routeTimeoutErrorCode(route) : undefined),
      }
    }

    if (dependencies.usesCommandBridge?.(platform)) {
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

    return waitForReply<PlatformSendResult>(
      platform,
      'write-and-send',
      iframeWriteResultTimeoutMs(payload),
      (event, data) => (
        event.source === dependencies.getFrame(platform).contentWindow
        && data.source === 'aichatroom-content'
        && data.event === 'result'
        && data.action === 'write-and-send'
        && data.platform === platform
      ),
      (data) => ({
        platform,
        ok: data.ok === true,
        error: typeof data.error === 'string' ? data.error : undefined,
      }),
      {
        platform,
        ok: false,
        diagnosticErrorCode: routeTimeoutErrorCode(route),
      },
      undefined,
      payload,
    )
  }

  async function readLastResponse(
    platform: AIPlatform,
    timeoutMs = 3000,
  ): Promise<ResponseReadResult> {
    if (chooseRoute(platform, dependencies) === 'official-tab') {
      if (dependencies.usesCommandBridge?.(platform)) {
        const { response: result, timedOut } = await sendOfficialTabCommandWithTimeout<CommandBridgeResult>(
          platform,
          'get-last-response',
          timeoutMs,
          {},
          'request-last-response',
        )
        if (!result) {
          return {
            text: '',
            error: '官方标签页命令桥不可用，请刷新对应 AI 官网页面',
            requestTimedOut: timedOut || undefined,
            diagnosticErrorCode: routeTimeoutErrorCode('official-tab'),
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
      const response = await sendOfficialTabCommand<{
        text?: string
        diagnosticErrorCode?: DiagnosticErrorCode
      }>(platform, 'get-last-response')
      return {
        text: response?.text ?? '',
        diagnosticErrorCode: response?.diagnosticErrorCode,
      }
    }

    if (dependencies.usesCommandBridge?.(platform)) {
      const result = await requestReadOnlyCommandBridge(
        platform,
        'get-last-response',
        timeoutMs,
        'request-last-response',
      )
      if (!result) {
        return {
          text: '',
          error: '命令桥通信超时，请刷新对应 AI 官网页面',
          requestTimedOut: true,
          diagnosticErrorCode: routeTimeoutErrorCode('iframe'),
        }
      }
      if (!result.ok) {
        return {
          text: '',
          error: result.error,
          diagnosticErrorCode: result.diagnosticErrorCode,
        }
      }
      if (typeof result.data !== 'string') {
        return {
          text: '',
          error: '命令桥返回了无效的回答结果',
        }
      }
      return { text: result.data }
    }

    return waitForReply<ResponseReadResult>(
      platform,
      'get-last-response',
      timeoutMs,
      (event, data) => (
        event.source === dependencies.getFrame(platform).contentWindow
        && data.source === 'aichatroom-content'
        && data.type === 'last-response'
        && data.platform === platform
      ),
      (data) => ({ text: typeof data.text === 'string' ? data.text : '' }),
      { text: '' },
      'request-last-response',
    )
  }

  async function readConversationState(
    platform: AIPlatform,
    timeoutMs = 3000,
  ): Promise<ConversationStateResult> {
    if (chooseRoute(platform, dependencies) === 'official-tab') {
      if (dependencies.usesCommandBridge?.(platform)) {
        const { response: result, timedOut } = await sendOfficialTabCommandWithTimeout<CommandBridgeResult>(
          platform,
          'get-state',
          timeoutMs,
          {},
          'request-conversation-state',
        )
        if (!result) {
          return {
            status: 'error',
            errorMessage: '官方标签页命令桥不可用，请刷新对应 AI 官网页面',
            requestTimedOut: timedOut || undefined,
            diagnosticErrorCode: routeTimeoutErrorCode('official-tab'),
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
      const response = await sendOfficialTabCommand<{
        state?: ConversationState
        ok?: boolean
        error?: string
        diagnosticErrorCode?: DiagnosticErrorCode
      }>(platform, 'get-state')
      if (response?.ok === false) {
        return {
          status: 'error',
          errorMessage: response.error ?? '官方标签页不可用',
          diagnosticErrorCode: response.diagnosticErrorCode,
        }
      }
      return response?.state ?? { status: 'idle', requestTimedOut: true }
    }

    if (dependencies.usesCommandBridge?.(platform)) {
      const result = await requestReadOnlyCommandBridge(
        platform,
        'get-state',
        timeoutMs,
        'request-conversation-state',
      )
      if (!result) {
        return {
          status: 'error',
          errorMessage: '命令桥通信超时，请刷新对应 AI 官网页面',
          requestTimedOut: true,
          diagnosticErrorCode: routeTimeoutErrorCode('iframe'),
        }
      }
      if (!result.ok) {
        return {
          status: 'error',
          errorMessage: result.error,
          diagnosticErrorCode: result.diagnosticErrorCode,
        }
      }
      if (typeof result.data !== 'object' || result.data === null) {
        return {
          status: 'error',
          errorMessage: '命令桥返回了无效的状态结果',
        }
      }
      return result.data as ConversationState
    }

    return waitForReply<ConversationStateResult>(
      platform,
      'get-state',
      timeoutMs,
      (event, data) => (
        event.source === dependencies.getFrame(platform).contentWindow
        && data.source === 'aichatroom-content'
        && data.type === 'state'
        && data.platform === platform
        && typeof data.state === 'object'
        && data.state !== null
      ),
      (data) => data.state as ConversationState,
      { status: 'idle', requestTimedOut: true },
      'request-conversation-state',
    )
  }

  async function readConversationUrl(platform: AIPlatform, timeoutMs = 1500): Promise<string> {
    if (dependencies.usesCommandBridge?.(platform)) {
      if (chooseRoute(platform, dependencies) === 'official-tab') {
        const { response: result } = await sendOfficialTabCommandWithTimeout<CommandBridgeResult>(
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
    const isDeepSeek = platform === 'deepseek'
    return waitForReply(
      platform,
      isDeepSeek ? 'get-conversation-id' : 'get-location',
      timeoutMs,
      (event, data) => (
        event.source === dependencies.getFrame(platform).contentWindow
        && data.source === 'aichatroom-content'
        && data.type === (isDeepSeek ? 'conversation-id' : 'location')
        && data.platform === platform
      ),
      (data) => {
        const value = isDeepSeek ? data.url : data.href
        return typeof value === 'string' ? value : ''
      },
      '',
    )
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
