import DiffMatchPatch from 'diff-match-patch'

export type DiffChunkType =
  | 'equal'
  | 'added-on-a'
  | 'added-on-b'

export interface DiffChunk {
  type: DiffChunkType
  a: string
  b: string
}

const dmp = new DiffMatchPatch()

export function diffResponses(a: string, b: string): DiffChunk[] {
  const aChunks = splitIntoChunks(a)
  const bChunks = splitIntoChunks(b)
  const result: DiffChunk[] = []

  const max = Math.max(aChunks.length, bChunks.length)
  for (let i = 0; i < max; i++) {
    const ac = aChunks[i] ?? ''
    const bc = bChunks[i] ?? ''

    if (ac === bc) {
      result.push({ type: 'equal', a: ac, b: bc })
    } else {
      const diffs = dmp.diff_main(ac, bc)
      dmp.diff_cleanupSemantic(diffs)
      for (const [op, text] of diffs) {
        if (op === 0) {
          result.push({ type: 'equal', a: text, b: text })
        } else if (op === -1) {
          result.push({ type: 'added-on-a', a: text, b: '' })
        } else if (op === 1) {
          result.push({ type: 'added-on-b', a: '', b: text })
        }
      }
    }
  }
  return result
}

function splitIntoChunks(text: string): string[] {
  if (!text) return []
  return text
    .split(/\n{2,}/)
    .flatMap(p => p.split(/(?<=[.!?。！？\n])\s*/))
    .map(s => s.trim())
    .filter(s => s.length > 0)
}
