import { describe, expect, it } from 'vitest'
import {
  FileTooLargeError,
  UnsupportedFileTypeError,
  buildAttachmentDeliveryPlan,
  classifyFile,
  getUnsupportedFileMessage,
  inlineTextFile,
  MAX_DOCUMENT_BYTES,
  MAX_INLINE_TEXT_BYTES,
  supportsAutoUpload,
} from '../../src/lib/file-handler'

describe('classifyFile', () => {
  it('keeps images on the file-upload path', () => {
    const file = new File(['x'], 'photo.png', { type: 'image/png' })
    expect(classifyFile(file)).toEqual({ kind: 'image', handling: 'file-upload' })
  })

  it('uses inline-text for txt, md, and csv files', () => {
    expect(classifyFile(new File(['x'], 'note.txt', { type: 'text/plain' }))).toEqual({ kind: 'text', handling: 'inline-text' })
    expect(classifyFile(new File(['x'], 'spec.md', { type: 'text/markdown' }))).toEqual({ kind: 'text', handling: 'inline-text' })
    expect(classifyFile(new File(['x'], 'table.csv', { type: 'text/csv' }))).toEqual({ kind: 'text', handling: 'inline-text' })
  })

  it('uses file-upload for supported binary document formats', () => {
    expect(classifyFile(new File(['x'], 'book.pdf', { type: 'application/pdf' }))).toEqual({ kind: 'document', handling: 'file-upload' })
    expect(classifyFile(new File(['x'], 'sheet.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))).toEqual({ kind: 'document', handling: 'file-upload' })
  })

  it('does not support Word documents yet', () => {
    const file = new File(['x'], 'doc.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })

    expect(() => classifyFile(file)).toThrow(UnsupportedFileTypeError)
  })
})

describe('inlineTextFile', () => {
  it('builds final prompt with file content', async () => {
    const file = new File(['# Spec\nhello'], 'spec.md', { type: 'text/markdown' })
    const result = await inlineTextFile(file, '请审查')

    expect(result.textContent).toBe('# Spec\nhello')
    expect(result.sentPrompt).toContain('请审查')
    expect(result.sentPrompt).toContain('【文件名】\nspec.md')
    expect(result.sentPrompt).toContain('【文件内容开始】\n# Spec\nhello\n【文件内容结束】')
  })

  it('uses a default prompt when user text is empty', async () => {
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })
    const result = await inlineTextFile(file, '')

    expect(result.sentPrompt).toContain('请阅读下面这个文件')
  })

  it('rejects text files over 1MB', async () => {
    const file = new File([new Uint8Array(MAX_INLINE_TEXT_BYTES + 1)], 'large.md', { type: 'text/markdown' })
    await expect(inlineTextFile(file, 'x')).rejects.toBeInstanceOf(FileTooLargeError)
  })

})

describe('file limits', () => {
  it('documents are limited to 20MB', () => {
    expect(MAX_DOCUMENT_BYTES).toBe(20 * 1024 * 1024)
  })
})

describe('supportsAutoUpload', () => {
  it('allows image upload for ChatGPT, Gemini, and Doubao', () => {
    const image = classifyFile(new File(['x'], 'photo.png', { type: 'image/png' }))
    expect(supportsAutoUpload('chatgpt', image)).toBe(true)
    expect(supportsAutoUpload('gemini', image)).toBe(true)
    expect(supportsAutoUpload('doubao', image)).toBe(true)
  })

  it('does not auto-upload document files to ChatGPT in v1', () => {
    const documentFile = classifyFile(new File(['x'], 'book.pdf', { type: 'application/pdf' }))
    expect(supportsAutoUpload('chatgpt', documentFile)).toBe(false)
    expect(supportsAutoUpload('gemini', documentFile)).toBe(true)
    expect(supportsAutoUpload('doubao', documentFile)).toBe(false)
  })
})

describe('buildAttachmentDeliveryPlan', () => {
  it('sends image uploads to all image-capable platforms', () => {
    const image = classifyFile(new File(['x'], 'photo.png', { type: 'image/png' }))
    const plan = buildAttachmentDeliveryPlan(['chatgpt', 'gemini', 'doubao'], image, true)

    expect(plan.sendTargets).toEqual(['chatgpt', 'gemini', 'doubao'])
    expect(plan.autoUploadTargets).toEqual(['chatgpt', 'gemini', 'doubao'])
    expect(plan.manualUploadTargets).toEqual([])
  })

  it('does not send an empty text-only message to unsupported platforms', () => {
    const documentFile = classifyFile(new File(['x'], 'book.pdf', { type: 'application/pdf' }))
    const plan = buildAttachmentDeliveryPlan(['chatgpt'], documentFile, false)

    expect(plan.sendTargets).toEqual([])
    expect(plan.autoUploadTargets).toEqual([])
    expect(plan.manualUploadTargets).toEqual(['chatgpt'])
  })

  it('keeps all targets when there is no upload attachment', () => {
    const plan = buildAttachmentDeliveryPlan(['chatgpt', 'doubao'], null, false)

    expect(plan.sendTargets).toEqual(['chatgpt', 'doubao'])
    expect(plan.autoUploadTargets).toEqual([])
    expect(plan.manualUploadTargets).toEqual([])
  })
})

describe('getUnsupportedFileMessage', () => {
  it('explains why Word documents are not supported yet', () => {
    const message = getUnsupportedFileMessage({ name: 'doc.docx' })

    expect(message).toContain('暂不支持 Word 文档')
    expect(message).toContain('图片、表格或版式信息')
    expect(message).toContain('建议先转成 PDF')
  })

  it('lists supported formats for other unsupported files', () => {
    const message = getUnsupportedFileMessage({ name: 'slides.pptx' })

    expect(message).toContain('当前支持')
    expect(message).toContain('Markdown')
    expect(message).toContain('Excel')
  })
})
