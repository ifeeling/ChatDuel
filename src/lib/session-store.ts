import type { Session } from '../types'

export const MAX_SESSIONS = 500
export const MAX_BYTES = 100 * 1024 * 1024 // 100MB

const STORAGE_KEY = 'sessions'

async function getRaw(): Promise<Session[]> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  return (result[STORAGE_KEY] as Session[] | undefined) ?? []
}

async function setRaw(sessions: Session[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: sessions })
}

async function evictIfNeeded(sessions: Session[]): Promise<Session[]> {
  if (sessions.length > MAX_SESSIONS) {
    sessions.sort((a, b) => a.createdAt - b.createdAt)
    sessions = sessions.slice(sessions.length - MAX_SESSIONS)
  }
  const json = JSON.stringify(sessions)
  if (json.length > MAX_BYTES) {
    sessions.sort((a, b) => a.createdAt - b.createdAt)
    while (sessions.length > 1 && JSON.stringify(sessions).length > MAX_BYTES) {
      sessions.shift()
    }
  }
  return sessions
}

export async function addSession(session: Session): Promise<void> {
  const all = await getRaw()
  all.push(session)
  const trimmed = await evictIfNeeded(all)
  await setRaw(trimmed)
}

export async function loadSessions(): Promise<Session[]> {
  return getRaw()
}

export async function getSession(id: string): Promise<Session | undefined> {
  const all = await getRaw()
  return all.find(s => s.id === id)
}

export async function updateSession(session: Session): Promise<void> {
  const all = await getRaw()
  const idx = all.findIndex(s => s.id === session.id)
  if (idx >= 0) {
    all[idx] = session
  } else {
    all.push(session)
  }
  const trimmed = await evictIfNeeded(all)
  await setRaw(trimmed)
}

export async function deleteSession(id: string): Promise<void> {
  const all = await getRaw()
  await setRaw(all.filter(s => s.id !== id))
}
