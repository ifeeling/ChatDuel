import type { AIAdapter } from '../adapters/base'
import { createAdapterDiagnostics } from '../lib/diagnostic-client'
import type { AIPlatform } from '../types'

export interface ContentScriptMessageTarget {
  postMessage(message: unknown, options: WindowPostMessageOptions): void
}

export interface ContentScriptWindow extends ContentScriptMessageTarget {
  readonly parent: ContentScriptMessageTarget
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

export type ContentScriptRuntimeMessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | void

export interface ContentScriptRuntime {
  onMessage: {
    addListener(listener: ContentScriptRuntimeMessageListener): void
    removeListener(listener: ContentScriptRuntimeMessageListener): void
  }
  sendMessage(message: unknown): Promise<unknown> | void
}

export interface ContentScriptCommandBridgeEnvironment {
  window: ContentScriptWindow
  runtime: ContentScriptRuntime
  location: Pick<Location, 'href'>
  extensionOrigin: string
  decodeBase64(value: string): Uint8Array
  createFile(parts: BlobPart[], name: string, options: FilePropertyBag): File
}

export interface ContentScriptCommandExtensionResult {
  handled: boolean
  data?: unknown
}

export type ContentScriptCommandExtensionHandler = (
  context: { command: string; request: Readonly<Record<string, unknown>> },
) => ContentScriptCommandExtensionResult | Promise<ContentScriptCommandExtensionResult>

export interface InstallContentScriptCommandBridgeOptions {
  platform: AIPlatform
  adapter: AIAdapter
  selectorConfigVersion: string
  extensionHandler?: ContentScriptCommandExtensionHandler
}

export type ContentScriptCommandResult =
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
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function decodeImage(
  request: Readonly<Record<string, unknown>>,
  environment: ContentScriptCommandBridgeEnvironment,
): File | undefined {
  if (typeof request.imageDataUrl !== 'string' || !request.imageDataUrl) return undefined
  const separatorIndex = request.imageDataUrl.indexOf(',')
  const base64 = separatorIndex >= 0
    ? request.imageDataUrl.slice(separatorIndex + 1)
    : request.imageDataUrl
  let bytes: Uint8Array
  try {
    if (!base64) throw new Error('empty image data')
    bytes = environment.decodeBase64(base64)
    if (bytes.byteLength === 0) throw new Error('empty decoded image')
  } catch {
    throw new Error('图片数据无法解码')
  }
  const mime = typeof request.imageMime === 'string' && request.imageMime
    ? request.imageMime
    : 'image/png'
  const name = typeof request.imageName === 'string' && request.imageName
    ? request.imageName
    : 'image.png'
  const fileBytes = new Uint8Array(bytes.byteLength)
  fileBytes.set(bytes)
  return environment.createFile([fileBytes.buffer], name, { type: mime })
}

async function executeCommand(
  command: string,
  request: Readonly<Record<string, unknown>>,
  options: InstallContentScriptCommandBridgeOptions,
  environment: ContentScriptCommandBridgeEnvironment,
): Promise<ContentScriptCommandResult | null> {
  try {
    const extensionResult = await options.extensionHandler?.({ command, request })
    if (extensionResult?.handled) {
      return {
        platform: options.platform,
        command,
        ok: true,
        data: extensionResult.data,
      }
    }
    if (command === 'write-and-send') {
      await options.adapter.sendMessage(
        typeof request.text === 'string' ? request.text : '',
        decodeImage(request, environment),
        createAdapterDiagnostics(
          options.platform,
          request.diagnostics,
          options.selectorConfigVersion,
        ),
      )
      return {
        platform: options.platform,
        command,
        ok: true,
        data: undefined,
      }
    }
    if (command === 'get-state') {
      return {
        platform: options.platform,
        command,
        ok: true,
        data: await options.adapter.getConversationState(),
      }
    }
    if (command === 'get-last-response') {
      return {
        platform: options.platform,
        command,
        ok: true,
        data: await options.adapter.getLastResponse(),
      }
    }
    if (command === 'get-conversation-url') {
      return {
        platform: options.platform,
        command,
        ok: true,
        data: environment.location.href,
      }
    }
    return null
  } catch (error) {
    return {
      platform: options.platform,
      command,
      ok: false,
      error: errorMessage(error),
    }
  }
}

function createBrowserEnvironment(): ContentScriptCommandBridgeEnvironment {
  return {
    window,
    runtime: chrome.runtime,
    location,
    extensionOrigin: new URL(chrome.runtime.getURL('/')).origin,
    decodeBase64(value) {
      const binary = atob(value)
      return Uint8Array.from(binary, character => character.charCodeAt(0))
    },
    createFile(parts, name, options) {
      return new File(parts, name, options)
    },
  }
}

export function installContentScriptCommandBridge(
  options: InstallContentScriptCommandBridgeOptions,
  environment: ContentScriptCommandBridgeEnvironment = createBrowserEnvironment(),
): () => void {
  const isEmbedded = environment.window.parent !== environment.window
  const onIframeMessage = (event: MessageEvent): void => {
    if (
      event.source !== environment.window.parent
      || event.origin !== environment.extensionOrigin
      || !isRecord(event.data)
      || event.data.source !== 'aichatroom-parent'
      || typeof event.data.action !== 'string'
      || typeof event.data.requestId !== 'string'
    ) {
      return
    }

    const command = event.data.action
    const requestId = event.data.requestId
    void executeCommand(command, event.data, options, environment).then((result) => {
      if (!result) return
      environment.window.parent.postMessage({
        source: 'aichatroom-content',
        event: 'command-result',
        ...result,
        requestId,
      }, { targetOrigin: environment.extensionOrigin })
    })
  }
  const onRuntimeMessage: ContentScriptRuntimeMessageListener = (message, _sender, sendResponse) => {
    if (!isRecord(message) || typeof message.type !== 'string') return false
    const command = message.type
    void executeCommand(command, message, options, environment).then((result) => {
      sendResponse(result ?? {
        platform: options.platform,
        command,
        ok: false,
        error: `不支持的命令：${command}`,
      })
    })
    return true
  }

  if (isEmbedded) {
    environment.window.addEventListener('message', onIframeMessage)
    environment.window.parent.postMessage({
      source: 'aichatroom-content',
      event: 'command-bridge-ready',
      platform: options.platform,
    }, { targetOrigin: environment.extensionOrigin })
  }
  environment.runtime.onMessage.addListener(onRuntimeMessage)

  const unsubscribeFromStreamEvents = options.adapter.onStreamEvent((event) => {
    try {
      void Promise.resolve(environment.runtime.sendMessage({
        type: 'stream-event',
        event,
      })).catch(() => {})
    } catch {
      // 扩展更新会让 runtime 暂时失效，事件转发不能影响平台页面。
    }
  })

  return () => {
    if (isEmbedded) {
      environment.window.removeEventListener('message', onIframeMessage)
    }
    environment.runtime.onMessage.removeListener(onRuntimeMessage)
    unsubscribeFromStreamEvents()
  }
}
