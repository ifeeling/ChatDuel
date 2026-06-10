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
// @ 提及功能 (v0.4+):
//   - 输入 @ 弹候选(从 activePlatforms() 派生 = HTML 里实际打开的 panel)
//   - 已选目标显示成 chip 在文本框上方;@ 字符不进文本框
//   - 1-9/0 数字键 / ↑↓ / Enter / Esc / 鼠标
//   - 文本路径 "@chatgpt" 仍兼容(parseAtMentions)
//
// 图片功能 (v0.3):
//   - 文件 → dataURL → postMessage 到 iframe → adapter 接管
//   - ChatGPT 走原生 <input type=file>,Gemini 走 paste 事件 fallback
//   - onSend 收集各平台结果,合并 toast;全部/部分失败时复制剪贴板兜底

import type { AIPlatform } from '../types'
import { MAX_IMAGE_BYTES, ImageTooLargeError } from '../lib/image-handler'
import { activePlatforms, getPlatformMeta, shortcutKey, type AIPlatformMeta } from '../lib/ai-platforms'
import { detectAtInput, filterCandidates, parseAtMentions } from '../lib/at-parser'
import { getDefaultTemplates, renderTemplate } from '../lib/prompt-template'

// PLATFORMS 不再硬编码:由 activePlatforms() 从 DOM 派生(HTML 里有几个 panel 就有几个)
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

// ---------- @ 状态 ----------
// atSelected:UI 选中的目标(空集合 = 发给所有 panel)
const atSelected: Set<AIPlatform> = new Set()
// atPopupOpen + atPopupIndex:键盘高亮
let atPopupOpen = false
let atPopupIndex = 0
let atPopupCandidates: AIPlatformMeta[] = []
// atPopupAnchor:输入时记下 @ 的位置,选中后把 @ + 后续输入片段删掉
let atPopupAnchor: { start: number; length: number } | null = null

const atChipsEl = $<HTMLDivElement>('#at-chips')
const atPopupEl = $<HTMLDivElement>('#at-popup')

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
  btnImage.classList.add('has-image')
  btnImage.title = `已附加图片: ${file.name || 'image'} — 点击替换`
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
  btnImage.classList.remove('has-image')
  btnImage.title = '附加图片'
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
  for (const p of activePlatforms()) {
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
  // 目标优先级:atSelected(UI 选) > 文本里手打 @xxx(向后兼容) > 全发
  let targets: AIPlatform[]
  if (atSelected.size > 0) {
    targets = [...atSelected]
  } else {
    const validKeys = new Set(activePlatforms())
    const mentioned = parseAtMentions(text, validKeys)
    targets = mentioned.length > 0 ? mentioned : activePlatforms()
  }

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
      // 部分成功:v0.5+ 不再走剪贴板兜底(跨源 iframe 写剪贴板经常失败)
      showToast('部分目标未自动接收图片,请手动上传到失败侧', 'warn', 6000)
    } else {
      // 全部失败:v0.5+ 不再走剪贴板兜底
      showToast('图片自动发送失败,请手动上传', 'err', 6000)
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
  // onSend 完顺手清掉 at 选择(避免下条消息还受上一条的影响)
  // 不清 atSelected:如果想连发同一组目标,保留;但目前默认清掉,符合"每次明确选"的直觉
  // 选 1:不 clear(连发场景更顺手)
  // 选 2:clear(显式选择更可控)
  // —— 选 1
}

// ---------- @ 弹层 / Chips ----------
function getAllPanelMetas(): AIPlatformMeta[] {
  return activePlatforms()
    .map((k) => getPlatformMeta(k))
    .filter((m): m is AIPlatformMeta => !!m)
}

function renderChips() {
  if (atSelected.size === 0) {
    atChipsEl.hidden = true
    atChipsEl.innerHTML = ''
    return
  }
  atChipsEl.hidden = false
  atChipsEl.innerHTML = ''
  for (const p of atSelected) {
    const meta = getPlatformMeta(p)
    if (!meta) continue
    const chip = document.createElement('span')
    chip.className = 'at-chip'
    chip.dataset.platform = p
    chip.innerHTML = `<span class="at-chip-icon">${meta.icon}</span><span>${meta.label}</span><span class="at-chip-remove" title="移除">×</span>`
    chip.querySelector('.at-chip-remove')!.addEventListener('click', (ev) => {
      ev.stopPropagation()
      atSelected.delete(p)
      renderChips()
    })
    atChipsEl.appendChild(chip)
  }
}

