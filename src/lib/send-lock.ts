import type { AIPlatform } from '../types'

export const SEND_LOCK_TIMEOUT_MS = 120_000

export type SendLockStatus = 'waiting' | 'done' | 'timeout' | 'unlocked'
export type SendLockPhase = 'submitting' | 'waiting-response'

export interface SendLockState {
  status: SendLockStatus
  phase: SendLockPhase
  targetPlatforms: AIPlatform[]
  pendingPlatforms: AIPlatform[]
  startedAt: number
  submittedAt?: number
  completedAt?: number
}

export function createSendLock(targetPlatforms: AIPlatform[], startedAt = Date.now()): SendLockState {
  const uniqueTargets = [...new Set(targetPlatforms)]
  return {
    status: uniqueTargets.length > 0 ? 'waiting' : 'done',
    phase: 'submitting',
    targetPlatforms: uniqueTargets,
    pendingPlatforms: uniqueTargets,
    startedAt,
    completedAt: uniqueTargets.length === 0 ? startedAt : undefined,
  }
}

export function markSendLockSubmitted(lock: SendLockState, now = Date.now()): SendLockState {
  if (lock.status !== 'waiting') return lock
  return {
    ...lock,
    phase: 'waiting-response',
    submittedAt: now,
  }
}

export function markSendLockPlatformDone(
  lock: SendLockState,
  platform: AIPlatform,
  now = Date.now(),
): SendLockState {
  if (lock.status !== 'waiting') return lock

  const pendingPlatforms = lock.pendingPlatforms.filter((p) => p !== platform)
  if (pendingPlatforms.length === 0) {
    return {
      ...lock,
      status: 'done',
      pendingPlatforms,
      completedAt: now,
    }
  }

  return {
    ...lock,
    pendingPlatforms,
  }
}

export function shouldSendLockTimeout(lock: SendLockState, now = Date.now()): boolean {
  return lock.status === 'waiting' && now - lock.startedAt >= SEND_LOCK_TIMEOUT_MS
}

export function shouldUnlockInsteadOfSend(lock: SendLockState | null | undefined): boolean {
  return lock?.status === 'waiting' && lock.phase === 'waiting-response'
}

export function markSendLockTimedOut(lock: SendLockState): SendLockState {
  if (lock.status !== 'waiting') return lock
  return { ...lock, status: 'timeout' }
}

export function markSendLockUnlocked(lock: SendLockState): SendLockState {
  return { ...lock, status: 'unlocked' }
}
