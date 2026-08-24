import type { AIAdapter, AdapterDiagnostics, AdapterSendInternals } from '../base'
import { emitDiagnostic } from '../shared/diagnostics'
import { attachImageToFileInput as sharedAttachImageToFileInput } from '../shared/file-input'
import { attachFileWithFallback } from '../shared/attachment-evidence'
import { writeEditableValue } from '../shared/dom-write'
import {
  queryFirst,
  writeNativeTextareaValue,
  activateControl,
  normalizeText,
  mapProseOutsideFencedCode,
  isHidden,
  elementMarker,
  hasDirectResponseActions,
  hasStopGeneratingButton,
  isUserMessage,
  dispatchEnter,
  hasPendingContent,
} from '../shared/ds-doubao-shared'
import { createResponseCursor, type ResponseCursor } from '../shared/response-cursor'
import type { ConversationState } from '../../types'
import { buildDataTransferFromFile, dispatchPaste } from '../../lib/image-handler'
import { elementToMarkdownText, stripThinkingNodes } from '../../lib/dom-response-text'
import { describeCaptureElement, logCaptureDebug } from '../../lib/capture-debug'
import { notifyDebugAlert } from '../../lib/debug-fallback-notify'
import { mergeSelectorOverrides, type SelectorOverrideMap } from '../../lib/remote-selector-config'

// ⚠️ 提醒：下面这组内置默认选择器（inputBox / sendButton / stopButton / response）
// 对应的 key 都在 remote-selector-config.ts 的 ALLOWED_SELECTOR_KEYS.doubao 里，
// 意味着它们本该可以通过服务器端热更新覆盖，不用等发版——但热更新只在服务器那份
// 远程配置（chatduel.ifeeling.app）里真的写了对应值时才生效。改了这里任何一个选择器
// （比如豆包又改版，某个 class/文案变了），记得同步去更新服务器端的远程配置，
// 否则装了旧版本、还没吃到新发行版的用户只能继续用这里的旧默认值，等于白改。
const DEFAULT_INPUT_SELECTORS = [
  'textarea[placeholder*="发消息"]',
  'textarea',
  '[contenteditable="true"]',
  '[role="textbox"]',
]

const DEFAULT_SEND_BUTTON_SELECTORS = [
  'button[aria-label*="发送"]',
  'button[title*="发送"]',
  'button[type="submit"]',
  '[role="button"][aria-label*="发送"]',
  '[role="button"][title*="发送"]',
]

const DEFAULT_STOP_BUTTON_SELECTORS = [
  'button[aria-label*="停止"]',
  'button[title*="停止"]',
  'button[aria-label*="中止"]',
  'button[title*="中止"]',
  'button[aria-label*="取消"]',
  'button[title*="取消"]',
  'button[aria-label*="stop" i]',
  'button[title*="stop" i]',
  'button[aria-label*="cancel" i]',
  'button[title*="cancel" i]',
  '[role="button"][aria-label*="停止"]',
  '[role="button"][title*="停止"]',
  '[role="button"][aria-label*="中止"]',
  '[role="button"][title*="中止"]',
  '[role="button"][aria-label*="取消"]',
  '[role="button"][title*="取消"]',
  '[role="button"][aria-label*="stop" i]',
  '[role="button"][title*="stop" i]',
  '[role="button"][aria-label*="cancel" i]',
  '[role="button"][title*="cancel" i]',
  '[data-testid*="stop" i]',
  '[data-testid*="cancel" i]',
  '[class*="stop" i]',
  '[class*="cancel" i]',
  // 真机确认（2026-08-22）：豆包当前 UI 的"打断生成"控件既没有 aria-label/title，也不含
  // stop/cancel/停止/取消 这类文案，唯一的标记是 class 里的 break-btn-<hash>（"打断"）。
  // 生成中它替换掉输入框末尾的语音图标；连续采样确认它在整个生成过程（含专家模式思考
  // 阶段的长时间停顿）里持续存在，生成一结束就立刻消失，是目前唯一可靠的"仍在生成"信号。
  '[class*="break-btn" i]',
]

