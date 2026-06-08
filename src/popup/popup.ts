import type { AIPlatform, StreamStatus } from '../types'
import type { SwToPopup, PopupToSw } from '../shared/messages'

// ---------- DOM refs ----------
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!
const statusDot = (p: AIPlatform) => document.querySelector<HTMLSpanElement>(`.status-item[data-platform="${p}"] .dot`)!
const panelState = (p: AIPlatform) => document.querySelector<HTMLElement>(`.panel[data-platform="${p}"] .panel-state`)!
const messagesEl = (p: AIPlatform) => document.getElementById(`messages-${p}`) as HTMLDivElement
const inputEl = $<HTMLTextAreaElement>('#input')
const sendBtn = $<HTMLButtonElement>('#btn-send')
const quoteBtn = $<HTMLButtonElement>('#btn-quote')
const imageBtn = $<HTMLButtonElement>('#btn-image')

// ---------- State ----------
interface UIState {
  status: Record<AIPlatform, StreamStatus>
  lastResponses: Record<AIPlatform, string>
  hasUserMessage: boolean
}
const state: UIState = {
  status: { chatgpt: 'idle', gemini: 'idle' },
  lastResponses: { chatgpt: '', gemini: '' },
  hasUserMessage: false,
}

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

function addBubble(p: AIPlatform, text: string, kind: 'user' | 'ai' | 'placeholder') {
  const div = document.createElement('div')
  div.className = `bubble ${kind}`
  div.textContent = text
  messagesEl(p).appendChild(div)
  messagesEl(p).scrollTop = messagesEl(p).scrollHeight
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
    if (e.type === 'finished') {
      state.lastResponses[e.platform] = e.text
      setPlatformStatus(e.platform, 'finished')
      // Check if both finished
      if (state.status.chatgpt === 'finished' && state.status.gemini === 'finished') {
        flashPanel('chatgpt')
        flashPanel('gemini')
      }
    } else if (e.type === 'started' || e.type === 'token') {
      setPlatformStatus(e.platform, 'streaming')
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
  inputEl.addEventListener('input', () => {
    state.hasUserMessage = inputEl.value.trim().length > 0
  })
})

async function onSend() {
  const text = inputEl.value.trim()
  if (!text) return
  const platforms: AIPlatform[] = ['chatgpt', 'gemini']
  for (const p of platforms) {
    addBubble(p, text, 'user')
    setPlatformStatus(p, 'queued')
  }
  inputEl.value = ''
  await sendToSw({ type: 'send-message', platforms, text })
}