function openAtPopup() {
  atPopupOpen = true
  atPopupEl.hidden = false
  // 先渲染出来(让浏览器算好 offsetHeight),再读真实高度定位
  atPopupEl.style.position = 'fixed'
  atPopupEl.style.left = '-9999px'  // 先放屏外,避免闪一下
  atPopupEl.style.zIndex = '9999'
  // 同步读真实尺寸(此时 hidden=false,DOM 已布局)
  // renderAtPopup 会在 openAtPopup 之后被调用,所以这里读到的还是旧的或 0。
  // 改:在 renderAtPopup 末尾做定位。
}

function closeAtPopup() {
  atPopupOpen = false
  atPopupEl.hidden = true
  atPopupAnchor = null
  atPopupCandidates = []
  atPopupIndex = 0
}

function renderAtPopup() {
  atPopupEl.innerHTML = ''
  if (atPopupCandidates.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'at-popup-empty'
    empty.textContent = '没有可用的 AI(全部已选或前台未打开面板)'
    atPopupEl.appendChild(empty)
    return
  }
  atPopupCandidates.forEach((meta, idx) => {
    const item = document.createElement('div')
    item.className = 'at-popup-item' + (idx === atPopupIndex ? ' active' : '')
    item.dataset.platform = meta.key
    const key = shortcutKey(idx)
    item.innerHTML =
      `<span class="at-popup-key">${key ?? ' '}</span>` +
      `<span class="at-popup-icon">${meta.icon}</span>` +
      `<span class="at-popup-label">${meta.label}</span>`
    item.addEventListener('mouseenter', () => {
      atPopupIndex = idx
      updateAtPopupActive()
    })
    item.addEventListener('click', (ev) => {
      ev.preventDefault()
      selectAtCandidate(meta.key)
    })
    atPopupEl.appendChild(item)
  })
  const hint = document.createElement('div')
  hint.className = 'at-popup-hint'
  hint.textContent = '↑↓ 选择 · Enter 确认 · Esc 取消'
  atPopupEl.appendChild(hint)
  // 渲染完后再做定位(用真实高度)
  positionAtPopup()
}

/**
 * 弹层定位:贴 textarea,下方放不下就翻到上方;用真实 offsetHeight 决定
 */
function positionAtPopup() {
  const rect = inputEl.getBoundingClientRect()
  const margin = 4
  const popupHeight = atPopupEl.offsetHeight || 100  // 兜底,防 0
  const belowTop = rect.bottom + margin
  const wouldOverflow = belowTop + popupHeight > window.innerHeight
  atPopupEl.style.left = `${Math.round(rect.left)}px`
  if (wouldOverflow) {
    atPopupEl.style.top = `${Math.round(rect.top - popupHeight - margin)}px`
  } else {
    atPopupEl.style.top = `${Math.round(belowTop)}px`
  }
  atPopupEl.onmousedown = (e) => e.preventDefault()
  console.log('[AIChatRoom @] positionAtPopup', {
    rectTop: rect.top, rectBottom: rect.bottom,
    popupHeight, wouldOverflow,
    popupTop: atPopupEl.style.top, innerHeight: window.innerHeight,
  })
}

function updateAtPopupActive() {
  const items = atPopupEl.querySelectorAll<HTMLDivElement>('.at-popup-item')
  items.forEach((el, i) => {
    if (i === atPopupIndex) el.classList.add('active')
    else el.classList.remove('active')
  })
}

function moveAtPopup(delta: number) {
  if (atPopupCandidates.length === 0) return
  atPopupIndex = (atPopupIndex + delta + atPopupCandidates.length) % atPopupCandidates.length
  updateAtPopupActive()
}

