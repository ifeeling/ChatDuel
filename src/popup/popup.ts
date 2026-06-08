import type { AIPlatform, StreamStatus } from '../types'
import type { SwToPopup, PopupToSw } from '../shared/messages'
import { parseAtMentions } from '../lib/at-parser'
import { countWords, durationMs, ttftMs } from '../lib/stats'
import { buildDataTransferFromFile, MAX_IMAGE_BYTES, ImageTooLargeError } from '../lib/image-handler'
import { renderTemplate, getDefaultTemplates } from '../lib/prompt-template'

// ---------- DOM refs ----------
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!
const statusDot = (p: AIPlatform) => document.querySelector<HTMLSpanElement>(`.status-item[data-platform="${p}"] .dot`)!
const panelState = (p: AIPlatform) => document.querySelector<HTMLElement>(`.panel[data-platform="${p}"] .panel-state`)!
const messagesEl = (p: AIPlatform) => document.getElementById(`messages-${p}`) as HTMLDivElement
const inputEl = $<HTMLTextAreaElement>('#input')
const sendBtn = $<HTMLButtonElement>('#btn-send')
const quoteBtn = $<HTMLButtonElement>('#btn-quote')
const imageBtn = $<HTMLButtonElement>('#btn-image')
const btnC2G = $<HTMLButtonElement>('#btn-transfer-c2g')
const btnG2C = $<HTMLButtonElement>('#btn-transfer-g2c')
const btnSummary = $<HTMLButtonElement>('#btn-summary')

// ---------- State ----------
interface UIState {
  status: Record<AIPlatform, StreamStatus>
  lastResponses: Record<AIPlatform, string>
  hasUserMessage: boolean
  placeholder: Record<AIPlatform, HTMLDivElement | null>
  streamStartTime: Record<AIPlatform, number | undefined>
  firstTokenTime: Record<AIPlatform, number | undefined>
  lastPrompt: string
}
const state: UIState = {
  status: { chatgpt: 'idle', gemini: 'idle' },
  lastResponses: { chatgpt: '', gemini: '' },
  hasUserMessage: false,
  placeholder: { chatgpt: null, gemini: null },
  streamStartTime: { chatgpt: undefined, gemini: undefined },
  firstTokenTime: { chatgpt: undefined, gemini: undefined },
  lastPrompt: '',
}

// Pending image attached to the next send (popup-only state)
let pendingImage: File | null = null

// ---------- Render ----------
function setPlatformStatus(p: AIPlatform, s: StreamStatus) {
  state.status[p] = s
  const el = panelState(p)
  el.className = 'panel-state'
  if (s === 'streaming' || s === 'sending') {
    el.classList.add('streaming')
    el.textContent = '回答中...'
  } else if (s === 'finished') {
    el.classList.add('finished')
    el.textContent = '已回答'
  } else if (s === 'error') {
    el.classList.add('error')
    el.textContent = '出错'
  } else {
    el.textContent = '空闲'
  }

  const dot = statusDot(p)
  dot.classList.remove('ok', 'err')
  if (s === 'finished') dot.classList.add('ok')
  if (s === 'error') dot.classList.add('err')
}

function addBubble(p: AIPlatform, text: string, kind: 'user' | 'ai' | 'placeholder'): HTMLDivElement {
  const div = document.createElement('div')
  div.className = `bubble ${kind}`
  div.textContent = text
  messagesEl(p).appendChild(div)
  messagesEl(p).scrollTop = messagesEl(p).scrollHeight
  return div
}

function flashPanel(p: AIPlatform) {
  const panel = document.querySelector<HTMLElement>(`.panel[data-platform="${p}"]`)!
  panel.classList.remove('flash')
  void panel.offsetWidth
  panel.classList.add('flash')
}

// ---------- Messages to SW ----------
function sendToSw<T = unknown>(msg: PopupToSw): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
      else resolve(response as T)
    })
  })
}

