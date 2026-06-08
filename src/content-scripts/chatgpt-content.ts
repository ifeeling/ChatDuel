import { createChatGPTAdapter } from '../adapters/chatgpt/adapter'
import type { SwToContent, ContentToSw } from '../shared/messages'
import type { AIPlatform } from '../types'
import { buildDataTransferFromFile, dispatchPaste, downloadImage, tryCopyImageToClipboard, MAX_IMAGE_BYTES, ImageTooLargeError } from '../lib/image-handler'

const adapter = createChatGPTAdapter()

async function dataUrlToFile(dataUrl: string, name = 'pasted'): Promise<File> {
  const res = await fetch(dataUrl)
  const blob = await res.blob()
  const ext = blob.type.split('/')[1] || 'png'
  return new File([blob], `${name}.${ext}`, { type: blob.type })
}

async function deliverImage(text: string, imageDataUrl: string): Promise<void> {
  const file = await dataUrlToFile(imageDataUrl)
  if (file.size > MAX_IMAGE_BYTES) {
    throw new ImageTooLargeError(file.size)
  }
  const box = document.querySelector<HTMLElement>('[contenteditable="true"], textarea')
  if (!box) {
    downloadImage(file, file.name)
    return
  }
  const dt = buildDataTransferFromFile(file)
  dispatchPaste(box, dt, 'paste')
  const copied = await tryCopyImageToClipboard(file)
  if (!copied) {
    downloadImage(file, file.name)
  }
}

adapter.onStreamEvent((event) => {
  const msg: ContentToSw = { type: 'stream-event', event }
  chrome.runtime.sendMessage(msg).catch(() => {/* popup may be closed */})
})

chrome.runtime.onMessage.addListener((msg: SwToContent, _sender, sendResponse) => {
  if (msg.type === 'write-and-send') {
    const p = msg.imageDataUrl
      ? deliverImage(msg.text, msg.imageDataUrl).then(() => adapter.sendMessage(msg.text))
      : adapter.sendMessage(msg.text)
    p
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }))
    return true
  }
  if (msg.type === 'get-state') {
    adapter.getConversationState()
      .then((state) => {
        const reply: ContentToSw = { type: 'state', platform: 'chatgpt' as AIPlatform, state }
        sendResponse(reply)
      })
    return true
  }
  if (msg.type === 'get-last-response') {
    adapter.getLastResponse()
      .then((text) => {
        const reply: ContentToSw = { type: 'last-response', text }
        sendResponse(reply)
      })
    return true
  }
  return false
})
