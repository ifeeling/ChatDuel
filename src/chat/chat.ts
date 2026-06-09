// chat.ts:全屏 chat 页面主逻辑
//
// 通信架构:
//   - 父页 (chat.html) ↔ Service Worker:enable-embed-rules / disable-embed-rules
//   - 父页 (chat.html) ↔ iframe 子 frame:window.postMessage 直连(不走 SW)
//   - iframe 子 frame ↔ 官方页面:content script(由 manifest content_scripts 注入)
//
// 关键约定:所有跨窗口消息都带 `source` 字段,父页消息用 'aichatroom-parent',
// 子 frame 消息用 'aichatroom-content',防止被官方页面自身的 postMessage 干扰。

import type { AIPlatform } from '../types'

const PLATFORMS: AIPlatform[] = ['chatgpt', 'gemini']
const OFFICIAL_URLS: Record<AIPlatform, string> = {
  chatgpt: 'https://chatgpt.com/',
  gemini: 'https://gemini.google.com/',
}

// ---------- DOM 引用 ----------
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector<T>(sel)!
const statusText = (p: AIPlatform): HTMLSpanElement =>
  document.querySelector<HTMLSpanElement>(`.status-item[data-platform="${p}"] .status-text`)!
const statusDot = (p: AIPlatform): HTMLSpanElement =>
  document.querySelector<HTMLSpanElement>(`.status-item[data-platform="${p}"] .dot`)!
const panelIframe = (p: AIPlatform): HTMLIFrameElement =>
  document.querySelector<HTMLIFrameElement>(`.panel-iframe[data-platform="${p}"]`)!

const inputEl = $<HTMLTextAreaElement>('#input')
const sendBtn = $<HTMLButtonElement>('#btn-send')
const btnQuote = $<HTMLButtonElement>('#btn-quote')
const btnC2G = $<HTMLButtonElement>('#btn-transfer-c2g')
const btnG2C = $<HTMLButtonElement>('#btn-transfer-g2c')
const btnSummary = $<HTMLButtonElement>('#btn-summary')
const btnHistory = $<HTMLButtonElement>('#btn-history')
const btnImage = $<HTMLButtonElement>('#btn-image')
const btnRefresh = $<HTMLButtonElement>('#btn-refresh')
const splitter = $<HTMLDivElement>('#splitter')

// ---------- 状态 ----------
// 等待 iframe 内 content script 注入并发送 ready
const readyMap: Record<AIPlatform, boolean> = { chatgpt: false, gemini: false }
const readyWaiters: Record<AIPlatform, Array<(ok: boolean) => void>> = { chatgpt: [], gemini: [] }

function setStatus(p: AIPlatform, state: 'ok' | 'err' | 'warn', text: string) {
  const dot = statusDot(p)
  dot.classList.remove('ok', 'err', 'warn')
  if (state !== ('idle' as never)) dot.classList.add(state)
  statusText(p).textContent = text
}

function waitForIframeReady(p: AIPlatform, timeoutMs = 5000): Promise<boolean> {
  if (readyMap[p]) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const waiter = (ok: boolean) => resolve(ok)
    readyWaiters[p].push(waiter)
    setTimeout(() => {
      const idx = readyWaiters[p].indexOf(waiter)
      if (idx >= 0) readyWaiters[p].splice(idx, 1)
      resolve(readyMap[p])
    }, timeoutMs)
  })
}

// ---------- 与 SW 通信 ----------
function sendToSw<T = unknown>(msg: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
      else resolve(resp as T)
    })
  })
}

// ---------- 启动:启用 DNR 规则 + 加载 iframe ----------
async function bootstrap() {
  try {
    await sendToSw({ type: 'enable-embed-rules' })
    console.log('[AIChatRoom chat] embed rules enabled')
  } catch (e) {
    console.error('[AIChatRoom chat] enable-embed-rules failed', e)
  }
  refreshAllStatuses()
}

async function refreshAllStatuses() {
  for (const p of PLATFORMS) {
    setStatus(p, 'warn', '检测中…')
    const iframe = panelIframe(p)
    if (iframe.src === 'about:blank' || !iframe.src) {
      iframe.src = OFFICIAL_URLS[p]
    }
    const ok = await waitForIframeReady(p)
    if (ok) setStatus(p, 'ok', '已打开')
    else setStatus(p, 'err', '加载超时')
  }
}

