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
import { getDefaultTemplatesForLanguage, renderTemplate } from '../lib/prompt-template'
import {
  DEFAULT_USER_SETTINGS,
  getDefaultUserPromptTemplates,
  loadUserSettings,
  saveUserSettings,
  swapPlatformOrder,
  type UserPromptTemplateCustomizations,
  type UserPromptTemplateKey,
  type UserPromptTemplates,
  type UserSettings,
} from '../lib/user-settings'
import { t, type UserLanguage } from '../lib/i18n'
import { getSendButtonState } from '../lib/send-button-state'
import { addSession, deleteSession, getSession, loadSessions, updateSession } from '../lib/session-store'
import {
  applyCaptureFailures,
  applyCapturedResponses,
  applySendResults,
  createSessionRecord,
  createSummarySessionRecord,
  isNewCapturedResponse,
  normalizeCapturedResponse,
} from '../lib/session-record'
import {
  SEND_LOCK_TIMEOUT_MS,
  createSendLock,
  markSendLockSubmitted,
  markSendLockPlatformDone,
  markSendLockTimedOut,
  markSendLockUnlocked,
  shouldUnlockInsteadOfSend,
  shouldSendLockTimeout,
  type SendLockState,
} from '../lib/send-lock'
import { buildSessionMarkdownExport, formatBytes, formatCapturedMarkdownText, formatSessionMarkdown } from '../lib/history-format'
import { buildSummaryPrompt } from '../lib/summary-builder'
import { evaluateResponseCapture, isResponseCompleteForUnlock, type ResponseCaptureProgress } from '../lib/response-capture'
import { buildTransferContent, buildTransferSourceOptions, type TransferSourceOption } from '../lib/transfer-source'
import { bindComposerFocusRestorer } from '../lib/focus-restore'
import { filterSessionsByTitle } from '../lib/history-search'
import { deleteConversation, isSpecificConversationUrl, loadConversations, renameConversation, upsertConversation } from '../lib/conversation-store'
import { logCaptureDebug, textPreview } from '../lib/capture-debug'
import { prepareDiagnosticExport, type PreparedDiagnosticExport } from '../lib/diagnostic-export'
import {
  deriveDiagnosticExport,
  type DiagnosticEnvelope,
  type DiagnosticExportPayload,
} from '../lib/diagnostic-retention'
import {
  createDiagnosticBatchId,
  createDiagnosticContext,
  createDiagnosticProducerId,
  createDiagnosticReporter,
} from '../lib/diagnostic-client'
import type { DiagnosticContext, DiagnosticErrorCode } from '../lib/diagnostic-types'
import {
  classifyResponseCaptureWait,
  createResponseDiagnosticTracker,
  type ResponseDiagnosticTracker,
} from './response-diagnostic'
import {
  choosePlatformMessageRoute,
  iframeWriteResultTimeoutMs,
  routeTimeoutErrorCode,
} from './platform-message-route'

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
const composerTextbox = $<HTMLDivElement>('#composer-textbox')
const composerToolbar = $<HTMLDivElement>('.composer-toolbar')
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
const attachmentWarning = $<HTMLSpanElement>('#attachment-warning')
const btnImageRemove = $<HTMLButtonElement>('#btn-image-remove')
const btnRefresh = $<HTMLButtonElement>('#btn-refresh')
const toastContainer = $<HTMLDivElement>('#toast-container')
const settingsOverlay = $<HTMLDivElement>('#settings-overlay')
const btnSettingsClose = $<HTMLButtonElement>('#btn-settings-close')
const btnSettingsSave = $<HTMLButtonElement>('#btn-settings-save')
const settingLanguage = $<HTMLSelectElement>('#setting-language')
const settingPromptKind = $<HTMLSelectElement>('#setting-prompt-kind')
const settingPromptLabel = $<HTMLSpanElement>('#setting-prompt-label')
const settingPromptTemplate = $<HTMLTextAreaElement>('#setting-prompt-template')
const settingPromptHelp = $<HTMLParagraphElement>('#setting-prompt-help')
const settingCaptureDebug = $<HTMLInputElement>('#setting-capture-debug')
const settingDiagnosticEnabled = $<HTMLInputElement>('#setting-diagnostic-enabled')
const diagnosticSummary = $<HTMLDivElement>('#diagnostic-summary')
const diagnosticList = $<HTMLDivElement>('#diagnostic-list')
const diagnosticPreviewWrap = $<HTMLLabelElement>('#diagnostic-preview-wrap')
const diagnosticExportPreview = $<HTMLTextAreaElement>('#diagnostic-export-preview')
const btnDiagnosticView = $<HTMLButtonElement>('#btn-diagnostic-view')
const btnDiagnosticCopyFailure = $<HTMLButtonElement>('#btn-diagnostic-copy-failure')
const btnDiagnosticDownload = $<HTMLButtonElement>('#btn-diagnostic-download')
const btnDiagnosticClear = $<HTMLButtonElement>('#btn-diagnostic-clear')
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
const conversationNote = $<HTMLDivElement>('#conversation-note')
const summaryOverlay = $<HTMLDivElement>('#summary-overlay')
const btnSummaryClose = $<HTMLButtonElement>('#btn-summary-close')
const btnSummaryCancel = $<HTMLButtonElement>('#btn-summary-cancel')
const btnSummaryGenerate = $<HTMLButtonElement>('#btn-summary-generate')
const summaryList = $<HTMLDivElement>('#summary-list')
const summaryLead = $<HTMLParagraphElement>('#summary-lead')
const summaryTargetLabel = $<HTMLSpanElement>('#summary-sentence-prefix')
const summaryModeLabel = $<HTMLSpanElement>('#summary-sentence-mid')
const summaryTargetSelect = $<HTMLSelectElement>('#summary-target')
const summaryModeSelect = $<HTMLSelectElement>('#summary-mode')
const summarySourceLabel = $<HTMLSpanElement>('#summary-sentence-suffix')
const summarySourceList = $<HTMLDivElement>('#summary-source-list')
const summarySelected = $<HTMLDivElement>('#summary-selected')
const summaryPreviewTitle = $<HTMLHeadingElement>('#summary-preview-title')
const summaryPreview = $<HTMLDivElement>('#summary-preview')
const transferOverlay = $<HTMLDivElement>('#transfer-overlay')
const transferTitle = $<HTMLHeadingElement>('#transfer-title')
const transferLead = $<HTMLParagraphElement>('#transfer-lead')
const transferTargetLabel = $<HTMLSpanElement>('#transfer-target-label')
const transferPreviewTitle = $<HTMLHeadingElement>('#transfer-preview-title')
const btnTransferClose = $<HTMLButtonElement>('#btn-transfer-close')
const btnTransferCancel = $<HTMLButtonElement>('#btn-transfer-cancel')
const btnTransferSend = $<HTMLButtonElement>('#btn-transfer-send')
const transferList = $<HTMLDivElement>('#transfer-list')
const transferTargetList = $<HTMLDivElement>('#transfer-target-list')
const transferSelected = $<HTMLDivElement>('#transfer-selected')
const transferPreview = $<HTMLDivElement>('#transfer-preview')

// ---------- 状态 ----------
const readyMap = Object.fromEntries(SUPPORTED_PLATFORMS.map((platform) => [platform, false])) as Record<AIPlatform, boolean>
const readyWaiters = SUPPORTED_PLATFORMS.reduce((acc, platform) => {
  acc[platform] = []
  return acc
}, {} as Record<AIPlatform, Array<(ok: boolean) => void>>)
const RESPONSE_BACKFILL_INTERVAL_MS = 3000
const RESPONSE_BACKFILL_MAX_ATTEMPTS = 20
const RESPONSE_STABLE_REQUIRED_POLLS = 2
let userSettings: UserSettings = DEFAULT_USER_SETTINGS
let diagnosticEventCount = 0
let preparedDiagnosticExport: PreparedDiagnosticExport | null = null
let preparedDiagnosticExportScope: 'all' | 'latest-failure' | null = null
let clearDiagnosticsWhenDisabled = false
const DIAGNOSTIC_NOTICE_VERSION = 1
let selectedPromptTemplateKey: UserPromptTemplateKey = 'transfer'
let promptTemplateDrafts: UserPromptTemplates = { ...DEFAULT_USER_SETTINGS.promptTemplates }
let promptTemplateCustomizationDrafts: UserPromptTemplateCustomizations = { ...DEFAULT_USER_SETTINGS.promptTemplateCustomizations }
let historySessions: Session[] = []
let conversationEntries: ConversationEntry[] = []
let selectedHistoryId: string | null = null
let summarySessions: Session[] = []
const selectedSummaryIds: Set<string> = new Set()
const selectedSummaryPlatforms: Set<AIPlatform> = new Set()
let transferSourcePlatform: AIPlatform | null = null
let transferSourceOptions: TransferSourceOption[] = []
let currentSendLock: SendLockState | null = null
let sendLockTimer: ReturnType<typeof setTimeout> | null = null
let originalInputPlaceholder = inputEl.placeholder

// 待发送的附件(仅支持 1 个,后续 attach 会替换)
interface PendingAttachment {
  file: File
  classification: FileClassification
  textContent?: string
}

let pendingAttachment: PendingAttachment | null = null
let pendingImageObjectUrl: string | null = null

function setElementText(selector: string, text: string) {
  const el = document.querySelector<HTMLElement>(selector)
  if (el) el.textContent = text
}

function setElementTitle(selector: string, title: string) {
  const el = document.querySelector<HTMLElement>(selector)
  if (el) {
    el.title = title
    if (el.hasAttribute('aria-label')) el.setAttribute('aria-label', title)
  }
}

