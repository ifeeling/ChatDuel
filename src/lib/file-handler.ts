import type { AIPlatform, SessionAttachment } from '../types'
import { getPlatformCapabilities } from './ai-platforms'
import { MAX_IMAGE_BYTES } from './image-handler'

export const MAX_INLINE_TEXT_BYTES = 1 * 1024 * 1024
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024
export const SUPPORTED_FILE_FORMATS_TEXT = '图片、TXT、Markdown、CSV、PDF、Excel（XLSX）'

export type AttachmentKind = SessionAttachment['kind']
export type AttachmentHandling = SessionAttachment['handling']

export interface FileClassification {
  kind: AttachmentKind
  handling: AttachmentHandling
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
  if (['.doc', '.docx'].includes(ext)) {
    return `暂不支持 Word 文档。Word 里可能有图片、表格或版式信息，直接抽文字容易丢内容；建议先转成 PDF，或把关键页面截图后上传。当前支持：${SUPPORTED_FILE_FORMATS_TEXT}。`
  }

  return `暂不支持这个文件格式。当前支持：${SUPPORTED_FILE_FORMATS_TEXT}。`
}

export function classifyFile(file: File): FileClassification {
  if (file.type.startsWith('image/')) return { kind: 'image', handling: 'file-upload' }

  const ext = extname(file.name)
  if (['.txt', '.md', '.csv'].includes(ext)) return { kind: 'text', handling: 'inline-text' }
  if (['.pdf', '.xlsx'].includes(ext)) return { kind: 'document', handling: 'file-upload' }

  throw new UnsupportedFileTypeError(file.name)
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
  if (classification.kind === 'image' && file.size > MAX_IMAGE_BYTES) {
    throw new FileTooLargeError(file.size, MAX_IMAGE_BYTES)
  }
  if (classification.kind === 'text' && classification.handling === 'inline-text' && file.size > MAX_INLINE_TEXT_BYTES) {
    throw new FileTooLargeError(file.size, MAX_INLINE_TEXT_BYTES)
  }
  if (classification.kind === 'document' && file.size > MAX_DOCUMENT_BYTES) {
    throw new FileTooLargeError(file.size, MAX_DOCUMENT_BYTES)
  }
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