function selectAtCandidate(platform: AIPlatform) {
  atSelected.add(platform)
  renderChips()
  // 删掉 textarea 里的 @ + 输入片段,光标回到 anchor 起点
  if (atPopupAnchor) {
    const before = inputEl.value.slice(0, atPopupAnchor.start)
    const after = inputEl.value.slice(atPopupAnchor.start + atPopupAnchor.length)
    inputEl.value = before + after
    const caret = atPopupAnchor.start
    inputEl.setSelectionRange(caret, caret)
  }
  closeAtPopup()
  inputEl.focus()
}

function onAtInput() {
  const caret = inputEl.selectionStart ?? 0
  const before = inputEl.value.slice(0, caret)
  const state = detectAtInput(before)
  if (!state) {
    if (atPopupOpen) closeAtPopup()
    return
  }
  // 候选:所有 panel 中、未被选中的
  const all = getAllPanelMetas().filter((m) => !atSelected.has(m.key as AIPlatform))
  atPopupCandidates = filterCandidates(all, state.prefix)
  atPopupIndex = 0
  atPopupAnchor = { start: state.startIndex, length: caret - state.startIndex }
  if (!atPopupOpen) openAtPopup()
  renderAtPopup()
}

function onAtKeydown(e: KeyboardEvent) {
  if (atPopupOpen) {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeAtPopup()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveAtPopup(1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveAtPopup(-1)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const c = atPopupCandidates[atPopupIndex]
      if (c) selectAtCandidate(c.key as AIPlatform)
      return
    }
    // 数字键 1-9 / 0 快捷选
    if (/^[0-9]$/.test(e.key)) {
      const idx = e.key === '0' ? 9 : parseInt(e.key, 10) - 1
      if (idx >= 0 && idx < atPopupCandidates.length) {
        e.preventDefault()
        const c = atPopupCandidates[idx]
        if (c) selectAtCandidate(c.key as AIPlatform)
      }
      return
    }
  }
}

// ---------- 转移(Transfer) ----------
const MAX_TRANSFER_LENGTH = 50_000

/** transfer 模板(取自 prompt-template.ts 的 getDefaultTemplates().transfer) */
const transferTemplate = getDefaultTemplates().transfer

/**
 * 转移流程:点 panel A 的 .panel-transfer
 *   1) 候选 = activePlatforms().filter(p => p !== sourceKey)
 *   2) N=2 → 直接 executeTransfer(source, candidate[0])
 *   3) N>2 → 复用 at-popup 单选模式
 *   4) N=1 → toast 报错
 */
async function onTransfer(sourceKey: AIPlatform) {
  const candidates = activePlatforms().filter((p) => p !== sourceKey)
  if (candidates.length === 0) {
    showToast('没有可转移的目标', 'warn')
    return
  }
  if (candidates.length === 1) {
    void executeTransfer(sourceKey, candidates[0] as AIPlatform)
    return
  }
  // N>2:复用 at-popup 弹层
  openAtPopupForTransfer(sourceKey, candidates)
}

/**
 * Transfer 模式的弹层:直接渲染候选(绕过 atSelected 逻辑),点候选 = executeTransfer。
 * 跟 at-popup 共用 DOM / 样式,但走独立点击处理。
 */
let transferSourceKey: AIPlatform | null = null

function openAtPopupForTransfer(sourceKey: AIPlatform, candidates: AIPlatform[]) {
  transferSourceKey = sourceKey
  atPopupCandidates = candidates
    .map((k) => getPlatformMeta(k))
    .filter((m): m is AIPlatformMeta => !!m)
  atPopupIndex = 0
  atPopupAnchor = null
  if (!atPopupOpen) openAtPopup()
  renderTransferPopup()
  // 弹层外部 click / Esc 关掉时清状态
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      transferSourceKey = null
      closeAtPopup()
      window.removeEventListener('keydown', onKey, true)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveAtPopup(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveAtPopup(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const c = atPopupCandidates[atPopupIndex]
      if (c) {
        void executeTransfer(sourceKey, c.key as AIPlatform)
        transferSourceKey = null
        closeAtPopup()
        window.removeEventListener('keydown', onKey, true)
      }
    } else if (/^[0-9]$/.test(e.key)) {
      const idx = e.key === '0' ? 9 : parseInt(e.key, 10) - 1
      if (idx >= 0 && idx < atPopupCandidates.length) {
        e.preventDefault()
        const c = atPopupCandidates[idx]
        if (c) {
          void executeTransfer(sourceKey, c.key as AIPlatform)
          transferSourceKey = null
          closeAtPopup()
          window.removeEventListener('keydown', onKey, true)
        }
      }
    }
  }
  window.addEventListener('keydown', onKey, true)
}

