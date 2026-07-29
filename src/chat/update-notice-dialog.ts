import { t, type UserLanguage } from '../lib/i18n'
import {
  acknowledgeExtensionUpdate,
  getPendingExtensionUpdateVersion,
  type ExtensionUpdateNoticeStorage,
} from '../lib/extension-update-notice'

export interface ExtensionUpdateNoticeDialogOptions {
  overlay: HTMLElement
  message: HTMLElement
  acknowledgeButton: HTMLButtonElement
  language: UserLanguage
  storage: ExtensionUpdateNoticeStorage
}

export async function showExtensionUpdateNotice(
  options: ExtensionUpdateNoticeDialogOptions,
): Promise<void> {
  const pendingVersion = await getPendingExtensionUpdateVersion(options.storage)
  if (!pendingVersion) return
  options.message.textContent = t(options.language, 'updateNotice.message')
  options.acknowledgeButton.textContent = t(options.language, 'updateNotice.acknowledge')
  options.acknowledgeButton.addEventListener('click', () => {
    options.acknowledgeButton.disabled = true
    void acknowledgeExtensionUpdate(pendingVersion, options.storage)
      .then(() => {
        options.overlay.hidden = true
      })
      .catch((error) => {
        console.error('[ChatDuel] failed to acknowledge extension update notice', error)
        options.acknowledgeButton.disabled = false
      })
  })
  options.overlay.hidden = false
  options.acknowledgeButton.focus()
}
