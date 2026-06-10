// chat.ts:全屏 chat 页面主逻辑
//
// 通信架构:
//   - 父页 (chat.html) ↔ Service Worker:enable-embed-rules / disable-embed-rules
//   - 父页 (chat.html) ↔ iframe 子 frame:window.postMessage 直连(不走 SW)
//   - iframe 子 frame ↔ 官方页面:content script(由 manifest content_scripts 注入)
//
// 关键约定:所有跨窗口消息都带 `source` 字段,父页消息用 'aichatroom-parent',
// 子 frame 消息用 'aichatroom-content',防止被官方页面自身的 postMessage 干扰。
//
// 图片功能 v0.2.1 (简化版):
//   - 支持选文件 / 拖拽 / 粘贴 接收图片
//   - 发送时:文字直接发;图片自动复制到剪贴板,弹出 toast 提示用户
//     在两侧 iframe 的 AI 输入框内手动 Ctrl+V
//   - 为什么不自动上传:Chrome MV3 禁止扩展往跨源 iframe 写文件 input,
//     派发合成 paste 事件到 Quill/ProseMirror 也不可靠
//   - 这个交互跟 ChatBrawl 0.7.2 一致

import type { AIPlatform } from '../types'
import { MAX_IMAGE_BYTES, ImageTooLargeError } from '../lib/image-handler'

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
const fileInput = $<HTMLInputElement>('#file-input')
const imagePreview = $<HTMLDivElement>('#image-preview')
const previewImg = $<HTMLImageElement>('#preview-img')
const imageMeta = $<HTMLSpanElement>('#image-meta')
const btnImageRemove = $<HTMLButtonElement>('#btn-image-remove')
const btnRefresh = $<HTMLButtonElement>('#btn-refresh')
const splitter = $<HTMLDivElement>('#splitter')
const toastContainer = $<HTMLDivElement>('#toast-container')

// ---------- 状态 ----------
const readyMap: Record<AIPlatform, boolean> = { chatgpt: false, gemini: false }
const readyWaiters: Record<AIPlatform, Array<(ok: boolean) => void>> = { chatgpt: [], gemini: [] }

// 待发送的图片(仅支持 1 张,后续 attach 会替换)
let pendingImage: File | null = null
let pendingImageObjectUrl: string | null = null

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

function sendToSw<T = unknown>(msg: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
      else resolve(resp as T)
    })
  })
}

// ---------- Toast 通知 ----------
type ToastKind = 'info' | 'success' | 'warn' | 'err'
function showToast(text: string, kind: ToastKind = 'info', durationMs = 4000) {
  const div = document.createElement('div')
  div.className = `toast ${kind}`
  div.textContent = text
  toastContainer.appendChild(div)
  setTimeout(() => {
    div.style.transition = 'opacity 0.3s, transform 0.3s'
    div.style.opacity = '0'
    div.style.transform = 'translateX(20px)'
    setTimeout(() => div.remove(), 300)
  }, durationMs)
}

// ---------- 图片处理 ----------
function acceptImage(file: File) {
  if (!file.type.startsWith('image/')) {
    showToast('只支持图片文件', 'err')
    return
  }
  if (file.size > MAX_IMAGE_BYTES) {
    showToast(`图片太大(${(file.size / 1024 / 1024).toFixed(1)}MB,上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB)`, 'err')
    return
  }

  // 清理旧的 object URL
  if (pendingImageObjectUrl) {
    URL.revokeObjectURL(pendingImageObjectUrl)
  }
  pendingImage = file
  pendingImageObjectUrl = URL.createObjectURL(file)
  previewImg.src = pendingImageObjectUrl
  imageMeta.textContent = `${file.name || 'image'} · ${(file.size / 1024).toFixed(0)}KB`
  imagePreview.hidden = false
  btnImage.textContent = '图片 ✓'
  showToast('图片已附加', 'success', 1500)
}

function clearImage() {
  if (pendingImageObjectUrl) {
    URL.revokeObjectURL(pendingImageObjectUrl)
    pendingImageObjectUrl = null
  }
  pendingImage = null
  previewImg.src = ''
  imageMeta.textContent = ''
  imagePreview.hidden = true
  btnImage.textContent = '图片'
  if (fileInput) fileInput.value = ''
}


// File → base64 dataURL(给 iframe 端)
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })
}

// 尝试把图片复制到剪贴板(给用户手动 Ctrl+V 用)
async function tryCopyImageToClipboard(file: File): Promise<boolean> {
  try {
    if (!navigator.clipboard || !('write' in navigator.clipboard)) return false
    // @ts-ignore - ClipboardItem 在某些 TS lib.dom 里类型不全
    await navigator.clipboard.write([new ClipboardItem({ [file.type]: file })])
    return true
  } catch {
    return false
  }
}

// ---------- 启动 ----------
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

