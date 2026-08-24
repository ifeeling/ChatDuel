/**
 * 平台无关的"附件证据 + 失败文案"双向检测，以及基于它的通用文件上传兜底链路。
 *
 * 从 deepseek/adapter.ts 的 attachmentEvidenceCount/waitForAttachmentFailure 一族
 * 抽出来的泛化版本（原实现本身就不含平台特判，只是没被其它适配器复用）。用于
 * ATTACH-01（issue #35）新增的非图片文件自动上传：直塞 input 是 Plan A（主路径），
 * paste 是 Plan B（兜底），不是反过来——两层都试完仍无证据或被判定失败，交回调用方
 * 决定报错文案，不在这里替调用方兜底到"人工上传"（那是编排层的职责）。
 *
 * 只看到新的附件卡片元素不算数：还要等一段 settle 时间，确认没有紧接着出现平台自己
 * 的拒绝/失败提示文案——文件名本身可能被平台重写（如 ChatGPT 把 paste 进来的文件改成
 * UUID 命名），纯文本匹配这个信号不可靠，必须同时看结构性证据。
 */

import { attachImageToFileInput, type AttachImageOptions } from './file-input'
import { buildDataTransferFromFile, dispatchPaste } from '../../lib/image-handler'

const EVIDENCE_WAIT_MS = 3000
const FAILURE_SETTLE_MS = 900
// 中英文混合的通用拒绝/失败文案；具体平台的拒绝文案长什么样这次没有全部覆盖到
// （风险点见 issue #35 正文"失败检测的泛化风险"一节），遇到陌生平台文案的灰区
// 交给 EVIDENCE_WAIT_MS/FAILURE_SETTLE_MS 的总超时兜底：超时视为"没有失败证据"，
// 由证据信号本身决定成败。
const FAILURE_TEXT_PATTERN = /异常文件|删除异常文件|未提取到文字|无法上传|上传失败|格式不支持|不支持该格式|不支持此格式|文件类型不支持|failed to upload|upload failed|not supported|unsupported file|failed|error/i
const EVIDENCE_SELECTOR = [
  'img',
  'canvas',
  '[class*="upload" i]',
  '[class*="attach" i]',
  '[class*="file" i]',
  '[class*="image" i]',
  '[data-testid*="upload" i]',
  '[data-testid*="attach" i]',
  '[data-testid*="file" i]',
].join(',')
const FAILURE_CONTEXT_SELECTOR = [
  EVIDENCE_SELECTOR,
  '[role="alert"]',
  '[aria-live="assertive"]',
].join(',')

/** 从锚点(通常是输入框或 file input)向上找出"包住输入框/上传相关元素"的最外层容器，作为证据检测范围。 */
export function findAttachmentScope(anchor: HTMLElement): ParentNode {
  let best: HTMLElement | null = null
  let scope: HTMLElement = anchor
  for (let depth = 0; scope.parentElement && depth < 8; depth += 1) {
    scope = scope.parentElement
    if (scope === document.body || scope === document.documentElement) break
    if (
      scope.querySelector('textarea, [contenteditable="true"], [role="textbox"]')
      || scope.querySelector('input[type="file"]')
    ) {
      best = scope
    }
  }
  return best ?? anchor.parentElement ?? document.body
}

function elementMarker(element: Element): string {
  return [
    element.textContent ?? '',
    element.getAttribute('alt') ?? '',
    element.getAttribute('title') ?? '',
    element.getAttribute('aria-label') ?? '',
  ].join(' ').toLowerCase()
}

export function attachmentEvidenceCount(file: File, scope: ParentNode = document.body): number {
  const fileName = file.name.toLowerCase()
  const textHits = [...scope.querySelectorAll<HTMLElement>('*')]
    .filter((el) => elementMarker(el).includes(fileName)).length
  const uploadMarks = scope.querySelectorAll(EVIDENCE_SELECTOR).length
  return textHits + uploadMarks
}

