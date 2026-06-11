import type { AIPlatform, SessionAttachment } from '../types'
import { MAX_IMAGE_BYTES } from './image-handler'

export const MAX_INLINE_TEXT_BYTES = 1 * 1024 * 1024
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024

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

export function classifyFile(file: File): FileClassification {
  if (file.type.startsWith('image/')) return { kind: 'image', handling: 'file-upload' }

  const ext = extname(file.name)
  if (['.txt', '.md', '.csv'].includes(ext)) return { kind: 'text', handling: 'inline-text' }
  if (['.pdf', '.xlsx'].includes(ext)) return { kind: 'document', handling: 'file-upload' }

  throw new UnsupportedFileTypeError(file.name)
}

export function supportsAutoUpload(platform: AIPlatform, classification: FileClassification): boolean {
  if (classification.handling !== 'file-upload') return false
  if (classification.kind === 'image') return true
  return platform === 'gemini'
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
