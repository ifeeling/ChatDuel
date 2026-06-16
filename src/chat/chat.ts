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
//
// 历史与会话:
//   - "历史"按每次用户提交保存问题、实际发送内容、附件和 AI 回复,用于回看、总结、转发。
//   - "会话"只保存官方网页的具体会话 URL,用于回到旧对话继续聊,不保存 AI 回复正文。

import type { AIPlatform, ConversationEntry, ConversationState, Session, SessionAttachment, SessionResponse, SessionSummary, SummaryMode } from '../types'
import {
  FileTooLargeError,
  SUPPORTED_FILE_FORMATS_TEXT,
  UnsupportedFileTypeError,
  assertFileWithinLimit,
  buildInlineTextPrompt,
  buildAttachmentDeliveryPlan,
  classifyFile,
  getUnsupportedFileMessage,
  inlineTextFile,
  type FileClassification,
} from '../lib/file-handler'
import {
  MAX_ACTIVE_PLATFORMS,
  MIN_ACTIVE_PLATFORMS,
  SUPPORTED_PLATFORMS,
  activePlatforms,
  getPlatformCapabilities,
  getPlatformMeta,
  platformsWithCapability,
  shortcutKey,
  type AIPlatformMeta,
} from '../lib/ai-platforms'
import { detectAtInput, filterCandidates, parseAtMentions } from '../lib/at-parser'
import { getDefaultTemplates, renderTemplate } from '../lib/prompt-template'
import {
  DEFAULT_USER_SETTINGS,
  loadUserSettings,
  saveUserSettings,
  swapPlatformOrder,
  type UserPromptTemplateKey,
  type UserPromptTemplates,
  type UserSettings,
} from '../lib/user-settings'
import { addSession, deleteSession, getSession, loadSessions, updateSession } from '../lib/session-store'
import {
  applyCapturedResponses,
  applySendResults,
  createSessionRecord,
  createSummarySessionRecord,
  isNewCapturedResponse,
} from '../lib/session-record'
import { buildSessionMarkdownExport, formatBytes, formatSessionMarkdown, summarizeSessionTargets } from '../lib/history-format'
import { buildSummaryPrompt } from '../lib/summary-builder'
import { evaluateResponseCapture, type ResponseCaptureProgress } from '../lib/response-capture'
import { buildTransferContent, buildTransferSourceOptions, type TransferSourceOption } from '../lib/transfer-source'
import { bindComposerFocusRestorer } from '../lib/focus-restore'
import { filterSessionsByTitle } from '../lib/history-search'
import { deleteConversation, isSpecificConversationUrl, loadConversations, upsertConversation } from '../lib/conversation-store'

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
const panelsContainer = $<HTMLElement>('.panels')
const composer = $<HTMLElement>('.composer')
const composerToolbar = $<HTMLDivElement>('.composer-toolbar')
const btnQuote = $<HTMLButtonElement>('#btn-quote')
const btnSummary = $<HTMLButtonElement>('#btn-summary')
const btnHistory = $<HTMLButtonElement>('#btn-history')
const btnConversations = $<HTMLButtonElement>('#btn-conversations')
const btnAddPanel = $<HTMLButtonElement>('#btn-add-panel')
const btnSettings = $<HTMLButtonElement>('#btn-settings')
const btnExpandInput = $<HTMLButtonElement>('#btn-expand-input')
const btnImage = $<HTMLButtonElement>('#btn-image')
const fileInput = $<HTMLInputElement>('#file-input')
const imagePreview = $<HTMLDivElement>('#image-preview')
const previewImg = $<HTMLImageElement>('#preview-img')
const imageMeta = $<HTMLSpanElement>('#image-meta')
const btnImageRemove = $<HTMLButtonElement>('#btn-image-remove')
const btnRefresh = $<HTMLButtonElement>('#btn-refresh')
const toastContainer = $<HTMLDivElement>('#toast-container')
const settingsOverlay = $<HTMLDivElement>('#settings-overlay')
const btnSettingsClose = $<HTMLButtonElement>('#btn-settings-close')
const btnSettingsSave = $<HTMLButtonElement>('#btn-settings-save')
const settingPromptKind = $<HTMLSelectElement>('#setting-prompt-kind')
const settingPromptLabel = $<HTMLSpanElement>('#setting-prompt-label')
const settingPromptTemplate = $<HTMLTextAreaElement>('#setting-prompt-template')
const settingPromptHelp = $<HTMLParagraphElement>('#setting-prompt-help')
const btnResetPromptTemplate = $<HTMLButtonElement>('#btn-reset-prompt-template')
const historyOverlay = $<HTMLDivElement>('#history-overlay')
const btnHistoryClose = $<HTMLButtonElement>('#btn-history-close')
const historySearchInput = $<HTMLInputElement>('#history-search')
const historyList = $<HTMLDivElement>('#history-list')
const historyDetail = $<HTMLDivElement>('#history-detail')
const panelSwitchMenu = $<HTMLDivElement>('#panel-switch-menu')
const conversationOverlay = $<HTMLDivElement>('#conversation-overlay')
const btnConversationClose = $<HTMLButtonElement>('#btn-conversation-close')
const conversationList = $<HTMLDivElement>('#conversation-list')
const summaryOverlay = $<HTMLDivElement>('#summary-overlay')
const btnSummaryClose = $<HTMLButtonElement>('#btn-summary-close')
const btnSummaryCancel = $<HTMLButtonElement>('#btn-summary-cancel')
const btnSummaryGenerate = $<HTMLButtonElement>('#btn-summary-generate')
const summaryList = $<HTMLDivElement>('#summary-list')
const summaryTargetSelect = $<HTMLSelectElement>('#summary-target')
const summaryModeSelect = $<HTMLSelectElement>('#summary-mode')
const summarySourceList = $<HTMLDivElement>('#summary-source-list')
const summarySelected = $<HTMLDivElement>('#summary-selected')
const summaryPreview = $<HTMLDivElement>('#summary-preview')
const transferOverlay = $<HTMLDivElement>('#transfer-overlay')
const transferTitle = $<HTMLHeadingElement>('#transfer-title')
const btnTransferClose = $<HTMLButtonElement>('#btn-transfer-close')
const btnTransferCancel = $<HTMLButtonElement>('#btn-transfer-cancel')
const btnTransferSend = $<HTMLButtonElement>('#btn-transfer-send')
const transferList = $<HTMLDivElement>('#transfer-list')
const transferTargetList = $<HTMLDivElement>('#transfer-target-list')
const transferSelected = $<HTMLDivElement>('#transfer-selected')
const transferPreview = $<HTMLDivElement>('#transfer-preview')
const ATTACH_BUTTON_TITLE = `支持：${SUPPORTED_FILE_FORMATS_TEXT}。暂不支持 Word。`

// ---------- 状态 ----------
const readyMap: Record<AIPlatform, boolean> = { chatgpt: false, gemini: false, doubao: false }
const readyWaiters: Record<AIPlatform, Array<(ok: boolean) => void>> = { chatgpt: [], gemini: [], doubao: [] }
const RESPONSE_BACKFILL_INTERVAL_MS = 3000
const RESPONSE_BACKFILL_MAX_ATTEMPTS = 20
const RESPONSE_STABLE_REQUIRED_POLLS = 2
let userSettings: UserSettings = DEFAULT_USER_SETTINGS
let selectedPromptTemplateKey: UserPromptTemplateKey = 'transfer'
let promptTemplateDrafts: UserPromptTemplates = { ...DEFAULT_USER_SETTINGS.promptTemplates }
let historySessions: Session[] = []
let conversationEntries: ConversationEntry[] = []
let selectedHistoryId: string | null = null
let summarySessions: Session[] = []
const selectedSummaryIds: Set<string> = new Set()
const selectedSummaryPlatforms: Set<AIPlatform> = new Set()
let transferSourcePlatform: AIPlatform | null = null
let transferSourceOptions: TransferSourceOption[] = []

// 待发送的附件(仅支持 1 个,后续 attach 会替换)
interface PendingAttachment {
  file: File
  classification: FileClassification
  textContent?: string
}

let pendingAttachment: PendingAttachment | null = null
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

function updateComposerToolbarVisibility() {
  composerToolbar.classList.toggle('has-content', !atChipsEl.hidden || !imagePreview.hidden)
}

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

// ---------- 设置 ----------
function allPlatforms(): AIPlatform[] {
  return [...SUPPORTED_PLATFORMS]
}

function platformPanel(p: AIPlatform): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.panel[data-platform="${p}"]`)
}

function platformUrl(p: AIPlatform): string {
  return getPlatformMeta(p)?.url ?? 'about:blank'
}

function platformOrigin(p: AIPlatform): string {
  const url = platformUrl(p)
  if (url === 'about:blank') return '*'
  try {
    return new URL(url).origin
  } catch {
    return '*'
  }
}

function platformStatusItem(p: AIPlatform): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.status-item[data-platform="${p}"]`)
}

function settingPlatformInputs(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('.site-row input[data-platform]')]
    .filter((input) => allPlatforms().includes(input.dataset.platform as AIPlatform))
}

function selectedSettingsPlatforms(): AIPlatform[] {
  return settingPlatformInputs()
    .filter((input) => input.checked)
    .map((input) => input.dataset.platform as AIPlatform)
}

function enabledPlatformKeys(settings: UserSettings = userSettings): AIPlatform[] {
  return allPlatforms().filter((platform) => settings.enabledPlatforms[platform])
}

function syncSplitters() {
  const hasVisiblePanelBefore = (el: HTMLElement): boolean => {
    let current = el.previousElementSibling
    while (current) {
      if (current instanceof HTMLElement && current.classList.contains('panel') && !current.hidden) return true
      current = current.previousElementSibling
    }
    return false
  }
  const hasVisiblePanelAfter = (el: HTMLElement): boolean => {
    let current = el.nextElementSibling
    while (current) {
      if (current instanceof HTMLElement && current.classList.contains('panel') && !current.hidden) return true
      current = current.nextElementSibling
    }
    return false
  }

  document.querySelectorAll<HTMLElement>('.splitter').forEach((splitterEl) => {
    splitterEl.hidden = !hasVisiblePanelBefore(splitterEl) || !hasVisiblePanelAfter(splitterEl)
  })
}