const DEFAULT_RESPONSE_SELECTORS = [
  '[data-testid*="assistant" i]',
  '[data-testid*="answer" i]',
  '[data-testid*="message" i]',
  '[class*="assistant" i]',
  '[class*="answer" i]',
  '[class*="markdown" i]',
  '[class*="message" i]',
  'article',
  '[role="article"]',
]

const RESPONSE_EXCLUDE_ANCESTORS = [
  'aside',
  'nav',
  'header',
  'footer',
  'textarea',
  'input',
  'button',
  '[role="button"]',
  '[contenteditable="true"]',
].join(',')

const RESPONSE_QUIET_FALLBACK_MS = 45_000
const COMPLETION_ACTION_BAR_SELECTORS = [
  '[class*="message-action-bar"]',
  '[data-foundation-type*="message-action-bar"]',
  '[data-testid*="message-action"]',
]

interface DoubaoSelectors {
  [key: string]: string[]
  inputBox: string[]
  sendButton: string[]
  stopButton: string[]
  response: string[]
}

const DEFAULT_SELECTORS: DoubaoSelectors = {
  inputBox: DEFAULT_INPUT_SELECTORS,
  sendButton: DEFAULT_SEND_BUTTON_SELECTORS,
  stopButton: DEFAULT_STOP_BUTTON_SELECTORS,
  response: DEFAULT_RESPONSE_SELECTORS,
}
export const DOUBAO_SELECTOR_VERSION = 'builtin-1'

export interface DoubaoAttachmentProbeResult {
  inputFound: boolean
  explicitFileInputFound: boolean
  imageFileInputFound: boolean
  documentFileInputFound: boolean
  misleadingCreationShortcutFound: boolean
  canAutoUploadImage: boolean
  canAutoUploadFile: boolean
  reason: string
}

function composerScope(input: HTMLElement): HTMLElement {
  let best: HTMLElement | null = null
  let scope: HTMLElement = input
  for (let depth = 0; scope.parentElement && depth < 8; depth += 1) {
    scope = scope.parentElement
    if (scope === document.body || scope === document.documentElement) break
    if (scope.querySelector('textarea, [contenteditable="true"], [role="textbox"]')) best = scope
  }
  return best ?? input
}

function attachmentEvidenceCount(scope: HTMLElement, file: File): number {
  const mediaCount = scope.querySelectorAll('img, video, canvas').length
  const fileName = file.name.toLowerCase()
  const fileNameHit = [...scope.querySelectorAll<HTMLElement>('*')]
    .some((el) => {
      const marker = [
        el.textContent ?? '',
        el.getAttribute('alt') ?? '',
        el.getAttribute('title') ?? '',
        el.getAttribute('aria-label') ?? '',
      ].join(' ').toLowerCase()
      return marker.includes(fileName)
    }) ? 1 : 0
  const uploadMarks = scope.querySelectorAll('[class*="upload" i], [class*="attachment" i], [class*="file" i], [data-testid*="upload" i]').length
  return mediaCount + fileNameHit + uploadMarks
}

