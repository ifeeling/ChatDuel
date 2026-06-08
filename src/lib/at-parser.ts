const AT_RE = /@([A-Za-z][\w-]*)/g

export function parseAtMentions(text: string): string[] {
  if (!text) return []
  const seen = new Set<string>()
  const result: string[] = []
  let m: RegExpExecArray | null
  AT_RE.lastIndex = 0
  while ((m = AT_RE.exec(text)) !== null) {
    const name = m[1]
    const key = name.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      result.push(key)
    }
  }
  return result
}