// ---------- Listen for SW pushes ----------
chrome.runtime.onMessage.addListener((msg: SwToPopup) => {
  if (msg.type === 'stream-event') {
    const e = msg.event
    if (e.type === 'started') {
      if (state.firstTokenTime[e.platform] === undefined && state.streamStartTime[e.platform] !== undefined) {
        state.firstTokenTime[e.platform] = Date.now()
      }
      setPlatformStatus(e.platform, 'streaming')
    } else if (e.type === 'token') {
      if (state.firstTokenTime[e.platform] === undefined && state.streamStartTime[e.platform] !== undefined) {
        state.firstTokenTime[e.platform] = Date.now()
      }
      const ph = state.placeholder[e.platform]
      if (ph) {
        ph.className = 'bubble ai'
        ph.textContent = e.text
        messagesEl(e.platform).scrollTop = messagesEl(e.platform).scrollHeight
      } else {
        addBubble(e.platform, e.text, 'ai')
      }
      setPlatformStatus(e.platform, 'streaming')
    } else if (e.type === 'finished') {
      const ph = state.placeholder[e.platform]
      if (ph) ph.remove()
      state.placeholder[e.platform] = null
      addBubble(e.platform, e.text, 'ai')
      state.lastResponses[e.platform] = e.text
      setPlatformStatus(e.platform, 'finished')

      const start = state.streamStartTime[e.platform] ?? Date.now()
      const ft = state.firstTokenTime[e.platform] ?? start
      const wc = countWords(e.text)
      const dur = durationMs(start)
      const ttft = ttftMs(start, ft)
      const statsDiv = document.createElement('div')
      statsDiv.className = 'stats'
      statsDiv.textContent = `${wc} 字 · ${(dur / 1000).toFixed(1)} 秒 · 首次 Token ${(ttft / 1000).toFixed(1)} 秒`
      messagesEl(e.platform).appendChild(statsDiv)
      messagesEl(e.platform).scrollTop = messagesEl(e.platform).scrollHeight

      if (state.status.chatgpt === 'finished' && state.status.gemini === 'finished') {
        flashPanel('chatgpt')
        flashPanel('gemini')
      }
      updateQuoteButton()
      updateTransferButtons()
      updateSummaryButton()
    } else if (e.type === 'paused') {
      setPlatformStatus(e.platform, 'paused')
    } else if (e.type === 'error') {
      setPlatformStatus(e.platform, 'error')
    } else if (e.type === 'rate-limit') {
      setPlatformStatus(e.platform, 'error')
      addBubble(e.platform, `⚠️ 限流：${e.message}`, 'placeholder')
    }
  }
})

// ---------- Boot ----------
window.addEventListener('DOMContentLoaded', () => {
  console.log('[AIChatRoom popup] ready')
  sendBtn.addEventListener('click', onSend)
  quoteBtn.addEventListener('click', onQuote)
  btnC2G.addEventListener('click', () => transferResponse('chatgpt', 'gemini'))
  btnG2C.addEventListener('click', () => transferResponse('gemini', 'chatgpt'))
  btnSummary.addEventListener('click', onSummary)
  inputEl.addEventListener('input', () => {
    state.hasUserMessage = inputEl.value.trim().length > 0
  })
  inputEl.addEventListener('paste', onPasteImage)
  inputEl.addEventListener('drop', onDropImage)
  imageBtn.addEventListener('click', () => {
    alert('直接 Ctrl+V 粘贴图片，或拖拽图片到输入框')
  })
  updateQuoteButton()
  updateTransferButtons()
})

// ---------- Quote ----------
function updateQuoteButton() {
  const hasResponse = !!(state.lastResponses.chatgpt || state.lastResponses.gemini)
  quoteBtn.disabled = !hasResponse
}

function onQuote() {
  const source: AIPlatform | null = state.lastResponses.chatgpt
    ? 'chatgpt'
    : (state.lastResponses.gemini ? 'gemini' : null)
  if (!source) return
  const text = state.lastResponses[source]
  const name = source === 'chatgpt' ? 'ChatGPT' : 'Gemini'
  const insertion = `[引用 ${name} 的上一条回答]：\n${text}\n\n`
  const start = inputEl.selectionStart ?? inputEl.value.length
  const end = inputEl.selectionEnd ?? inputEl.value.length
  inputEl.value = inputEl.value.slice(0, start) + insertion + inputEl.value.slice(end)
  const newPos = start + insertion.length
  inputEl.setSelectionRange(newPos, newPos)
  inputEl.focus()
}

// ---------- Transfer ----------
function updateTransferButtons() {
  btnC2G.disabled = !state.lastResponses.chatgpt
  btnG2C.disabled = !state.lastResponses.gemini
}

