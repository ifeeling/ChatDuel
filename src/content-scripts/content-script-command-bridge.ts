import type { AIAdapter } from '../adapters/base'
import { createAdapterDiagnostics } from '../lib/diagnostic-client'
import {
  OFFICIAL_TAB_COMMAND_MESSAGE_TYPE,
  type PlatformCommandResult,
} from '../shared/messages'
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
  context: { command: string; payload: Readonly<Record<string, unknown>> },
) => ContentScriptCommandExtensionResult | Promise<ContentScriptCommandExtensionResult>

export interface InstallContentScriptCommandBridgeOptions {
  platform: AIPlatform
  adapter: AIAdapter
  selectorConfigVersion: string
  extensionHandler?: ContentScriptCommandExtensionHandler
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function successResult(
  platform: AIPlatform,
  command: string,
  data: unknown,
): PlatformCommandResult {
  return {
    platform,
    command,
    ok: true,
    data,
  }
}

function decodeImage(
  payload: Readonly<Record<string, unknown>>,
  environment: ContentScriptCommandBridgeEnvironment,
): File | undefined {
  if (typeof payload.imageDataUrl !== 'string' || !payload.imageDataUrl) return undefined
  const separatorIndex = payload.imageDataUrl.indexOf(',')
  const base64 = separatorIndex >= 0
    ? payload.imageDataUrl.slice(separatorIndex + 1)
    : payload.imageDataUrl
  let bytes: Uint8Array
  try {
    if (!base64) throw new Error('empty image data')
    bytes = environment.decodeBase64(base64)
    if (bytes.byteLength === 0) throw new Error('empty decoded image')
  } catch {
    throw new Error('图片数据无法解码')
  }
  const mime = typeof payload.imageMime === 'string' && payload.imageMime
    ? payload.imageMime
    : 'image/png'
  const name = typeof payload.imageName === 'string' && payload.imageName
    ? payload.imageName
    : 'image.png'
  const fileBytes = new Uint8Array(bytes.byteLength)
  fileBytes.set(bytes)
  return environment.createFile([fileBytes.buffer], name, { type: mime })
}

async function executeCommand(
  command: string,
  payload: Readonly<Record<string, unknown>>,
  options: InstallContentScriptCommandBridgeOptions,
  environment: ContentScriptCommandBridgeEnvironment,
): Promise<PlatformCommandResult | null> {
  try {
    const extensionResult = await options.extensionHandler?.({ command, payload })
    if (extensionResult?.handled) {
      return successResult(options.platform, command, extensionResult.data)
    }
    if (command === 'write-and-send') {
      await options.adapter.sendMessage(
        typeof payload.text === 'string' ? payload.text : '',
        decodeImage(payload, environment),
        createAdapterDiagnostics(
          options.platform,
          payload.diagnostics,
          options.selectorConfigVersion,
        ),
      )
      return successResult(options.platform, command, undefined)
    }
    if (command === 'get-state') {
      return successResult(
        options.platform,
        command,
        await options.adapter.getConversationState(),
      )
    }
    if (command === 'get-last-response') {
      return successResult(
        options.platform,
        command,
        await options.adapter.getLastResponse(),
      )
    }
    if (command === 'get-conversation-url') {
      return successResult(options.platform, command, environment.location.href)
    }
    if (command === 'ping') {
      // 只证明命令桥（content-script + 消息通道）本身活着，不碰 adapter，
      // 所以哪怕 adapter 的异步操作卡住，ping 仍然能立刻应答。
      return successResult(options.platform, command, { alive: true })
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
      || typeof event.data.command !== 'string'
      || typeof event.data.requestId !== 'string'
    ) {
      return
    }

    const command = event.data.command
    const requestId = event.data.requestId
    const payload = isRecord(event.data.payload) ? event.data.payload : {}
    void executeCommand(command, payload, options, environment).then((result) => {
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
    if (!isRecord(message) || message.type !== OFFICIAL_TAB_COMMAND_MESSAGE_TYPE) return false
    const command = typeof message.command === 'string' ? message.command : ''
    const payload = isRecord(message.payload) ? message.payload : {}
    void executeCommand(command, payload, options, environment).then((result) => {
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

  return () => {
    if (isEmbedded) {
      environment.window.removeEventListener('message', onIframeMessage)
    }
    environment.runtime.onMessage.removeListener(onRuntimeMessage)
  }
}
