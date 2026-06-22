// Service Worker 职责:
// 1) 工具栏图标点击 → 新开 tab 到 src/chat/chat.html(无 default_popup 时 Chrome 走 onClicked)
// 2) 维护 chat 页 tab 列表(chatTabIds),用于按需启用 DNR 规则和 tab 状态广播
// 3) 监听 chat 页发来的 enable-embed-rules / disable-embed-rules 消息
// 4) 监听官方页 tab 打开/关闭,广播给 chat 页更新顶部状态
//
// 通信协议见 src/shared/messages.ts
//
// 注意:这个 SW 主要是"给 chat.html 用"的协调器。chat.html 内 iframe
// 的官方页面之间通信走 window.postMessage 直连,不经过 SW(因为 iframe
// 没有 tabId,SW 找不到它们)。详见 docs/postmortems/2026-06-09-iframe-no-response.md

import { enableEmbedRules, disableEmbedRules, getEmbedRuleCleanupIds } from './dnr-rules'
import { SUPPORTED_PLATFORMS } from '../lib/ai-platforms'
import {
  REMOTE_SELECTOR_CONFIG_STORAGE_KEY,
  REMOTE_SELECTOR_CONFIG_URL,
  getStoredSelectorOverrides,
  sanitizeRemoteSelectorConfig,
} from '../lib/remote-selector-config'
import type { AIPlatform } from '../types'

const CHAT_PAGE_URL = 'src/chat/chat.html'

const PLATFORM_URL_PREFIXES: Record<AIPlatform, string[]> = {
  chatgpt: ['https://chatgpt.com/'],
  gemini: ['https://gemini.google.com/'],
  doubao: ['https://www.doubao.com/', 'https://doubao.com/'],
  deepseek: ['https://chat.deepseek.com/'],
}

const CHAT_TAB_IDS_KEY = 'chatTabIds'
const SELECTOR_CONFIG_REFRESH_ALARM = 'selector-config-refresh'

async function getChatTabIds(): Promise<Set<number>> {
  const r = await chrome.storage.session.get(CHAT_TAB_IDS_KEY)
  return new Set<number>((r[CHAT_TAB_IDS_KEY] as number[] | undefined) ?? [])
}

async function addChatTabId(id: number): Promise<void> {
  const ids = await getChatTabIds()
  ids.add(id)
  await chrome.storage.session.set({ [CHAT_TAB_IDS_KEY]: [...ids] })
}

async function removeChatTabId(id: number): Promise<void> {
  const ids = await getChatTabIds()
  ids.delete(id)
  await chrome.storage.session.set({ [CHAT_TAB_IDS_KEY]: [...ids] })
}

async function findOfficialTab(platform: AIPlatform): Promise<chrome.tabs.Tab | null> {
  for (const prefix of PLATFORM_URL_PREFIXES[platform]) {
    const tabs = await chrome.tabs.query({ url: `${prefix}*` })
    if (tabs[0]) return tabs[0]
  }
  return null
}

async function sendOfficialTabMessage(platform: AIPlatform, message: unknown): Promise<unknown> {
  const tab = await findOfficialTab(platform)
  if (!tab?.id) {
    throw new Error(`${platform} 官方标签页没有打开`)
  }
  return chrome.tabs.sendMessage(tab.id, message)
}

async function broadcastToChatTabs(msg: unknown): Promise<void> {
  const ids = await getChatTabIds()
  for (const id of ids) {
    try {
      await chrome.tabs.sendMessage(id, msg)
    } catch {
      // tab 可能已关闭,忽略
    }
  }
}

function scheduleSelectorConfigRefresh(): void {
  chrome.alarms?.create(SELECTOR_CONFIG_REFRESH_ALARM, { periodInMinutes: 24 * 60 })
}

async function refreshRemoteSelectorConfig(): Promise<boolean> {
  try {
    const response = await fetch(REMOTE_SELECTOR_CONFIG_URL, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'X-ChatDuel-Version': chrome.runtime.getManifest().version,
      },
    })
    if (!response.ok) return false
    const rawConfig = await response.json()
    const config = sanitizeRemoteSelectorConfig(rawConfig)
    if (!config) {
      await chrome.storage.local.remove(REMOTE_SELECTOR_CONFIG_STORAGE_KEY)
      return false
    }
    await chrome.storage.local.set({ [REMOTE_SELECTOR_CONFIG_STORAGE_KEY]: config })
    return true
  } catch (e) {
    console.warn('[ChatDuel] remote selector config refresh failed', e)
    return false
  }
}

