import type { AIPlatform, Session, StreamStatus } from '../types'
import type { SwToPopup, PopupToSw } from '../shared/messages'
import { parseAtMentions } from '../lib/at-parser'
import { countWords, durationMs, ttftMs } from '../lib/stats'
import { buildDataTransferFromFile, MAX_IMAGE_BYTES, ImageTooLargeError } from '../lib/image-handler'
import { renderTemplate, getDefaultTemplates } from '../lib/prompt-template'
import { diffResponses, type DiffChunk } from '../lib/diff'
import { addSession, loadSessions, deleteSession, MAX_SESSIONS } from '../lib/session-store'

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
const btnHistory = $<HTMLButtonElement>('#btn-history')

// ---------- State ----------
interface UIState {
  status: Record<AIPlatform, StreamStatus>
  lastResponses: Record<AIPlatform, string>
  hasUserMessage: boolean
  placeholder: Record<AIPlatform, HTMLDivElement | null>
  streamStartTime: Record<AIPlatform, number | undefined>
  firstTokenTime: Record<AIPlatform, number | undefined>
  lastPrompt: string
  lastAiBubble: Record<AIPlatform, HTMLDivElement | null>
  lastStats: Record<AIPlatform, HTMLDivElement | null>
}
const state: UIState = {
  status: { chatgpt: 'idle', gemini: 'idle' },
  lastResponses: { chatgpt: '', gemini: '' },
  hasUserMessage: false,
  placeholder: { chatgpt: null, gemini: null },
  streamStartTime: { chatgpt: undefined, gemini: undefined },
  firstTokenTime: { chatgpt: undefined, gemini: undefined },
  lastPrompt: '',
  lastAiBubble: { chatgpt: null, gemini: null },
  lastStats: { chatgpt: null, gemini: null },
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

function renderOrUpdateAiBubble(p: AIPlatform, text: string): void {
  const other: AIPlatform = p === 'chatgpt' ? 'gemini' : 'chatgpt'
  const otherText = state.lastResponses[other]

  let bubble: HTMLDivElement
  if (!otherText) {
    bubble = document.createElement('div')
    bubble.className = 'bubble ai'
    bubble.textContent = text
  } else {
    const aText = p === 'chatgpt' ? text : otherText
    const bText = p === 'chatgpt' ? otherText : text
    const chunks: DiffChunk[] = diffResponses(aText, bText)
    bubble = document.createElement('div')
    bubble.className = 'bubble ai'
    for (const chunk of chunks) {
      const span = document.createElement('span')
      if (p === 'chatgpt') {
        if (chunk.type === 'equal') {
          span.className = 'diff-equal'
          span.textContent = chunk.a
        } else if (chunk.type === 'added-on-a') {
          span.className = 'diff-added-on-a'
          span.textContent = chunk.a
        } else {
          span.className = 'diff-gap'
          span.textContent = '（对方未提到）'
        }
      } else {
        if (chunk.type === 'equal') {
          span.className = 'diff-equal'
          span.textContent = chunk.b
        } else if (chunk.type === 'added-on-b') {
          span.className = 'diff-added-on-b'
          span.textContent = chunk.b
        } else {
          span.className = 'diff-gap'
          span.textContent = '（对方未提到）'
        }
      }
      bubble.appendChild(span)
    }
  }

  const existing = state.lastAiBubble[p]
  if (existing && existing.parentNode) {
    existing.replaceWith(bubble)
  } else {
    messagesEl(p).appendChild(bubble)
  }
  state.lastAiBubble[p] = bubble
  messagesEl(p).scrollTop = messagesEl(p).scrollHeight
}

function renderOrUpdateStats(p: AIPlatform, text: string): void {
  const start = state.streamStartTime[p] ?? Date.now()
  const ft = state.firstTokenTime[p] ?? start
  const wc = countWords(text)
  const dur = durationMs(start)
  const ttft = ttftMs(start, ft)
  const statsDiv = document.createElement('div')
  statsDiv.className = 'stats'
  statsDiv.textContent = `${wc} 字 · ${(dur / 1000).toFixed(1)} 秒 · 首次 Token ${(ttft / 1000).toFixed(1)} 秒`

  const existing = state.lastStats[p]
  if (existing && existing.parentNode) {
    existing.replaceWith(statsDiv)
  } else {
    messagesEl(p).appendChild(statsDiv)
  }
  state.lastStats[p] = statsDiv
  messagesEl(p).scrollTop = messagesEl(p).scrollHeight
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
      state.lastResponses[e.platform] = e.text

      const bothDone = !!(state.lastResponses.chatgpt && state.lastResponses.gemini)
      if (bothDone) {
        const other: AIPlatform = e.platform === 'chatgpt' ? 'gemini' : 'chatgpt'
        renderOrUpdateAiBubble(e.platform, e.text)
        renderOrUpdateAiBubble(other, state.lastResponses[other])
        renderOrUpdateStats(e.platform, e.text)
        renderOrUpdateStats(other, state.lastResponses[other])
      } else {
        renderOrUpdateAiBubble(e.platform, e.text)
        renderOrUpdateStats(e.platform, e.text)
      }

      setPlatformStatus(e.platform, 'finished')

      if (state.status.chatgpt === 'finished' && state.status.gemini === 'finished') {
        flashPanel('chatgpt')
        flashPanel('gemini')
        void saveCurrentSession()
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
  btnHistory.addEventListener('click', () => void onHistory())
  inputEl.addEventListener('input', () => {
    state.hasUserMessage = inputEl.value.trim().length > 0
  })
  inputEl.addEventListener('paste', onPasteImage)
  inputEl.addEventListener('drop', onDropImage)
  imageBtn.addEventListener('click', () => {
    alert('直接 Ctrl+V 粘贴图片，或拖拽图片到输入框')
  })
  window.addEventListener('keydown', onKeydown)
  updateQuoteButton()
  updateTransferButtons()
})

function onKeydown(e: KeyboardEvent) {
  const isMod = e.metaKey || e.ctrlKey
  if (!isMod) return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void onSend()
  } else if (e.shiftKey && (e.key === '!' || e.code === 'Digit1')) {
    e.preventDefault()
    btnC2G.click()
  } else if (e.shiftKey && (e.key === '@' || e.code === 'Digit2')) {
    e.preventDefault()
    btnG2C.click()
  }
}

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