async function waitForAttachmentEvidence(scope: HTMLElement, file: File, baseline: number, maxMs = 3000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (attachmentEvidenceCount(scope, file) > baseline) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

// 豆包原版 findFileInput 用的选择器子集（不含 data-testid='upload' / aria-label*='image'，
// 且不递归子 frame）。抽取到共享原语后，显式传回原版行为，避免无意的行为扩张。
const DOUBAO_FILE_INPUT_CANDIDATES = [
  "input[type='file'][accept*='image']",
  "input[type='file'][aria-label*='upload' i]",
  "input[type='file'][aria-label*='图片' i]",
  "input[type='file'][aria-label*='附件' i]",
  "input[type='file']",
]

// 豆包文件输入路径：保留体积上限校验（与抽取前一致），且不重试——
// 与 chatgpt / gemini / claude 默认 5s 重试不同，豆包走粘贴兜底，无需等待文件输入框出现。
// 注：buildDataTransferFromFile 此处仅借用其「超体积抛 ImageTooLargeError」的校验副作用，
// 返回值由共享原语内部重建（new DataTransfer + items.add），挂载行为不变。
async function attachImageToFileInput(file: File): Promise<boolean> {
  buildDataTransferFromFile(file)
  return sharedAttachImageToFileInput(file, {
    maxMs: 0,
    candidates: DOUBAO_FILE_INPUT_CANDIDATES,
    recurseIframes: false,
  })
}

async function pasteImageIntoComposer(file: File, selectors: DoubaoSelectors): Promise<boolean> {
  const box = queryFirst<HTMLElement>(selectors.inputBox)
  if (!box) return false
  const scope = composerScope(box)
  const baseline = attachmentEvidenceCount(scope, file)
  try {
    box.focus()
  } catch {
    /* focus may be blocked in embedded frames */
  }
  dispatchPaste(box, buildDataTransferFromFile(file))
  return waitForAttachmentEvidence(scope, file, baseline)
}

function findSendControl(selectors: DoubaoSelectors): HTMLElement | null {
  const direct = queryFirst<HTMLElement>(selectors.sendButton)
  if (direct) return direct

  const controls = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
  const textButton = controls.find((button) => /发送|send/i.test(button.textContent ?? ''))
  if (textButton) return textButton

  const input = queryFirst<HTMLElement>(selectors.inputBox)
  if (!input) return null
  let scope: HTMLElement | null = input.parentElement
  for (let depth = 0; scope && depth < 5; depth += 1, scope = scope.parentElement) {
    const scopedControls = [...scope.querySelectorAll<HTMLElement>('button, [role="button"]')]
      .filter((button) => !(button instanceof HTMLButtonElement && button.disabled))
    const inputIndex = scopedControls.findIndex((button) => {
      const position = button.compareDocumentPosition(input)
      return (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    })
    const afterInput = inputIndex >= 0 ? scopedControls.slice(inputIndex + 1) : scopedControls
    if (afterInput.length > 0) return afterInput[afterInput.length - 1]
  }
  return null
}

function fileInputAccepts(input: HTMLInputElement, patterns: RegExp[]): boolean {
  const accept = input.accept.toLowerCase()
  if (!accept) return true
  return patterns.some((pattern) => pattern.test(accept))
}

export function probeDoubaoAttachmentControls(selectorOverrides?: SelectorOverrideMap): DoubaoAttachmentProbeResult {
  const selectors = mergeSelectorOverrides(DEFAULT_SELECTORS, selectorOverrides) as DoubaoSelectors
  const inputFound = !!queryFirst(selectors.inputBox)
  const fileInputs = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')]
  const explicitFileInputFound = fileInputs.length > 0
  const imageFileInputFound = fileInputs.some((input) => fileInputAccepts(input, [/image\/\*/, /image\//, /\.png/, /\.jpe?g/, /\.webp/, /\.gif/]))
  const documentFileInputFound = fileInputs.some((input) => fileInputAccepts(input, [/\.pdf/, /\.xlsx/, /application\/pdf/, /spreadsheet/]))
  const misleadingCreationShortcutFound = [...document.querySelectorAll<HTMLElement>('button, [role="button"], a')]
    .some((el) => /图像生成|AI 创作|帮我写作|编程/.test(normalizeText(el.textContent ?? '')))

  return {
    inputFound,
    explicitFileInputFound,
    imageFileInputFound,
    documentFileInputFound,
    misleadingCreationShortcutFound,
    canAutoUploadImage: imageFileInputFound,
    canAutoUploadFile: false,
    reason: imageFileInputFound ? '发现图片上传入口' : '未发现豆包可自动使用的上传入口',
  }
}

function isSuggestionNode(el: HTMLElement): boolean {
  const marker = elementMarker(el)
  return /\b(suggest-list-item|suggest-message|suggestion|recommend-item)\b/i.test(marker)
}

function cloneWithoutSuggestionNodes(el: HTMLElement): HTMLElement {
  const clone = el.cloneNode(true) as HTMLElement
  if (isSuggestionNode(clone)) return document.createElement('div')
  for (const suggestion of clone.querySelectorAll<HTMLElement>('*')) {
    if (isSuggestionNode(suggestion)) suggestion.remove()
  }
  // 豆包"深度思考"折叠区和正式回答同处一个候选容器时，必须在拍平成文字之前
  // 按 DOM 边界删掉思考区，行过滤已经丢了 DOM 边界，清不干净（issue #8）。
  stripThinkingNodes(clone)
  return clone
}

// 按行过滤"搜索 N 个关键词/参考 N 篇资料"这类引用条噪音行；围栏代码块内的行不参与
// 这一步——逐行 trim 会把代码块的缩进也一起削平（CAP-09，issue #21）。
function withoutDoubaoReferenceLines(text: string): string {
  return mapProseOutsideFencedCode(text, (prose) =>
    prose
      .split('\n')
      .map((line) => line.trim())
      .map((line) => line
        .replace(/^搜索\s*\d+\s*个?关键词[，,]?\s*参考\s*\d+\s*篇资料\s*/u, '')
        .replace(/^搜索\s*\d+\s*个?关键词[，,]?\s*/u, '')
        .replace(/^参考\s*\d+\s*篇资料\s*/u, '')
        .replace(/\s*参考\s*\d+\s*篇资料$/u, '')
        .trim())
      .filter(Boolean)
      .join('\n'))
}

function cleanDoubaoResponseText(text: string): string {
  const cleanedText = withoutDoubaoReferenceLines(normalizeText(text))
  return removeTrailingSuggestionLines(cleanedText)
}

function elementText(el: HTMLElement): string {
  return cleanDoubaoResponseText(elementToMarkdownText(cloneWithoutSuggestionNodes(el)))
}

function isLikelySuggestionLine(line: string): boolean {
  const text = line.trim()
  if (!text) return false
  if (/^[\d一二三四五六七八九十]+[.)、]/.test(text)) return false
  if (/^[•\-*]/.test(text)) return false
  return text.length <= 36 && (/[?？]$/.test(text) || /[→↗>]$/.test(text))
}

function isConversationListContainer(el: HTMLElement): boolean {
  return /\b(message-list|v_list)\b/i.test(elementMarker(el))
}

function collectResponseCandidateElements(selectors: DoubaoSelectors): HTMLElement[] {
  const ordered = new Map<HTMLElement, HTMLElement>()
  for (const el of document.querySelectorAll<HTMLElement>(selectors.response.join(','))) {
    if (isConversationListContainer(el)) {
      for (const child of el.children) {
        if (child instanceof HTMLElement) ordered.set(child, child)
      }
      continue
    }
    ordered.set(el, el)
  }
  return [...ordered.values()]
}

function removeTrailingSuggestionLines(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length <= 1) return text

  let trailingSuggestionCount = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!isLikelySuggestionLine(lines[index])) break
    trailingSuggestionCount += 1
  }

  if (trailingSuggestionCount < 1) return text
  const keepCount = Math.max(1, lines.length - trailingSuggestionCount)
  return lines.slice(0, keepCount).join('\n')
}

function isSearchLoadingText(text: string): boolean {
  return /^正在搜索$|^搜索中|^找到\s*\d+\s*篇资料$/u.test(text.trim())
}

function isSearchResultWithAnswer(text: string): boolean {
  const stripped = text
    .replace(/^搜索\s*\d+\s*个?关键词[，,]?\s*/u, '')
    .replace(/参考\s*\d+\s*(篇|个|条)?资料/g, '')
    .trim()
  return /^搜索\s*\d+/u.test(text) && stripped.length > 0
}

function responseCandidateScore(el: HTMLElement): number {
  const marker = elementMarker(el)
  const text = elementText(el)
  let score = 0
  if (isConversationListContainer(el)) score -= 300
  if (/\b(assistant|answer|markdown)\b/i.test(marker) || el.matches('article, [role="article"]')) score += 100
  if (/\b(recommend|suggest|guide|prompt|chip|card|reference|references|source|sources|citation|search)\b/i.test(marker)) score -= 100
  if (/^(参考|引用|来源|已阅读)\s*\d+\s*(篇|个|条)?/.test(text)) score -= 200
  if (/^搜索\s*\d+\s*(篇|个|条)?/.test(text) && !isSearchResultWithAnswer(text)) score -= 200
  if (isSearchLoadingText(text)) score -= 200
  if (isSearchResultWithAnswer(text)) score += 80
  if (isLikelySuggestionLine(text)) score -= 100
  if (hasDirectResponseActions(el)) score += 120
  if (text.length <= 80 && !hasDirectResponseActions(el) && !isSearchResultWithAnswer(text)) score -= 20
  if (el.closest('main')) score += 10
  return score
}

// 候选查询：匹配 response 选择器（含外层列表容器展开）、过滤隐藏/排除祖先/列表容器/
// 用户消息后的原始元素列表。响应游标的 remember（发送前）与读取时都基于这份同一口径
// 的候选列表，这样锚点元素才能在后续查询里按引用对上号。
function queryResponseCandidateElements(selectors: DoubaoSelectors): HTMLElement[] {
  return collectResponseCandidateElements(selectors)
    .filter((el) => !isHidden(el))
    .filter((el) => !el.closest(RESPONSE_EXCLUDE_ANCESTORS))
    .filter((el) => !isConversationListContainer(el))
    .filter((el) => !isUserMessage(el, {}))
}

interface DoubaoResponseCandidate {
  el: HTMLElement
  text: string
  score: number
  index: number
}

function getLatestResponseCandidate(
  selectors: DoubaoSelectors,
  responseCursor: ResponseCursor,
  excludedTexts: ReadonlySet<string> = new Set(),
): DoubaoResponseCandidate | undefined {
  // 豆包会出现外层列表、搜索块和建议问题；改候选选择前先看 docs/RESPONSE_CAPTURE_MAINTENANCE.md。
  const seen = new Set<string>()
  const rawCandidates = queryResponseCandidateElements(selectors)
  const candidates = responseCursor.sinceAnchor(rawCandidates)
    .map((el, index) => ({ el, text: elementText(el), score: responseCandidateScore(el), index }))
    .filter((candidate) => candidate.text.length > 0)
    .filter((candidate) => !excludedTexts.has(normalizeText(candidate.text)))
    .filter((candidate) => !isSearchLoadingText(candidate.text))
    .filter((candidate) => {
      if (seen.has(candidate.text)) return false
      seen.add(candidate.text)
      return true
    })
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score
      return a.index - b.index
    })

  logCaptureDebug({
    platform: 'doubao',
    event: 'candidates',
    candidates: candidates.map((candidate) => ({
      ...describeCaptureElement(candidate.el, candidate.text),
      index: candidate.index,
      score: candidate.score,
      isUserMessage: false,
    })),
    selected: candidates.length > 0
      ? {
          ...describeCaptureElement(candidates[candidates.length - 1].el, candidates[candidates.length - 1].text),
          index: candidates[candidates.length - 1].index,
          score: candidates[candidates.length - 1].score,
          isUserMessage: false,
        }
      : undefined,
  })

  return candidates[candidates.length - 1]
}