export async function waitForAttachmentEvidence(
  file: File,
  baseline: number,
  scope: ParentNode = document.body,
  maxMs = EVIDENCE_WAIT_MS,
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (attachmentEvidenceCount(file, scope) > baseline) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

function containsComposerInput(element: HTMLElement): boolean {
  return element.matches('textarea, [contenteditable="true"], [role="textbox"]')
    || !!element.querySelector('textarea, [contenteditable="true"], [role="textbox"]')
}

function attachmentFailureContexts(file: File, scope: ParentNode): HTMLElement[] {
  const fileName = file.name.toLowerCase()
  const seeds = [...scope.querySelectorAll<HTMLElement>(FAILURE_CONTEXT_SELECTOR)]
  for (const element of scope.querySelectorAll<HTMLElement>('*')) {
    if (!elementMarker(element).includes(fileName)) continue
    const childMentionsFile = [...element.children]
      .some((child) => elementMarker(child).includes(fileName))
    if (!childMentionsFile) seeds.push(element)
  }

  const contexts = new Set<HTMLElement>()
  for (const seed of seeds) {
    contexts.add(seed)
    if (seed.parentElement && seed.parentElement !== scope && !containsComposerInput(seed.parentElement)) {
      contexts.add(seed.parentElement)
    }
  }
  return [...contexts]
}

export type AttachmentFailureSnapshot = Map<HTMLElement, string>

export function attachmentFailureSnapshot(file: File, scope: ParentNode): AttachmentFailureSnapshot {
  return new Map(attachmentFailureContexts(file, scope).map((element) => [
    element,
    (element.innerText || element.textContent || '').trim(),
  ]))
}

function attachmentFailureDetails(
  file: File,
  scope: ParentNode,
  baseline: AttachmentFailureSnapshot,
): { text: string } | null {
  for (const element of attachmentFailureContexts(file, scope)) {
    const text = (element.innerText || element.textContent || '').trim()
    if (baseline.get(element) === text) continue
    const match = text.match(FAILURE_TEXT_PATTERN)
    if (!match) continue
    const start = Math.max(0, (match.index ?? 0) - 40)
    const end = Math.min(text.length, (match.index ?? 0) + match[0].length + 60)
    return { text: text.slice(start, end) }
  }
  return null
}

export async function waitForAttachmentFailure(
  file: File,
  scope: ParentNode,
  baseline: AttachmentFailureSnapshot,
  maxMs = FAILURE_SETTLE_MS,
): Promise<{ text: string } | null> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const failure = attachmentFailureDetails(file, scope, baseline)
    if (failure) return failure
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return null
}

export interface AttachFileWithFallbackOptions {
  /** 转发给 attachImageToFileInput 的 Plan A 查找配置（候选选择器/是否递归子 frame/最长重试等待）。 */
  inputOptions?: AttachImageOptions
}

/**
 * 通用"直塞 input（Plan A）→ paste（Plan B）"文件上传探测，供任意扩展名的非图片
 * 附件在任意平台适配器里复用。composer 传 null 时只做 Plan A（没有粘贴目标）。
 * 两层都没证据或被判定失败，返回 false；调用方据此决定报错文案或人工上传兜底。
 */
export async function attachFileWithFallback(
  file: File,
  composer: HTMLElement | null,
  options: AttachFileWithFallbackOptions = {},
): Promise<boolean> {
  const scope = composer ? findAttachmentScope(composer) : document.body

  const inputBaseline = attachmentEvidenceCount(file, scope)
  const inputFailureBaseline = attachmentFailureSnapshot(file, scope)
  const inputAttempted = await attachImageToFileInput(file, options.inputOptions)
  if (inputAttempted) {
    const evidenceFound = await waitForAttachmentEvidence(file, inputBaseline, scope)
    if (evidenceFound) {
      const failure = await waitForAttachmentFailure(file, scope, inputFailureBaseline)
      if (!failure) return true
    }
  }

  if (!composer) return false
  try {
    composer.focus()
  } catch {
    // focus 可能被内嵌 frame 拦截
  }
  const pasteBaseline = attachmentEvidenceCount(file, scope)
  const pasteFailureBaseline = attachmentFailureSnapshot(file, scope)
  dispatchPaste(composer, buildDataTransferFromFile(file))
  const pasteEvidenceFound = await waitForAttachmentEvidence(file, pasteBaseline, scope)
  if (!pasteEvidenceFound) return false
  const pasteFailure = await waitForAttachmentFailure(file, scope, pasteFailureBaseline)
  return !pasteFailure
}
