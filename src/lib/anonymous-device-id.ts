export const ANONYMOUS_DEVICE_ID_STORAGE_KEY = 'anonymousDeviceId'

function generateDeviceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `device-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

let pendingId: Promise<string> | null = null

export async function getAnonymousDeviceId(): Promise<string> {
  if (!pendingId) {
    pendingId = (async () => {
      const result = await chrome.storage.local.get(ANONYMOUS_DEVICE_ID_STORAGE_KEY)
      const existing = result[ANONYMOUS_DEVICE_ID_STORAGE_KEY]
      if (typeof existing === 'string' && existing) return existing

      const id = generateDeviceId()
      await chrome.storage.local.set({ [ANONYMOUS_DEVICE_ID_STORAGE_KEY]: id })
      return id
    })().finally(() => {
      pendingId = null
    })
  }
  return pendingId
}
