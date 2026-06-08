import { describe, it, expect, beforeEach, vi } from 'vitest'
import { addSession, loadSessions, getSession, deleteSession, MAX_SESSIONS, MAX_BYTES } from '../../src/lib/session-store'
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
  id, createdAt: Date.now(), prompt,
  responses: {}, followUps: [],
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
})
