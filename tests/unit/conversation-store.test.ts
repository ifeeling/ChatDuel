import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteConversation,
  isSpecificConversationUrl,
  loadConversations,
  renameConversation,
  upsertConversation,
} from '../../src/lib/conversation-store'
import type { ConversationEntry } from '../../src/types'

beforeEach(() => {
  const store: Record<string, unknown> = {}
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(store, obj)
        }),
      },
    },
  })
})

function makeConversation(id: string, title: string, url: string): ConversationEntry {
  return {
    id,
    title,
    createdAt: 1000,
    updatedAt: 1000,
    enabledPlatforms: ['chatgpt'],
    platformUrls: { chatgpt: url },
  }
}

describe('conversation-store', () => {
  it('recognizes specific official conversation urls', () => {
    expect(isSpecificConversationUrl('chatgpt', 'https://chatgpt.com/c/abc')).toBe(true)
    expect(isSpecificConversationUrl('gemini', 'https://gemini.google.com/app/abc')).toBe(true)
    expect(isSpecificConversationUrl('doubao', 'https://www.doubao.com/chat/38430589934872834')).toBe(true)
    expect(isSpecificConversationUrl('chatgpt', 'https://chatgpt.com/')).toBe(false)
    expect(isSpecificConversationUrl('doubao', 'https://www.doubao.com/chat/')).toBe(false)
  })

  it('adds a new conversation snapshot and reads it back newest first', async () => {
    await upsertConversation(makeConversation('c1', '第一场对话', 'https://chatgpt.com/c/one'))
    await upsertConversation({
      ...makeConversation('c2', '第二场对话', 'https://chatgpt.com/c/two'),
      updatedAt: 2000,
    })

    const all = await loadConversations()

    expect(all.map((item) => item.id)).toEqual(['c2', 'c1'])
  })

  it('updates an existing conversation when a platform url matches', async () => {
    await upsertConversation(makeConversation('old', '旧标题', 'https://chatgpt.com/c/same'))
    await upsertConversation({
      id: 'new',
      title: '新标题',
      createdAt: 3000,
      updatedAt: 3000,
      enabledPlatforms: ['chatgpt', 'doubao'],
      platformOrder: ['doubao', 'chatgpt', 'gemini'],
      platformUrls: {
        chatgpt: 'https://chatgpt.com/c/same',
        doubao: 'https://www.doubao.com/chat/38430589934872834',
      },
    })

    const all = await loadConversations()

    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({
      id: 'old',
      title: '旧标题',
      updatedAt: 3000,
      enabledPlatforms: ['chatgpt', 'doubao'],
      platformOrder: ['doubao', 'chatgpt', 'gemini'],
      platformUrls: {
        chatgpt: 'https://chatgpt.com/c/same',
        doubao: 'https://www.doubao.com/chat/38430589934872834',
      },
    })
  })

  it('deletes a conversation by id', async () => {
    await upsertConversation(makeConversation('c1', '第一场对话', 'https://chatgpt.com/c/one'))
    await deleteConversation('c1')

    await expect(loadConversations()).resolves.toEqual([])
  })

  it('renames a conversation by id without changing official urls', async () => {
    await upsertConversation(makeConversation('c1', '旧标题', 'https://chatgpt.com/c/one'))

    const renamed = await renameConversation('c1', '  新标题  ', 2000)

    expect(renamed).toMatchObject({
      id: 'c1',
      title: '新标题',
      updatedAt: 2000,
      platformUrls: { chatgpt: 'https://chatgpt.com/c/one' },
    })
    await expect(loadConversations()).resolves.toMatchObject([{ title: '新标题' }])
  })
})
