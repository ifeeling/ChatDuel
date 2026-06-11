import { describe, it, expect, beforeEach, vi } from 'vitest'
import { addSession, loadSessions, getSession, deleteSession, updateSession, MAX_SESSIONS, MAX_BYTES } from '../../src/lib/session-store'
import type { Session } from '../../src/types'

// jsdom doesn't provide chrome.storage, so mock it
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

const make = (id: string, prompt = 'p'): Session => ({
  id, createdAt: Date.now(), updatedAt: Date.now(), prompt, sentPrompt: prompt, targetPlatforms: ['chatgpt'],
  responses: {}, followUps: [],
  attachments: [], summaries: [],
})

describe('session-store', () => {
  it('adds a session and reads it back', async () => {
    await addSession(make('s1', 'hello'))
    const all = await loadSessions()
    expect(all.find(s => s.id === 's1')).toBeTruthy()
  })

  it('keeps at most MAX_SESSIONS, evicting oldest', async () => {
    for (let i = 0; i < MAX_SESSIONS + 10; i++) {
      await addSession(make(`s${i}`))
    }
    const all = await loadSessions()
    expect(all.length).toBe(MAX_SESSIONS)
    expect(all.find(s => s.id === 's0')).toBeUndefined()
    expect(all.find(s => s.id === `s${MAX_SESSIONS + 9}`)).toBeTruthy()
  })

  it('exports numeric limits for documentation', () => {
    expect(MAX_SESSIONS).toBe(500)
    expect(MAX_BYTES).toBe(100 * 1024 * 1024)
  })

  it('getSession returns the session by id', async () => {
    await addSession(make('xyz', 'foo'))
    const s = await getSession('xyz')
    expect(s?.prompt).toBe('foo')
  })

  it('deleteSession removes the session', async () => {
    await addSession(make('del', 'p'))
    await deleteSession('del')
    const s = await getSession('del')
    expect(s).toBeUndefined()
  })

  it('updateSession replaces an existing session and refreshes updatedAt', async () => {
    const original = make('update', 'before')
    await addSession(original)

    await updateSession({
      ...original,
      prompt: 'after',
      sentPrompt: 'after',
      updatedAt: original.updatedAt + 10,
    })

    const saved = await getSession('update')
    expect(saved?.prompt).toBe('after')
    expect(saved?.sentPrompt).toBe('after')
    expect(saved?.updatedAt).toBe(original.updatedAt + 10)
  })
})