function formatUiText(language: UserLanguage, key: string, values: Record<string, string | number>): string {
  let text = t(language, key)
  for (const [name, value] of Object.entries(values)) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

function uiText(key: string, values: Record<string, string | number> = {}): string {
  return formatUiText(userSettings.language, key, values)
}

function applyStaticUiLanguage(language: UserLanguage) {
  document.documentElement.lang = language
  setElementTitle('#btn-settings', t(language, 'app.settings'))
  setElementTitle('#btn-image', t(language, 'toolbar.attachTitle'))
  setElementText('#btn-summary', t(language, 'toolbar.summary'))
  setElementTitle('#btn-summary', t(language, 'toolbar.summaryTitle'))
  setElementText('#btn-history', t(language, 'toolbar.records'))
  setElementTitle('#btn-history', t(language, 'toolbar.recordsTitle'))
  setElementText('#btn-conversations', t(language, 'toolbar.officialChats'))
  setElementTitle('#btn-conversations', t(language, 'toolbar.officialChatsTitle'))
  setElementText('#btn-add-panel', t(language, 'toolbar.addAi'))
  setElementTitle('#btn-add-panel', t(language, 'toolbar.addAiTitle'))
  setElementTitle('#btn-expand-input', t(language, composer.classList.contains('expanded') ? 'toolbar.collapseInput' : 'toolbar.expandInput'))
  setElementTitle('#btn-send', t(language, 'toolbar.send'))
  inputEl.placeholder = t(language, 'input.placeholder')
  originalInputPlaceholder = inputEl.placeholder
  updateSendButtonState()
  setElementText('#settings-title', t(language, 'app.settings'))
  setElementText('[data-settings-tab="sites"]', t(language, 'settings.sitesTab'))
  setElementText('[data-settings-tab="prompts"]', t(language, 'settings.promptsTab'))
  setElementText('[data-settings-tab="diagnostics"]', t(language, 'settings.diagnosticsTab'))
  setElementText('.settings-nav-item:disabled', t(language, 'settings.shortcutsTab'))
  setElementText('[data-settings-tab="help"]', t(language, 'settings.helpTab'))
  setElementText('[data-settings-panel="sites"] .settings-lead', t(language, 'settings.sitesLead'))
  setElementText('[data-settings-panel="prompts"] .settings-lead', t(language, 'settings.promptLead'))
  setElementText('.prompt-kind-field span', t(language, 'settings.promptKind'))
  setElementText('#btn-reset-prompt-template', t(language, 'settings.resetPrompt'))
  setElementText('#diagnostics-lead', t(language, 'settings.diagnosticsLead'))
  setElementText('#diagnostic-local-title', t(language, 'diagnostic.title'))
  setElementText('#diagnostic-local-disclosure', t(language, 'diagnostic.disclosure'))
  setElementText('#btn-diagnostic-view', t(language, 'diagnostic.view'))
  setElementText('#btn-diagnostic-copy-failure', t(language, 'diagnostic.copyFailure'))
  setElementText('#btn-diagnostic-download', t(language, 'diagnostic.download'))
  setElementText('#btn-diagnostic-clear', t(language, 'diagnostic.clear'))
  setElementText('#diagnostic-preview-title', t(language, 'diagnostic.preview'))
  setElementText('#diagnostics-capture-title', t(language, 'settings.captureDebugTitle'))
  setElementText('#diagnostics-capture-help', t(language, 'settings.captureDebugHelp'))
  setElementText('.settings-field span', t(language, 'settings.language'))
  setElementText('#btn-refresh', t(language, 'settings.refreshStatus'))
  setElementTitle('#btn-refresh', t(language, 'settings.refreshStatusTitle'))
  setElementText('#settings-note-prefix', t(language, 'settings.notePrefix'))
  setElementText('#settings-note-body', t(language, 'settings.noteBody'))
  document.querySelectorAll<HTMLElement>('[data-site-owner]').forEach((owner) => {
    const platform = owner.dataset.siteOwner
    if (platform) owner.textContent = t(language, `site.owner.${platform}`)
  })
  document.querySelectorAll<HTMLElement>('[data-site-note]').forEach((note) => {
    const key = note.dataset.siteNote
    if (key) note.textContent = t(language, `site.note.${key}`)
  })
  document.querySelectorAll<HTMLElement>('[data-site-short-note]').forEach((note) => {
    const key = note.dataset.siteShortNote
    if (key) note.textContent = t(language, `site.shortNote.${key}`)
  })
  document.querySelectorAll<HTMLAnchorElement>('.site-open').forEach((link) => {
    const row = link.closest<HTMLElement>('.site-row')
    const platform = row?.querySelector<HTMLInputElement>('input[data-platform]')?.dataset.platform
    if (platform) link.title = t(language, `site.open.${platform}`)
  })
  setElementText('#history-title', t(language, 'toolbar.records'))
  historySearchInput.placeholder = t(language, 'history.search')
  setElementText('#conversation-title', t(language, 'toolbar.officialChats'))
  conversationNote.textContent = t(language, 'conversation.note')
  setElementText('#summary-title', t(language, 'toolbar.summaryTitle'))
  summaryLead.textContent = t(language, 'summary.lead')
  summaryTargetLabel.textContent = t(language, 'summary.sentencePrefix')
  summaryModeLabel.textContent = t(language, 'summary.sentenceMid')
  summarySourceLabel.textContent = t(language, 'summary.sentenceSuffix')
  summarySourceList.setAttribute('aria-label', t(language, 'summary.sourceAriaLabel'))
  summarySelected.textContent = formatUiText(language, 'summary.selectedCount', { count: selectedSummaryIds.size })
  btnSummaryCancel.textContent = t(language, 'common.cancel')
  btnSummaryGenerate.textContent = t(language, 'summary.generate')
  summaryPreviewTitle.textContent = t(language, 'summary.previewTitle')
  syncSummaryModeOptions(language)
  setElementText('#transfer-title', t(language, 'transfer.title'))
  transferLead.textContent = t(language, 'transfer.lead')
  transferTargetLabel.textContent = t(language, 'transfer.targetLabel')
  transferTargetList.setAttribute('aria-label', t(language, 'transfer.targetLabel'))
  transferPreviewTitle.textContent = t(language, 'transfer.previewTitle')
  btnTransferCancel.textContent = t(language, 'common.cancel')
  btnTransferSend.textContent = t(language, 'panel.transfer').replace(/\s*[-➔>]+$/, '')
  setElementTitle('#btn-settings-close', t(language, 'common.close'))
  setElementTitle('#btn-history-close', t(language, 'common.close'))
  setElementTitle('#btn-conversation-close', t(language, 'common.close'))
  setElementTitle('#btn-summary-close', t(language, 'common.close'))
  setElementTitle('#btn-transfer-close', t(language, 'common.close'))
  setElementText('#btn-settings-save', t(language, 'common.save'))
  syncPromptKindOptions()
  renderPromptTemplateEditor()
  document.querySelectorAll<HTMLButtonElement>('.panel-transfer').forEach((btn) => {
    btn.textContent = t(language, 'panel.transfer')
    btn.title = t(language, 'panel.transferTitle')
  })
  document.querySelectorAll<HTMLButtonElement>('.panel-switch').forEach((btn) => {
    btn.textContent = t(language, 'panel.switch')
    btn.title = t(language, 'panel.switchTitle')
  })
  document.querySelectorAll<HTMLButtonElement>('.panel-open').forEach((btn) => {
    btn.title = t(language, 'panel.openTitle')
  })
  document.querySelectorAll<HTMLButtonElement>('.panel-close').forEach((btn) => {
    btn.title = t(language, 'panel.closeTitle')
  })
  renderHelpContent(language)
}

function summaryModeLabelText(mode: SummaryMode, language: UserLanguage = userSettings.language): string {
  return t(language, `summary.mode.${mode}`)
}

function syncSummaryModeOptions(language: UserLanguage = userSettings.language) {
  for (const option of summaryModeSelect.options) {
    option.textContent = summaryModeLabelText(option.value as SummaryMode, language)
  }
}

const HELP_KEYS = ['send', 'attach', 'forward', 'panels', 'summary', 'records', 'officialChats', 'browserCompatibility']

function renderHelpContent(language: UserLanguage) {
  setElementText('[data-settings-panel="help"] .settings-lead', t(language, 'help.lead'))
  const cards = [...document.querySelectorAll<HTMLElement>('.help-card')]
  for (const [index, key] of HELP_KEYS.entries()) {
    const card = cards[index]
    if (!card) continue
    const title = card.querySelector('h3')
    const body = card.querySelector('p')
    if (title) title.textContent = t(language, `help.${key}.title`)
    if (body) body.textContent = t(language, `help.${key}.body`)
  }
}

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
  composerToolbar.classList.toggle('has-content', !imagePreview.hidden)
}

function setStatus(p: AIPlatform, state: 'ok' | 'err' | 'warn', text: string) {
  const dot = statusDot(p)
  dot.classList.remove('ok', 'err', 'warn')
  if (state !== ('idle' as never)) dot.classList.add(state)
  statusText(p).textContent = text
}

function sendButtonTitle(kind: ReturnType<typeof getSendButtonState>['kind']): string {
  if (kind === 'empty') return t(userSettings.language, 'send.emptyTitle')
  if (kind === 'waiting-response') return t(userSettings.language, 'send.lockResponseTitle')
  if (kind === 'submitting') return t(userSettings.language, 'send.lockStillSubmitting')
  return t(userSettings.language, 'toolbar.send')
}

function updateSendButtonState() {
  const state = getSendButtonState({
    hasContent: inputEl.value.trim().length > 0 || !!pendingAttachment,
    lockPhase: currentSendLock?.status === 'waiting' ? currentSendLock.phase : null,
  })
  sendBtn.dataset.icon = state.icon
  sendBtn.disabled = state.disabled
  sendBtn.classList.toggle('waiting-response', state.kind === 'waiting-response')
  sendBtn.classList.toggle('empty', state.kind === 'empty')
  const title = sendButtonTitle(state.kind)
  sendBtn.title = title
  sendBtn.setAttribute('aria-label', title)
}

function setSubmittingLockUi() {
  inputEl.disabled = true
  btnImage.disabled = true
  inputEl.placeholder = t(userSettings.language, 'send.lockedPlaceholder')
  updateSendButtonState()
}

function setWaitingResponseLockUi() {
  inputEl.disabled = false
  btnImage.disabled = false
  inputEl.placeholder = originalInputPlaceholder
  updateSendButtonState()
}

