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

import { enableEmbedRules, disableEmbedRules } from './dnr-rules'
import type { AIPlatform } from '../types'

const CHAT_PAGE_URL = 'src/chat/chat.html'

const PLATFORMS: AIPlatform[] = ['chatgpt', 'gemini']
const PLATFORM_URL_PREFIX: Record<AIPlatform, string> = {
  chatgpt: 'https://chatgpt.com/',
  gemini: 'https://gemini.google.com/',
}

const CHAT_TAB_IDS_KEY = 'chatTabIds'

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
  const tabs = await chrome.tabs.query({ url: `https://${platform === 'chatgpt' ? 'chatgpt.com' : 'gemini.google.com'}/*` })
  return tabs[0] ?? null
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

// ---------- 启动时的兜底清理 ----------
// 之前会话可能崩溃 / beforeunload 没跑成功,先清掉旧的 DNR 规则
chrome.runtime.onInstalled.addListener(() => {
  chrome.declarativeNetRequest
    .updateDynamicRules({ removeRuleIds: [1, 2] })
    .catch((e) => console.warn('[AIChatRoom] startup cleanup failed', e))
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
  for (const p of PLATFORMS) {
    const tab = await findOfficialTab(p)
    await broadcastToChatTabs({ type: 'tab-status-changed', platform: p, exists: !!tab })
  }
})

chrome.tabs.onUpdated.addListener(async (tabId, _change, tab) => {
  if (!tab.url) return
  for (const p of PLATFORMS) {
    if (tab.url.startsWith(PLATFORM_URL_PREFIX[p])) {
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
  if (msg.type === 'get-history') {
    // v1 暂未实现,先返回空数组
    sendResponse({ ok: true, sessions: [] })
    return false
  }
  return false
})
