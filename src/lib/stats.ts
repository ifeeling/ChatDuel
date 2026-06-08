export function countWords(text: string): number {
  if (!text) return 0
  const cjkMatches = text.match(/[\u4e00-\u9fff]/g) ?? []
  const cjkCount = cjkMatches.length
  const nonCjk = text.replace(/[\u4e00-\u9fff]/g, ' ')
  const words = nonCjk.split(/\s+/).filter(w => w.length > 0)
  return cjkCount + words.length
}

export function durationMs(startTimestamp: number, endTimestamp: number = Date.now()): number {
  return Math.max(0, endTimestamp - startTimestamp)
}

export function ttftMs(sendTimestamp: number, firstTokenTimestamp: number): number {
  return Math.max(0, firstTokenTimestamp - sendTimestamp)
}
