import type { AIPlatform, ConversationEntry } from '../types'

const STORAGE_KEY = 'conversation-history'
const MAX_CONVERSATIONS = 200

async function getRaw(): Promise<ConversationEntry[]> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  return (result[STORAGE_KEY] as ConversationEntry[] | undefined) ?? []
}

async function setRaw(conversations: ConversationEntry[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: conversations })
}

export function isSpecificConversationUrl(platform: AIPlatform, url: string | undefined): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    if (platform === 'chatgpt') return parsed.hostname.endsWith('chatgpt.com') && /^\/c\/[^/]+/.test(parsed.pathname)
    if (platform === 'gemini') return parsed.hostname.endsWith('gemini.google.com') && /^\/app\/[^/]+/.test(parsed.pathname)
    if (platform === 'doubao') return parsed.hostname.endsWith('doubao.com') && /^\/chat\/\d+/.test(parsed.pathname)
  } catch {
    return false
  }
  return false
}

function matchingConversationId(
  conversations: ConversationEntry[],
  platformUrls: Partial<Record<AIPlatform, string>>,
): string | null {
  for (const conversation of conversations) {
    for (const [platform, url] of Object.entries(platformUrls) as Array<[AIPlatform, string | undefined]>) {
      if (
        isSpecificConversationUrl(platform, url) &&
        conversation.platformUrls[platform] === url
      ) {
        return conversation.id
      }
    }
  }
  return null
}

function trimConversations(conversations: ConversationEntry[]): ConversationEntry[] {
  return conversations
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONVERSATIONS)
}

export async function loadConversations(): Promise<ConversationEntry[]> {
  return trimConversations(await getRaw())
}

export async function upsertConversation(next: ConversationEntry): Promise<ConversationEntry | null> {
  const specificUrls = Object.fromEntries(
    (Object.entries(next.platformUrls) as Array<[AIPlatform, string | undefined]>)
      .filter(([platform, url]) => isSpecificConversationUrl(platform, url)),
  ) as Partial<Record<AIPlatform, string>>
  if (Object.keys(specificUrls).length === 0) return null

  const all = await getRaw()
  const matchId = matchingConversationId(all, specificUrls)
  const idx = matchId ? all.findIndex((item) => item.id === matchId) : -1
  const saved: ConversationEntry = idx >= 0
    ? {
        ...all[idx],
        updatedAt: next.updatedAt,
        enabledPlatforms: next.enabledPlatforms,
        platformOrder: next.platformOrder,
        platformUrls: {
          ...all[idx].platformUrls,
          ...specificUrls,
        },
      }
    : {
        ...next,
        platformUrls: specificUrls,
      }

  if (idx >= 0) all[idx] = saved
  else all.push(saved)

  await setRaw(trimConversations(all))
  return saved
}

export async function deleteConversation(id: string): Promise<void> {
  const all = await getRaw()
  await setRaw(all.filter((item) => item.id !== id))
}

export async function renameConversation(id: string, title: string, now = Date.now()): Promise<ConversationEntry | null> {
  const nextTitle = title.trim()
  if (!nextTitle) return null

  const all = await getRaw()
  const idx = all.findIndex((item) => item.id === id)
  if (idx < 0) return null

  const renamed: ConversationEntry = {
    ...all[idx],
    title: nextTitle,
    updatedAt: now,
  }
  all[idx] = renamed
  await setRaw(trimConversations(all))
  return renamed
}
