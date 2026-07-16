import { createClaudeAdapter } from '../adapters/claude/adapter'
import type { SwToContent, ContentToSw } from '../shared/messages'
import type { AIPlatform } from '../types'
import { loadSelectorOverrides } from './selector-overrides'

// ─── Claude iframe 存储分区缓存清理 ──────────────────────────────
//
// 背景：现代浏览器对第三方 iframe 实施存储分区（Storage Partitioning）。
//   - 用户在独立标签页打开 claude.ai → 顶级分区的 localStorage / IndexedDB
//   - ChatDuel 扩展（chrome-extension://）内嵌 claude.ai iframe → 扩展分区存储
//   这两套存储互相隔离！用户在独立标签页切到新模型（如 Sonnet 5 Medium），
// 不会影响 iframe 分区里缓存的旧模型配置。当 Claude 发布新版废弃旧模型后，
//  iframe 就会卡在 "Unsupported model" + 空模型菜单的状态。
//
// 本模块在 content script boot 阶段检测这种过期状态，清除已知的相关缓存 key，
// 然后让 iframe 重新加载一次（用 sessionStorage flag 防止无限循环刷新）。
//
// 已知的 Claude 存储 key 模式（来自 2026-06-19 排查笔记与实页观察）：
//   LSS-model-selector-*          → 当前选中模型
//   LSS-model-picker-*            → 模型选择器 UI 状态
//   claude-*                      → Claude 会话/模型相关

const CLAUDE_CACHE_CLEAR_FLAG = 'aichatroom-claude-cache-cleared'
const LOG_PREFIX = '[ChatDuel Claude]'

/**
 * 全量 dump 当前 origin 的 localStorage / sessionStorage 到控制台。
 * 用于诊断 iframe 存储分区隔离问题——用户可以在父页 DevTools 里看到这些日志。
 */
function dumpStorage(label: string): void {
  const lsKeys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k) lsKeys.push(k)
  }
  const ssKeys: string[] = []
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i)
    if (k) ssKeys.push(k)
  }
  console.log(`${LOG_PREFIX} [DIAG-${label}] localStorage keys (${lsKeys.length}):`, lsKeys)
  console.log(`${LOG_PREFIX} [DIAG-${label}] sessionStorage keys (${ssKeys.length}):`, ssKeys)

  // 对每个 localStorage key 打印截断的值（方便判断是否是过期模型配置）
  for (const k of lsKeys) {
    try {
      const v = localStorage.getItem(k) ?? ''
      console.log(`${LOG_PREFIX}   LS ${k} = ${v.length > 120 ? v.slice(0, 120) + '...(' + v.length + 'chars)' : v}`)
    } catch { /* 某些 key 可能无法读取 */ }
  }
}

/**
 * 清除 Claude 相关的 localStorage / sessionStorage 缓存 key，
 * 返回实际清除了多少条。
 *
 * 第二参数 aggressive=true 时，清除**全部** localStorage 和 sessionStorage
 * （iframe 分区是隔离的，Claude 会从服务端重新初始化，所以全清是安全的）。
 */
function clearClaudeModelCache(aggressive = false): number {
  let cleared = 0

  if (aggressive) {
    // 激进模式：清空整个 iframe 分区的所有存储（最干净）
    const lsCount = localStorage.length
    const ssCount = sessionStorage.length
    localStorage.clear()
    sessionStorage.clear()
    console.log(`${LOG_PREFIX} Aggressive clear: wiped ${lsCount} LS + ${ssCount} SS entries`)
    return lsCount + ssCount
  }

  // 保守模式：只清已知模式的 key
  const patterns = [
    /^LSS-model-selector/i,
    /^LSS-model-picker/i,
    /^LSS-conversation/i,
    /^claude-/i,
  ]

  // 清 localStorage
  const lsKeysToRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key) continue
    if (patterns.some((p) => p.test(key))) {
      lsKeysToRemove.push(key)
    }
  }
  for (const k of lsKeysToRemove) {
    localStorage.removeItem(k)
    cleared++
  }

  // 清 sessionStorage
  const ssKeysToRemove: string[] = []
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i)
    if (!key) continue
    if (patterns.some((p) => p.test(key))) {
      ssKeysToRemove.push(key)
    }
  }
  for (const k of ssKeysToRemove) {
    sessionStorage.removeItem(k)
    cleared++
  }

  return cleared
}