function applyPanelOrder(order: AIPlatform[]) {
  const panels = new Map<AIPlatform, HTMLElement>()
  for (const platform of allPlatforms()) {
    const panel = platformPanel(platform)
    if (panel) panels.set(platform, panel)
  }
  const splitters = [...panelsContainer.querySelectorAll<HTMLElement>('.splitter')]
  const orderedPanels = order
    .map((platform) => panels.get(platform))
    .filter((panel): panel is HTMLElement => !!panel)

  for (const [index, panel] of orderedPanels.entries()) {
    panelsContainer.appendChild(panel)
    const splitter = splitters[index]
    if (splitter && index < orderedPanels.length - 1) panelsContainer.appendChild(splitter)
  }
}

function applyUserSettings(settings: UserSettings) {
  userSettings = settings
  applyPanelOrder(settings.platformOrder)
  for (const p of allPlatforms()) {
    const enabled = settings.enabledPlatforms[p]
    const panel = platformPanel(p)
    const status = platformStatusItem(p)
    const iframe = document.querySelector<HTMLIFrameElement>(`.panel-iframe[data-platform="${p}"]`)

    if (panel) panel.hidden = !enabled
    if (status) status.hidden = !enabled
    if (!enabled && iframe) {
      iframe.src = 'about:blank'
      readyMap[p] = false
    }
    if (!enabled || !getPlatformCapabilities(p).supportsText) atSelected.delete(p)
  }

  syncSplitters()
  btnAddPanel.hidden = false
  const canTransfer = platformsWithCapability('supportsLastResponse').length >= 1 && platformsWithCapability('supportsText').length >= 2
  document.querySelectorAll<HTMLButtonElement>('.panel-transfer').forEach((btn) => {
    const platform = btn.dataset.platform as AIPlatform | undefined
    btn.disabled = !canTransfer || !platform || !getPlatformCapabilities(platform).supportsLastResponse
  })
  btnSummary.disabled = platformsWithCapability('supportsText').length < 2
  renderChips()
}

const PROMPT_TEMPLATE_META: Record<UserPromptTemplateKey, { label: string; help: string }> = {
  transfer: {
    label: '转发提示词',
    help: '可用变量：{{fromLabel}} 表示来源 AI 名字，{{content}} 表示要转发的回答内容。',
  },
  summaryFinalAnswer: {
    label: '总结：最终结论',
    help: '可用变量：{{historyBlock}} 表示历史记录内容，{{modeInstruction}} 表示当前总结方式的补充要求。',
  },
  summaryDifferences: {
    label: '总结：只看分歧',
    help: '可用变量：{{historyBlock}} 表示历史记录内容，{{modeInstruction}} 表示当前总结方式的补充要求。',
  },
  summaryShort: {
    label: '总结：简短摘要',
    help: '可用变量：{{historyBlock}} 表示历史记录内容，{{modeInstruction}} 表示当前总结方式的补充要求。',
  },
  summaryOpinionDigest: {
    label: '总结：汇总意见',
    help: '可用变量：{{historyBlock}} 表示历史记录内容，{{modeInstruction}} 表示当前总结方式的补充要求。',
  },
}

function syncCurrentPromptDraft() {
  promptTemplateDrafts[selectedPromptTemplateKey] = settingPromptTemplate.value
}

function renderPromptTemplateEditor() {
  const meta = PROMPT_TEMPLATE_META[selectedPromptTemplateKey]
  settingPromptKind.value = selectedPromptTemplateKey
  settingPromptLabel.textContent = meta.label
  settingPromptTemplate.value = promptTemplateDrafts[selectedPromptTemplateKey]
  settingPromptHelp.textContent = meta.help
}

function renderSettingsForm() {
  for (const input of settingPlatformInputs()) {
    const platform = input.dataset.platform as AIPlatform
    input.checked = !!userSettings.enabledPlatforms[platform]
  }
  promptTemplateDrafts = { ...userSettings.promptTemplates }
  selectedPromptTemplateKey = settingPromptKind.value as UserPromptTemplateKey || 'transfer'
  renderPromptTemplateEditor()
}

function openSettings() {
  renderSettingsForm()
  settingsOverlay.hidden = false
}

function closeSettings() {
  settingsOverlay.hidden = true
}

function selectSettingsTab(tab: string) {
  document.querySelectorAll<HTMLButtonElement>('.settings-nav-item[data-settings-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.settingsTab === tab)
  })
  document.querySelectorAll<HTMLElement>('.settings-panel[data-settings-panel]').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.settingsPanel === tab)
  })
  btnSettingsSave.hidden = tab === 'help'
}

function toggleInputExpanded() {
  const expanded = composer.classList.toggle('expanded')
  btnExpandInput.textContent = expanded ? '⇲' : '⛶'
  btnExpandInput.title = expanded ? '收起输入框' : '放大输入框'
  btnExpandInput.setAttribute('aria-label', btnExpandInput.title)
  inputEl.focus()
}

async function initializeSettings() {
  try {
    applyUserSettings(await loadUserSettings())
  } catch (e) {
    console.error('[AIChatRoom chat] load settings failed', e)
    applyUserSettings(DEFAULT_USER_SETTINGS)
  }
}

async function onSaveSettings() {
  const enabledPlatforms = Object.fromEntries(
    allPlatforms().map((platform) => [platform, false]),
  ) as Record<AIPlatform, boolean>
  for (const input of settingPlatformInputs()) {
    enabledPlatforms[input.dataset.platform as AIPlatform] = input.checked
  }

  const selectedPlatforms = selectedSettingsPlatforms()
  if (selectedPlatforms.length < MIN_ACTIVE_PLATFORMS) {
    showToast(`至少保留 ${MIN_ACTIVE_PLATFORMS} 个 AI`, 'warn')
    renderSettingsForm()
    return
  }
  if (selectedPlatforms.length > MAX_ACTIVE_PLATFORMS) {
    showToast(`最多同时显示 ${MAX_ACTIVE_PLATFORMS} 个 AI`, 'warn')
    renderSettingsForm()
    return
  }

  syncCurrentPromptDraft()
  const next: UserSettings = {
    enabledPlatforms,
    platformOrder: userSettings.platformOrder,
    promptTemplates: promptTemplateDrafts,
  }

  btnSettingsSave.disabled = true
  try {
    const saved = await saveUserSettings(next)
    applyUserSettings(saved)
    closeSettings()
    await refreshAllStatuses()
    showToast('设置已保存', 'success', 1600)
  } catch (e) {
    console.error('[AIChatRoom chat] save settings failed', e)
    showToast('设置保存失败,请重试', 'err')
  } finally {
    btnSettingsSave.disabled = false
  }
}

// ---------- 附件处理 ----------
async function acceptFile(file: File) {
  // 清理旧的 object URL
  if (pendingImageObjectUrl) {
    URL.revokeObjectURL(pendingImageObjectUrl)
    pendingImageObjectUrl = null
  }

  let classification: FileClassification
  try {
    classification = classifyFile(file)
    assertFileWithinLimit(file, classification)
  } catch (e) {
    if (e instanceof UnsupportedFileTypeError) {
      showToast(getUnsupportedFileMessage(file), 'err', 7000)
      return
    }
    if (e instanceof FileTooLargeError) {
      showToast(`文件太大(${(file.size / 1024 / 1024).toFixed(1)}MB)`, 'err')
      return
    }
    throw e
  }

  let textContent: string | undefined
  if (classification.handling === 'inline-text') {
    try {
      const result = await inlineTextFile(file, inputEl.value.trim())
      textContent = result.textContent
    } catch (e) {
      console.error('[AIChatRoom chat] failed to read text file', e)
      showToast('读取文本文件失败', 'err')
      return
    }
  }

  pendingAttachment = { file, classification, textContent }

  if (classification.kind === 'image') {
    pendingImageObjectUrl = URL.createObjectURL(file)
    previewImg.src = pendingImageObjectUrl
    previewImg.hidden = false
  } else {
    previewImg.src = ''
    previewImg.hidden = true
  }

  imageMeta.textContent = `${file.name || 'file'} · ${(file.size / 1024).toFixed(0)}KB`
  imagePreview.hidden = false
  updateComposerToolbarVisibility()
  btnImage.classList.add('has-image')
  btnImage.title = `已附加文件: ${file.name || 'file'} — 点击替换`
  showToast(classification.handling === 'inline-text' ? '文本文件已附加' : '文件已附加', 'success', 1500)
}

function clearAttachment() {
  if (pendingImageObjectUrl) {
    URL.revokeObjectURL(pendingImageObjectUrl)
    pendingImageObjectUrl = null
  }
  pendingAttachment = null
  previewImg.src = ''
  previewImg.hidden = false
  imageMeta.textContent = ''
  imagePreview.hidden = true
  updateComposerToolbarVisibility()
  btnImage.classList.remove('has-image')
  btnImage.title = ATTACH_BUTTON_TITLE
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
    if (!getPlatformCapabilities(p).supportsEmbed) {
      readyMap[p] = false
      setStatus(p, 'warn', '待接入')
      const iframe = panelIframe(p)
      iframe.src = 'about:blank'
      continue
    }
    setStatus(p, 'warn', '检测中…')
    const iframe = panelIframe(p)
    if (iframe.src === 'about:blank' || !iframe.src) {
      iframe.src = platformUrl(p)
    }
    const ok = await waitForIframeReady(p)
    if (ok) {
      const capabilities = getPlatformCapabilities(p)
      if (capabilities.supportsText) {
        setStatus(p, 'ok', '已打开')
      } else {
        const state = await requestConversationState(p, 1000)
        if (state.status === 'error') setStatus(p, 'warn', state.errorMessage ?? '需检查')
        else setStatus(p, 'ok', '已打开')
      }
    } else {
      setStatus(p, 'err', '加载超时')
    }
  }
}