function getLatestResponseText(
  selectors: DoubaoSelectors,
  responseCursor: ResponseCursor,
  excludedTexts: ReadonlySet<string> = new Set(),
): string {
  return getLatestResponseCandidate(selectors, responseCursor, excludedTexts)?.text ?? ''
}

function isVisiblyRendered(el: HTMLElement): boolean {
  for (let current: HTMLElement | null = el; current; current = current.parentElement) {
    if (isHidden(current)) return false
    if (window.getComputedStyle?.(current).opacity === '0') return false
    if (current === document.body) break
  }
  return true
}

function appearsBefore(first: HTMLElement, second: HTMLElement): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

function hasVisibleCompletionActionBar(candidate: DoubaoResponseCandidate, selectors: DoubaoSelectors): boolean {
  const responseElements = collectResponseCandidateElements(selectors)
  return [...document.querySelectorAll<HTMLElement>(COMPLETION_ACTION_BAR_SELECTORS.join(','))]
    .filter((bar) => isVisiblyRendered(bar))
    .some((bar) => {
      if (candidate.el.contains(bar)) return true
      if (!appearsBefore(candidate.el, bar)) return false
      const hasInterveningResponse = responseElements.some((other) => {
        if (other === candidate.el || candidate.el.contains(other) || other.contains(candidate.el)) return false
        return appearsBefore(candidate.el, other) && appearsBefore(other, bar) && elementText(other).length > 0
      })
      return !hasInterveningResponse
    })
}