// ---------- History ----------
async function saveCurrentSession() {
  const session: Session = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    prompt: state.lastPrompt,
    responses: {
      chatgpt: state.lastResponses.chatgpt || undefined,
      gemini: state.lastResponses.gemini || undefined,
    },
    followUps: [],
  }
  await addSession(session)
}

async function onHistory() {
  const all = await loadSessions()
  all.sort((a, b) => b.createdAt - a.createdAt)
  if (all.length === 0) {
    alert('暂无历史记录')
    return
  }
  const list = all.slice(0, 20).map((s, i) => {
    const ts = new Date(s.createdAt).toLocaleString()
    const p = s.prompt.slice(0, 50) + (s.prompt.length > 50 ? '…' : '')
    return `${i + 1}. [${ts}] ${p}`
  }).join('\n')
  const choice = prompt(`历史记录 (最近 20 条，共 ${all.length} 条，上限 ${MAX_SESSIONS}):\n\n${list}\n\n输入序号查看详情，或留空返回：`)
  if (!choice) return
  const idx = parseInt(choice, 10)
  if (isNaN(idx) || idx < 1 || idx > all.length) {
    alert('无效的序号')
    return
  }
  const s = all[idx - 1]
  const detail = `用户问题：${s.prompt}\n\nChatGPT: ${s.responses.chatgpt ?? '(无)'}\n\nGemini: ${s.responses.gemini ?? '(无)'}`
  alert(detail)
  if (confirm('是否删除此条历史？')) {
    await deleteSession(s.id)
  }
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
