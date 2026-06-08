export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export class ImageTooLargeError extends Error {
  constructor(size: number) {
    super(`Image too large: ${size} bytes (max ${MAX_IMAGE_BYTES})`)
    this.name = 'ImageTooLargeError'
  }
}

export function buildDataTransferFromFile(file: File): DataTransfer {
  if (file.size > MAX_IMAGE_BYTES) {
    throw new ImageTooLargeError(file.size)
  }
  const dt = new DataTransfer()
  dt.items.add(file)
  return dt
}

export function dispatchPaste(target: HTMLElement, dt: DataTransfer, eventType: 'paste' | 'drop' = 'paste'): void {
  const event = new ClipboardEvent(eventType, {
    clipboardData: dt,
    bubbles: true,
    cancelable: true,
  })
  try {
    Object.defineProperty(event, 'clipboardData', { value: dt, configurable: true })
  } catch {
    // ClipboardEvent.clipboardData may be read-only in some envs
  }
  target.dispatchEvent(event)
}

export async function tryCopyImageToClipboard(file: File): Promise<boolean> {
  try {
    if (!navigator.clipboard || !('write' in navigator.clipboard)) return false
    // @ts-ignore - ClipboardItem in older TS lib.dom
    await navigator.clipboard.write([new ClipboardItem({ [file.type]: file })])
    return true
  } catch {
    return false
  }
}

export function downloadImage(file: File, filename?: string): void {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = filename ?? file.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