/**
 * 渲染 transfer 模式的弹层(类似 at-popup,但每个 item 的 click 走 transfer)
 */
function renderTransferPopup() {
  atPopupEl.innerHTML = ''
  if (atPopupCandidates.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'at-popup-empty'
    empty.textContent = '没有可转移的目标'
    atPopupEl.appendChild(empty)
    return
  }
  atPopupCandidates.forEach((meta, idx) => {
    const item = document.createElement('div')
    item.className = 'at-popup-item' + (idx === atPopupIndex ? ' active' : '')
    const key = shortcutKey(idx)
    item.innerHTML =
      `<span class="at-popup-key">${key ?? ' '}</span>` +
      `<span class="at-popup-icon">${meta.icon}</span>` +
      `<span class="at-popup-label">${meta.label}</span>`
    item.addEventListener('mouseenter', () => {
      atPopupIndex = idx
      updateAtPopupActive()
    })
    item.addEventListener('click', (ev) => {
      ev.preventDefault()
      if (!transferSourceKey) return
      const target = transferSourceKey
      transferSourceKey = null
      void executeTransfer(target, meta.key as AIPlatform)
      closeAtPopup()
    })
    // 防止 mousedown 抢焦点
    item.addEventListener('mousedown', (e) => e.preventDefault())
    atPopupEl.appendChild(item)
  })
  const hint = document.createElement('div')
  hint.className = 'at-popup-hint'
  hint.textContent = '↑↓ 选择 · Enter 确认 · Esc 取消'
  atPopupEl.appendChild(hint)
  positionAtPopup()
}