// ---------- 父页 ↔ iframe postMessage ----------
function postToIframe(p: AIPlatform, action: string, extra: Record<string, unknown> = {}) {
  const win = panelIframe(p).contentWindow
  if (!win) return
  win.postMessage({ source: 'aichatroom-parent', action, ...extra }, OFFICIAL_URLS[p])
}

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
  if (!text && !pendingImage) {
    showToast('请输入文字或附加图片', 'warn')
    return
  }
  const mentioned: AIPlatform[] = []
  for (const p of PLATFORMS) {
    if (text.toLowerCase().includes(`@${p}`)) mentioned.push(p)
  }
  const targets = mentioned.length > 0 ? mentioned : PLATFORMS

  // 1. 准备图片(若有):转 dataURL 供 iframe 内 adapter 接管
  let imageDataUrl: string | undefined
  let imageMime: string | undefined
  let imageName: string | undefined
  if (pendingImage) {
    try {
      imageDataUrl = await fileToDataUrl(pendingImage)
      imageMime = pendingImage.type
      imageName = pendingImage.name
    } catch (e) {
      console.error('[AIChatRoom chat] failed to read image as data URL', e)
    }
  }

  // 2. 发文字 + 图片到 iframe(由 content script 交给 adapter)。文字不附加 [图片] 后缀。
  const textToSend = text
  // 给每个目标发;分别等结果(不阻塞,但用 Promise 收集成功/失败)
  const results: Array<{ p: AIPlatform; ok: boolean }> = []
  await Promise.all(
    targets.map(
      (p) =>
        new Promise<void>((resolve) => {
          const win = panelIframe(p).contentWindow
          if (!win) {
            results.push({ p, ok: false })
            resolve()
            return
          }
          // 注册一次性结果监听
          const onMsg = (e: MessageEvent) => {
            const d = e.data as { source?: string; event?: string; action?: string; platform?: AIPlatform; ok?: boolean } | undefined
            if (!d || d.source !== 'aichatroom-content') return
            if (d.event === 'result' && d.action === 'write-and-send' && d.platform === p) {
              window.removeEventListener('message', onMsg)
              results.push({ p, ok: !!d.ok })
              resolve()
            }
          }
          window.addEventListener('message', onMsg)
          postToIframe(p, 'write-and-send', {
            text: textToSend,
            imageDataUrl,
            imageMime,
            imageName,
          })
          // 8 秒兜底:iframe 没回 result 也算 ok(可能 result 已发过)
          setTimeout(() => {
            window.removeEventListener('message', onMsg)
            if (!results.find((r) => r.p === p)) {
              results.push({ p, ok: true })
              resolve()
            }
          }, 8000)
        }),
    ),
  )

  // 3. 根据结果给一个合并的 toast
  const okCount = results.filter((r) => r.ok).length
  if (pendingImage) {
    if (okCount === results.length && results.length > 0) {
      showToast('图片已发送到所有目标', 'success', 2500)
    } else if (okCount > 0) {
      // 部分成功:把图片复制到剪贴板,让用户在失败那一侧手动 Ctrl+V
      const copied = await tryCopyImageToClipboard(pendingImage)
      if (copied) {
        showToast(`部分目标未自动接收图片,已复制到剪贴板,请在失败侧 Ctrl+V`, 'warn', 6000)
      } else {
        showToast(`部分目标未自动接收图片,剪贴板也复制失败,请手动上传`, 'err', 6000)
      }
    } else {
      // 全部失败:剪贴板兜底
      const copied = await tryCopyImageToClipboard(pendingImage)
      if (copied) {
        showToast('图片自动发送失败,已复制到剪贴板,请在 AI 输入框 Ctrl+V', 'err', 6000)
      } else {
        showToast('图片自动发送失败,剪贴板也失败,请手动上传', 'err', 6000)
      }
    }
  } else {
    if (okCount === 0 && results.length > 0) {
      showToast('发送失败,请重试', 'err', 3000)
    } else {
      showToast('已发送', 'success', 1200)
    }
  }

  // 4. 清空
  inputEl.value = ''
  clearImage()
}

// ---------- 工具按钮(暂作占位) ----------
function onC2G() { console.log('[AIChatRoom chat] C→G transfer: not implemented yet') }
function onG2C() { console.log('[AIChatRoom chat] G→C transfer: not implemented yet') }
function onSummary() { console.log('[AIChatRoom chat] summary: not implemented yet') }
function onQuote() { console.log('[AIChatRoom chat] quote: not implemented yet') }
function onHistory() { alert('历史功能 v1 暂未启用') }

// ---------- 图片按钮 ----------
function onImageClick() {
  // 触发隐藏的 file input
  fileInput.click()
}

function onFileInputChange(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (file) acceptImage(file)
}

function onPaste(e: ClipboardEvent) {
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

function onDrop(e: DragEvent) {
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
  // 粘贴图片到 textarea
  inputEl.addEventListener('paste', onPaste)
  // 拖拽图片到 textarea
  inputEl.addEventListener('drop', onDrop)
  inputEl.addEventListener('dragover', (e) => e.preventDefault())

  btnC2G.addEventListener('click', onC2G)
  btnG2C.addEventListener('click', onG2C)
  btnSummary.addEventListener('click', onSummary)
  btnQuote.addEventListener('click', onQuote)
  btnHistory.addEventListener('click', onHistory)

  // 图片按钮 + 移除按钮
  btnImage.addEventListener('click', onImageClick)
  btnImageRemove.addEventListener('click', clearImage)
  fileInput.addEventListener('change', onFileInputChange)

  btnRefresh.addEventListener('click', () => void refreshAllStatuses())
}

// ---------- 离开时关 DNR 规则 ----------
window.addEventListener('beforeunload', () => {
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