// ---------- 启动时的兜底清理 ----------
// 之前会话可能崩溃 / beforeunload 没跑成功,先清掉旧的 DNR 规则
chrome.runtime.onInstalled.addListener(() => {
  scheduleSelectorConfigRefresh()
  void refreshRemoteSelectorConfig()
  chrome.declarativeNetRequest
    .updateDynamicRules({ removeRuleIds: getEmbedRuleCleanupIds() })
    .catch((e) => console.warn('[ChatDuel] startup cleanup failed', e))
})

chrome.runtime.onStartup.addListener(() => {
  scheduleSelectorConfigRefresh()
  void refreshRemoteSelectorConfig()
})

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === SELECTOR_CONFIG_REFRESH_ALARM) {
    void refreshRemoteSelectorConfig()
  }
})

// ---------- 工具栏图标点击 → 打开 chat 页 ----------
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL(CHAT_PAGE_URL) })
})

// ---------- 维护 chatTabIds ----------
chrome.tabs.onRemoved.addListener((tabId) => {
  void removeChatTabId(tabId)
  // tab 关闭后,如果 chatTabIds 空了,关掉 DNR 规则(兜底)
  void getChatTabIds().then((ids) => {
    if (ids.size === 0) {
      void disableEmbedRules().catch(() => {})
    }
  })
})

// 监听 chat 页导航(防止 tabId 重用时 chatTabIds 残留,跟 ChatBrawl 同款)
chrome.webNavigation?.onCommitted.addListener((details) => {
  if (details.url === chrome.runtime.getURL(CHAT_PAGE_URL)) {
    void addChatTabId(details.tabId)
  }
})

// ---------- 官方页 tab 状态广播 ----------
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  if (removeInfo.windowId === chrome.windows.WINDOW_ID_NONE) return
  for (const p of SUPPORTED_PLATFORMS) {
    const tab = await findOfficialTab(p)
    await broadcastToChatTabs({ type: 'tab-status-changed', platform: p, exists: !!tab })
  }
})

chrome.tabs.onUpdated.addListener(async (tabId, _change, tab) => {
  if (!tab.url) return
  for (const p of SUPPORTED_PLATFORMS) {
    if (PLATFORM_URL_PREFIXES[p].some((prefix) => tab.url?.startsWith(prefix))) {
      const t = await findOfficialTab(p)
      await broadcastToChatTabs({ type: 'tab-status-changed', platform: p, exists: !!t })
    }
  }
})

// ---------- 来自 chat 页 / popup / content script 的消息 ----------
chrome.runtime.onMessage.addListener((msg: { type: string; [k: string]: unknown }, _sender, sendResponse) => {
  if (msg.type === 'enable-embed-rules') {
    enableEmbedRules()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }))
    return true
  }
  if (msg.type === 'disable-embed-rules') {
    disableEmbedRules()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }))
    return true
  }
  if (msg.type === 'check-tab-exists') {
    findOfficialTab(msg.platform as AIPlatform)
      .then((tab) => sendResponse({ ok: true, exists: !!tab }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }))
    return true
  }
  if (msg.type === 'official-tab-command') {
    const platform = msg.platform as AIPlatform
    const command = msg.command as string
    const text = typeof msg.text === 'string' ? msg.text : ''
    const imageDataUrl = typeof msg.imageDataUrl === 'string' ? msg.imageDataUrl : undefined
    const contentMessage =
      command === 'write-and-send'
        ? { type: 'write-and-send', text, imageDataUrl }
        : command === 'get-state'
          ? { type: 'get-state' }
          : command === 'get-last-response'
            ? { type: 'get-last-response' }
            : null
    if (!contentMessage) {
      sendResponse({ ok: false, error: `unknown official-tab-command: ${command}` })
      return false
    }
    sendOfficialTabMessage(platform, contentMessage)
      .then((response) => sendResponse(response ?? { ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }))
    return true
  }
  if (msg.type === 'selector-config:get') {
    getStoredSelectorOverrides(msg.platform as AIPlatform)
      .then((selectors) => sendResponse({ ok: true, selectors }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }))
    return true
  }
  if (msg.type === 'selector-config:refresh') {
    refreshRemoteSelectorConfig()
      .then((ok) => sendResponse({ ok }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }))
    return true
  }
  if (msg.type === 'get-history') {
    // v1 暂未实现,先返回空数组
    sendResponse({ ok: true, sessions: [] })
    return false
  }
  return false
})