async function executeTransfer(sourceKey: AIPlatform, targetKey: AIPlatform) {
  // 找到源 panel header 按钮,设 busy
  const srcBtn = document.querySelector<HTMLButtonElement>(`.panel-transfer[data-platform="${sourceKey}"]`)
  const tgtBtn = document.querySelector<HTMLButtonElement>(`.panel-transfer[data-platform="${targetKey}"]`)
  if (srcBtn) {
    srcBtn.classList.add('busy')
    srcBtn.disabled = true
    srcBtn.textContent = '转移中…'
  }
  if (tgtBtn) tgtBtn.disabled = true

  try {
    // 1. 源状态检查
    const srcIframe = panelIframe(sourceKey)
    const srcWin = srcIframe.contentWindow
    if (!srcWin) throw new Error('源 iframe 不可用')
    const srcState = await new Promise<{ status: string }>((resolve) => {
      const onMsg = (e: MessageEvent) => {
        const d = e.data as { source?: string; type?: string; state?: { status: string } } | undefined
        if (d?.source === 'aichatroom-content' && d.type === 'state' && d.state) {
          window.removeEventListener('message', onMsg)
          resolve(d.state)
        }
      }
      window.addEventListener('message', onMsg)
      srcWin.postMessage(
        { source: 'aichatroom-parent', action: 'get-state' },
        OFFICIAL_URLS[sourceKey],
      )
      setTimeout(() => { window.removeEventListener('message', onMsg); resolve({ status: 'unknown' }) }, 2000)
    })

    if (!['idle', 'finished', 'error'].includes(srcState.status)) {
      showToast(`源 AI 还在生成中,等一会儿再试(当前: ${srcState.status})`, 'warn', 4000)
      return
    }

    // 2. 取源回答
    const content = await new Promise<string>((resolve) => {
      const onMsg = (e: MessageEvent) => {
        const d = e.data as { source?: string; type?: string; text?: string } | undefined
        if (d?.source === 'aichatroom-content' && d.type === 'last-response') {
          window.removeEventListener('message', onMsg)
          resolve(d.text ?? '')
        }
      }
      window.addEventListener('message', onMsg)
      srcWin.postMessage(
        { source: 'aichatroom-parent', action: 'get-last-response' },
        OFFICIAL_URLS[sourceKey],
      )
      setTimeout(() => { window.removeEventListener('message', onMsg); resolve('') }, 3000)
    })

    if (!content || !content.trim()) {
      showToast('源 AI 还没有回答可转移', 'warn', 4000)
      return
    }

    // 3. 目标状态轻量预检(50ms 超时,降级)
    const tgtIframe = panelIframe(targetKey)
    const tgtWin = tgtIframe.contentWindow
    if (tgtWin) {
      try {
        const tgtState = await new Promise<{ status: string } | null>((resolve) => {
          const onMsg = (e: MessageEvent) => {
            const d = e.data as { source?: string; type?: string; state?: { status: string } } | undefined
            if (d?.source === 'aichatroom-content' && d.type === 'state' && d.state) {
              window.removeEventListener('message', onMsg)
              resolve(d.state)
            }
          }
          window.addEventListener('message', onMsg)
          tgtWin.postMessage(
            { source: 'aichatroom-parent', action: 'get-state' },
            OFFICIAL_URLS[targetKey],
          )
          setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null) }, 50)
        })
        if (tgtState && !['idle', 'finished', 'error'].includes(tgtState.status)) {
          showToast(`目标 AI 还在生成中,等一会儿再试(当前: ${tgtState.status})`, 'warn', 4000)
          return
        }
      } catch { /* 预检失败不阻塞 */ }
    }

    // 4. 长文本保护
    let finalContent = content
    if (content.length > MAX_TRANSFER_LENGTH) {
      finalContent = content.slice(0, MAX_TRANSFER_LENGTH) +
        `\n\n[...已截断,原回答共 ${content.length} 字符]`
      showToast(`源回答过长,已截断到 ${MAX_TRANSFER_LENGTH} 字符`, 'warn', 4000)
    }

    // 5. 渲染模板
    const fromLabel = getPlatformMeta(sourceKey)?.label ?? sourceKey
    const prompt = renderTemplate(transferTemplate, { fromLabel, content: finalContent })

    // 6. 发送到目标
    showToast(`正在把 ${fromLabel} 的回答转移到 ${getPlatformMeta(targetKey)?.label ?? targetKey}…`, 'info', 2000)
    tgtWin?.postMessage(
      { source: 'aichatroom-parent', action: 'write-and-send', text: prompt },
      OFFICIAL_URLS[targetKey],
    )
  } catch (e) {
    console.error('[AIChatRoom chat] transfer failed', e)
    showToast(`转移失败: ${e instanceof Error ? e.message : String(e)}`, 'err', 5000)
  } finally {
    if (srcBtn) {
      srcBtn.classList.remove('busy')
      srcBtn.disabled = false
      srcBtn.textContent = '转移 ➔'
    }
    if (tgtBtn) tgtBtn.disabled = false
    closeAtPopup()
  }
}

/** 在启动时给所有 .panel-transfer 按钮绑事件(数量随 N 个 AI 变化) */
function setupTransferButtons() {
  document.querySelectorAll<HTMLButtonElement>('.panel-transfer').forEach((btn) => {
    const p = btn.dataset.platform
    if (!p) return
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      void onTransfer(p as AIPlatform)
    })
  })
}

// ---------- 工具按钮(暂作占位) ----------
// 转移按钮(panel header 上的 .panel-transfer)由 setupTransferButtons() 单独绑定(动态 target)
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
  for (const p of activePlatforms()) {
    document.querySelector<HTMLButtonElement>(`.panel-open[data-platform="${p}"]`)!
      .addEventListener('click', () => {
        const url = OFFICIAL_URLS[p as keyof typeof OFFICIAL_URLS] ?? ''
        chrome.tabs.create({ url })
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
  // @ 弹层监听
  inputEl.addEventListener('input', onAtInput)
  inputEl.addEventListener('keydown', onAtKeydown)
  inputEl.addEventListener('blur', () => {
    // 失焦关弹层(等 100ms 给 click 事件先到达)
    setTimeout(() => { if (atPopupOpen) closeAtPopup() }, 100)
  })
  // 粘贴图片到 textarea
  inputEl.addEventListener('paste', onPaste)
  // 拖拽图片到 textarea
  inputEl.addEventListener('drop', onDrop)
  inputEl.addEventListener('dragover', (e) => e.preventDefault())

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
  setupTransferButtons()
  bindEvents()
  void bootstrap()
})