// ---------- 父页 ↔ iframe postMessage 派发 ----------
function postToIframe(p: AIPlatform, action: string, extra: Record<string, unknown> = {}) {
  const win = panelIframe(p).contentWindow
  if (!win) return
  win.postMessage({ source: 'aichatroom-parent', action, ...extra }, OFFICIAL_URLS[p])
}

// 监听 iframe 内 content script 的消息
window.addEventListener('message', (e: MessageEvent) => {
  const data = e.data as
    | { source?: string; event?: string; platform?: AIPlatform; action?: string; ok?: boolean; error?: string }
    | undefined
  if (!data || data.source !== 'aichatroom-content') return

  if (data.event === 'ready' && (data.platform === 'chatgpt' || data.platform === 'gemini')) {
    readyMap[data.platform] = true
    const waiters = readyWaiters[data.platform]
    readyWaiters[data.platform] = []
    for (const w of waiters) w(true)
    console.log('[AIChatRoom chat] ready:', data.platform)
  }

  if (data.event === 'result' && data.action === 'write-and-send') {
    console.log(`[AIChatRoom chat] write-and-send result for ${data.platform}: ok=${data.ok} error=${data.error ?? ''}`)
  }
})

// ---------- 发送 ----------
async function onSend() {
  const text = inputEl.value.trim()
  if (!text) return
  // @mention 解析
  const mentioned: AIPlatform[] = []
  for (const p of PLATFORMS) {
    if (text.toLowerCase().includes(`@${p}`)) mentioned.push(p)
  }
  const targets = mentioned.length > 0 ? mentioned : PLATFORMS
  for (const p of targets) {
    await waitForIframeReady(p)
    postToIframe(p, 'write-and-send', { text })
  }
  inputEl.value = ''
}

// ---------- 工具按钮(暂作占位) ----------
function onC2G() {
  // v1 暂未实现跨平台搬运,留接口
  console.log('[AIChatRoom chat] C→G transfer: not implemented yet')
}
function onG2C() {
  console.log('[AIChatRoom chat] G→C transfer: not implemented yet')
}
function onSummary() {
  console.log('[AIChatRoom chat] summary: not implemented yet')
}
function onQuote() {
  console.log('[AIChatRoom chat] quote: not implemented yet')
}
function onHistory() {
  alert('历史功能 v1 暂未启用')
}
function onImage() {
  alert('请直接 Ctrl+V 粘贴图片,或拖拽图片到输入框')
}

// ---------- 分隔条拖拽 ----------
function setupSplitter() {
  let dragging = false
  splitter.addEventListener('mousedown', (e) => {
    dragging = true
    splitter.classList.add('dragging')
    e.preventDefault()
  })
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return
    const panels = document.querySelector<HTMLElement>('.panels')!
    const leftPanel = document.querySelector<HTMLElement>('.panel[data-platform="gemini"]')!
    const ratio = Math.max(0.15, Math.min(0.85, e.clientX / panels.clientWidth))
    leftPanel.style.flex = `0 0 ${ratio * 100}%`
  })
  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false
      splitter.classList.remove('dragging')
    }
  })
}

// ---------- 打开外部 tab ----------
function setupOpenButtons() {
  for (const p of PLATFORMS) {
    document.querySelector<HTMLButtonElement>(`.panel-open[data-platform="${p}"]`)!
      .addEventListener('click', () => {
        chrome.tabs.create({ url: OFFICIAL_URLS[p] })
      })
  }
}

// ---------- 事件绑定 ----------
function bindEvents() {
  sendBtn.addEventListener('click', () => void onSend())
  inputEl.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void onSend()
    }
  })
  btnC2G.addEventListener('click', onC2G)
  btnG2C.addEventListener('click', onG2C)
  btnSummary.addEventListener('click', onSummary)
  btnQuote.addEventListener('click', onQuote)
  btnHistory.addEventListener('click', onHistory)
  btnImage.addEventListener('click', onImage)
  btnRefresh.addEventListener('click', () => void refreshAllStatuses())
}

// ---------- 离开时关 DNR 规则 ----------
window.addEventListener('beforeunload', () => {
  // best-effort,SW 可能已经关掉
  try {
    chrome.runtime.sendMessage({ type: 'disable-embed-rules' })
  } catch {
    /* ignore */
  }
})

// ---------- 启动 ----------
window.addEventListener('DOMContentLoaded', () => {
  console.log('[AIChatRoom chat] ready')
  setupSplitter()
  setupOpenButtons()
  bindEvents()
  void bootstrap()
})