function hideSendLockUi() {
  inputEl.disabled = false
  btnImage.disabled = false
  inputEl.placeholder = originalInputPlaceholder
  updateSendButtonState()
}

function clearSendLockTimer() {
  if (!sendLockTimer) return
  clearTimeout(sendLockTimer)
  sendLockTimer = null
}

function beginSendLock(targets: AIPlatform[]) {
  clearSendLockTimer()
  currentSendLock = createSendLock(targets)
  setSubmittingLockUi()
  sendLockTimer = setTimeout(() => {
    if (!currentSendLock || !shouldSendLockTimeout(currentSendLock)) return
    const timedOutLock = markSendLockTimedOut(currentSendLock)
    currentSendLock = markSendLockUnlocked(timedOutLock)
    hideSendLockUi()
    const labels = timedOutLock.pendingPlatforms.map((p) => getPlatformMeta(p)?.label ?? p).join(' / ')
    showToast(uiText('send.lockTimeout', { labels }), 'warn', 8000)
  }, SEND_LOCK_TIMEOUT_MS)
}

function markCurrentSendSubmitted() {
  if (!currentSendLock || currentSendLock.status !== 'waiting') return
  currentSendLock = markSendLockSubmitted(currentSendLock)
  setWaitingResponseLockUi()
}

function finishSendLockPlatform(platform: AIPlatform) {
  if (!currentSendLock || currentSendLock.status !== 'waiting') return
  currentSendLock = markSendLockPlatformDone(currentSendLock, platform)
  if (currentSendLock.status !== 'done') return
  clearSendLockTimer()
  hideSendLockUi()
}