// ---------- 父页 ↔ iframe postMessage ----------
function postToIframe(p: AIPlatform, action: string, extra: Record<string, unknown> = {}) {
  const win = panelIframe(p).contentWindow
  if (!win) return
  win.postMessage({ source: 'aichatroom-parent', action, ...extra }, platformOrigin(p))
}

function requestLastResponse(p: AIPlatform, timeoutMs = 3000): Promise<string> {
  const win = panelIframe(p).contentWindow
  if (!win) return Promise.resolve('')
  return new Promise<string>((resolve) => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { source?: string; type?: string; platform?: AIPlatform; text?: string } | undefined
      if (
        e.source === win &&
        d?.source === 'aichatroom-content' &&
        d.type === 'last-response' &&
        d.platform === p
      ) {
        window.removeEventListener('message', onMsg)
        resolve(d.text ?? '')
      }
    }
    window.addEventListener('message', onMsg)
    postToIframe(p, 'get-last-response')
    setTimeout(() => {
      window.removeEventListener('message', onMsg)
      resolve('')
    }, timeoutMs)
  })
}

function requestConversationState(p: AIPlatform, timeoutMs = 3000): Promise<ConversationState> {
  const win = panelIframe(p).contentWindow
  if (!win) return Promise.resolve({ status: 'idle' })
  return new Promise<ConversationState>((resolve) => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as {
        source?: string
        type?: string
        platform?: AIPlatform
        state?: ConversationState
      } | undefined
      if (
        e.source === win &&
        d?.source === 'aichatroom-content' &&
        d.type === 'state' &&
        d.platform === p &&
        d.state
      ) {
        window.removeEventListener('message', onMsg)
        resolve(d.state)
      }
    }
    window.addEventListener('message', onMsg)
    postToIframe(p, 'get-state')
    setTimeout(() => {
      window.removeEventListener('message', onMsg)
      resolve({ status: 'idle' })
    }, timeoutMs)
  })
}

function requestPlatformLocation(p: AIPlatform, timeoutMs = 1500): Promise<string> {
  const win = panelIframe(p).contentWindow
  if (!win) return Promise.resolve('')
  return new Promise<string>((resolve) => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as {
        source?: string
        type?: string
        platform?: AIPlatform
        href?: string
      } | undefined
      if (
        e.source === win &&
        d?.source === 'aichatroom-content' &&
        d.type === 'location' &&
        d.platform === p
      ) {
        window.removeEventListener('message', onMsg)
        resolve(d.href ?? '')
      }
    }
    window.addEventListener('message', onMsg)
    postToIframe(p, 'get-location')
    setTimeout(() => {
      window.removeEventListener('message', onMsg)
      resolve('')
    }, timeoutMs)
  })
}

async function captureResponseBaselines(targets: AIPlatform[]): Promise<Partial<Record<AIPlatform, string>>> {
  const entries = await Promise.all(
    targets.map(async (platform) => [platform, await requestLastResponse(platform, 1500)] as const),
  )
  return Object.fromEntries(entries)
}

function scheduleSessionResponseBackfill(
  sessionId: string,
  platforms: AIPlatform[],
  baselines: Partial<Record<AIPlatform, string>>,
  progress: Partial<Record<AIPlatform, ResponseCaptureProgress>> = {},
  attempt = 0,
) {
  if (platforms.length === 0 || attempt >= RESPONSE_BACKFILL_MAX_ATTEMPTS) return

  setTimeout(() => {
    void backfillSessionResponses(sessionId, platforms, baselines, progress, attempt)
  }, RESPONSE_BACKFILL_INTERVAL_MS)
}

async function backfillSessionResponses(
  sessionId: string,
  platforms: AIPlatform[],
  baselines: Partial<Record<AIPlatform, string>>,
  progress: Partial<Record<AIPlatform, ResponseCaptureProgress>>,
  attempt: number,
) {
  try {
    const session = await getSession(sessionId)
    if (!session) return

    const pendingPlatforms = platforms.filter((platform) => {
      const response = session.responses[platform]
      return response?.status === 'pending'
    })
    if (pendingPlatforms.length === 0) return

    const captured: Partial<Record<AIPlatform, string>> = {}
    const nextProgress = { ...progress }
    await Promise.all(pendingPlatforms.map(async (platform) => {
      const state = await requestConversationState(platform, 1500)
      const text = state.lastResponse ? state.lastResponse : await requestLastResponse(platform, 1500)
      const decision = evaluateResponseCapture(
        { text, status: state.status },
        baselines[platform],
        progress[platform],
        RESPONSE_STABLE_REQUIRED_POLLS,
      )
      nextProgress[platform] = decision.progress
      if (decision.shouldCapture && isNewCapturedResponse(decision.text, baselines[platform])) {
        captured[platform] = decision.text
      }
    }))

    const updated = applyCapturedResponses(session, captured)
    if (updated !== session) await updateSession(updated)

    const remaining = pendingPlatforms.filter((platform) => !captured[platform])
    scheduleSessionResponseBackfill(sessionId, remaining, baselines, nextProgress, attempt + 1)
  } catch (e) {
    console.error('[AIChatRoom chat] response backfill failed', e)
  }
}

