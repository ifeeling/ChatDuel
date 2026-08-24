import type { AIPlatform, SessionAttachment } from '../types'
import { getPlatformCapabilities } from './ai-platforms'
import { MAX_IMAGE_BYTES } from './image-handler'

export const MAX_INLINE_TEXT_BYTES = 1 * 1024 * 1024
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024
export const SUPPORTED_FILE_FORMATS_TEXT = '图片、TXT、Markdown、CSV、PDF、Word、Excel、HTML，以及大多数其它常见文件格式（视目标平台是否接受而定）'

// 明显不合适自动上传给 AI 平台的可执行/脚本类扩展名——不管目标平台接不接受，
// 一律直接拒绝，不发起 Plan A/Plan B 探测（ATTACH-01 / issue #35 风险点 1）。
const BLOCKED_FILE_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.dll',
  '.sh', '.bash', '.ps1', '.vbs', '.apk', '.jar', '.deb', '.rpm', '.bin',
])

export type AttachmentKind = SessionAttachment['kind']
export type AttachmentHandling = SessionAttachment['handling']

export interface FileClassification {
  kind: AttachmentKind
  handling: AttachmentHandling
}

export interface PreparedAttachment {
  readonly file: File
  readonly classification: FileClassification
  readonly textContent?: string
}

export interface InlineTextResult {
  textContent: string
  sentPrompt: string
}

export interface AttachmentDeliveryPlan {
  sendTargets: AIPlatform[]
  autoUploadTargets: AIPlatform[]
  manualUploadTargets: AIPlatform[]
}

export class UnsupportedFileTypeError extends Error {
  constructor(name: string) {
    super(`Unsupported file type: ${name}`)
    this.name = 'UnsupportedFileTypeError'
  }
}

export class FileTooLargeError extends Error {
  constructor(size: number, max: number) {
    super(`File too large: ${size} bytes (max ${max})`)
    this.name = 'FileTooLargeError'
  }
}

function extname(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx >= 0 ? name.slice(idx).toLowerCase() : ''
}

export function getUnsupportedFileMessage(file: Pick<File, 'name'>): string {
  const ext = extname(file.name)
  if (BLOCKED_FILE_EXTENSIONS.has(ext)) {
    return `为安全考虑，不支持上传可执行/脚本文件（${ext}）。当前支持：${SUPPORTED_FILE_FORMATS_TEXT}。`
  }

  return `暂不支持这个文件格式。当前支持：${SUPPORTED_FILE_FORMATS_TEXT}。`
}

/**
 * 文件分类。除明显不合适的可执行/脚本扩展名外，不再对"没见过的扩展名"直接拒绝——
 * 交给后续 attachFileWithFallback 在具体目标平台上运行时探测（直塞 input → paste →
 * 都失败才提示不支持），支持权从"代码里的静态列表"转移到"目标平台运行时接不接受"。
 * 见 ATTACH-01（issue #35）设计方向。
 */
export function classifyFile(file: File): FileClassification {
  if (file.type.startsWith('image/')) return { kind: 'image', handling: 'file-upload' }

  const ext = extname(file.name)
  if (BLOCKED_FILE_EXTENSIONS.has(ext)) throw new UnsupportedFileTypeError(file.name)

  if (['.txt', '.csv'].includes(ext)) return { kind: 'text', handling: 'inline-text' }
  // md/html 走真实附件而不是塞进输入框（不占用输入框、不跟用户文字混在一起）；
  // 语义上不是 pdf/xlsx 那种"文档"，单独归一类，见 research-01。
  if (['.md', '.html', '.htm'].includes(ext)) return { kind: 'markup', handling: 'file-upload' }
  if (['.pdf', '.xlsx', '.xlsm', '.docx', '.doc', '.xls'].includes(ext)) return { kind: 'document', handling: 'file-upload' }

  // 没见过的扩展名：不当场拒绝，标记为 unknown 交给运行时探测决定。
  return { kind: 'unknown', handling: 'file-upload' }
}

export function supportsAutoUpload(platform: AIPlatform, classification: FileClassification): boolean {
  if (classification.handling !== 'file-upload') return false
  const capabilities = getPlatformCapabilities(platform)
  if (classification.kind === 'image') return capabilities.supportsImageUpload
  return capabilities.supportsFileUpload
}

export function buildAttachmentDeliveryPlan(
  targets: AIPlatform[],
  classification: FileClassification | null,
  hasText: boolean,
): AttachmentDeliveryPlan {
  if (!classification || classification.handling !== 'file-upload') {
    return {
      sendTargets: [...targets],
      autoUploadTargets: [],
      manualUploadTargets: [],
    }
  }

  const autoUploadTargets = targets.filter((p) => supportsAutoUpload(p, classification))
  const manualUploadTargets = targets.filter((p) => !supportsAutoUpload(p, classification))
  return {
    sendTargets: hasText ? [...targets] : autoUploadTargets,
    autoUploadTargets,
    manualUploadTargets,
  }
}

export function assertFileWithinLimit(file: File, classification = classifyFile(file)): void {
  if (classification.kind === 'image') {
    if (file.size > MAX_IMAGE_BYTES) throw new FileTooLargeError(file.size, MAX_IMAGE_BYTES)
    return
  }
  if (classification.handling === 'inline-text') {
    if (file.size > MAX_INLINE_TEXT_BYTES) throw new FileTooLargeError(file.size, MAX_INLINE_TEXT_BYTES)
    return
  }
  // document / markup / unknown 都走真实附件上传，统一用同一个体积上限——
  // 不逐个 kind 枚举，新增 kind 时天然沿用这条规则，不需要跟着改这里。
  if (file.size > MAX_DOCUMENT_BYTES) throw new FileTooLargeError(file.size, MAX_DOCUMENT_BYTES)
}

export function buildInlineTextPrompt(fileName: string, textContent: string, userText: string): string {
  const prompt = userText.trim() || '请阅读下面这个文件，并总结重点、指出问题、给出改进建议。'
  return `${prompt}

下面是我附加的文件内容，请结合它一起处理。

【文件名】
${fileName}

【文件内容开始】
${textContent}
【文件内容结束】`
}

export async function prepareAttachment(file: File): Promise<PreparedAttachment> {
  const classification = classifyFile(file)
  assertFileWithinLimit(file, classification)
  if (classification.handling !== 'inline-text') {
    return { file, classification }
  }
  return {
    file,
    classification,
    textContent: await readFileAsText(file),
  }
}

export async function inlineTextFile(file: File, userText: string): Promise<InlineTextResult> {
  const classification = classifyFile(file)
  if (classification.handling !== 'inline-text') throw new UnsupportedFileTypeError(file.name)
  assertFileWithinLimit(file, classification)

  const textContent = await readFileAsText(file)
  return {
    textContent,
    sentPrompt: buildInlineTextPrompt(file.name, textContent, userText),
  }
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsText(file)
  })
}
