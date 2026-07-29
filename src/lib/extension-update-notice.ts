export interface ExtensionUpdateNoticeStorage {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export const EXTENSION_UPDATE_NOTICE_STORAGE_KEY = 'extensionUpdateNotice'

interface ExtensionUpdateNoticeState {
  pendingVersion?: string
  acknowledgedVersion?: string
}

async function loadState(storage: ExtensionUpdateNoticeStorage): Promise<ExtensionUpdateNoticeState> {
  const stored = await storage.get(EXTENSION_UPDATE_NOTICE_STORAGE_KEY)
  const value = stored[EXTENSION_UPDATE_NOTICE_STORAGE_KEY]
  if (typeof value !== 'object' || value === null) return {}
  const state = value as Record<string, unknown>
  return {
    pendingVersion: typeof state.pendingVersion === 'string' ? state.pendingVersion : undefined,
    acknowledgedVersion: typeof state.acknowledgedVersion === 'string' ? state.acknowledgedVersion : undefined,
  }
}

export async function recordExtensionUpdate(
  details: { reason: string },
  currentVersion: string,
  storage: ExtensionUpdateNoticeStorage,
): Promise<void> {
  if (details.reason !== 'update') return
  const state = await loadState(storage)
  await storage.set({
    [EXTENSION_UPDATE_NOTICE_STORAGE_KEY]: {
      ...state,
      pendingVersion: currentVersion,
    },
  })
}

export async function getPendingExtensionUpdateVersion(
  storage: ExtensionUpdateNoticeStorage,
): Promise<string | null> {
  const state = await loadState(storage)
  if (!state.pendingVersion || state.pendingVersion === state.acknowledgedVersion) return null
  return state.pendingVersion
}

export async function acknowledgeExtensionUpdate(
  version: string,
  storage: ExtensionUpdateNoticeStorage,
): Promise<void> {
  const state = await loadState(storage)
  await storage.set({
    [EXTENSION_UPDATE_NOTICE_STORAGE_KEY]: {
      ...state,
      acknowledgedVersion: version,
    },
  })
}
