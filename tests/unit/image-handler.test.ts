import { describe, it, expect, beforeAll } from 'vitest'
import { buildDataTransferFromFile, MAX_IMAGE_BYTES, ImageTooLargeError } from '../../src/lib/image-handler'

beforeAll(() => {
  if (typeof globalThis.DataTransfer === 'undefined') {
    class DT {
      items: { add: (f: File) => void }
      files: File[]
      constructor() {
        const files: File[] = []
        this.files = files
        this.items = {
          add: (f: File) => {
            files.push(f)
          },
        }
      }
    }
    ;(globalThis as unknown as { DataTransfer: typeof DataTransfer }).DataTransfer = DT as unknown as typeof DataTransfer
  }
})

describe('buildDataTransferFromFile', () => {
  it('creates a DataTransfer with files', () => {
    const file = new File(['hello'], 'test.png', { type: 'image/png' })
    const dt = buildDataTransferFromFile(file)
    expect(dt.files.length).toBe(1)
    expect(dt.files[0].name).toBe('test.png')
  })

  it('throws ImageTooLargeError when file is too large', () => {
    const big = new File([new Uint8Array(21 * 1024 * 1024)], 'big.png', { type: 'image/png' })
    expect(() => buildDataTransferFromFile(big)).toThrow(ImageTooLargeError)
  })
})

describe('MAX_IMAGE_BYTES', () => {
  it('is 20MB', () => {
    expect(MAX_IMAGE_BYTES).toBe(20 * 1024 * 1024)
  })
})
