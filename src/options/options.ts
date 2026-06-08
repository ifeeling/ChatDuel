import chatgptSelectors from '../adapters/chatgpt/selectors.json'
import geminiSelectors from '../adapters/gemini/selectors.json'
import { loadSessions, MAX_SESSIONS, MAX_BYTES } from '../lib/session-store'

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!

const SETTINGS_KEY = 'settings'

interface Settings {
  enabled: { chatgpt: boolean; gemini: boolean }
}

const DEFAULT_SETTINGS: Settings = {
  enabled: { chatgpt: true, gemini: true },
}

async function loadSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get(SETTINGS_KEY)
  return (r[SETTINGS_KEY] as Settings | undefined) ?? DEFAULT_SETTINGS
}

async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s })
}

async function refreshAdapterInfo() {
  const ul = $('#adapter-info') as HTMLUListElement
  ul.innerHTML = ''
  for (const [name, json] of [
    ['ChatGPT', chatgptSelectors],
    ['Gemini', geminiSelectors],
  ] as const) {
    const li = document.createElement('li')
    li.textContent = `${name} adapter v${json.version}（最后验证 ${json.lastVerified}）`
    ul.appendChild(li)
  }
}

async function refreshHistoryStats() {
  const all = await loadSessions()
  const json = JSON.stringify(all)
  const kb = (json.length / 1024).toFixed(1)
  const stats = $('#history-stats') as HTMLParagraphElement
  stats.textContent = `已保存 ${all.length} / ${MAX_SESSIONS} 条会话，占用约 ${kb} KB / 上限 ${(MAX_BYTES / 1024 / 1024).toFixed(0)} MB`
}

async function init() {
  const settings = await loadSettings()
  const cbChat = $<HTMLInputElement>('#enable-chatgpt')
  const cbGem = $<HTMLInputElement>('#enable-gemini')
  cbChat.checked = settings.enabled.chatgpt
  cbGem.checked = settings.enabled.gemini
  cbChat.addEventListener('change', async () => {
    settings.enabled.chatgpt = cbChat.checked
    await saveSettings(settings)
  })
  cbGem.addEventListener('change', async () => {
    settings.enabled.gemini = cbGem.checked
    await saveSettings(settings)
  })

  await refreshAdapterInfo()
  await refreshHistoryStats()

  const btnClear = $<HTMLButtonElement>('#btn-clear-history')
  btnClear.addEventListener('click', async () => {
    if (!confirm('确定要清空所有历史记录吗？此操作不可恢复。')) return
    await chrome.storage.local.remove('sessions')
    await refreshHistoryStats()
  })
}

window.addEventListener('DOMContentLoaded', init)
