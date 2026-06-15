import type { Session } from '../types'

export function filterSessionsByTitle(sessions: Session[], query: string): Session[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return sessions
  return sessions.filter((session) => session.prompt.toLowerCase().includes(normalized))
}
