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
 * 全量 dump 当前 origin 的 localStorage / sessionStorage / IndexedDB 到控制台。
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

  // 异步 dump IndexedDB（不阻塞主流程）
  dumpIndexedDB(label)
}

/**
 * 清除 Claude 相关的 localStorage / sessionStorage / IndexedDB 缓存，
 * 返回实际清除了多少条。
 *
 * 第二参数 aggressive=true 时，清除**全部**存储（LS / SS / IDB），
 * 并清除 Cache API 中 claude.ai origin 下的缓存。
 * （iframe 分区是隔离的，Claude 会从服务端重新初始化，所以全清是安全的。）
 */
async function clearClaudeModelCache(aggressive = false): Promise<number> {
  let cleared = 0

  if (aggressive) {
    // ── 1. 清 localStorage / sessionStorage ──
    const lsCount = localStorage.length
    const ssCount = sessionStorage.length
    localStorage.clear()
    sessionStorage.clear()
    cleared += lsCount + ssCount
    console.log(`${LOG_PREFIX} Aggressive clear: wiped ${lsCount} LS + ${ssCount} SS entries`)

    // ── 2. 清 IndexedDB（这是关键！Claude 很可能把模型状态存在这里）──
    try {
      const dbs = await indexedDB.databases()
      const dbNames = dbs.map((d) => d.name).filter((n): n is string => !!n)
      console.log(`${LOG_PREFIX} Found ${dbNames.length} IndexedDB databases to delete:`, dbNames)
      await Promise.allSettled(
        dbNames.map((name) =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(name)
            req.onsuccess = () => { console.log(`${LOG_PREFIX} Deleted IDB: ${name}`); resolve() }
            req.onerror = () => { console.warn(`${LOG_PREFIX} Failed to delete IDB: ${name}`); resolve() }
            req.onblocked = () => { console.warn(`${LOG_PREFIX} IDB delete blocked: ${name}`); resolve() }
          })
        )
      )
      cleared += dbNames.length
    } catch (e) {
      console.warn(`${LOG_PREFIX} Error clearing IndexedDB:`, e)
    }

    // ── 3. 清 Cache API（同源缓存）──
    try {
      if ('caches' in window) {
        const names = await caches.keys()
        const claudeCacheNames = names.filter(n =>
          n.includes('claude') || n.includes('anthropic') || n.includes('workbox')
        )
        for (const name of claudeCacheNames) {
          await caches.delete(name)
          cleared++
          console.log(`${LOG_PREFIX} Deleted cache: ${name}`)
        }
        if (claudeCacheNames.length === 0 && names.length > 0) {
          console.log(`${LOG_PREFIX} Cache names (none deleted):`, names)
        }
      }
    } catch (e) {
      console.warn(`${LOG_PREFIX} Error clearing caches:`, e)
    }

    return cleared
  }

  // 保守模式：只清已知模式的 key（仅 localStorage/sessionStorage）
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
 * 异步版：dump IndexedDB 数据库名称列表（诊断用）
 */