/**
 * 检测 Claude 页面是否处于"不支持模型"或"空模型菜单"状态。
 * 用多种 DOM 特征组合判断，避免误判。
 */
function detectStaleModelState(): boolean {
  // 特征1：页面文本包含 "Unsupported model" 或类似提示
  const bodyText = document.body?.textContent ?? ''
  if (/unsupported\s+model|model.*isn't.*available|switch\s+to\s+another/i.test(bodyText)) return true

  // 特征2：存在模型选择器按钮但展开后菜单为空
  const modelButtons = document.querySelectorAll(
    'button[aria-label*="Model" i], button[aria-label*="模型" i], [data-testid="model-selector"]',
  )
  for (const btn of modelButtons) {
    // 如果按钮本身显示 unsupported / unknown 文本
    const btnText = btn.textContent?.trim().toLowerCase() ?? ''
    if (
      btnText.includes('unsupported') ||
      btnText === '?' ||
      btnText === 'unknown' ||
      btnText === 'select model'
    ) return true
  }

  // 特征3：Claude 主区域出现错误提示块（非正常回答态）
  const errorBlocks = document.querySelectorAll(
    '[role="alert"], .error-message, [data-error], [class*="unsupported"]',
  )
  for (const block of errorBlocks) {
    const text = block.textContent?.trim() ?? ''
    if (/model|available|supported/i.test(text) && text.length < 200) return true
  }

  return false
}

/**
 * 在 content script 注入早期执行缓存清理检查。
 * 返回 true 表示已触发强制刷新（调用方应不再继续初始化 adapter）。
 */
function tryClearStaleCache(): boolean {
  // 已经清理并刷新过了，不要再重复执行
  if (sessionStorage.getItem(CLAUDE_CACHE_CLEAR_FLAG)) return false

  // 给 Claude 页面一点时间渲染（避免在空白页误判）
  // 如果页面还在初始加载中（body 几乎为空），先不判断
  if ((document.body?.textContent?.length ?? 0) < 50) return false

  // ── 诊断：先 dump 当前存储状态（无论是否检测到过期都要 dump）──
  dumpStorage('BEFORE')

  if (!detectStaleModelState()) {
    console.log(`${LOG_PREFIX} Model state looks healthy (no "Unsupported model" detected). Keeping cache as-is.`)
    return false
  }

  // 检测到过期状态：用激进模式清空整个 iframe 分区的所有存储
  const clearedCount = clearClaudeModelCache(/* aggressive */ true)
  console.log(`${LOG_PREFIX} Stale model state DETECTED. Cleared ${clearedCount} cache keys (aggressive mode). Reloading iframe...`)

  // 清完后也 dump 一次确认干净了
  dumpStorage('AFTER-CLEAR')

  sessionStorage.setItem(CLAUDE_CACHE_CLEAR_FLAG, '1')
  location.reload()
  return true // 告诉调用方不要继续 boot
}

// Claude 在扩展 iframe 里点开模型菜单时，浮层可用高度可能被压扁(只剩几 px)，
// 导致菜单外壳可见但选项内容出不来。这里只做一个最小 CSS 补丁：给已展开的
// 菜单强制一个可用高度，并让内部滚动层继承，避免被 iframe 底部压住。
// 具体高度/类名以实页验证为准(见 Claude 接入验证清单)。
function installMenuHeightPatch(): void {
  const style = document.createElement('style')
  style.textContent = `
[data-cds="Menu"][role="menu"][data-open] {
  max-height: 60vh !important;
  min-height: 180px !important;
  overflow-y: auto !important;
}
[data-cds="Menu"][role="menu"][data-open] [class*="overflow"],
[data-cds="Menu"][role="menu"][data-open] [class*="scroll"] {
  max-height: 52vh !important;
  overflow-y: auto !important;
}
`
  document.documentElement.appendChild(style)
}

async function boot() {
  // ── 阶段 0：检测并清理过期的模型缓存（iframe 存储分区隔离问题）──
  // 如果检测到 "Unsupported model" / 空菜单等过期状态，会自动清缓存并 reload。
  // reload 后 sessionStorage flag 会阻止再次清理，正常走后续初始化。
  if (tryClearStaleCache()) {
    return // 已触发强制刷新，本次 boot 终止
  }

  // ── 阶段 1：正常初始化（缓存状态健康 或 已清理后重新加载）──
  // 打印一次 post-reload 的存储状态，方便确认清理效果
  if (sessionStorage.getItem(CLAUDE_CACHE_CLEAR_FLAG)) {
    console.log(`${LOG_PREFIX} Post-reload init (cache was cleared in previous load)`)
    dumpStorage('POST-RELOAD')
  }
  installMenuHeightPatch()
  const adapter = createClaudeAdapter(await loadSelectorOverrides('claude'))

  adapter.onStreamEvent((event) => {
    const msg: ContentToSw = { type: 'stream-event', event }
    chrome.runtime.sendMessage(msg).catch(() => {/* SW may not be ready */})
  })

  if (window.parent !== window) {
    try {
      window.parent.postMessage(
        { source: 'aichatroom-content', event: 'ready', platform: 'claude' },
        { targetOrigin: '*' },
      )
    } catch {
      /* ignore */
    }
  }

  window.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as
      | { source?: string; action?: string; text?: string; imageDataUrl?: string; imageMime?: string; imageName?: string }
      | undefined
    if (!data || data.source !== 'aichatroom-parent') return
    if (data.action !== 'write-and-send') {
      // 父页发 get-state / get-last-response 查询(走 iframe 模式,SW 路径用不了——没有 tabId)
      if (data.action === 'get-state') {
        adapter.getConversationState().then((state) => {
          e.source?.postMessage(
            { source: 'aichatroom-content', type: 'state', platform: 'claude', state },
            { targetOrigin: '*' },
          )
        })
        return
      }
      if (data.action === 'get-last-response') {
        adapter.getLastResponse().then((text) => {
          e.source?.postMessage(
            { source: 'aichatroom-content', type: 'last-response', platform: 'claude', text },
            { targetOrigin: '*' },
          )
        })
        return
      }
      if (data.action === 'get-location') {
        e.source?.postMessage(
          { source: 'aichatroom-content', type: 'location', platform: 'claude', href: location.href },
          { targetOrigin: '*' },
        )
        return
      }
      return
    }

    const text = data.text ?? ''
    const file = data.imageDataUrl
      ? dataUrlToFile(data.imageDataUrl, data.imageMime || 'image/png', data.imageName || 'image.png')
      : undefined

    void Promise.resolve()
      .then(() => adapter.sendMessage(text, file))
      .then(() => {
        e.source?.postMessage(
          { source: 'aichatroom-content', event: 'result', action: 'write-and-send', platform: 'claude', ok: true },
          { targetOrigin: '*' },
        )
      })
      .catch((err: unknown) => {
        e.source?.postMessage(
          {
            source: 'aichatroom-content',
            event: 'result',
            action: 'write-and-send',
            platform: 'claude',
            ok: false,
            error: String(err),
          },
          { targetOrigin: '*' },
        )
      })
  })

  chrome.runtime.onMessage.addListener((msg: SwToContent, _sender, sendResponse) => {
    if (msg.type === 'write-and-send') {
      adapter
        .sendMessage(msg.text)
        .then(() => sendResponse({ ok: true }))
        .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }))
      return true
    }
    if (msg.type === 'get-state') {
      adapter
        .getConversationState()
        .then((state) => {
          const reply: ContentToSw = { type: 'state', platform: 'claude' as AIPlatform, state }
          sendResponse(reply)
        })
      return true
    }
    if (msg.type === 'get-last-response') {
      adapter
        .getLastResponse()
        .then((text) => {
          const reply: ContentToSw = { type: 'last-response', platform: 'claude' as AIPlatform, text }
          sendResponse(reply)
        })
      return true
    }
    return false
  })
}

void boot()

// 把父页传过来的 dataURL 还原成 File(给 adapter.sendMessage 第二参数)
function dataUrlToFile(dataUrl: string, mime: string, name: string): File {
  const commaIdx = dataUrl.indexOf(',')
  const b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl
  const bin = atob(b64)
  const len = bin.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], name, { type: mime })
}