window.addEventListener('message', (e: MessageEvent) => {
  const data = e.data as
    | { source?: string; event?: string; platform?: AIPlatform; action?: string; ok?: boolean; error?: string }
    | undefined
  if (!data || data.source !== 'aichatroom-content') return

  if (data.event === 'ready' && data.platform && allPlatforms().includes(data.platform)) {
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
  if (!text && !pendingAttachment) {
    showToast('请输入文字或附加文件', 'warn')
    return
  }
  // 目标优先级:atSelected(UI 选) > 文本里手打 @xxx(向后兼容) > 全发
  let targets: AIPlatform[]
  if (atSelected.size > 0) {
    targets = platformsWithCapability('supportsText', [...atSelected])
  } else {
    const textPlatforms = platformsWithCapability('supportsText')
    const validKeys = new Set(textPlatforms)
    const mentioned = parseAtMentions(text, validKeys)
    targets = mentioned.length > 0 ? mentioned : textPlatforms
  }
  if (targets.length === 0) {
    showToast('当前没有可发送文本的 AI', 'warn')
    return
  }

  const deliveryPlan = buildAttachmentDeliveryPlan(
    targets,
    pendingAttachment?.classification ?? null,
    text.length > 0,
  )
  targets = deliveryPlan.sendTargets
  if (pendingAttachment?.classification.handling === 'file-upload') {
    if (deliveryPlan.manualUploadTargets.length > 0) {
      const labels = deliveryPlan.manualUploadTargets.map((p) => getPlatformMeta(p)?.label ?? p).join(' / ')
      const message = text.length > 0
        ? `${labels} 暂不支持自动上传这个文件类型,将只发送文字;可手动上传文件`
        : `${labels} 暂不支持自动上传这个文件类型,已跳过;可手动上传`
      showToast(message, 'warn', 6000)
    }
    if (targets.length === 0) {
      showToast('当前目标都不支持自动上传这个文件类型,请手动上传或改用 .md/.txt', 'warn', 6000)
      return
    }
  }

  // 1. 准备附件:上传类转 dataURL,文本类拼进 prompt。
  let imageDataUrl: string | undefined
  let imageMime: string | undefined
  let imageName: string | undefined
  let textToSend = text
  if (pendingAttachment?.classification.handling === 'inline-text') {
    textToSend = buildInlineTextPrompt(pendingAttachment.file.name, pendingAttachment.textContent ?? '', text)
  }
  if (pendingAttachment?.classification.handling === 'file-upload') {
    try {
      imageDataUrl = await fileToDataUrl(pendingAttachment.file)
      imageMime = pendingAttachment.file.type
      imageName = pendingAttachment.file.name
    } catch (e) {
      console.error('[AIChatRoom chat] failed to read file as data URL', e)
    }
  }

  const attachments: SessionAttachment[] = pendingAttachment
    ? [{
      id: `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: pendingAttachment.file.name,
      mime: pendingAttachment.file.type,
      size: pendingAttachment.file.size,
      kind: pendingAttachment.classification.kind,
      handling: pendingAttachment.classification.handling,
      inlinedText: pendingAttachment.classification.handling === 'inline-text' ? pendingAttachment.textContent : undefined,
      uploadStatus: pendingAttachment.classification.handling === 'file-upload' ? 'pending' : undefined,
    }]
    : []

  let currentSession: Session | null = createSessionRecord({
    prompt: text,
    sentPrompt: textToSend,
    targetPlatforms: targets,
    attachments,
  })
  try {
    await addSession(currentSession)
  } catch (e) {
    console.error('[AIChatRoom chat] failed to save session history', e)
    currentSession = null
  }

  const responseBaselines = await captureResponseBaselines(targets)

  // 2. 发文字 + 附件到 iframe(由 content script 交给 adapter)。
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
          const shouldUploadFile = deliveryPlan.autoUploadTargets.includes(p)
          postToIframe(p, 'write-and-send', {
            text: textToSend,
            imageDataUrl: shouldUploadFile ? imageDataUrl : undefined,
            imageMime: shouldUploadFile ? imageMime : undefined,
            imageName: shouldUploadFile ? imageName : undefined,
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

  if (currentSession) {
    try {
      currentSession = applySendResults(currentSession, results)
      await updateSession(currentSession)
      scheduleSessionResponseBackfill(
        currentSession.id,
        results.filter((r) => r.ok).map((r) => r.p),
        responseBaselines,
      )
    } catch (e) {
      console.error('[AIChatRoom chat] failed to update session history', e)
    }
  }
  scheduleConversationSnapshot(text, results.filter((r) => r.ok).map((r) => r.p))

  // 3. 根据结果给一个合并的 toast
  const okCount = results.filter((r) => r.ok).length
  if (pendingAttachment?.classification.handling === 'file-upload') {
    if (okCount === results.length && results.length > 0) {
      showToast('文件已发送到所有目标', 'success', 2500)
    } else if (okCount > 0) {
      // 部分成功:v0.5+ 不再走剪贴板兜底(跨源 iframe 写剪贴板经常失败)
      showToast('部分目标未自动接收文件,请手动上传到失败侧', 'warn', 6000)
    } else {
      // 全部失败:v0.5+ 不再走剪贴板兜底
      showToast('文件自动发送失败,请手动上传', 'err', 6000)
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
  clearAttachment()
  // onSend 完顺手清掉 at 选择(避免下条消息还受上一条的影响)
  // 不清 atSelected:如果想连发同一组目标,保留;但目前默认清掉,符合"每次明确选"的直觉
  // 选 1:不 clear(连发场景更顺手)
  // 选 2:clear(显式选择更可控)
  // —— 选 1
}

// ---------- @ 弹层 / Chips ----------
function getAllPanelMetas(): AIPlatformMeta[] {
  return platformsWithCapability('supportsText')
    .map((k) => getPlatformMeta(k))
    .filter((m): m is AIPlatformMeta => !!m)
}

function renderChips() {
  if (atSelected.size === 0) {
    atChipsEl.hidden = true
    atChipsEl.innerHTML = ''
    updateComposerToolbarVisibility()
    return
  }
  atChipsEl.hidden = false
  updateComposerToolbarVisibility()
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

// ---------- 转发(Transfer) ----------
const MAX_TRANSFER_LENGTH = 50_000

/**
 * 转发流程:点 panel A 的 .panel-transfer
 *   1) 候选 = 支持文本输入的平台.filter(p => p !== sourceKey)
 *   2) 弹出回答选择器,默认选中最新回答
 *   3) 用户可多选历史回答,再选择目标 AI 发送
 */
async function onTransfer(sourceKey: AIPlatform) {
  if (!getPlatformCapabilities(sourceKey).supportsLastResponse) {
    showToast(`${getPlatformMeta(sourceKey)?.label ?? sourceKey} 暂不支持读取回答`, 'warn')
    return
  }

  const candidates = platformsWithCapability('supportsText').filter((p) => p !== sourceKey)
  if (candidates.length === 0) {
    showToast('没有可转发的目标', 'warn')
    return
  }
  await openTransferDialog(sourceKey, candidates)
}

async function getCurrentTransferResponse(sourceKey: AIPlatform): Promise<string> {
  const state = await requestConversationState(sourceKey, 2000)
  if (!['idle', 'finished', 'error'].includes(state.status)) {
    showToast(`源 AI 还在生成中,等一会儿再试(当前: ${state.status})`, 'warn', 4000)
    return ''
  }
  return state.lastResponse?.trim() || await requestLastResponse(sourceKey, 3000)
}

function renderTransferTargets(sourceKey: AIPlatform, candidates: AIPlatform[]) {
  transferTargetList.innerHTML = ''
  candidates.forEach((platform, index) => {
    const meta = getPlatformMeta(platform)
    const item = document.createElement('label')
    item.className = 'transfer-target-item'

    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.name = 'transfer-target'
    checkbox.value = platform
    checkbox.checked = index === 0

    const text = document.createElement('span')
    text.textContent = meta?.label ?? platform

    item.append(checkbox, text)
    transferTargetList.appendChild(item)
  })
}

function selectedTransferTargets(): AIPlatform[] {
  return [...transferTargetList.querySelectorAll<HTMLInputElement>('input[name="transfer-target"]:checked')]
    .map((input) => input.value as AIPlatform)
}

function formatTransferTargetLabels(targets: AIPlatform[]): string {
  return targets
    .map((target) => getPlatformMeta(target)?.label ?? target)
    .join('、')
}

async function executeTransferToTargets(sourceKey: AIPlatform, targetKeys: AIPlatform[], selectedContent: string) {
  for (const targetKey of targetKeys) {
    await executeTransfer(sourceKey, targetKey, selectedContent)
  }
}

async function openTransferDialog(sourceKey: AIPlatform, candidates: AIPlatform[]) {
  transferSourcePlatform = sourceKey
  const sourceLabel = getPlatformMeta(sourceKey)?.label ?? sourceKey
  transferTitle.textContent = `选择要转发的 ${sourceLabel} 回答`
  transferOverlay.hidden = false
  transferList.innerHTML = '<div class="history-empty">正在读取可转发回答…</div>'
  transferPreview.innerHTML = ''
  transferSelected.textContent = '已选择 0 条回答'
  btnTransferSend.disabled = true
  renderTransferTargets(sourceKey, candidates)

  const [currentResponse, sessions] = await Promise.all([
    getCurrentTransferResponse(sourceKey),
    loadSessions(),
  ])

  if (transferSourcePlatform !== sourceKey || transferOverlay.hidden) return
  transferSourceOptions = buildTransferSourceOptions(
    sourceKey,
    sessions.sort((a, b) => b.createdAt - a.createdAt),
    { currentResponse },
  )
  renderTransferSourceList()
}

function closeTransferDialog() {
  transferOverlay.hidden = true
  transferSourcePlatform = null
  transferSourceOptions = []
  transferList.innerHTML = ''
  transferPreview.innerHTML = ''
}

function selectedTransferSourceOptions(): TransferSourceOption[] {
  return transferSourceOptions.filter((option) => option.selected)
}

function renderTransferSourceList() {
  transferList.innerHTML = ''
  if (transferSourceOptions.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'history-empty'
    empty.textContent = '没有可转发的已记录回答'
    transferList.appendChild(empty)
    updateTransferSelectedCount()
    return
  }

  for (const option of transferSourceOptions) {
    const item = document.createElement('label')
    item.className = 'summary-item'

    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.value = option.id
    checkbox.checked = option.selected

    const content = document.createElement('span')
    const title = document.createElement('span')
    title.className = 'summary-item-title'
    title.textContent = option.source === 'current' ? '当前页面最新回答' : compactText(option.prompt)
    const meta = document.createElement('span')
    meta.className = 'summary-item-meta'
    meta.textContent = `${formatTime(option.createdAt)} · ${option.source === 'current' ? '当前页面' : '历史记录'}`
    const preview = document.createElement('span')
    preview.className = 'summary-item-targets'
    preview.textContent = compactText(option.text, 72)

    content.append(title, meta, preview)
    item.append(checkbox, content)
    checkbox.addEventListener('change', () => {
      option.selected = checkbox.checked
      updateTransferSelectedCount()
    })
    transferList.appendChild(item)
  }
  updateTransferSelectedCount()
}

function updateTransferSelectedCount() {
  const count = selectedTransferSourceOptions().length
  transferSelected.textContent = `已选择 ${count} 条回答`
  btnTransferSend.disabled = count === 0 || !transferSourcePlatform || selectedTransferTargets().length === 0
  renderTransferPreview()
}

function renderTransferPreview() {
  transferPreview.innerHTML = ''
  const sourceKey = transferSourcePlatform
  const sourceLabel = sourceKey ? getPlatformMeta(sourceKey)?.label ?? sourceKey : '来源 AI'
  const selected = selectedTransferSourceOptions()
  if (selected.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'summary-preview-empty'
    empty.textContent = '勾选左侧回答后，这里会显示转发内容'
    transferPreview.appendChild(empty)
    return
  }

  const card = document.createElement('article')
  card.className = 'summary-preview-card'
  const header = document.createElement('header')
  header.className = 'summary-preview-card-header'
  const title = document.createElement('h4')
  title.className = 'summary-preview-title'
  title.textContent = `${sourceLabel} · ${selected.length} 条回答`
  const meta = document.createElement('div')
  meta.className = 'summary-preview-meta'
  const targets = selectedTransferTargets()
  meta.textContent = targets.length > 0
    ? `将发送到 ${formatTransferTargetLabels(targets)}`
    : '请选择转发目标'
  header.append(title, meta)
  card.appendChild(header)
  appendSummaryPreviewSection(card, '转发内容', buildTransferContent(selected, sourceLabel))
  transferPreview.appendChild(card)
}

async function onSendTransferSelection() {
  if (!transferSourcePlatform) return
  const targets = selectedTransferTargets()
  const selected = selectedTransferSourceOptions()
  if (targets.length === 0 || selected.length === 0) {
    showToast('请选择要转发的回答和目标 AI', 'warn')
    return
  }
  const sourceLabel = getPlatformMeta(transferSourcePlatform)?.label ?? transferSourcePlatform
  const content = buildTransferContent(selected, sourceLabel)
  const source = transferSourcePlatform
  closeTransferDialog()
  await executeTransferToTargets(source, targets, content)
}

async function executeTransfer(sourceKey: AIPlatform, targetKey: AIPlatform, selectedContent?: string) {
  // 找到源 panel header 按钮,设 busy
  const srcBtn = document.querySelector<HTMLButtonElement>(`.panel-transfer[data-platform="${sourceKey}"]`)
  const tgtBtn = document.querySelector<HTMLButtonElement>(`.panel-transfer[data-platform="${targetKey}"]`)
  if (srcBtn) {
    srcBtn.classList.add('busy')
    srcBtn.disabled = true
    srcBtn.textContent = '转发中…'
  }
  if (tgtBtn) tgtBtn.disabled = true

  try {
    const srcIframe = panelIframe(sourceKey)
    const srcWin = srcIframe.contentWindow
    if (!srcWin && !selectedContent) throw new Error('源 iframe 不可用')

    let content = selectedContent?.trim() ?? ''
    if (!content) {
      if (!srcWin) throw new Error('源 iframe 不可用')
      const srcState = await new Promise<{ status: string }>((resolve) => {
        const onMsg = (e: MessageEvent) => {
          const d = e.data as { source?: string; type?: string; platform?: AIPlatform; state?: { status: string } } | undefined
          if (
            e.source === srcWin &&
            d?.source === 'aichatroom-content' &&
            d.type === 'state' &&
            d.platform === sourceKey &&
            d.state
          ) {
            window.removeEventListener('message', onMsg)
            resolve(d.state)
          }
        }
        window.addEventListener('message', onMsg)
        srcWin.postMessage(
          { source: 'aichatroom-parent', action: 'get-state' },
          platformOrigin(sourceKey),
        )
        setTimeout(() => { window.removeEventListener('message', onMsg); resolve({ status: 'unknown' }) }, 2000)
      })

      if (!['idle', 'finished', 'error'].includes(srcState.status)) {
        showToast(`源 AI 还在生成中,等一会儿再试(当前: ${srcState.status})`, 'warn', 4000)
        return
      }

      content = await new Promise<string>((resolve) => {
        const onMsg = (e: MessageEvent) => {
          const d = e.data as { source?: string; type?: string; platform?: AIPlatform; text?: string } | undefined
          if (
            e.source === srcWin &&
            d?.source === 'aichatroom-content' &&
            d.type === 'last-response' &&
            d.platform === sourceKey
          ) {
            window.removeEventListener('message', onMsg)
            resolve(d.text ?? '')
          }
        }
        window.addEventListener('message', onMsg)
        srcWin.postMessage(
          { source: 'aichatroom-parent', action: 'get-last-response' },
          platformOrigin(sourceKey),
        )
        setTimeout(() => { window.removeEventListener('message', onMsg); resolve('') }, 3000)
      })
    }

    if (!content || !content.trim()) {
      showToast('源 AI 还没有回答可转发', 'warn', 4000)
      return
    }

    // 3. 目标状态轻量预检(50ms 超时,降级)
    const tgtIframe = panelIframe(targetKey)
    const tgtWin = tgtIframe.contentWindow
    if (tgtWin) {
      try {
        const tgtState = await new Promise<{ status: string } | null>((resolve) => {
          const onMsg = (e: MessageEvent) => {
            const d = e.data as { source?: string; type?: string; platform?: AIPlatform; state?: { status: string } } | undefined
            if (
              e.source === tgtWin &&
              d?.source === 'aichatroom-content' &&
              d.type === 'state' &&
              d.platform === targetKey &&
              d.state
            ) {
              window.removeEventListener('message', onMsg)
              resolve(d.state)
            }
          }
          window.addEventListener('message', onMsg)
          tgtWin.postMessage(
            { source: 'aichatroom-parent', action: 'get-state' },
            platformOrigin(targetKey),
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
    const prompt = renderTemplate(userSettings.promptTemplates.transfer, { fromLabel, content: finalContent })

    // 6. 发送到目标
    showToast(`正在把 ${fromLabel} 的回答转发给 ${getPlatformMeta(targetKey)?.label ?? targetKey}…`, 'info', 2000)
    tgtWin?.postMessage(
      { source: 'aichatroom-parent', action: 'write-and-send', text: prompt },
      platformOrigin(targetKey),
    )
  } catch (e) {
    console.error('[AIChatRoom chat] transfer failed', e)
    showToast(`转发失败: ${e instanceof Error ? e.message : String(e)}`, 'err', 5000)
  } finally {
    if (srcBtn) {
      srcBtn.classList.remove('busy')
      srcBtn.disabled = !getPlatformCapabilities(sourceKey).supportsLastResponse
      srcBtn.textContent = '转发 ➔'
    }
    if (tgtBtn) tgtBtn.disabled = !getPlatformCapabilities(targetKey).supportsLastResponse
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

// ---------- 历史记录 ----------
function compactText(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (!oneLine) return '空问题'
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine
}

function responseLabel(response?: SessionResponse): string {
  if (!response) return '未发送'
  if (response.status === 'captured') return '已记录'
  if (response.status === 'failed') return '发送失败'
  return '待回填'
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

function renderHistoryList() {
  historyList.innerHTML = ''
  if (historySessions.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'history-empty'
    empty.textContent = '还没有历史记录'
    historyList.appendChild(empty)
    return
  }

  const visibleSessions = filterSessionsByTitle(historySessions, historySearchInput.value)
  if (visibleSessions.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'history-empty'
    empty.textContent = '没有匹配的历史记录'
    historyList.appendChild(empty)
    return
  }

  for (const session of visibleSessions) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = `history-item${session.id === selectedHistoryId ? ' active' : ''}`
    item.dataset.sessionId = session.id

    const title = document.createElement('span')
    title.className = 'history-item-title'
    title.textContent = compactText(session.prompt)

    const meta = document.createElement('span')
    meta.className = 'history-item-meta'
    meta.textContent = formatTime(session.createdAt)

    const targets = document.createElement('span')
    targets.className = 'history-item-targets'
    targets.textContent = summarizeSessionTargets(session)

    item.append(title, meta, targets)
    item.addEventListener('click', () => {
      selectedHistoryId = session.id
      renderHistoryList()
      renderHistoryDetail(session)
      void refreshAndRenderHistorySession(session)
    })
    historyList.appendChild(item)
  }
}

function selectFirstVisibleHistorySession() {
  const visibleSessions = filterSessionsByTitle(historySessions, historySearchInput.value)
  selectedHistoryId = visibleSessions[0]?.id ?? null
  renderHistoryList()
  renderHistoryDetail(visibleSessions[0])
}

function renderHistoryDetail(session?: Session) {
  historyDetail.innerHTML = ''
  if (!session) {
    const empty = document.createElement('div')
    empty.className = 'history-empty'
    empty.textContent = historySessions.length === 0 ? '还没有历史记录' : '选择一条历史记录查看详情'
    historyDetail.appendChild(empty)
    return
  }

  const header = document.createElement('div')
  header.className = 'history-detail-header'

  const headingWrap = document.createElement('div')
  const title = document.createElement('h3')
  title.className = 'history-detail-title'
  title.textContent = compactText(session.prompt, 120)
  const meta = document.createElement('div')
  meta.className = 'history-detail-meta'
  meta.textContent = `${formatTime(session.createdAt)} · ${summarizeSessionTargets(session)}`
  headingWrap.append(title, meta)

  const actions = document.createElement('div')
  actions.className = 'history-actions'
  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'history-action'
  copyBtn.textContent = '复制 Markdown'
  copyBtn.addEventListener('click', () => void copySessionMarkdown(session))
  const exportBtn = document.createElement('button')
  exportBtn.type = 'button'
  exportBtn.className = 'history-action'
  exportBtn.textContent = '导出 Markdown'
  exportBtn.addEventListener('click', () => exportSessionMarkdown(session))
  const deleteBtn = document.createElement('button')
  deleteBtn.type = 'button'
  deleteBtn.className = 'history-action danger'
  deleteBtn.textContent = '删除'
  deleteBtn.addEventListener('click', () => void deleteHistorySession(session.id))
  actions.append(copyBtn, exportBtn, deleteBtn)
  header.append(headingWrap, actions)
  historyDetail.appendChild(header)

  if (session.summaries.length > 0 && session.prompt.startsWith('【总结】')) {
    appendHistorySection('总结信息', formatSummaryHistoryInfo(session.summaries[0]))
  }
  appendHistorySection('用户问题', session.prompt || '空')
  if (session.sentPrompt && session.sentPrompt !== session.prompt) {
    appendHistorySection('实际发送内容', session.sentPrompt)
  }
  if (session.attachments.length > 0) {
    appendAttachmentSection(session.attachments)
  }
  for (const platform of session.targetPlatforms) {
    const label = getPlatformMeta(platform)?.label ?? platform
    const response = session.responses[platform]
    const text = response?.status === 'captured' && response.text.trim()
      ? response.text
      : responseLabel(response)
    appendHistorySection(`${label} 回答`, text)
  }
}

function appendHistorySection(titleText: string, bodyText: string) {
  const section = document.createElement('section')
  section.className = 'history-section'
  const header = document.createElement('div')
  header.className = 'history-section-header'
  const title = document.createElement('h3')
  title.textContent = titleText
  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'history-block-copy'
  copyBtn.title = `复制${titleText}`
  copyBtn.textContent = '复制'
  copyBtn.addEventListener('click', () => void copyHistoryBlockText(bodyText))
  const body = document.createElement('pre')
  body.className = 'history-block'
  body.textContent = bodyText
  header.append(title, copyBtn)
  section.append(header, body)
  historyDetail.appendChild(section)
}

async function copyHistoryBlockText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    showToast('已复制内容', 'success', 1200)
  } catch (e) {
    console.error('[AIChatRoom chat] failed to copy history block', e)
    showToast('复制失败,请稍后重试', 'err', 3000)
  }
}

function formatSummaryHistoryInfo(summary: SessionSummary): string {
  const targetLabel = getPlatformMeta(summary.target)?.label ?? summary.target
  const modeLabel = SUMMARY_MODE_LABELS[summary.mode]
  const sourceCount = summary.sourceSessionIds.length
  return [
    `总结目标：${targetLabel}`,
    `总结方式：${modeLabel}`,
    `来源历史：${sourceCount} 条`,
    `发送时间：${formatTime(summary.sentAt ?? summary.timestamp)}`,
  ].join('\n')
}

function appendAttachmentSection(attachments: SessionAttachment[]) {
  const section = document.createElement('section')
  section.className = 'history-section'
  const title = document.createElement('h3')
  title.textContent = '附件'
  const list = document.createElement('ul')
  list.className = 'history-attachments'
  for (const attachment of attachments) {
    const item = document.createElement('li')
    item.textContent = `${attachment.name} · ${attachment.mime || '未知类型'} · ${formatBytes(attachment.size)}`
    list.appendChild(item)
  }
  section.append(title, list)
  historyDetail.appendChild(section)
}

async function copySessionMarkdown(session: Session) {
  try {
    await navigator.clipboard.writeText(formatSessionMarkdown(session))
    showToast('已复制历史 Markdown', 'success', 1600)
  } catch (e) {
    console.error('[AIChatRoom chat] failed to copy history markdown', e)
    showToast('复制失败,请稍后重试', 'err', 3000)
  }
}

function exportSessionMarkdown(session: Session) {
  const report = buildSessionMarkdownExport(session)
  const blob = new Blob([report.content], { type: report.mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = report.filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
  showToast('已导出 Markdown 报告', 'success', 1600)
}

async function deleteHistorySession(id: string) {
  if (!confirm('确定删除这条历史记录吗？')) return
  await deleteSession(id)
  historySessions = historySessions.filter((s) => s.id !== id)
  selectFirstVisibleHistorySession()
  showToast('历史记录已删除', 'success', 1600)
}

async function refreshAndRenderHistorySession(session: Session) {
  const refreshed = await refreshSessionResponses(session)
  if (refreshed === session) return
  historySessions = historySessions.map((s) => (s.id === refreshed.id ? refreshed : s))
  renderHistoryList()
  if (selectedHistoryId === refreshed.id) renderHistoryDetail(refreshed)
}

async function refreshSessionResponses(session: Session): Promise<Session> {
  const captured: Partial<Record<AIPlatform, string>> = {}
  for (const platform of session.targetPlatforms) {
    const current = session.responses[platform]
    if (current?.status === 'captured' && current.text.trim()) continue
    captured[platform] = await requestLastResponse(platform)
  }
  const updated = applyCapturedResponses(session, captured)
  if (updated !== session) await updateSession(updated)
  return updated
}

async function openHistory() {
  historyOverlay.hidden = false
  historySearchInput.value = ''
  historyDetail.innerHTML = '<div class="history-empty">正在刷新最新回答…</div>'
  historySessions = (await loadSessions()).sort((a, b) => b.createdAt - a.createdAt)
  if (historySessions[0]) {
    const refreshed = await refreshSessionResponses(historySessions[0])
    historySessions = historySessions.map((s) => (s.id === refreshed.id ? refreshed : s))
  }
  selectedHistoryId = historySessions[0]?.id ?? null
  renderHistoryList()
  renderHistoryDetail(historySessions[0])
}

function closeHistory() {
  historyOverlay.hidden = true
}

function conversationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `conversation-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function conversationPlatformLabels(entry: ConversationEntry): string {
  return entry.enabledPlatforms
    .filter((platform) => entry.platformUrls[platform])
    .map((platform) => getPlatformMeta(platform)?.label ?? platform)
    .join(' / ')
}

async function saveConversationSnapshot(title: string, platforms: AIPlatform[]) {
  const entries = await Promise.all(
    platforms.map(async (platform) => [platform, await requestPlatformLocation(platform)] as const),
  )
  const platformUrls = Object.fromEntries(
    entries.filter(([platform, url]) => isSpecificConversationUrl(platform, url)),
  ) as Partial<Record<AIPlatform, string>>
  if (Object.keys(platformUrls).length === 0) return

  await upsertConversation({
    id: conversationId(),
    title: compactText(title, 90),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    enabledPlatforms: platforms,
    platformOrder: userSettings.platformOrder,
    platformUrls,
  })
}

function scheduleConversationSnapshot(title: string, platforms: AIPlatform[]) {
  const activeTargets = platforms.filter((platform) => getPlatformCapabilities(platform).supportsEmbed)
  if (activeTargets.length === 0) return
  setTimeout(() => void saveConversationSnapshot(title, activeTargets), 1500)
  setTimeout(() => void saveConversationSnapshot(title, activeTargets), 4500)
}

function renderConversationList() {
  conversationList.innerHTML = ''
  if (conversationEntries.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'history-empty'
    empty.textContent = '还没有会话历史'
    conversationList.appendChild(empty)
    return
  }

  for (const entry of conversationEntries) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'conversation-item'

    const main = document.createElement('span')
    main.className = 'conversation-main'
    const title = document.createElement('span')
    title.className = 'conversation-item-title'
    title.textContent = entry.title
    const platforms = document.createElement('span')
    platforms.className = 'conversation-item-platforms'
    platforms.textContent = conversationPlatformLabels(entry)
    main.append(title, platforms)

    const time = document.createElement('span')
    time.className = 'conversation-item-time'
    time.textContent = formatTime(entry.updatedAt)

    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.className = 'conversation-delete'
    deleteBtn.title = '删除会话历史'
    deleteBtn.textContent = '删'
    deleteBtn.addEventListener('click', (event) => {
      event.stopPropagation()
      void deleteConversationEntry(entry.id)
    })

    item.append(main, time, deleteBtn)
    item.addEventListener('click', () => void restoreConversation(entry))
    conversationList.appendChild(item)
  }
}

async function deleteConversationEntry(id: string) {
  if (!confirm('确定删除这条会话历史吗？')) return
  await deleteConversation(id)
  conversationEntries = conversationEntries.filter((entry) => entry.id !== id)
  renderConversationList()
  showToast('会话历史已删除', 'success', 1600)
}

function conversationRestoreOrder(entry: ConversationEntry): AIPlatform[] {
  const base = entry.platformOrder ?? entry.enabledPlatforms
  const result: AIPlatform[] = []
  for (const platform of base) {
    if (!result.includes(platform)) result.push(platform)
  }
  for (const platform of allPlatforms()) {
    if (!result.includes(platform)) result.push(platform)
  }
  return result
}

async function restoreConversation(entry: ConversationEntry) {
  const enabledPlatforms = Object.fromEntries(
    allPlatforms().map((platform) => [platform, entry.enabledPlatforms.includes(platform)]),
  ) as Record<AIPlatform, boolean>
  const saved = await saveUserSettings({
    enabledPlatforms,
    platformOrder: conversationRestoreOrder(entry),
    promptTemplates: userSettings.promptTemplates,
  })
  applyUserSettings(saved)

  for (const [platform, url] of Object.entries(entry.platformUrls) as Array<[AIPlatform, string | undefined]>) {
    if (!url) continue
    const panel = platformPanel(platform)
    if (!panel) continue
    readyMap[platform] = false
    setStatus(platform, 'warn', '加载中…')
    panelIframe(platform).src = url
  }
  closeConversationHistory()
  showToast('已打开会话历史', 'success', 1600)
  void refreshAllStatuses()
}

async function openConversationHistory() {
  conversationOverlay.hidden = false
  conversationList.innerHTML = '<div class="history-empty">正在读取会话历史…</div>'
  conversationEntries = await loadConversations()
  renderConversationList()
}

function closeConversationHistory() {
  conversationOverlay.hidden = true
}

const SUMMARY_MODE_LABELS: Record<SummaryMode, string> = {
  'final-answer': '最终结论',
  differences: '只看分歧',
  'short-summary': '简短摘要',
  'opinion-digest': '汇总意见',
}

const SUMMARY_MODE_TEMPLATE_KEYS: Record<SummaryMode, UserPromptTemplateKey> = {
  'final-answer': 'summaryFinalAnswer',
  differences: 'summaryDifferences',
  'short-summary': 'summaryShort',
  'opinion-digest': 'summaryOpinionDigest',
}

function pickSummaryTarget(): AIPlatform | null {
  const active = platformsWithCapability('supportsText')
  if (active.includes('chatgpt')) return 'chatgpt'
  if (active.includes('gemini')) return 'gemini'
  return null
}

function renderSummaryTargets() {
  summaryTargetSelect.innerHTML = ''
  for (const platform of platformsWithCapability('supportsText')) {
    const option = document.createElement('option')
    option.value = platform
    option.textContent = getPlatformMeta(platform)?.label ?? platform
    summaryTargetSelect.appendChild(option)
  }
  const preferred = pickSummaryTarget()
  if (preferred) summaryTargetSelect.value = preferred
}

function renderSummaryList() {
  summaryList.innerHTML = ''
  if (summarySessions.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'history-empty'
    empty.textContent = '还没有历史记录'
    summaryList.appendChild(empty)
    updateSummarySelectedCount()
    return
  }

  for (const session of summarySessions) {
    const item = document.createElement('label')
    item.className = 'summary-item'

    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.value = session.id
    checkbox.checked = selectedSummaryIds.has(session.id)

    const content = document.createElement('span')
    const title = document.createElement('span')
    title.className = 'summary-item-title'
    title.textContent = compactText(session.prompt)
    const meta = document.createElement('span')
    meta.className = 'summary-item-meta'
    meta.textContent = formatTime(session.createdAt)
    const targets = document.createElement('span')
    targets.className = 'summary-item-targets'
    targets.textContent = summarizeSessionTargets(session)

    content.append(title, meta, targets)
    item.append(checkbox, content)
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedSummaryIds.add(session.id)
      else selectedSummaryIds.delete(session.id)
      resetSummarySourceSelection()
      updateSummarySelectedCount()
    })
    summaryList.appendChild(item)
  }
  updateSummarySelectedCount()
}

function updateSummarySelectedCount() {
  summarySelected.textContent = `已选择 ${selectedSummaryIds.size} 条历史`
  btnSummaryGenerate.disabled = selectedSummaryIds.size === 0
  renderSummarySourceOptions()
  renderSummaryPreview()
}

function availableSummaryPlatforms(): AIPlatform[] {
  const selected = selectedSummarySessions()
  const seen = new Set<AIPlatform>()
  const result: AIPlatform[] = []
  for (const platform of allPlatforms()) {
    if (!selected.some((session) => session.targetPlatforms.includes(platform))) continue
    if (seen.has(platform)) continue
    seen.add(platform)
    result.push(platform)
  }
  return result
}

function resetSummarySourceSelection() {
  selectedSummaryPlatforms.clear()
  for (const platform of availableSummaryPlatforms()) {
    selectedSummaryPlatforms.add(platform)
  }
}

function renderSummarySourceOptions() {
  summarySourceList.innerHTML = ''
  const platforms = availableSummaryPlatforms()
  if (platforms.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'summary-preview-empty'
    empty.textContent = '先选择包含 AI 回复的历史'
    summarySourceList.appendChild(empty)
    return
  }
  for (const platform of platforms) {
    const label = document.createElement('label')
    label.className = 'transfer-target-item'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.value = platform
    input.checked = selectedSummaryPlatforms.has(platform)
    input.addEventListener('change', () => {
      if (input.checked) selectedSummaryPlatforms.add(platform)
      else selectedSummaryPlatforms.delete(platform)
      renderSummaryPreview()
    })
    const text = document.createElement('span')
    text.textContent = getPlatformMeta(platform)?.label ?? platform
    label.append(input, text)
    summarySourceList.appendChild(label)
  }
}

function renderSummaryPreview() {
  summaryPreview.innerHTML = ''
  const sessions = selectedSummarySessions().sort((a, b) => b.createdAt - a.createdAt)
  if (sessions.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'summary-preview-empty'
    empty.textContent = '勾选左侧历史后，这里会显示具体聊天内容'
    summaryPreview.appendChild(empty)
    return
  }

  for (const session of sessions) {
    const card = document.createElement('article')
    card.className = 'summary-preview-card'

    const header = document.createElement('header')
    header.className = 'summary-preview-card-header'
    const title = document.createElement('h4')
    title.className = 'summary-preview-title'
    title.textContent = compactText(session.prompt, 90)
    const meta = document.createElement('div')
    meta.className = 'summary-preview-meta'
    meta.textContent = `${formatTime(session.createdAt)} · ${summarizeSessionTargets(session)}`
    header.append(title, meta)
    card.appendChild(header)

    appendSummaryPreviewSection(card, '用户问题', session.prompt || '空')
    if (session.sentPrompt && session.sentPrompt !== session.prompt) {
      appendSummaryPreviewSection(card, '实际发送内容', session.sentPrompt)
    }
    for (const platform of session.targetPlatforms) {
      if (!selectedSummaryPlatforms.has(platform)) continue
      const label = getPlatformMeta(platform)?.label ?? platform
      const response = session.responses[platform]
      const text = response?.status === 'captured' && response.text.trim()
        ? response.text
        : responseLabel(response)
      appendSummaryPreviewSection(card, `${label} 回答`, text)
    }

    summaryPreview.appendChild(card)
  }
}

function appendSummaryPreviewSection(card: HTMLElement, titleText: string, bodyText: string) {
  const section = document.createElement('section')
  section.className = 'summary-preview-section'
  const title = document.createElement('h4')
  title.textContent = titleText
  const body = document.createElement('pre')
  body.className = 'summary-preview-text'
  body.textContent = truncatePreviewText(bodyText)
  section.append(title, body)
  card.appendChild(section)
}

function truncatePreviewText(text: string, max = 1200): string {
  const normalized = text.trim() || '空'
  return normalized.length > max ? `${normalized.slice(0, max)}\n\n……内容较长，生成总结时会使用完整内容。` : normalized
}

async function openSummaryDialog() {
  summaryOverlay.hidden = false
  summaryList.innerHTML = '<div class="history-empty">正在读取历史记录…</div>'
  selectedSummaryIds.clear()
  selectedSummaryPlatforms.clear()
  renderSummaryTargets()
  summaryModeSelect.value = 'final-answer'

  summarySessions = (await loadSessions()).sort((a, b) => b.createdAt - a.createdAt)
  if (summarySessions[0]) {
    const refreshed = await refreshSessionResponses(summarySessions[0])
    summarySessions = summarySessions.map((s) => (s.id === refreshed.id ? refreshed : s))
    selectedSummaryIds.add(refreshed.id)
  }
  resetSummarySourceSelection()
  renderSummaryList()
}

function closeSummaryDialog() {
  summaryOverlay.hidden = true
}

function selectedSummarySessions(): Session[] {
  return summarySessions
    .filter((session) => selectedSummaryIds.has(session.id))
    .sort((a, b) => a.createdAt - b.createdAt)
}

function hasCapturedResponseFromPlatforms(session: Session, platforms: AIPlatform[]): boolean {
  return platforms.some((platform) => {
    const response = session.responses[platform]
    return response?.status === 'captured' && response.text.trim().length > 0
  })
}

function summarySessionTitle(sessions: Session[], mode: SummaryMode): string {
  const firstPrompt = compactText(sessions[0]?.prompt ?? '历史记录', 56)
  const modeLabel = SUMMARY_MODE_LABELS[mode]
  const countLabel = sessions.length > 1 ? `${firstPrompt} 等 ${sessions.length} 条` : firstPrompt
  return `【总结】${modeLabel} · ${countLabel}`
}

async function onGenerateSummary() {
  const target = summaryTargetSelect.value as AIPlatform
  if (!target) {
    showToast('没有可用的总结目标 AI', 'warn')
    return
  }

  const sessions = selectedSummarySessions()
  if (sessions.length === 0) {
    showToast('请至少选择一条历史记录', 'warn')
    return
  }
  const includedPlatforms = [...selectedSummaryPlatforms]
  if (includedPlatforms.length === 0) {
    showToast('请至少选择一个参与总结的 AI', 'warn')
    return
  }
  const incomplete = sessions.filter((session) => !hasCapturedResponseFromPlatforms(session, includedPlatforms))
  if (incomplete.length > 0) {
    showToast(`有 ${incomplete.length} 条历史还没有可用回答,等 AI 回答完成后再试`, 'warn', 5000)
    return
  }

  const mode = summaryModeSelect.value as SummaryMode
  const prompt = buildSummaryPrompt(userSettings.promptTemplates[SUMMARY_MODE_TEMPLATE_KEYS[mode]], sessions, {
    targetLabel: getPlatformMeta(target)?.label ?? target,
    mode,
    modeLabel: SUMMARY_MODE_LABELS[mode],
    includedPlatforms,
  })
  const summary: SessionSummary = {
    id: `summary-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    target,
    range: 'manual',
    mode,
    prompt,
    status: 'sent',
    sourceSessionIds: sessions.map((session) => session.id),
    timestamp: Date.now(),
    sentAt: Date.now(),
  }

  btnSummaryGenerate.disabled = true
  try {
    const summaryBaselines = await captureResponseBaselines([target])
    const summarySession = createSummarySessionRecord({
      title: summarySessionTitle(sessions, mode),
      prompt,
      target,
      summary,
    })
    await addSession(summarySession)

    for (const session of sessions) {
      await updateSession({
        ...session,
        summaries: [summary, ...(session.summaries ?? [])],
        updatedAt: Date.now(),
      })
    }
    postToIframe(target, 'write-and-send', { text: prompt })
    scheduleSessionResponseBackfill(summarySession.id, [target], summaryBaselines)
    closeSummaryDialog()
    showToast(`已发送总结请求到 ${getPlatformMeta(target)?.label ?? target}`, 'success', 1800)
  } catch (e) {
    console.error('[AIChatRoom chat] summary failed', e)
    showToast(`总结失败: ${e instanceof Error ? e.message : String(e)}`, 'err', 5000)
  } finally {
    updateSummarySelectedCount()
  }
}

// ---------- 工具按钮(暂作占位) ----------
// 转发按钮(panel header 上的 .panel-transfer)由 setupTransferButtons() 单独绑定(动态 target)
async function onSummary() {
  if (activePlatforms().length === 0) {
    showToast('没有可用的总结目标 AI', 'warn')
    return
  }
  await openSummaryDialog()
}
function onQuote() { console.log('[AIChatRoom chat] quote: not implemented yet') }
function onHistory() { void openHistory() }

// ---------- 图片按钮 ----------
function onImageClick() {
  // 触发隐藏的 file input
  fileInput.click()
}

function onFileInputChange(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (file) void acceptFile(file)
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
        void acceptFile(file)
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
      void acceptFile(file)
      return
    }
  }
}

// ---------- 分隔条拖拽 ----------
function setupSplitter() {
  let draggingSplitter: HTMLElement | null = null
  let startX = 0
  let leftStartWidth = 0
  let rightStartWidth = 0
  let leftPanel: HTMLElement | null = null
  let rightPanel: HTMLElement | null = null

  const findVisiblePanel = (from: Element | null, direction: 'previous' | 'next'): HTMLElement | null => {
    let current = from
    while (current) {
      if (current instanceof HTMLElement && current.classList.contains('panel') && !current.hidden) return current
      current = direction === 'previous' ? current.previousElementSibling : current.nextElementSibling
    }
    return null
  }

  document.querySelectorAll<HTMLElement>('.splitter').forEach((splitterEl) => {
    splitterEl.addEventListener('mousedown', (e) => {
      leftPanel = findVisiblePanel(splitterEl.previousElementSibling, 'previous')
      rightPanel = findVisiblePanel(splitterEl.nextElementSibling, 'next')
      if (!leftPanel || !rightPanel) return

      draggingSplitter = splitterEl
      startX = e.clientX
      leftStartWidth = leftPanel.getBoundingClientRect().width
      rightStartWidth = rightPanel.getBoundingClientRect().width
      splitterEl.classList.add('dragging')
      e.preventDefault()
    })
  })
  window.addEventListener('mousemove', (e) => {
    if (!draggingSplitter || !leftPanel || !rightPanel) return
    const total = leftStartWidth + rightStartWidth
    if (total <= 0) return

    const delta = e.clientX - startX
    const minWidth = 240
    const leftWidth = Math.max(minWidth, Math.min(total - minWidth, leftStartWidth + delta))
    const rightWidth = total - leftWidth

    leftPanel.style.flex = `0 0 ${leftWidth}px`
    rightPanel.style.flex = `0 0 ${rightWidth}px`
  })
  window.addEventListener('mouseup', () => {
    if (draggingSplitter) {
      draggingSplitter.classList.remove('dragging')
      draggingSplitter = null
      leftPanel = null
      rightPanel = null
    }
  })
}

// ---------- 打开外部 tab ----------
function setupOpenButtons() {
  for (const p of allPlatforms()) {
    document.querySelector<HTMLButtonElement>(`.panel-open[data-platform="${p}"]`)!
      .addEventListener('click', () => {
        chrome.tabs.create({ url: platformUrl(p) })
      })
  }
}

function closePanelSwitchMenu() {
  panelSwitchMenu.hidden = true
  delete panelSwitchMenu.dataset.sourcePlatform
  delete panelSwitchMenu.dataset.mode
}

function positionPanelSwitchMenu(anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect()
  const wasHidden = panelSwitchMenu.hidden
  if (wasHidden) {
    panelSwitchMenu.hidden = false
    panelSwitchMenu.style.visibility = 'hidden'
  }

  const menuWidth = panelSwitchMenu.offsetWidth || 170
  const menuHeight = panelSwitchMenu.offsetHeight || 180
  const belowTop = rect.bottom + 6
  const aboveTop = rect.top - menuHeight - 6
  const top = belowTop + menuHeight > window.innerHeight
    ? Math.max(8, aboveTop)
    : belowTop
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8))

  panelSwitchMenu.style.left = `${left}px`
  panelSwitchMenu.style.top = `${top}px`
  if (wasHidden) {
    panelSwitchMenu.style.visibility = ''
    panelSwitchMenu.hidden = true
  }
}

function appendPanelMenuItem(platform: AIPlatform, active: boolean, statusText: string, onClick: () => void) {
  const meta = getPlatformMeta(platform)
  const item = document.createElement('button')
  item.type = 'button'
  item.className = active ? 'active' : ''
  item.dataset.platform = platform
  const icon = document.createElement('span')
  icon.textContent = meta?.icon ?? ''
  const label = document.createElement('span')
  label.textContent = meta?.label ?? platform
  const status = document.createElement('span')
  status.className = 'switch-menu-status'
  status.textContent = statusText
  item.append(icon, label, status)
  item.addEventListener('click', onClick)
  panelSwitchMenu.appendChild(item)
}

function renderPanelSwitchMenu(source: AIPlatform) {
  panelSwitchMenu.innerHTML = ''
  panelSwitchMenu.dataset.mode = 'switch'
  panelSwitchMenu.dataset.sourcePlatform = source
  for (const platform of allPlatforms()) {
    appendPanelMenuItem(
      platform,
      platform === source,
      userSettings.enabledPlatforms[platform] ? '已显示' : '未显示',
      () => void onSwitchPanel(source, platform),
    )
  }
}

function renderPanelAddMenu() {
  panelSwitchMenu.innerHTML = ''
  panelSwitchMenu.dataset.mode = 'add'
  const hiddenPlatforms = allPlatforms().filter((platform) => !userSettings.enabledPlatforms[platform])
  for (const platform of hiddenPlatforms) {
    appendPanelMenuItem(platform, false, '添加', () => void onAddPanel(platform))
  }
  if (hiddenPlatforms.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'at-popup-empty'
    empty.textContent = '没有可添加的 AI'
    panelSwitchMenu.appendChild(empty)
  }
}

function openPanelSwitchMenu(source: AIPlatform, anchor: HTMLElement) {
  renderPanelSwitchMenu(source)
  positionPanelSwitchMenu(anchor)
  panelSwitchMenu.hidden = false
}

function openPanelAddMenu(anchor: HTMLElement) {
  const hiddenPlatforms = allPlatforms().filter((platform) => !userSettings.enabledPlatforms[platform])
  if (hiddenPlatforms.length === 0) {
    closePanelSwitchMenu()
    showToast('当前所有 AI 都已显示', 'info', 1800)
    return
  }
  renderPanelAddMenu()
  positionPanelSwitchMenu(anchor)
  panelSwitchMenu.hidden = false
}

async function savePanelSettings(next: UserSettings, successMessage: string, errorMessage: string) {
  try {
    const saved = await saveUserSettings(next)
    applyUserSettings(saved)
    await refreshAllStatuses()
    showToast(successMessage, 'success', 1600)
  } catch (e) {
    console.error('[AIChatRoom chat] panel settings failed', e)
    showToast(errorMessage, 'err', 3000)
  }
}

async function onSwitchPanel(source: AIPlatform, target: AIPlatform) {
  closePanelSwitchMenu()
  if (source === target) return
  const enabledPlatforms = { ...userSettings.enabledPlatforms }
  if (!enabledPlatforms[target]) {
    enabledPlatforms[target] = true
    enabledPlatforms[source] = false
  }
  const next: UserSettings = {
    enabledPlatforms,
    platformOrder: swapPlatformOrder(userSettings.platformOrder, source, target),
    promptTemplates: userSettings.promptTemplates,
  }

  await savePanelSettings(next, 'AI 面板位置已更新', '切换失败,请稍后重试')
}

async function onAddPanel(platform: AIPlatform) {
  closePanelSwitchMenu()
  const enabledPlatforms = { ...userSettings.enabledPlatforms }
  if (enabledPlatformKeys().length >= MAX_ACTIVE_PLATFORMS) {
    showToast(`最多同时显示 ${MAX_ACTIVE_PLATFORMS} 个 AI`, 'warn')
    return
  }
  enabledPlatforms[platform] = true
  await savePanelSettings({
    enabledPlatforms,
    platformOrder: userSettings.platformOrder,
    promptTemplates: userSettings.promptTemplates,
  }, 'AI 面板已添加', '添加失败,请稍后重试')
}

async function onClosePanel(platform: AIPlatform) {
  const active = enabledPlatformKeys()
  if (active.length <= MIN_ACTIVE_PLATFORMS) {
    showToast(`至少保留 ${MIN_ACTIVE_PLATFORMS} 个 AI`, 'warn')
    return
  }
  const enabledPlatforms = { ...userSettings.enabledPlatforms, [platform]: false }
  await savePanelSettings({
    enabledPlatforms,
    platformOrder: userSettings.platformOrder,
    promptTemplates: userSettings.promptTemplates,
  }, 'AI 面板已关闭', '关闭失败,请稍后重试')
}

function setupPanelSwitchButtons() {
  document.querySelectorAll<HTMLButtonElement>('.panel-switch').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const source = btn.dataset.platform as AIPlatform | undefined
      if (!source) return
      if (!panelSwitchMenu.hidden && panelSwitchMenu.dataset.sourcePlatform === source) {
        closePanelSwitchMenu()
        return
      }
      openPanelSwitchMenu(source, btn)
    })
  })
}

function setupPanelCloseButtons() {
  document.querySelectorAll<HTMLButtonElement>('.panel-close').forEach((btn) => {
    btn.addEventListener('click', () => {
      const platform = btn.dataset.platform as AIPlatform | undefined
      if (platform) void onClosePanel(platform)
    })
  })
}

// ---------- 事件绑定 ----------
function bindEvents() {
  bindComposerFocusRestorer({
    input: inputEl,
    composer,
    isBlocked: () => (
      !settingsOverlay.hidden ||
      !historyOverlay.hidden ||
      !conversationOverlay.hidden ||
      !summaryOverlay.hidden ||
      !transferOverlay.hidden
    ),
  })

  sendBtn.addEventListener('click', () => void onSend())
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !atPopupOpen) {
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
  btnSummaryClose.addEventListener('click', closeSummaryDialog)
  btnSummaryCancel.addEventListener('click', closeSummaryDialog)
  btnSummaryGenerate.addEventListener('click', () => void onGenerateSummary())
  summaryOverlay.addEventListener('click', (e) => {
    if (e.target === summaryOverlay) closeSummaryDialog()
  })
  btnTransferClose.addEventListener('click', closeTransferDialog)
  btnTransferCancel.addEventListener('click', closeTransferDialog)
  btnTransferSend.addEventListener('click', () => void onSendTransferSelection())
  transferTargetList.addEventListener('change', updateTransferSelectedCount)
  transferOverlay.addEventListener('click', (e) => {
    if (e.target === transferOverlay) closeTransferDialog()
  })
  document.addEventListener('click', (e) => {
    const target = e.target
    if (!(target instanceof Node)) return
    if (!panelSwitchMenu.hidden && !panelSwitchMenu.contains(target)) closePanelSwitchMenu()
  })
  btnQuote.addEventListener('click', onQuote)
  btnHistory.addEventListener('click', onHistory)
  btnHistoryClose.addEventListener('click', closeHistory)
  historySearchInput.addEventListener('input', () => {
    const visibleSessions = filterSessionsByTitle(historySessions, historySearchInput.value)
    if (!visibleSessions.some((session) => session.id === selectedHistoryId)) {
      selectedHistoryId = visibleSessions[0]?.id ?? null
      renderHistoryDetail(visibleSessions[0])
    }
    renderHistoryList()
  })
  historyOverlay.addEventListener('click', (e) => {
    if (e.target === historyOverlay) closeHistory()
  })
  btnConversations.addEventListener('click', () => void openConversationHistory())
  btnAddPanel.addEventListener('click', (e) => {
    e.stopPropagation()
    if (!panelSwitchMenu.hidden && panelSwitchMenu.dataset.mode === 'add') {
      closePanelSwitchMenu()
      return
    }
    openPanelAddMenu(btnAddPanel)
  })
  btnConversationClose.addEventListener('click', closeConversationHistory)
  conversationOverlay.addEventListener('click', (e) => {
    if (e.target === conversationOverlay) closeConversationHistory()
  })
  btnSettings.addEventListener('click', openSettings)
  btnExpandInput.addEventListener('click', toggleInputExpanded)
  btnSettingsClose.addEventListener('click', closeSettings)
  btnSettingsSave.addEventListener('click', () => void onSaveSettings())
  settingPromptKind.addEventListener('change', () => {
    syncCurrentPromptDraft()
    selectedPromptTemplateKey = settingPromptKind.value as UserPromptTemplateKey
    renderPromptTemplateEditor()
  })
  btnResetPromptTemplate.addEventListener('click', () => {
    settingPromptTemplate.value = DEFAULT_USER_SETTINGS.promptTemplates[selectedPromptTemplateKey]
    syncCurrentPromptDraft()
  })
  document.querySelectorAll<HTMLButtonElement>('.settings-nav-item[data-settings-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.settingsTab
      if (tab) selectSettingsTab(tab)
    })
  })
  settingsOverlay.addEventListener('mousedown', (e) => {
    if (e.target === settingsOverlay) closeSettings()
  })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panelSwitchMenu.hidden) closePanelSwitchMenu()
    if (e.key === 'Escape' && !summaryOverlay.hidden) closeSummaryDialog()
    if (e.key === 'Escape' && !transferOverlay.hidden) closeTransferDialog()
    if (e.key === 'Escape' && !historyOverlay.hidden) closeHistory()
    if (e.key === 'Escape' && !conversationOverlay.hidden) closeConversationHistory()
    if (e.key === 'Escape' && !settingsOverlay.hidden) closeSettings()
  })

  // 图片按钮 + 移除按钮
  btnImage.addEventListener('click', onImageClick)
  btnImageRemove.addEventListener('click', clearAttachment)
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
  void (async () => {
    await initializeSettings()
    setupSplitter()
    setupOpenButtons()
    setupPanelSwitchButtons()
    setupPanelCloseButtons()
    setupTransferButtons()
    bindEvents()
    await bootstrap()
  })()
})