async function dumpIndexedDB(label: string): Promise<void> {
  try {
    const dbs = await indexedDB.databases()
    console.log(`${LOG_PREFIX} [DIAG-${label}] IndexedDB databases (${dbs.length}):`, dbs.map(d => d.name))
  } catch (e) {
    console.warn(`${LOG_PREFIX} [DIAG-${label}] Cannot list IndexedDB:`, e)
  }
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
 * 安排延迟的缓存状态检查（不阻塞 boot 主流程）。
 *
 * 背景：content script 在 document_start 注入，此时 Claude 页面还是空白的，
 * "Unsupported model" 等文本尚未渲染。同步检测会因 body 太短而直接跳过。
 * 本函数用 MutationObserver + 延时重试双策略，等页面真正渲染后再检查。
 */
function scheduleStaleCacheCheck(): void {
  // 已清理过就不再安排
  if (sessionStorage.getItem(CLAUDE_CACHE_CLEAR_FLAG)) return

  let settled = false
  const MAX_ATTEMPTS = 10       // 最多尝试 ~10 秒
  const BASE_DELAY_MS = 500     // 首次 0.5s，之后每次 +500ms
  let attempts = 0

  /**
   * 执行一次检测。返回 Promise<boolean>：
   *   true  = 已触发清理+刷新（后续不再执行）
   *   false = 未检测到过期（继续重试）
   */
  async function attempt(): Promise<boolean> {
    if (settled) return true

    // body 还太短 → 页面还没渲染完，继续等
    const len = document.body?.textContent?.length ?? 0
    if (len < 50) {
      console.log(`${LOG_PREFIX} [CACHE-CHECK #${attempts}] Body too short (${len} chars), waiting...`)
      return false
    }

    // ── 页面有内容了，做诊断 dump ──
    dumpStorage(`CHECK-${attempts}`)

    if (!detectStaleModelState()) {
      console.log(`${LOG_PREFIX} [CACHE-CHECK #${attempts}] Model state looks healthy.`)
      return false
    }

    // ── 检测到过期！执行激进清理（含 IndexedDB + Cache API）──
    settled = true
    const clearedCount = await clearClaudeModelCache(/* aggressive */ true)
    console.log(`${LOG_PREFIX} STALE DETECTED at attempt #${attempts}. Cleared ${clearedCount} entries (aggressive, incl IDB). Reloading...`)
    sessionStorage.setItem(CLAUDE_CACHE_CLEAR_FLAG, '1')
    location.reload()
    return true
  }

  // 策略 A：MutationObserver — 当 DOM 有实质变化时触发检测
  const observer = new MutationObserver(() => {
    if (settled) { observer.disconnect(); return }
    void attempt().then((done) => { if (done) observer.disconnect() })
  })
  observer.observe(document.body ?? document.documentElement, {
    childList: true,
    subtree: true,
  })

  // 策略 B：定时重试 —— 即使 Observer 漏掉某些情况也有兜底
  function scheduleNext() {
    if (settled || attempts >= MAX_ATTEMPTS) {
      if (!settled && attempts >= MAX_ATTEMPTS) {
        // 超过最大尝试次数，dump 最终状态后放弃
        dumpStorage('TIMEOUT')
        console.log(`${LOG_PREFIX} Cache check timed out after ${MAX_ATTEMPTS} attempts. Keeping cache as-is.`)
      }
      observer.disconnect()
      return
    }
    attempts++
    const delay = BASE_DELAY_MS * attempts
    setTimeout(() => {
      void attempt().then((done) => { if (done) { observer.disconnect(); return } scheduleNext() })
    }, delay)
  }

  // 第一次延时稍长一点（给初始加载留时间）
  setTimeout(scheduleNext, 1000)
}

// Claude 在扩展 iframe 里点开模型菜单时，浮层可用高度可能被压扁(只剩几 px)，
// 导致菜单外壳可见但选项内容出不来。这里只做一个最小 CSS 补丁：给已展开的
// 菜单强制一个可用高度，并让内部滚动层继承，避免被 iframe 底部压住。
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
  // ── 阶段 0：异步检测并清理过期模型缓存 ──
  // 不再同步阻塞 boot；改为后台调度，等页面渲染完自动检查。
  // 如果检测到过期状态，会清缓存并 reload（本次 boot 自然终止）。
  scheduleStaleCacheCheck()

  // ── 阶段 1：正常初始化（缓存状态健康 或 已清理后重新加载）──
  // 打印一次 post-reload 的存储状态，方便确认清理效果
  if (sessionStorage.getItem(CLAUDE_CACHE_CLEAR_FLAG)) {
    console.log(`${LOG_PREFIX} Post-reload init (cache was cleared in previous load)`)
    // 延迟一点等 Claude 重新初始化完再 dump
    setTimeout(() => dumpStorage('POST-RELOAD'), 2000)
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
