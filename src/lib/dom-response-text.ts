const IGNORED_TAGS = new Set(['BUTTON', 'SVG', 'IMG', 'STYLE', 'SCRIPT'])
const BLOCK_TAGS = new Set([
  'ARTICLE',
  'BLOCKQUOTE',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'MAIN',
  'MESSAGE-CONTENT',
  'MODEL-RESPONSE',
  'OL',
  'P',
  'SECTION',
  'UL',
])

function normalizeText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim()
}

function inlineText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (!(node instanceof HTMLElement)) return ''
  if (IGNORED_TAGS.has(node.tagName) || node.hidden || node.getAttribute('aria-hidden') === 'true') return ''
  if (node.tagName === 'BR') return '\n'
  return [...node.childNodes].map(inlineText).join('')
}

function hasBlockChildren(el: HTMLElement): boolean {
  return [...el.children].some((child) => child instanceof HTMLElement && BLOCK_TAGS.has(child.tagName))
}

function headingMarkdown(el: HTMLElement): string {
  const level = Number(el.tagName.slice(1))
  return `${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${normalizeText(inlineText(el))}`.trim()
}

function listMarkdown(el: HTMLElement): string {
  const ordered = el.tagName === 'OL'
  const items = [...el.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.tagName === 'LI')
  return items
    .map((item, index) => {
      const marker = ordered ? `${index + 1}.` : '-'
      return `${marker} ${normalizeText(inlineText(item))}`.trim()
    })
    .filter(Boolean)
    .join('\n')
}

function blocksFromElement(el: HTMLElement): string[] {
  if (IGNORED_TAGS.has(el.tagName) || el.hidden || el.getAttribute('aria-hidden') === 'true') return []

  if (/^H[1-6]$/.test(el.tagName)) {
    const text = headingMarkdown(el)
    return text ? [text] : []
  }

  if (el.tagName === 'UL' || el.tagName === 'OL') {
    const text = listMarkdown(el)
    return text ? [text] : []
  }

  if (el.tagName === 'P' || el.tagName === 'LI' || !hasBlockChildren(el)) {
    const text = normalizeText(inlineText(el))
    return text ? [text] : []
  }

  return [...el.childNodes].flatMap(blocksFromNode)
}

function blocksFromNode(node: Node): string[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = normalizeText(node.textContent ?? '')
    return text ? [text] : []
  }
  if (node instanceof HTMLElement) return blocksFromElement(node)
  return []
}

export function elementToMarkdownText(el: HTMLElement): string {
  return blocksFromElement(el)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