function forceUnlockComposer() {
  if (!currentSendLock || currentSendLock.status !== 'waiting') return
  currentSendLock = markSendLockUnlocked(currentSendLock)
  clearSendLockTimer()
  hideSendLockUi()
  showToast(t(userSettings.language, 'send.manualUnlocked'), 'warn', 5000)
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
  applyStaticUiLanguage(settings.language)
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

function syncCurrentPromptDraft() {
  promptTemplateDrafts[selectedPromptTemplateKey] = settingPromptTemplate.value
}

function promptTemplateLabel(key: UserPromptTemplateKey): string {
  return t(userSettings.language, `settings.prompt.${key}`)
}

function promptTemplateHelp(key: UserPromptTemplateKey): string {
  return key === 'transfer'
    ? t(userSettings.language, 'settings.promptHelp.transfer')
    : t(userSettings.language, 'settings.promptHelp.summary')
}

function syncPromptKindOptions() {
  for (const option of settingPromptKind.options) {
    option.textContent = promptTemplateLabel(option.value as UserPromptTemplateKey)
  }
}

function refreshDefaultPromptDrafts(language: UserLanguage) {
  const defaults = getDefaultUserPromptTemplates(language)
  for (const key of Object.keys(defaults) as UserPromptTemplateKey[]) {
    if (!promptTemplateCustomizationDrafts[key]) {
      promptTemplateDrafts[key] = defaults[key]
    }
  }
}

function renderPromptTemplateEditor() {
  settingPromptKind.value = selectedPromptTemplateKey
  syncPromptKindOptions()
  settingPromptLabel.textContent = promptTemplateLabel(selectedPromptTemplateKey)
  settingPromptTemplate.value = promptTemplateDrafts[selectedPromptTemplateKey]
  settingPromptHelp.textContent = promptTemplateHelp(selectedPromptTemplateKey)
}

function renderSettingsForm() {
  settingLanguage.value = userSettings.language
  for (const input of settingPlatformInputs()) {
    const platform = input.dataset.platform as AIPlatform
    input.checked = !!userSettings.enabledPlatforms[platform]
  }
  promptTemplateDrafts = { ...userSettings.promptTemplates }
  promptTemplateCustomizationDrafts = { ...userSettings.promptTemplateCustomizations }
  settingCaptureDebug.checked = userSettings.captureDebug
  settingDiagnosticEnabled.checked = userSettings.diagnosticEnabled
  selectedPromptTemplateKey = settingPromptKind.value as UserPromptTemplateKey || 'transfer'
  renderPromptTemplateEditor()
}

interface DiagnosticSummaryResponse {
  ok?: boolean
  summary?: {
    eventCount: number
    batchCount: number
    runCount: number
    earliestTimestamp?: number
    hasFinalFailure: boolean
  }
  internalStatus?: { schemaError: boolean; storageError: boolean }
}

function clearPreparedDiagnosticExport() {
  preparedDiagnosticExport = null
  preparedDiagnosticExportScope = null
  diagnosticExportPreview.value = ''
  diagnosticPreviewWrap.hidden = true
}

async function loadDiagnosticSummary() {
  try {
    const response = await sendToSw<DiagnosticSummaryResponse>({ type: 'diagnostic:summary' })
    const summary = response?.summary
    if (!response?.ok || !summary) throw new Error('diagnostic summary unavailable')
    diagnosticEventCount = summary.eventCount
    const earliest = summary.earliestTimestamp
      ? new Date(summary.earliestTimestamp).toLocaleString(userSettings.language)
      : t(userSettings.language, 'diagnostic.none')
    const writerFailed = response.internalStatus?.schemaError || response.internalStatus?.storageError
    diagnosticSummary.textContent = formatUiText(userSettings.language, 'diagnostic.summary', {
      batches: summary.batchCount,
      runs: summary.runCount,
      events: summary.eventCount,
      earliest,
      status: writerFailed
        ? t(userSettings.language, 'diagnostic.writerFailed')
        : t(userSettings.language, 'diagnostic.writerOk'),
    })
    btnDiagnosticCopyFailure.disabled = !summary.hasFinalFailure
  } catch {
    diagnosticSummary.textContent = t(userSettings.language, 'diagnostic.summaryFailed')
    btnDiagnosticCopyFailure.disabled = true
  }
}

async function loadDiagnosticPayload(latestFailureOnly = false): Promise<DiagnosticExportPayload> {
  const response = await sendToSw<{ ok?: boolean; envelope?: DiagnosticEnvelope }>({ type: 'diagnostic:snapshot' })
  if (!response?.ok || !response.envelope) throw new Error('diagnostic snapshot unavailable')
  return deriveDiagnosticExport(response.envelope, {
    now: Date.now(),
    activePlatformRunIds: new Set(),
    latestFailureOnly,
  })
}

function showDiagnosticPreview(
  payload: DiagnosticExportPayload,
  scope: 'all' | 'latest-failure',
): PreparedDiagnosticExport {
  preparedDiagnosticExport = prepareDiagnosticExport(payload)
  preparedDiagnosticExportScope = scope
  diagnosticExportPreview.value = preparedDiagnosticExport.previewText
  diagnosticPreviewWrap.hidden = false
  return preparedDiagnosticExport
}

function renderDiagnosticBatches(payload: DiagnosticExportPayload) {
  diagnosticList.replaceChildren()
  if (payload.batches.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'settings-help'
    empty.textContent = t(userSettings.language, 'diagnostic.none')
    diagnosticList.appendChild(empty)
  }
  for (const batch of payload.batches) {
    const details = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = formatUiText(userSettings.language, 'diagnostic.batch', {
      id: batch.batchId,
      runs: batch.runs.length,
    })
    details.appendChild(summary)
    for (const run of batch.runs) {
      const row = document.createElement('div')
      row.className = 'diagnostic-run'
      const platform = run.events[0]?.platform ?? '-'
      const outcome = run.finalOutcome ?? run.derivedOutcome ?? t(userSettings.language, 'diagnostic.noTerminal')
      row.textContent = formatUiText(userSettings.language, 'diagnostic.run', {
        platform,
        outcome,
        events: run.events.length,
      })
      details.appendChild(row)
    }
    diagnosticList.appendChild(details)
  }
  diagnosticList.hidden = false
}

async function viewDiagnostics() {
  clearPreparedDiagnosticExport()
  const payload = await loadDiagnosticPayload()
  renderDiagnosticBatches(payload)
  showDiagnosticPreview(payload, 'all')
}

async function copyLatestFailedDiagnostics() {
  clearPreparedDiagnosticExport()
  const payload = await loadDiagnosticPayload(true)
  if (payload.batches.length === 0) {
    showToast(t(userSettings.language, 'diagnostic.noFailure'), 'info')
    return
  }
  const prepared = showDiagnosticPreview(payload, 'latest-failure')
  await navigator.clipboard.writeText(prepared.clipboardText)
  showToast(t(userSettings.language, 'diagnostic.copiedFailure'), 'success', 1800)
}

async function downloadDiagnostics() {
  const prepared = preparedDiagnosticExport && preparedDiagnosticExportScope === 'all'
    ? preparedDiagnosticExport
    : showDiagnosticPreview(await loadDiagnosticPayload(), 'all')
  const url = URL.createObjectURL(prepared.blob)
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = `chatduel-diagnostics-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function clearDiagnostics() {
  if (!confirm(t(userSettings.language, 'diagnostic.clearConfirm'))) return
  const response = await sendToSw<{ ok?: boolean }>({ type: 'diagnostic:clear' })
  if (!response?.ok) throw new Error('diagnostic clear failed')
  diagnosticEventCount = 0
  diagnosticList.replaceChildren()
  diagnosticList.hidden = true
  clearPreparedDiagnosticExport()
  await loadDiagnosticSummary()
  showToast(t(userSettings.language, 'diagnostic.cleared'), 'success', 1800)
}

function reportDiagnosticUiFailure(error: unknown) {
  console.error('[AIChatRoom chat] diagnostic action failed', error)
  showToast(t(userSettings.language, 'diagnostic.actionFailed'), 'err')
}

function openSettings() {
  renderSettingsForm()
  settingsOverlay.hidden = false
  void loadDiagnosticSummary()
}

function closeSettings() {
  settingsOverlay.hidden = true
  clearDiagnosticsWhenDisabled = false
  clearPreparedDiagnosticExport()
}

function selectSettingsTab(tab: string) {
  document.querySelectorAll<HTMLButtonElement>('.settings-nav-item[data-settings-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.settingsTab === tab)
  })
  document.querySelectorAll<HTMLElement>('.settings-panel[data-settings-panel]').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.settingsPanel === tab)
  })
  btnSettingsSave.hidden = tab === 'help'
  if (tab === 'diagnostics') void loadDiagnosticSummary()
}

function toggleInputExpanded() {
  const expanded = composer.classList.toggle('expanded')
  btnExpandInput.textContent = expanded ? '⇲' : '⛶'
  btnExpandInput.title = t(userSettings.language, expanded ? 'toolbar.collapseInput' : 'toolbar.expandInput')
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
  if (userSettings.diagnosticNoticeVersionSeen < DIAGNOSTIC_NOTICE_VERSION) {
    showToast(t(userSettings.language, 'diagnostic.firstNotice'), 'info', 7000)
    try {
      userSettings = await saveUserSettings({ diagnosticNoticeVersionSeen: DIAGNOSTIC_NOTICE_VERSION })
    } catch (error) {
      console.error('[AIChatRoom chat] save diagnostic notice failed', error)
    }
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
    showToast(uiText('panelMenu.minActive', { count: MIN_ACTIVE_PLATFORMS }), 'warn')
    renderSettingsForm()
    return
  }
  if (selectedPlatforms.length > MAX_ACTIVE_PLATFORMS) {
    showToast(uiText('panelMenu.maxActive', { count: MAX_ACTIVE_PLATFORMS }), 'warn')
    renderSettingsForm()
    return
  }

  syncCurrentPromptDraft()
  const next: UserSettings = {
    enabledPlatforms,
    platformOrder: userSettings.platformOrder,
    language: settingLanguage.value as UserLanguage,
    captureDebug: settingCaptureDebug.checked,
    diagnosticEnabled: settingDiagnosticEnabled.checked,
    diagnosticNoticeVersionSeen: userSettings.diagnosticNoticeVersionSeen,
    promptTemplates: promptTemplateDrafts,
    promptTemplateCustomizations: promptTemplateCustomizationDrafts,
  }

  btnSettingsSave.disabled = true
  try {
    const saved = await saveUserSettings(next)
    applyUserSettings(saved)
    if (!saved.diagnosticEnabled && clearDiagnosticsWhenDisabled) {
      try {
        const cleared = await sendToSw<{ ok?: boolean }>({ type: 'diagnostic:clear' })
        if (!cleared?.ok) throw new Error('diagnostic clear failed')
      } catch (error) {
        reportDiagnosticUiFailure(error)
      }
      clearDiagnosticsWhenDisabled = false
    }
    closeSettings()
    await refreshAllStatuses()
    showToast(t(userSettings.language, 'settings.saveSuccess'), 'success', 1600)
  } catch (e) {
    console.error('[AIChatRoom chat] save settings failed', e)
    showToast(t(userSettings.language, 'settings.saveFailed'), 'err')
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
      showToast(uiText('attachment.tooLarge', { size: (file.size / 1024 / 1024).toFixed(1) }), 'err')
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
      showToast(t(userSettings.language, 'attachment.readTextFailed'), 'err')
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
  updateSendButtonState()
  btnImage.classList.add('has-image')
  btnImage.title = uiText('attachment.attachedTitle', { name: file.name || 'file' })
  showToast(
    classification.handling === 'inline-text'
      ? t(userSettings.language, 'attachment.textAttached')
      : t(userSettings.language, 'attachment.fileAttached'),
    'success',
    1500,
  )
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
  attachmentWarning.textContent = ''
  attachmentWarning.hidden = true
  imagePreview.hidden = true
  updateComposerToolbarVisibility()
  updateSendButtonState()
  btnImage.classList.remove('has-image')
  btnImage.title = t(userSettings.language, 'toolbar.attachTitle')
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
      setStatus(p, 'warn', t(userSettings.language, 'panel.status.pending'))
      const iframe = panelIframe(p)
      iframe.src = 'about:blank'
      continue
    }
    setStatus(p, 'warn', t(userSettings.language, 'panel.status.checking'))
    const iframe = panelIframe(p)
    if (iframe.src === 'about:blank' || !iframe.src) {
      iframe.src = platformUrl(p)
    }
    const ok = await waitForIframeReady(p)
    if (ok) {
      const capabilities = getPlatformCapabilities(p)
      if (capabilities.supportsText) {
        setStatus(p, 'ok', t(userSettings.language, 'panel.status.opened'))
      } else {
        const state = await requestConversationState(p, 1000)
        if (state.status === 'error') setStatus(p, 'warn', state.errorMessage ?? t(userSettings.language, 'panel.status.needCheck'))
        else setStatus(p, 'ok', t(userSettings.language, 'panel.status.opened'))
      }
    } else {
      if (platformMessageRoute(p) === 'official-tab') {
        const state = await requestConversationState(p, 1200)
        if (state.status === 'error') setStatus(p, 'warn', state.errorMessage ?? t(userSettings.language, 'panel.status.needCheck'))
        else setStatus(p, 'ok', t(userSettings.language, 'panel.status.opened'))
      } else {
        setStatus(p, 'err', t(userSettings.language, 'panel.status.timeout'))
      }
    }
  }
}

// ---------- 父页 ↔ iframe postMessage ----------
function postToIframe(p: AIPlatform, action: string, extra: Record<string, unknown> = {}) {
  const win = panelIframe(p).contentWindow
  if (!win) return
  win.postMessage({ source: 'aichatroom-parent', action, ...extra }, platformOrigin(p))
}

function platformMessageRoute(p: AIPlatform) {
  return choosePlatformMessageRoute({
    platform: p,
    iframeReady: readyMap[p],
    iframeUrl: panelIframe(p).src,
    supportsEmbed: getPlatformCapabilities(p).supportsEmbed,
  })
}

async function sendOfficialTabCommand<T = unknown>(
  platform: AIPlatform,
  command: 'write-and-send' | 'get-state' | 'get-last-response',
  payload: Record<string, unknown> = {},
): Promise<T | null> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'official-tab-command',
      platform,
      command,
      ...payload,
    })
    return (response ?? null) as T | null
  } catch {
    return null
  }
}

function waitForIframeWriteResult(p: AIPlatform, payload: Record<string, unknown>): Promise<{ p: AIPlatform; ok: boolean; error?: string }> {
  const win = panelIframe(p).contentWindow
  if (!win) return Promise.resolve({ p, ok: false })
  return new Promise((resolve) => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { source?: string; event?: string; action?: string; platform?: AIPlatform; ok?: boolean; error?: string } | undefined
      if (!d || d.source !== 'aichatroom-content') return
      if (d.event === 'result' && d.action === 'write-and-send' && d.platform === p) {
        window.removeEventListener('message', onMsg)
        resolve({ p, ok: !!d.ok, error: d.error })
      }
    }
    window.addEventListener('message', onMsg)
    postToIframe(p, 'write-and-send', payload)
    setTimeout(() => {
      window.removeEventListener('message', onMsg)
      resolve({ p, ok: false })
    }, iframeWriteResultTimeoutMs(payload))
  })
}

interface PlatformSendResult {
  p: AIPlatform
  ok: boolean
  error?: string
  diagnosticErrorCode?: DiagnosticErrorCode
}

async function writeAndSendToPlatform(p: AIPlatform, payload: Record<string, unknown>): Promise<PlatformSendResult> {
  if (platformMessageRoute(p) === 'official-tab') {
    const response = await sendOfficialTabCommand<{
      ok?: boolean
      error?: string
      diagnosticErrorCode?: DiagnosticErrorCode
    }>(p, 'write-and-send', payload)
    return {
      p,
      ok: !!response?.ok,
      error: response?.error,
      diagnosticErrorCode: response?.diagnosticErrorCode,
    }
  }
  return waitForIframeWriteResult(p, payload)
}

function requestLastResponse(p: AIPlatform, timeoutMs = 3000): Promise<string> {
  if (platformMessageRoute(p) === 'official-tab') {
    return sendOfficialTabCommand<{ type?: string; text?: string; ok?: boolean }>(p, 'get-last-response')
      .then((response) => response?.text ?? '')
  }
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
      logCaptureDebug({
        platform: p,
        event: 'request-last-response-timeout',
        timeoutMs,
      })
      resolve('')
    }, timeoutMs)
  })
}

type ConversationStateResult = ConversationState & { requestTimedOut?: boolean }

function requestConversationState(p: AIPlatform, timeoutMs = 3000): Promise<ConversationStateResult> {
  if (platformMessageRoute(p) === 'official-tab') {
    return sendOfficialTabCommand<{ type?: string; state?: ConversationState; ok?: boolean; error?: string }>(p, 'get-state')
      .then((response) => {
        if (response?.ok === false) return { status: 'error', errorMessage: response.error ?? '官方标签页不可用' }
        return response?.state ?? { status: 'idle', requestTimedOut: true }
      })
  }
  const win = panelIframe(p).contentWindow
  if (!win) return Promise.resolve({ status: 'idle', requestTimedOut: true })
  return new Promise<ConversationStateResult>((resolve) => {
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
      logCaptureDebug({
        platform: p,
        event: 'request-conversation-state-timeout',
        timeoutMs,
      })
      resolve({ status: 'idle', requestTimedOut: true })
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

/**
 * 从 DeepSeek iframe 的侧边栏 DOM 中提取当前会话 ID
 * DeepSeek 的 location.href 始终是 /，但侧边栏中存在 /a/chat/s/<uuid> 链接
 * 第一个链接对应当前活跃会话
 */
function requestDeepSeekConversationUrl(timeoutMs = 1500): Promise<string> {
  const win = panelIframe('deepseek').contentWindow
  if (!win) return Promise.resolve('')
  return new Promise<string>((resolve) => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as {
        source?: string
        type?: string
        platform?: AIPlatform
        url?: string
      } | undefined
      if (
        e.source === win &&
        d?.source === 'aichatroom-content' &&
        d?.type === 'conversation-id' &&
        d?.platform === 'deepseek'
      ) {
        window.removeEventListener('message', onMsg)
        resolve(d.url ?? '')
      }
    }
    window.addEventListener('message', onMsg)
    postToIframe('deepseek', 'get-conversation-id')
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
  diagnosticTrackers: Partial<Record<AIPlatform, ResponseDiagnosticTracker>> = {},
  diagnosticWaitErrors: Partial<Record<AIPlatform, DiagnosticErrorCode>> = {},
) {
  // 修改回答回填前先看 docs/RESPONSE_CAPTURE_MAINTENANCE.md，避免再次覆盖旧历史或无限等待。
  if (platforms.length === 0) return
  if (attempt >= RESPONSE_BACKFILL_MAX_ATTEMPTS) {
    void (async () => {
      const session = await getSession(sessionId)
      if (!session) return
      const failures: Partial<Record<AIPlatform, string>> = {}
      for (const platform of platforms) {
        const response = session.responses[platform]
        if (response?.status !== 'pending') continue
        diagnosticTrackers[platform]?.finish({
          outcome: 'timed-out',
          errorCode: diagnosticWaitErrors[platform] ?? 'response-capture-timeout',
          now: Date.now(),
        })
        failures[platform] = 'response capture timed out'
        setStatus(platform, 'err', t(userSettings.language, 'send.statusFailed'))
        finishSendLockPlatform(platform)
        logCaptureDebug({
          platform,
          event: 'backfill-timeout',
          sessionId,
          attempt,
          lastTextPreview: textPreview(progress[platform]?.lastText ?? ''),
          lastStableCount: progress[platform]?.stableCount ?? 0,
          requiredStableCount: RESPONSE_STABLE_REQUIRED_POLLS,
        })
      }
      const updated = applyCaptureFailures(session, failures)
      if (updated !== session) await updateSession(updated)
    })().catch((e) => console.error('[AIChatRoom chat] response backfill timeout failed', e))
    for (const platform of platforms) {
      logCaptureDebug({
        platform,
        event: 'backfill-timeout-scheduled',
        sessionId,
        attempt,
        lastTextPreview: textPreview(progress[platform]?.lastText ?? ''),
        lastStableCount: progress[platform]?.stableCount ?? 0,
        requiredStableCount: RESPONSE_STABLE_REQUIRED_POLLS,
      })
    }
    return
  }

  setTimeout(() => {
    void backfillSessionResponses(
      sessionId,
      platforms,
      baselines,
      progress,
      attempt,
      diagnosticTrackers,
      diagnosticWaitErrors,
    )
  }, RESPONSE_BACKFILL_INTERVAL_MS)
}

async function backfillSessionResponses(
  sessionId: string,
  platforms: AIPlatform[],
  baselines: Partial<Record<AIPlatform, string>>,
  progress: Partial<Record<AIPlatform, ResponseCaptureProgress>>,
  attempt: number,
  diagnosticTrackers: Partial<Record<AIPlatform, ResponseDiagnosticTracker>>,
  diagnosticWaitErrors: Partial<Record<AIPlatform, DiagnosticErrorCode>>,
) {
  try {
    const session = await getSession(sessionId)
    if (!session) return

    const trackedPlatforms = platforms.filter((platform) => {
      const response = session.responses[platform]
      return response?.status === 'pending'
    })
    if (trackedPlatforms.length === 0) return

    const captured: Partial<Record<AIPlatform, string>> = {}
    const nextProgress = { ...progress }
    const nextDiagnosticWaitErrors = { ...diagnosticWaitErrors }
    await Promise.all(trackedPlatforms.map(async (platform) => {
      const state = await requestConversationState(platform, 1500)
      if (state.status === 'streaming') {
        setStatus(platform, 'warn', t(userSettings.language, 'send.statusResponding'))
      }
      const text = state.lastResponse ? state.lastResponse : await requestLastResponse(platform, 1500)
      const trimmedText = text.trim()
      const baselineText = (baselines[platform] ?? '').trim()
      diagnosticTrackers[platform]?.observe({
        now: Date.now(),
        status: state.status,
        responseLength: trimmedText.length,
        baselineLength: baselineText.length,
        differsFromBaseline: trimmedText !== baselineText,
        stopButtonDetected: state.stopButtonDetected === true,
      })
      nextDiagnosticWaitErrors[platform] = classifyResponseCaptureWait({
        stateRequestTimedOut: state.requestTimedOut === true,
        status: state.status,
        responseLength: trimmedText.length,
        differsFromBaseline: trimmedText !== baselineText,
      })
      const decision = evaluateResponseCapture(
        { text, status: state.status },
        baselines[platform],
        progress[platform],
        RESPONSE_STABLE_REQUIRED_POLLS,
      )
      nextProgress[platform] = decision.progress
      const completeForUnlock = isResponseCompleteForUnlock({ text, status: state.status }, baselines[platform])
      const willCapture = decision.shouldCapture && isNewCapturedResponse(decision.text, baselines[platform])
      // 详细诊断：分析 completeForUnlock 为 false 的原因
      const completeForUnlockReason = (() => {
        if (completeForUnlock) return 'complete'
        if (!trimmedText) return 'text-empty'
        if (trimmedText === baselineText) return 'text-equals-baseline'
        if (state.status === 'streaming' || state.status === 'queued' || state.status === 'sending') return `status-active-${state.status}`
        return 'unknown'
      })()
      logCaptureDebug({
        platform,
        event: 'backfill-poll',
        sessionId,
        attempt,
        stateStatus: state.status,
        route: platformMessageRoute(platform),
        textLength: text.trim().length,
        textPreview: textPreview(text),
        baselinePreview: textPreview(baselines[platform] ?? ''),
        previousStableCount: progress[platform]?.stableCount ?? 0,
        nextStableCount: decision.progress.stableCount,
        requiredStableCount: RESPONSE_STABLE_REQUIRED_POLLS,
        shouldCapture: decision.shouldCapture,
        willCapture,
        completeForUnlock,
        completeForUnlockReason,
      })
      if (completeForUnlock) {
        diagnosticTrackers[platform]?.finish({
          outcome: state.status === 'paused' ? 'paused' : 'completed',
          now: Date.now(),
        })
        setStatus(platform, 'ok', t(userSettings.language, 'send.statusDone'))
        finishSendLockPlatform(platform)
      }
      if (willCapture) {
        captured[platform] = decision.text
      }
    }))

    const updated = applyCapturedResponses(session, captured)
    for (const [platform, text] of Object.entries(captured) as Array<[AIPlatform, string]>) {
      logCaptureDebug({
        platform,
        event: 'history-capture',
        sessionId,
        attempt,
        textLength: text.trim().length,
        textPreview: textPreview(text),
      })
    }
    if (updated !== session) await updateSession(updated)

    const remaining = trackedPlatforms
    scheduleSessionResponseBackfill(
      sessionId,
      remaining,
      baselines,
      nextProgress,
      attempt + 1,
      diagnosticTrackers,
      nextDiagnosticWaitErrors,
    )
  } catch (e) {
    for (const platform of platforms) {
      diagnosticTrackers[platform]?.finish({
        outcome: 'failed',
        errorCode: 'unexpected-error',
        now: Date.now(),
      })
    }
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
  if (shouldUnlockInsteadOfSend(currentSendLock)) {
    forceUnlockComposer()
    return
  }
  if (currentSendLock?.status === 'waiting') {
    showToast(t(userSettings.language, 'send.lockStillSubmitting'), 'warn', 3000)
    return
  }
  const text = inputEl.value.trim()
  if (!text && !pendingAttachment) {
    showToast(t(userSettings.language, 'send.needTextOrAttachment'), 'warn')
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
    showToast(t(userSettings.language, 'send.noTextTarget'), 'warn')
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
        ? uiText('send.manualUploadWithText', { labels })
        : uiText('send.manualUploadOnly', { labels })
      showToast(message, 'warn', 6000)
    }
    if (targets.length === 0) {
      showToast(t(userSettings.language, 'send.noUploadTarget'), 'warn', 6000)
      return
    }
  }

  const diagnosticContexts: Partial<Record<AIPlatform, DiagnosticContext>> = {}
  if (userSettings.diagnosticEnabled) {
    const batchId = createDiagnosticBatchId()
    for (const platform of targets) diagnosticContexts[platform] = createDiagnosticContext(batchId)
  }

  beginSendLock(targets)
  targets.forEach((platform) => setStatus(platform, 'warn', t(userSettings.language, 'send.statusSending')))

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

  // 2. 发文字 + 附件到官方页面。iframe 被 CSP 拦住的平台会走官方标签页兜底。
  const results: PlatformSendResult[] = []
  await Promise.all(
    targets.map(async (p) => {
      const shouldUploadFile = deliveryPlan.autoUploadTargets.includes(p)
      const diagnosticContext = diagnosticContexts[p]
      const reporter = diagnosticContext
        ? createDiagnosticReporter(diagnosticContext, p, createDiagnosticProducerId('chat-ui'))
        : undefined
      const route = platformMessageRoute(p)
      reporter?.emit({
        component: 'chat-ui',
        operation: 'route-select',
        stage: 'routed',
        eventStatus: 'succeeded',
        route,
        inputCharacterCount: textToSend.length,
        hasAttachment: shouldUploadFile,
      })
      const result = await writeAndSendToPlatform(p, {
        text: textToSend,
        imageDataUrl: shouldUploadFile ? imageDataUrl : undefined,
        imageMime: shouldUploadFile ? imageMime : undefined,
        imageName: shouldUploadFile ? imageName : undefined,
        diagnostics: diagnosticContext,
      })
      if (!result.ok) {
        const timedOutWithoutReply = !result.error
        const terminalErrorCode = result.diagnosticErrorCode
          ?? (timedOutWithoutReply ? routeTimeoutErrorCode(route) : undefined)
        reporter?.emit({
          component: route === 'iframe' ? 'iframe-bridge' : 'official-tab',
          operation: 'result-return',
          stage: timedOutWithoutReply ? 'timed-out' : 'failed',
          eventStatus: timedOutWithoutReply ? 'timed-out' : 'failed',
          route,
          ...(terminalErrorCode
            ? {
                runOutcome: timedOutWithoutReply ? 'timed-out' : 'failed',
                errorCode: terminalErrorCode,
                timeoutMs: route === 'iframe' ? iframeWriteResultTimeoutMs({
                  imageDataUrl: shouldUploadFile ? imageDataUrl : undefined,
                }) : undefined,
              }
            : {}),
        })
      }
      results.push(result)
    }),
  )

  markCurrentSendSubmitted()

  for (const result of results) {
    if (result.ok) {
      setStatus(result.p, 'warn', t(userSettings.language, 'send.statusWaiting'))
    } else {
      setStatus(result.p, 'err', t(userSettings.language, 'send.statusFailed'))
      finishSendLockPlatform(result.p)
    }
  }

  const responseDiagnosticTrackers = Object.fromEntries(
    results
      .filter((result) => result.ok && diagnosticContexts[result.p])
      .map((result) => {
        const context = diagnosticContexts[result.p]!
        return [
          result.p,
          createResponseDiagnosticTracker(
            createDiagnosticReporter(
              context,
              result.p,
              createDiagnosticProducerId('response-capture'),
            ),
            Date.now(),
          ),
        ]
      }),
  ) as Partial<Record<AIPlatform, ResponseDiagnosticTracker>>

  const failResponseDiagnosticTrackers = () => {
    for (const tracker of Object.values(responseDiagnosticTrackers)) {
      tracker?.finish({ outcome: 'failed', errorCode: 'unexpected-error', now: Date.now() })
    }
  }

  if (currentSession) {
    try {
      currentSession = applySendResults(currentSession, results)
      await updateSession(currentSession)
      scheduleSessionResponseBackfill(
        currentSession.id,
        results.filter((r) => r.ok).map((r) => r.p),
        responseBaselines,
        {},
        0,
        responseDiagnosticTrackers,
      )
    } catch (e) {
      failResponseDiagnosticTrackers()
      console.error('[AIChatRoom chat] failed to update session history', e)
    }
  } else {
    failResponseDiagnosticTrackers()
  }
  scheduleConversationSnapshot(text, results.filter((r) => r.ok).map((r) => r.p))

  // 3. 根据结果给一个合并的 toast
  const okCount = results.filter((r) => r.ok).length
  const firstError = results.find((r) => !r.ok && r.error)?.error
  if (pendingAttachment?.classification.handling === 'file-upload') {
    if (okCount === results.length && results.length > 0) {
      showToast(t(userSettings.language, 'send.fileAllSent'), 'success', 2500)
    } else if (okCount > 0) {
      // 部分成功:v0.5+ 不再走剪贴板兜底(跨源 iframe 写剪贴板经常失败)
      showToast(t(userSettings.language, 'send.filePartial'), 'warn', 6000)
    } else {
      // 全部失败:v0.5+ 不再走剪贴板兜底
      showToast(firstError ?? t(userSettings.language, 'send.fileFailed'), 'err', 6000)
    }
  } else {
    if (okCount === 0 && results.length > 0) {
      showToast(firstError ?? t(userSettings.language, 'send.failed'), 'err', 3000)
    } else {
      showToast(t(userSettings.language, 'send.success'), 'success', 1200)
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
    const icon = document.createElement('span')
    icon.className = 'at-chip-icon'
    icon.textContent = meta.icon
    const label = document.createElement('span')
    label.textContent = `@${meta.label}`
    const remove = document.createElement('span')
    remove.className = 'at-chip-remove'
    remove.title = t(userSettings.language, 'at.remove')
    remove.textContent = '×'
    chip.append(icon, label, remove)
    remove.addEventListener('click', (ev) => {
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
    empty.textContent = t(userSettings.language, 'at.empty')
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
  hint.textContent = t(userSettings.language, 'at.hint')
  atPopupEl.appendChild(hint)
  // 渲染完后再做定位(用真实高度)
  positionAtPopup()
}

/**
 * 弹层定位:贴 textarea,下方放不下就翻到上方;用真实 offsetHeight 决定
 */
function positionAtPopup() {
  const rect = composerTextbox.getBoundingClientRect()
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
    showToast(uiText('transfer.unsupportedSource', { sourceLabel: getPlatformMeta(sourceKey)?.label ?? sourceKey }), 'warn')
    return
  }

  const candidates = platformsWithCapability('supportsText').filter((p) => p !== sourceKey)
  if (candidates.length === 0) {
    showToast(uiText('transfer.noTarget'), 'warn')
    return
  }
  await openTransferDialog(sourceKey, candidates)
}

async function getCurrentTransferResponse(sourceKey: AIPlatform): Promise<string> {
  const state = await requestConversationState(sourceKey, 2000)
  if (!['idle', 'finished', 'error'].includes(state.status)) {
    showToast(uiText('transfer.sourceBusy', { status: state.status }), 'warn', 4000)
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
    .join(userSettings.language === 'zh-CN' ? '、' : ', ')
}

async function executeTransferToTargets(sourceKey: AIPlatform, targetKeys: AIPlatform[], selectedContent: string) {
  for (const targetKey of targetKeys) {
    await executeTransfer(sourceKey, targetKey, selectedContent)
  }
}

async function openTransferDialog(sourceKey: AIPlatform, candidates: AIPlatform[]) {
  transferSourcePlatform = sourceKey
  const sourceLabel = getPlatformMeta(sourceKey)?.label ?? sourceKey
  transferTitle.textContent = uiText('transfer.dialogTitle', { sourceLabel })
  transferOverlay.hidden = false
  transferList.innerHTML = ''
  const loading = document.createElement('div')
  loading.className = 'history-empty'
  loading.textContent = uiText('transfer.loading')
  transferList.appendChild(loading)
  transferPreview.innerHTML = ''
  transferSelected.textContent = uiText('transfer.selectedCount', { count: 0 })
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
    empty.textContent = uiText('transfer.empty')
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
    title.textContent = option.source === 'current' ? uiText('transfer.currentResponse') : compactText(option.prompt)
    const meta = document.createElement('span')
    meta.className = 'summary-item-meta'
    meta.textContent = `${formatTime(option.createdAt)} · ${option.source === 'current' ? uiText('transfer.currentPage') : uiText('transfer.historyRecord')}`
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
  transferSelected.textContent = uiText('transfer.selectedCount', { count })
  btnTransferSend.disabled = count === 0 || !transferSourcePlatform || selectedTransferTargets().length === 0
  renderTransferPreview()
}

function renderTransferPreview() {
  transferPreview.innerHTML = ''
  const sourceKey = transferSourcePlatform
  const sourceLabel = sourceKey ? getPlatformMeta(sourceKey)?.label ?? sourceKey : t(userSettings.language, 'transfer.title')
  const selected = selectedTransferSourceOptions()
  if (selected.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'summary-preview-empty'
    empty.textContent = uiText('transfer.previewEmpty')
    transferPreview.appendChild(empty)
    return
  }

  const card = document.createElement('article')
  card.className = 'summary-preview-card'
  const header = document.createElement('header')
  header.className = 'summary-preview-card-header'
  const title = document.createElement('h4')
  title.className = 'summary-preview-title'
  title.textContent = uiText('transfer.previewSummary', { sourceLabel, count: selected.length })
  const meta = document.createElement('div')
  meta.className = 'summary-preview-meta'
  const targets = selectedTransferTargets()
  meta.textContent = targets.length > 0
    ? uiText('transfer.sendTo', { targets: formatTransferTargetLabels(targets) })
    : uiText('transfer.chooseTargets')
  header.append(title, meta)
  card.appendChild(header)
  appendSummaryPreviewSection(card, uiText('transfer.contentSection'), buildTransferContent(selected, sourceLabel))
  transferPreview.appendChild(card)
}

async function onSendTransferSelection() {
  if (!transferSourcePlatform) return
  const targets = selectedTransferTargets()
  const selected = selectedTransferSourceOptions()
  if (targets.length === 0 || selected.length === 0) {
    showToast(uiText('transfer.needSelection'), 'warn')
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
    srcBtn.textContent = uiText('transfer.sending')
  }
  if (tgtBtn) tgtBtn.disabled = true

  try {
    const srcIframe = panelIframe(sourceKey)
    const srcWin = srcIframe.contentWindow
    if (!srcWin && !selectedContent) throw new Error(t(userSettings.language, 'transfer.sourceFrameUnavailable'))

    let content = selectedContent?.trim() ?? ''
    if (!content) {
      if (!srcWin) throw new Error(t(userSettings.language, 'transfer.sourceFrameUnavailable'))
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
        showToast(uiText('transfer.sourceBusy', { status: srcState.status }), 'warn', 4000)
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
      showToast(uiText('transfer.noSourceResponse'), 'warn', 4000)
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
          showToast(uiText('transfer.targetBusy', { status: tgtState.status }), 'warn', 4000)
          return
        }
      } catch { /* 预检失败不阻塞 */ }
    }

    // 4. 长文本保护
    let finalContent = content
    if (content.length > MAX_TRANSFER_LENGTH) {
      finalContent = content.slice(0, MAX_TRANSFER_LENGTH) +
        `\n\n${uiText('transfer.truncatedSuffix', { length: content.length })}`
      showToast(uiText('transfer.truncated', { max: MAX_TRANSFER_LENGTH }), 'warn', 4000)
    }

    // 5. 渲染模板
    const fromLabel = getPlatformMeta(sourceKey)?.label ?? sourceKey
    const prompt = renderTemplate(userSettings.promptTemplates.transfer, { fromLabel, content: finalContent })

    // 6. 发送到目标
    showToast(uiText('transfer.sendingToast', {
      fromLabel,
      targetLabel: getPlatformMeta(targetKey)?.label ?? targetKey,
    }), 'info', 2000)
    postToIframe(targetKey, 'write-and-send', { text: prompt })
  } catch (e) {
    console.error('[AIChatRoom chat] transfer failed', e)
    showToast(uiText('transfer.failed', { message: e instanceof Error ? e.message : String(e) }), 'err', 5000)
  } finally {
    if (srcBtn) {
      srcBtn.classList.remove('busy')
      srcBtn.disabled = !getPlatformCapabilities(sourceKey).supportsLastResponse
      srcBtn.textContent = t(userSettings.language, 'panel.transfer')
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
  if (!oneLine) return t(userSettings.language, 'common.emptyQuestion')
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine
}

function responseLabel(response?: SessionResponse): string {
  if (!response) return t(userSettings.language, 'history.status.notSent')
  if (response.status === 'captured') return t(userSettings.language, 'history.status.captured')
  if (response.status === 'failed') return t(userSettings.language, 'history.status.failed')
  return t(userSettings.language, 'history.status.pending')
}

function summarizeSessionTargetsForUi(session: Session): string {
  return session.targetPlatforms
    .map((platform) => `${getPlatformMeta(platform)?.label ?? platform} ${responseLabel(session.responses[platform])}`)
    .join(' / ')
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

function renderHistoryList() {
  historyList.innerHTML = ''
  if (historySessions.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'history-empty'
    empty.textContent = t(userSettings.language, 'history.empty')
    historyList.appendChild(empty)
    return
  }

  const visibleSessions = filterSessionsByTitle(historySessions, historySearchInput.value)
  if (visibleSessions.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'history-empty'
    empty.textContent = t(userSettings.language, 'history.noMatch')
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
    targets.textContent = summarizeSessionTargetsForUi(session)

    item.append(title, meta, targets)
    item.addEventListener('click', () => {
      selectedHistoryId = session.id
      renderHistoryList()
      renderHistoryDetail(session)
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
    empty.textContent = historySessions.length === 0
      ? t(userSettings.language, 'history.empty')
      : t(userSettings.language, 'history.selectOne')
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
  meta.textContent = `${formatTime(session.createdAt)} · ${summarizeSessionTargetsForUi(session)}`
  headingWrap.append(title, meta)

  const actions = document.createElement('div')
  actions.className = 'history-actions'
  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'history-action'
  copyBtn.textContent = t(userSettings.language, 'common.copyMarkdown')
  copyBtn.addEventListener('click', () => void copySessionMarkdown(session))
  const exportBtn = document.createElement('button')
  exportBtn.type = 'button'
  exportBtn.className = 'history-action'
  exportBtn.textContent = t(userSettings.language, 'common.exportMarkdown')
  exportBtn.addEventListener('click', () => exportSessionMarkdown(session))
  const deleteBtn = document.createElement('button')
  deleteBtn.type = 'button'
  deleteBtn.className = 'history-action danger'
  deleteBtn.textContent = t(userSettings.language, 'common.delete')
  deleteBtn.addEventListener('click', () => void deleteHistorySession(session.id))
  actions.append(copyBtn, exportBtn, deleteBtn)
  header.append(headingWrap, actions)
  historyDetail.appendChild(header)

  if (session.summaries.length > 0) {
    appendHistorySection(t(userSettings.language, 'history.summaryInfo'), formatSummaryHistoryInfo(session.summaries[0]))
  }
  appendHistorySection(t(userSettings.language, 'history.userQuestion'), session.prompt || t(userSettings.language, 'common.empty'))
  if (session.sentPrompt && session.sentPrompt !== session.prompt) {
    appendHistorySection(t(userSettings.language, 'history.sentPrompt'), session.sentPrompt)
  }
  if (session.attachments.length > 0) {
    appendAttachmentSection(session.attachments)
  }
  for (const platform of session.targetPlatforms) {
    const label = getPlatformMeta(platform)?.label ?? platform
    const response = session.responses[platform]
    const text = response?.status === 'captured' && response.text.trim()
      ? formatCapturedMarkdownText(normalizeCapturedResponse(platform, response.text))
      : responseLabel(response)
    appendHistorySection(uiText('history.responseTitle', { label }), text)
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
  copyBtn.title = uiText('history.copyBlockTitle', { title: titleText })
  copyBtn.textContent = t(userSettings.language, 'common.copy')
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
    showToast(t(userSettings.language, 'history.copyBlockSuccess'), 'success', 1200)
  } catch (e) {
    console.error('[AIChatRoom chat] failed to copy history block', e)
    showToast(t(userSettings.language, 'common.copyFailed'), 'err', 3000)
  }
}

function formatSummaryHistoryInfo(summary: SessionSummary): string {
  const targetLabel = getPlatformMeta(summary.target)?.label ?? summary.target
  const modeLabel = summaryModeLabelText(summary.mode)
  const sourceCount = summary.sourceSessionIds.length
  return [
    uiText('history.summaryTarget', { targetLabel }),
    uiText('history.summaryMode', { modeLabel }),
    uiText('history.summarySourceCount', { count: sourceCount }),
    uiText('history.summarySentAt', { time: formatTime(summary.sentAt ?? summary.timestamp) }),
  ].join('\n')
}

function appendAttachmentSection(attachments: SessionAttachment[]) {
  const section = document.createElement('section')
  section.className = 'history-section'
  const title = document.createElement('h3')
  title.textContent = t(userSettings.language, 'history.attachments')
  const list = document.createElement('ul')
  list.className = 'history-attachments'
  for (const attachment of attachments) {
    const item = document.createElement('li')
    item.textContent = `${attachment.name} · ${attachment.mime || t(userSettings.language, 'common.unknownType')} · ${formatBytes(attachment.size)}`
    list.appendChild(item)
  }
  section.append(title, list)
  historyDetail.appendChild(section)
}

async function copySessionMarkdown(session: Session) {
  try {
    await navigator.clipboard.writeText(formatSessionMarkdown(session))
    showToast(t(userSettings.language, 'history.copyMarkdownSuccess'), 'success', 1600)
  } catch (e) {
    console.error('[AIChatRoom chat] failed to copy history markdown', e)
    showToast(t(userSettings.language, 'common.copyFailed'), 'err', 3000)
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
  showToast(t(userSettings.language, 'history.exportMarkdownSuccess'), 'success', 1600)
}

async function deleteHistorySession(id: string) {
  if (!confirm(t(userSettings.language, 'history.deleteConfirm'))) return
  await deleteSession(id)
  historySessions = historySessions.filter((s) => s.id !== id)
  selectFirstVisibleHistorySession()
  showToast(t(userSettings.language, 'history.deleteSuccess'), 'success', 1600)
}

async function openHistory() {
  historyOverlay.hidden = false
  historySearchInput.value = ''
  historyDetail.innerHTML = ''
  const loading = document.createElement('div')
  loading.className = 'history-empty'
  loading.textContent = t(userSettings.language, 'history.refreshing')
  historyDetail.appendChild(loading)
  historySessions = (await loadSessions()).sort((a, b) => b.createdAt - a.createdAt)
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
    .map((platform) => getPlatformMeta(platform)?.label ?? platform)
    .join(' / ')
}

async function saveConversationSnapshot(title: string, platforms: AIPlatform[]) {
  const entries = await Promise.all(
    platforms.map(async (platform) => {
      if (platform === 'deepseek') {
        const url = await requestDeepSeekConversationUrl(2000)
        return [platform, url] as const
      }
      return [platform, await requestPlatformLocation(platform)] as const
    }),
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
    empty.textContent = t(userSettings.language, 'conversation.empty')
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

    const renameBtn = document.createElement('button')
    renameBtn.type = 'button'
    renameBtn.className = 'conversation-rename'
    renameBtn.title = t(userSettings.language, 'conversation.renameTitle')
    renameBtn.textContent = t(userSettings.language, 'conversation.renameShort')
    renameBtn.addEventListener('click', (event) => {
      event.stopPropagation()
      void renameConversationEntry(entry)
    })

    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.className = 'conversation-delete'
    deleteBtn.title = t(userSettings.language, 'conversation.deleteTitle')
    deleteBtn.textContent = t(userSettings.language, 'conversation.deleteShort')
    deleteBtn.addEventListener('click', (event) => {
      event.stopPropagation()
      void deleteConversationEntry(entry.id)
    })

    item.append(main, time, renameBtn, deleteBtn)
    item.addEventListener('click', () => void restoreConversation(entry))
    conversationList.appendChild(item)
  }
}

async function renameConversationEntry(entry: ConversationEntry) {
  const nextTitle = prompt(t(userSettings.language, 'conversation.renamePrompt'), entry.title)?.trim()
  if (!nextTitle || nextTitle === entry.title) return

  const renamed = await renameConversation(entry.id, nextTitle)
  if (!renamed) return
  conversationEntries = conversationEntries.map((item) => (item.id === renamed.id ? renamed : item))
  renderConversationList()
  showToast(t(userSettings.language, 'conversation.renameSuccess'), 'success', 1600)
}

async function deleteConversationEntry(id: string) {
  if (!confirm(t(userSettings.language, 'conversation.deleteConfirm'))) return
  await deleteConversation(id)
  conversationEntries = conversationEntries.filter((entry) => entry.id !== id)
  renderConversationList()
  showToast(t(userSettings.language, 'conversation.deleteSuccess'), 'success', 1600)
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
    language: userSettings.language,
    promptTemplates: userSettings.promptTemplates,
    promptTemplateCustomizations: userSettings.promptTemplateCustomizations,
  })
  applyUserSettings(saved)

  for (const [platform, url] of Object.entries(entry.platformUrls) as Array<[AIPlatform, string | undefined]>) {
    if (!url) continue
    const panel = platformPanel(platform)
    if (!panel) continue

    readyMap[platform] = false
    setStatus(platform, 'warn', t(userSettings.language, 'common.loading'))
    panelIframe(platform).src = url
  }
  closeConversationHistory()
  showToast(t(userSettings.language, 'conversation.restoreSuccess'), 'success', 1600)
  void refreshAllStatuses()
}

async function openConversationHistory() {
  conversationOverlay.hidden = false
  conversationList.innerHTML = ''
  const loading = document.createElement('div')
  loading.className = 'history-empty'
  loading.textContent = t(userSettings.language, 'conversation.loading')
  conversationList.appendChild(loading)
  conversationEntries = await loadConversations()
  renderConversationList()
}

function closeConversationHistory() {
  conversationOverlay.hidden = true
}

const SUMMARY_MODE_TEMPLATE_KEYS: Record<SummaryMode, UserPromptTemplateKey> = {
  'final-answer': 'summaryFinalAnswer',
  differences: 'summaryDifferences',
  'short-summary': 'summaryShort',
  'opinion-digest': 'summaryOpinionDigest',
}

function pickSummaryTarget(): AIPlatform | null {
  const textCapable = new Set(platformsWithCapability('supportsText'))
  return activePlatforms().find((p) => textCapable.has(p)) ?? null
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
    empty.textContent = t(userSettings.language, 'history.empty')
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
    targets.textContent = summarizeSessionTargetsForUi(session)

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
  summarySelected.textContent = uiText('summary.selectedCount', { count: selectedSummaryIds.size })
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
    empty.textContent = t(userSettings.language, 'summary.noSourceResponses')
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
    empty.textContent = t(userSettings.language, 'summary.previewEmpty')
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
    meta.textContent = `${formatTime(session.createdAt)} · ${summarizeSessionTargetsForUi(session)}`
    header.append(title, meta)
    card.appendChild(header)

    appendSummaryPreviewSection(card, t(userSettings.language, 'history.userQuestion'), session.prompt || t(userSettings.language, 'common.empty'))
    if (session.sentPrompt && session.sentPrompt !== session.prompt) {
      appendSummaryPreviewSection(card, t(userSettings.language, 'history.sentPrompt'), session.sentPrompt)
    }
    for (const platform of session.targetPlatforms) {
      if (!selectedSummaryPlatforms.has(platform)) continue
      const label = getPlatformMeta(platform)?.label ?? platform
      const response = session.responses[platform]
      const text = response?.status === 'captured' && response.text.trim()
        ? response.text
        : responseLabel(response)
      appendSummaryPreviewSection(card, uiText('history.responseTitle', { label }), text)
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
  const normalized = text.trim() || t(userSettings.language, 'common.empty')
  return normalized.length > max
    ? `${normalized.slice(0, max)}\n\n${t(userSettings.language, 'summary.longPreview')}`
    : normalized
}

async function openSummaryDialog() {
  summaryOverlay.hidden = false
  summaryList.innerHTML = ''
  const loading = document.createElement('div')
  loading.className = 'history-empty'
  loading.textContent = t(userSettings.language, 'summary.loading')
  summaryList.appendChild(loading)
  selectedSummaryIds.clear()
  selectedSummaryPlatforms.clear()
  renderSummaryTargets()
  syncSummaryModeOptions()
  summaryModeSelect.value = 'final-answer'

  summarySessions = (await loadSessions()).sort((a, b) => b.createdAt - a.createdAt)
  if (summarySessions[0]) {
    selectedSummaryIds.add(summarySessions[0].id)
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
  const firstPrompt = compactText(sessions[0]?.prompt ?? t(userSettings.language, 'history.empty'), 56)
  const modeLabel = summaryModeLabelText(mode)
  const countLabel = sessions.length > 1
    ? uiText('summary.multipleCount', { firstPrompt, count: sessions.length })
    : firstPrompt
  return uiText('summary.recordTitle', { modeLabel, countLabel })
}

async function onGenerateSummary() {
  const target = summaryTargetSelect.value as AIPlatform
  if (!target) {
    showToast(t(userSettings.language, 'summary.noTarget'), 'warn')
    return
  }

  const sessions = selectedSummarySessions()
  if (sessions.length === 0) {
    showToast(t(userSettings.language, 'summary.needHistory'), 'warn')
    return
  }
  const includedPlatforms = [...selectedSummaryPlatforms]
  if (includedPlatforms.length === 0) {
    showToast(t(userSettings.language, 'summary.needSource'), 'warn')
    return
  }
  const incomplete = sessions.filter((session) => !hasCapturedResponseFromPlatforms(session, includedPlatforms))
  if (incomplete.length > 0) {
    showToast(uiText('summary.incomplete', { count: incomplete.length }), 'warn', 5000)
    return
  }

  const mode = summaryModeSelect.value as SummaryMode
  const prompt = buildSummaryPrompt(userSettings.promptTemplates[SUMMARY_MODE_TEMPLATE_KEYS[mode]], sessions, {
    targetLabel: getPlatformMeta(target)?.label ?? target,
    mode,
    modeLabel: summaryModeLabelText(mode),
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
    showToast(uiText('summary.sent', { targetLabel: getPlatformMeta(target)?.label ?? target }), 'success', 1800)
  } catch (e) {
    console.error('[AIChatRoom chat] summary failed', e)
    showToast(uiText('summary.failed', { message: e instanceof Error ? e.message : String(e) }), 'err', 5000)
  } finally {
    updateSummarySelectedCount()
  }
}

// ---------- 工具按钮(暂作占位) ----------
// 转发按钮(panel header 上的 .panel-transfer)由 setupTransferButtons() 单独绑定(动态 target)
async function onSummary() {
  if (activePlatforms().length === 0) {
    showToast(t(userSettings.language, 'summary.noTarget'), 'warn')
    return
  }
  await openSummaryDialog()
}
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
      userSettings.enabledPlatforms[platform] ? t(userSettings.language, 'panelMenu.shown') : t(userSettings.language, 'panelMenu.hidden'),
      () => void onSwitchPanel(source, platform),
    )
  }
}

function renderPanelAddMenu() {
  panelSwitchMenu.innerHTML = ''
  panelSwitchMenu.dataset.mode = 'add'
  const hiddenPlatforms = allPlatforms().filter((platform) => !userSettings.enabledPlatforms[platform])
  for (const platform of hiddenPlatforms) {
    appendPanelMenuItem(platform, false, t(userSettings.language, 'panelMenu.add'), () => void onAddPanel(platform))
  }
  if (hiddenPlatforms.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'at-popup-empty'
    empty.textContent = t(userSettings.language, 'panelMenu.noAddable')
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
    showToast(t(userSettings.language, 'panelMenu.allShown'), 'info', 1800)
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
    language: userSettings.language,
    captureDebug: userSettings.captureDebug,
    diagnosticEnabled: userSettings.diagnosticEnabled,
    diagnosticNoticeVersionSeen: userSettings.diagnosticNoticeVersionSeen,
    promptTemplates: userSettings.promptTemplates,
    promptTemplateCustomizations: userSettings.promptTemplateCustomizations,
  }

  await savePanelSettings(next, t(userSettings.language, 'panelMenu.updated'), t(userSettings.language, 'panelMenu.switchFailed'))
}

async function onAddPanel(platform: AIPlatform) {
  closePanelSwitchMenu()
  const enabledPlatforms = { ...userSettings.enabledPlatforms }
  if (enabledPlatformKeys().length >= MAX_ACTIVE_PLATFORMS) {
    showToast(uiText('panelMenu.maxActive', { count: MAX_ACTIVE_PLATFORMS }), 'warn')
    return
  }
  enabledPlatforms[platform] = true
  await savePanelSettings({
    enabledPlatforms,
    platformOrder: userSettings.platformOrder,
    language: userSettings.language,
    captureDebug: userSettings.captureDebug,
    diagnosticEnabled: userSettings.diagnosticEnabled,
    diagnosticNoticeVersionSeen: userSettings.diagnosticNoticeVersionSeen,
    promptTemplates: userSettings.promptTemplates,
    promptTemplateCustomizations: userSettings.promptTemplateCustomizations,
  }, t(userSettings.language, 'panelMenu.added'), t(userSettings.language, 'panelMenu.addFailed'))
}

async function onClosePanel(platform: AIPlatform) {
  const active = enabledPlatformKeys()
  if (active.length <= MIN_ACTIVE_PLATFORMS) {
    showToast(uiText('panelMenu.minActive', { count: MIN_ACTIVE_PLATFORMS }), 'warn')
    return
  }
  const enabledPlatforms = { ...userSettings.enabledPlatforms, [platform]: false }
  await savePanelSettings({
    enabledPlatforms,
    platformOrder: userSettings.platformOrder,
    language: userSettings.language,
    captureDebug: userSettings.captureDebug,
    diagnosticEnabled: userSettings.diagnosticEnabled,
    diagnosticNoticeVersionSeen: userSettings.diagnosticNoticeVersionSeen,
    promptTemplates: userSettings.promptTemplates,
    promptTemplateCustomizations: userSettings.promptTemplateCustomizations,
  }, t(userSettings.language, 'panelMenu.closed'), t(userSettings.language, 'panelMenu.closeFailed'))
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
  inputEl.addEventListener('input', updateSendButtonState)
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
  settingLanguage.addEventListener('change', () => {
    syncCurrentPromptDraft()
    const language = settingLanguage.value as UserLanguage
    refreshDefaultPromptDrafts(language)
    userSettings = { ...userSettings, language }
    applyStaticUiLanguage(language)
  })
  settingPromptKind.addEventListener('change', () => {
    syncCurrentPromptDraft()
    selectedPromptTemplateKey = settingPromptKind.value as UserPromptTemplateKey
    renderPromptTemplateEditor()
  })
  settingPromptTemplate.addEventListener('input', () => {
    promptTemplateCustomizationDrafts[selectedPromptTemplateKey] = true
  })
  btnResetPromptTemplate.addEventListener('click', () => {
    settingPromptTemplate.value = getDefaultUserPromptTemplates(settingLanguage.value as UserLanguage)[selectedPromptTemplateKey]
    promptTemplateCustomizationDrafts[selectedPromptTemplateKey] = false
    syncCurrentPromptDraft()
  })
  settingDiagnosticEnabled.addEventListener('change', () => {
    clearDiagnosticsWhenDisabled = !settingDiagnosticEnabled.checked
      && diagnosticEventCount > 0
      && confirm(t(userSettings.language, 'diagnostic.clearOnDisableConfirm'))
  })
  btnDiagnosticView.addEventListener('click', () => void viewDiagnostics().catch(reportDiagnosticUiFailure))
  btnDiagnosticCopyFailure.addEventListener('click', () => void copyLatestFailedDiagnostics().catch(reportDiagnosticUiFailure))
  btnDiagnosticDownload.addEventListener('click', () => void downloadDiagnostics().catch(reportDiagnosticUiFailure))
  btnDiagnosticClear.addEventListener('click', () => void clearDiagnostics().catch(reportDiagnosticUiFailure))
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
