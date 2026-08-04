export interface GitHubRelease {
  tag_name: string
  body: string
}

export type VersionCheckResult =
  | { status: 'update-available'; latestVersion: string; changelog: string }
  | { status: 'up-to-date'; latestVersion: string }
  | { status: 'error' }

export const REPO = 'ifeeling/ChatDuel'
export const RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`

export function compareVersions(current: string, latest: string): boolean {
  const parts = (value: string) => value.replace(/^v/i, '').split('.').map(Number)
  const currentParts = parts(current)
  const latestParts = parts(latest)
  for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
    const currentNum = currentParts[i] ?? 0
    const latestNum = latestParts[i] ?? 0
    if (latestNum !== currentNum) return latestNum > currentNum
  }
  return false
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderReleaseMarkdown(body: string): string {
  const lines = body.split('\n')
  const html: string[] = []
  let listOpen = false

  const closeList = () => {
    if (listOpen) {
      html.push('</ul>')
      listOpen = false
    }
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      closeList()
      continue
    }
    const inline = (text: string) =>
      escapeHtml(text)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      closeList()
      const level = Math.min(heading[1].length, 6)
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/)
    if (bullet) {
      if (!listOpen) {
        html.push('<ul>')
        listOpen = true
      }
      html.push(`<li>${inline(bullet[1])}</li>`)
      continue
    }
    closeList()
    html.push(`<p>${inline(line)}</p>`)
  }
  closeList()

  return html.join('')
}

export async function fetchLatestRelease(
  currentVersion: string,
  fetchFn: (input: string, init?: { signal?: AbortSignal }) => Promise<Response>,
  timeoutMs = 8000,
): Promise<VersionCheckResult> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetchFn(RELEASE_URL, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) return { status: 'error' }
    const release = (await response.json()) as Partial<GitHubRelease>
    if (typeof release.tag_name !== 'string') return { status: 'error' }

    const latestVersion = release.tag_name.replace(/^v/i, '')
    if (!compareVersions(currentVersion, latestVersion)) {
      return { status: 'up-to-date', latestVersion }
    }
    return {
      status: 'update-available',
      latestVersion,
      changelog: renderReleaseMarkdown(release.body ?? ''),
    }
  } catch {
    return { status: 'error' }
  }
}