export function createDoubaoAdapter(selectorOverrides?: SelectorOverrideMap): AIAdapter & AdapterSendInternals {
  const selectors = mergeSelectorOverrides(DEFAULT_SELECTORS, selectorOverrides) as DoubaoSelectors
  // ADR-0008 响应游标试点：发送前记住当前候选位置，读取时只看之后新出现的候选，
  // 取代原先逐元素做「发送前文字快照」判断陈旧候选的做法。
  const responseCursor = createResponseCursor()
  let activeSend: {
    prompt: string
    lastObservedResponse: string
    lastResponseChangeAt: number
    completed: boolean
    completionActionBarDetected: boolean
    completionActionBarStableCount: number
    // 2026-08-22 真机验证（CAP-06 调查过程中发现）：豆包 2.1 Turbo 专家模式下，
    // receive-message-action-bar 从助手消息气泡一创建（内容还是"深入思考中"占位阶段）
    // 就已经可见，不是等回答真正生成完才出现——"可见"本身不能当完成信号，否则思考阶段
    // 一闪而过的摘要提示文字只要连续两次轮询没变就会被永久锁定当成最终回答。只有当本轮
    // 曾经真的观察到 action bar 处于不可见状态、之后才变可见，这个"不可见→可见"的跳变
    // 才是可信的完成信号；从未见过它不可见，就必须退回下面 45 秒的安全兜底判定。
    hasObservedActionBarAbsent: boolean
    // 2026-08-22 真机验证：`break-btn` 类名标记的"打断生成"控件在整段生成过程（含专家
    // 模式思考阶段的长时间停顿）里持续存在，生成一结束就立刻消失——是目前唯一可靠的
    // "仍在生成"信号（见 hasStopGeneratingButton 里新增的 [class*="break-btn" i]）。
    // 一旦本轮观察到过它，说明"生成已结束"这个判断有独立证据支撑，不必再像上面
    // hasObservedActionBarAbsent 那样退回 45 秒安全兜底，可以直接走跟它一样的快速
    // 完成路径（只需再确认文字本身也稳定下来）。
    hasObservedStopButton: boolean
  } | null = null

  function responseExclusions(): ReadonlySet<string> {
    return activeSend?.prompt ? new Set([activeSend.prompt]) : new Set()
  }

  return {
    async writeText(text: string) {
      const box = queryFirst<HTMLElement>(selectors.inputBox)
      if (!box) throw new Error('doubao input box not found')
      if (box instanceof HTMLTextAreaElement) {
        writeNativeTextareaValue(box, text)
      } else {
        writeEditableValue(box, text, 'beforeinput-then-input')
      }
    },

    async triggerSend() {
      const btn = findSendControl(selectors)
      if (btn) {
        if (btn instanceof HTMLButtonElement && btn.disabled) btn.disabled = false
        activateControl(btn)
        return
      }
      const box = queryFirst<HTMLElement>(selectors.inputBox)
      if (!box) throw new Error('doubao send button not found')
      dispatchEnter(box, 'keydown-only')
    },

    async sendMessage(text: string, image?: File, diagnostics?: AdapterDiagnostics) {
      responseCursor.remember(
        queryResponseCandidateElements(selectors),
        (el) => elementText(el as HTMLElement).length > 0,
      )
      const box = queryFirst<HTMLElement>(selectors.inputBox)
      if (!box) {
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter', operation: 'input-locate', stage: 'failed', eventStatus: 'failed',
          runOutcome: 'failed', errorCode: 'input-box-not-found', inputCharacterCount: text.length,
        })
        throw new Error('doubao input box not found')
      }
      emitDiagnostic(diagnostics, {
        component: 'platform-adapter', operation: 'input-locate', stage: 'located', eventStatus: 'succeeded', inputCharacterCount: text.length,
      })
      try {
        if (box instanceof HTMLTextAreaElement) writeNativeTextareaValue(box, text)
        else writeEditableValue(box, text, 'beforeinput-then-input')
      } catch {
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter', operation: 'input-write', stage: 'failed', eventStatus: 'failed',
          runOutcome: 'failed', errorCode: 'input-write-failed', inputCharacterCount: text.length,
        })
        throw new Error('input write failed')
      }
      emitDiagnostic(diagnostics, {
        component: 'platform-adapter', operation: 'input-write', stage: 'written', eventStatus: 'succeeded', inputCharacterCount: text.length,
      })
      await new Promise((resolve) => setTimeout(resolve, 80))
      if (image) {
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter', operation: 'attachment-prepare', stage: 'preparing', eventStatus: 'observed', hasAttachment: true,
        })
        try {
          await this.attachImage(image)
        } catch {
          emitDiagnostic(diagnostics, {
            component: 'platform-adapter', operation: 'attachment-prepare', stage: 'failed', eventStatus: 'failed',
            runOutcome: 'failed', errorCode: 'attachment-preparation-timeout', hasAttachment: true,
          })
          throw new Error('attachment preparation failed')
        }
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter', operation: 'attachment-prepare', stage: 'prepared', eventStatus: 'succeeded', hasAttachment: true,
        })
      } else {
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter', operation: 'attachment-prepare', stage: 'skipped', eventStatus: 'skipped', hasAttachment: false,
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
      try {
        await this.triggerSend()
      } catch {
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter', operation: 'send-click', stage: 'failed', eventStatus: 'failed',
          runOutcome: 'failed', errorCode: 'send-click-failed', retryNumber: 1,
        })
        throw new Error('doubao send failed')
      }
      activeSend = {
        prompt: normalizeText(text),
        lastObservedResponse: '',
        lastResponseChangeAt: Date.now(),
        completed: false,
        completionActionBarDetected: false,
        completionActionBarStableCount: 0,
        hasObservedActionBarAbsent: false,
        hasObservedStopButton: false,
      }
      emitDiagnostic(diagnostics, {
        component: 'platform-adapter', operation: 'send-click', stage: 'clicked', eventStatus: 'succeeded', retryNumber: 1,
      })
      if (hasStopGeneratingButton(selectors) || !hasPendingContent(selectors, true)) {
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter', operation: 'send-ack', stage: 'accepted', eventStatus: 'succeeded', retryNumber: 1, retryCount: 1,
        })
      } else {
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter', operation: 'send-ack', stage: 'waiting', eventStatus: 'observed', retryNumber: 1, retryCount: 1,
        })
      }
    },

    async attachImage(file: File) {
      // 非图片附件（ATTACH-01 / issue #35）：直塞 input 是 Plan A，paste 是 Plan B 兜底。
      if (!file.type.startsWith('image/')) {
        const composer = queryFirst<HTMLElement>(selectors.inputBox)
        if (await attachFileWithFallback(file, composer, {
          inputOptions: { maxMs: 0, candidates: DOUBAO_FILE_INPUT_CANDIDATES, recurseIframes: false },
        })) return
        throw new Error('doubao file upload failed')
      }
      if (await attachImageToFileInput(file)) return
      if (await pasteImageIntoComposer(file, selectors)) return
      const probe = probeDoubaoAttachmentControls(selectorOverrides)
      throw new Error(`doubao image upload failed: ${probe.reason}`)
    },

    async getLastResponse() {
      if (activeSend?.completed) return activeSend.lastObservedResponse
      return getLatestResponseText(selectors, responseCursor, responseExclusions())
    },

    async getConversationState(): Promise<ConversationState> {
      if (!queryFirst(selectors.inputBox)) return { status: 'error', errorMessage: '豆包输入框未识别', stopButtonDetected: false }
      if (activeSend?.completed) {
        return {
          status: 'finished',
          lastResponse: activeSend.lastObservedResponse,
          stopButtonDetected: false,
          completionActionBarDetected: activeSend.completionActionBarDetected,
        }
      }
      const candidate = getLatestResponseCandidate(selectors, responseCursor, responseExclusions())
      const lastResponse = candidate?.text ?? ''
      if (hasStopGeneratingButton(selectors)) {
        if (activeSend) activeSend.hasObservedStopButton = true
        return { status: 'streaming', lastResponse, stopButtonDetected: true }
      }
      if (activeSend) {
        const meaningfulResponse = lastResponse
        if (!meaningfulResponse) {
          return { status: 'streaming', lastResponse, stopButtonDetected: false }
        }
        const completionActionBarDetected = !!candidate && hasVisibleCompletionActionBar(candidate, selectors)
        if (!completionActionBarDetected) activeSend.hasObservedActionBarAbsent = true
        activeSend.completionActionBarStableCount = completionActionBarDetected
          ? activeSend.completionActionBarStableCount + 1
          : 0
        if (meaningfulResponse !== activeSend.lastObservedResponse) {
          activeSend.lastObservedResponse = meaningfulResponse
          activeSend.lastResponseChangeAt = Date.now()
          return {
            status: 'streaming',
            lastResponse: meaningfulResponse,
            stopButtonDetected: false,
            completionActionBarDetected,
          }
        }
        if (
          (activeSend.hasObservedActionBarAbsent || activeSend.hasObservedStopButton)
          && activeSend.completionActionBarStableCount >= 2
        ) {
          activeSend.completed = true
          activeSend.completionActionBarDetected = true
          return {
            status: 'finished',
            lastResponse: meaningfulResponse,
            stopButtonDetected: false,
            completionActionBarDetected: true,
          }
        }
        if (Date.now() - activeSend.lastResponseChangeAt < RESPONSE_QUIET_FALLBACK_MS) {
          return {
            status: 'streaming',
            lastResponse: meaningfulResponse,
            stopButtonDetected: false,
            completionActionBarDetected,
          }
        }
        activeSend.completed = true
        // 走到这里说明本轮既没等到打断按钮消失、也没等到操作栏从无到有的可信信号，
        // 完全是靠 45 秒静默超时兜底判定完成——这通常意味着豆包又改版了，两个已知
        // 信号都失效了，值得回头看看。仅开发者自己手动开启调试开关时才会真的弹通知，
        // 见 debug-fallback-notify.ts 顶部注释。
        notifyDebugAlert(
          '豆包完成判定用了静默超时兜底',
          '没等到打断按钮消失或操作栏可见的信号，可能是豆包又改版了，值得查一下。',
        )
        return {
          status: 'finished',
          lastResponse: meaningfulResponse,
          stopButtonDetected: false,
          completionActionBarDetected: false,
        }
      }
      if (lastResponse) return { status: 'finished', lastResponse, stopButtonDetected: false }
      return { status: 'idle', stopButtonDetected: false }
    },
  }
}