function transferResponse(from: AIPlatform, to: AIPlatform) {
  const sourceText = state.lastResponses[from]
  if (!sourceText) return
  const wrapped = renderTemplate(getDefaultTemplates().review, { response: sourceText })
  sendToSinglePlatform(to, wrapped)
}

// ---------- Summary ----------
const SUMMARY_CHAR_LIMIT = 3000

function updateSummaryButton() {
  btnSummary.disabled = !(state.lastResponses.chatgpt && state.lastResponses.gemini)
}

function onSummary() {
  const a = state.lastResponses.chatgpt
  const b = state.lastResponses.gemini
  if (!a || !b) {
    alert('需要两边都有回答才能做对比总结')
    return
  }
  const tpl = getDefaultTemplates().summary
  const fullTpl = renderTemplate(tpl, { responseA: a, responseB: b })
  let prompt = fullTpl
  if (fullTpl.length > SUMMARY_CHAR_LIMIT) {
    const halfLimit = Math.max(50, Math.floor((SUMMARY_CHAR_LIMIT - tpl.length) / 2) - 50)
    const truncatedA = a.length > halfLimit ? a.slice(0, halfLimit) + '\n\n[…回答过长已截断…]' : a
    const truncatedB = b.length > halfLimit ? b.slice(0, halfLimit) + '\n\n[…回答过长已截断…]' : b
    prompt = renderTemplate(tpl, { responseA: truncatedA, responseB: truncatedB })
    alert('⚠️ 对比总结输入超过 3000 字符，已截断')
  }
  sendToSinglePlatform('chatgpt', prompt)
}

function sendToSinglePlatform(target: AIPlatform, text: string) {
  const now = Date.now()
  addBubble(target, text, 'user')
  const placeholder = addBubble(target, '⏳ 等待回应...', 'placeholder')
  state.placeholder[target] = placeholder
  state.streamStartTime[target] = now
  state.firstTokenTime[target] = undefined
  setPlatformStatus(target, 'queued')
  void sendToSw({ type: 'send-message', platforms: [target], text })
}

// ---------- Image input ----------
function onPasteImage(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) {
        e.preventDefault()
        acceptImage(file)
        return
      }
    }
  }
}

function onDropImage(e: DragEvent) {
  const files = e.dataTransfer?.files
  if (!files || files.length === 0) return
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    if (file.type.startsWith('image/')) {
      e.preventDefault()
      acceptImage(file)
      return
    }
  }
}

function acceptImage(file: File) {
  try {
    buildDataTransferFromFile(file)
    pendingImage = file
    imageBtn.textContent = '图片 ✓'
  } catch (err) {
    if (err instanceof ImageTooLargeError) {
      alert(`图片太大：${(file.size / 1024 / 1024).toFixed(1)}MB（上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB）`)
    } else {
      alert('图片处理失败')
    }
  }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

async function onSend() {
  const text = inputEl.value.trim()
  if (!text && !pendingImage) return
  const mentions = text ? parseAtMentions(text) : []
  const allPlatforms: AIPlatform[] = ['chatgpt', 'gemini']
  const targetPlatforms: AIPlatform[] = mentions.length > 0
    ? mentions.filter((m): m is AIPlatform => m === 'chatgpt' || m === 'gemini')
    : allPlatforms
  const platforms = targetPlatforms.length > 0 ? targetPlatforms : allPlatforms
  const now = Date.now()
  const userLabel = pendingImage
    ? `${text}${text ? '\n' : ''}[图片] ${pendingImage.name}`
    : text
  state.lastPrompt = userLabel
  for (const p of platforms) {
    addBubble(p, userLabel, 'user')
    const placeholder = addBubble(p, '⏳ 等待回应...', 'placeholder')
    state.placeholder[p] = placeholder
    state.streamStartTime[p] = now
    state.firstTokenTime[p] = undefined
    setPlatformStatus(p, 'queued')
  }
  inputEl.value = ''

  let imageDataUrl: string | undefined
  if (pendingImage) {
    try {
      imageDataUrl = await fileToDataUrl(pendingImage)
    } catch {
      alert('图片读取失败')
      pendingImage = null
      imageBtn.textContent = '图片'
      return
    }
  }
  pendingImage = null
  imageBtn.textContent = '图片'

  await sendToSw({ type: 'send-message', platforms, text, imageDataUrl })
}
