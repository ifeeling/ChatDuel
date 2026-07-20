import { CLAUDE_SELECTOR_VERSION, createClaudeAdapter } from '../adapters/claude/adapter'
import type { SwToContent, ContentToSw } from '../shared/messages'
import type { AIPlatform } from '../types'
import { createAdapterDiagnostics } from '../lib/diagnostic-client'
import { loadSelectorConfig } from './selector-overrides'
import selectorsJson from '../adapters/claude/selectors.json'

// selectors.json 是「最佳猜测」，以下诊断用于在实页确认每个选择器是否命中。
const CLAUDE_SELECTORS = selectorsJson.selectors as Record<string, string>

// ─── Claude iframe "Unsupported model" 修复 ──────────────────────────
//
// 根因（2026-07-16 实页验证确认）：
//   Claude 在 iframe 分区里缺少 `lastActiveOrg` cookie（浏览器存储分区隔离）。
//   独立标签页有这个 cookie → Claude 知道用户所属组织 → 正常显示可用模型。
//   扩展 iframe 分区没有 → Claude 不知道用户身份 → "Unsupported model" + 空菜单。
//
// 修复方案（参考 ChatBrawl 的 ensureLastActiveOrgCookie 实现）：
//   1. 检测 iframe 内是否有 lastActiveOrg cookie
//   2. 没有 → 调 Claude 官方 /edge-api/bootstrap API 获取组织 UUID
//   3. 把 UUID 写入 iframe 分区的 lastActiveOrg cookie
//   4. 强制 reload 一次（用 sessionStorage flag 防循环）
//   5. 第二次加载时 cookie 已存在 → Claude 正常初始化 → 显示 Sonnet/Opus 等
//
// 备选方案：如果 cookie 方案仍不够，再尝试清 localStorage/IndexedDB 缓存。

const LOG_PREFIX = '[ChatDuel Claude]'

// ── 阶段 A：确保 lastActiveOrg cookie 存在 ──────────────────────────

const ORG_COOKIE_RELOAD_KEY = 'chatduel-claude-org-cookie-reloaded'

/** 检查是否在 iframe 嵌入环境 */
function isEmbedded(): boolean {
  try {
    return window.top !== window.self
  } catch {
    return true // 跨域访问时 top 不可读，说明一定是嵌入的
  }
}

/** 检测某个 non-httpOnly cookie 是否存在 */
function hasReadableCookie(name: string): boolean {
  return document.cookie.split(';').some(c => c.trim().startsWith(`${name}=`))
}

/**
 * 设置 lastActiveOrg cookie 到当前 origin（即 iframe 分区的 claude.ai）。
 * 返回是否设置成功。
 */
function setLastActiveOrgCookie(organizationUuid: string): boolean {
  if (!organizationUuid) return false

  document.cookie = [
    `lastActiveOrg=${encodeURIComponent(organizationUuid)}`,
    'Path=/',
    'Max-Age=31536000', // 1 年
    'Secure',
    'SameSite=None',
  ].join('; ')

  return hasReadableCookie('lastActiveOrg')
}

/**
 * 从 Claude 的 bootstrap API 获取用户的组织 UUID。
 * 这个 API 是 Claude 自己的前端调用的，返回账户/组织信息。
 */
async function getBootstrapOrganizationUuid(): Promise<string | null> {
  try {
    const response = await fetch(
      '/edge-api/bootstrap?statsig_hashing_algorithm=djb2&growthbook_format=sdk&include_system_prompts=false',
      { credentials: 'include' },
    )
    if (!response.ok) {
      console.warn(`${LOG_PREFIX} Bootstrap API returned ${response.status}`)
      return null
    }
    const data = await response.json()
    // 遍历 memberships 找到第一个有组织 UUID 的
    const uuid = data?.account?.memberships?.find(
      (m: any) => m?.organization?.uuid,
    )?.organization?.uuid ?? null
    console.log(`${LOG_PREFIX} Bootstrap org UUID:`, uuid ?? '(not found)')
    return uuid
  } catch (e) {
    console.warn(`${LOG_PREFIX} Bootstrap API error:`, e)
    return null
  }
}

/**
 * 核心修复：确保 iframe 分区内存在 lastActiveOrg cookie。
 * 参考 ChatBrawl 的 ensureLastActiveOrgCookie()。
 *
 * 流程：
 *   1. 非 iframe 环境 / 已有 cookie → 不需要处理
 *   2. 调 bootstrap API 拿 UUID
 *   3. 写 cookie
 *   4. 写 sessionStorage flag + reload（防循环）
 *
 * 返回 true 表示已触发 reload（调用方应不再继续 boot）。
 */
async function ensureLastActiveOrgCookie(): Promise<boolean> {
  // 已经 reload 过了，不再重复
  if (sessionStorage.getItem(ORG_COOKIE_RELOAD_KEY)) return false

  // 非 iframe 环境不需要处理
  if (!isEmbedded()) return false

  // cookie 已经有了（可能之前设置过、或用户在独立标签页登录过且分区共享）
  if (hasReadableCookie('lastActiveOrg')) {
    console.log(`${LOG_PREFIX} lastActiveOrg cookie already present.`)
    return false
  }

  console.log(`${LOG_PREFIX} No lastActiveOrg cookie in iframe partition. Fetching from bootstrap API...`)

  try {
    const uuid = await getBootstrapOrganizationUuid()
    if (!uuid) {
      console.warn(`${LOG_PREFIX} Bootstrap returned no org UUID.`)
      return false
    }
    const ok = setLastActiveOrgCookie(uuid)

    if (!ok) {
      console.warn(`${LOG_PREFIX} Failed to set lastActiveOrg cookie (uuid=${uuid ?? 'null'}, ok=${ok})`)
      // cookie 设不上就不 reload，避免死循环；让后续流程继续
      return false
    }

    console.log(`${LOG_PREFIX} Set lastActiveOrg=${uuid}. Reloading iframe to apply...`)
    sessionStorage.setItem(ORG_COOKIE_RELOAD_KEY, 'true')
    location.reload()
    return true // 告诉调用方本次 boot 终止，等 reload 后重新进入

  } catch (e) {
    console.warn(`${LOG_PREFIX} ensureLastActiveOrgCookie failed:`, e)
    return false
  }
}

// ── 阶段 B：缓存清理兜底（如果 cookie 方案不够则触发） ─────────────

const CACHE_CLEAR_FLAG = 'chatduel-claude-cache-cleared'

/**
 * 检测页面是否处于 "Unsupported model" 状态。
 */
function detectStaleModelState(): boolean {
  const bodyText = document.body?.textContent ?? ''
  if (/unsupported\s+model|model.*isn't.*available|switch\s+to\s+another/i.test(bodyText)) return true

  const modelButtons = document.querySelectorAll(
    'button[aria-label*="Model" i], button[aria-label*="模型" i], [data-testid="model-selector"]',
  )
  for (const btn of modelButtons) {
    const btnText = btn.textContent?.trim().toLowerCase() ?? ''
    if (
      btnText.includes('unsupported') ||
      btnText === '?' ||
      btnText === 'unknown' ||
      btnText === 'select model'
    ) return true
  }

  return false
}

/**
 * 激进清空所有客户端缓存（LS + SS + IDB + Cache API）。
 */
async function clearAllCache(): Promise<number> {
  let cleared = 0

  const lsCount = localStorage.length
  const ssCount = sessionStorage.length
  localStorage.clear()
  sessionStorage.clear()
  cleared += lsCount + ssCount

  try {
    const dbs = await indexedDB.databases()
    const dbNames = dbs.map(d => d.name).filter((n): n is string => !!n)
    await Promise.allSettled(
      dbNames.map(name =>
        new Promise<void>(resolve => {
          const req = indexedDB.deleteDatabase(name)
          req.onsuccess = () => resolve()
          req.onerror = () => resolve()
          req.onblocked = () => resolve()
        }),
      ),
    )
    cleared += dbNames.length
  } catch { /* ignore */ }

  try {
    if ('caches' in window) {
      const names = await caches.keys()
      for (const name of names) {
        await caches.delete(name)
        cleared++
      }
    }
  } catch { /* ignore */ }

  return cleared
}

/**
 * 延迟调度缓存检查：等页面渲染完再检测 "Unsupported model"，
 * 如果检测到就激进清缓存 + reload。
 */
function scheduleStaleCacheCheck(): void {
  if (sessionStorage.getItem(CACHE_CLEAR_FLAG)) return

  let settled = false
  let attempts = 0
  const MAX_ATTEMPTS = 10
  const BASE_DELAY_MS = 500

  async function attempt(): Promise<boolean> {
    if (settled) return true
    const len = document.body?.textContent?.length ?? 0
    if (len < 50) {
      console.log(`${LOG_PREFIX} [CACHE #${attempts}] Body too short (${len} chars), waiting...`)
      return false
    }
    if (!detectStaleModelState()) {
      console.log(`${LOG_PREFIX} [CACHE #${attempts}] Model looks healthy.`)
      return false
    }

    settled = true
    const n = await clearAllCache()
    console.log(`${LOG_PREFIX} STALE DETECTED at attempt #${attempts}. Cleared ${n} entries. Reloading...`)
    sessionStorage.setItem(CACHE_CLEAR_FLAG, '1')
    location.reload()
    return true
  }

  const observer = new MutationObserver(() => {
    if (settled) { observer.disconnect(); return }
    void attempt().then(done => { if (done) observer.disconnect() })
  })
  observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true })

  function scheduleNext() {
    if (settled || attempts >= MAX_ATTEMPTS) {
      if (!settled && attempts >= MAX_ATTEMPTS)
        console.log(`${LOG_PREFIX} Cache check timed out after ${MAX_ATTEMPTS} attempts.`)
      observer.disconnect()
      return
    }
    attempts++
    setTimeout(() => {
      void attempt().then(done => { if (done) { observer.disconnect(); return } scheduleNext() })
    }, BASE_DELAY_MS * attempts)
  }

  setTimeout(scheduleNext, 1000)
}

// ── UI 补丁 ──────────────────────────────────────────────────────────

/**
 * Claude 在扩展 iframe 里点开模型菜单时，浮层可用高度可能被压扁。
 * 给已展开的菜单强制一个可用高度。
 */
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

// ── selectors.json 实页诊断 ──────────────────────────────────────────
//
// selectors.json 是「最佳猜测」，需要在真实 Claude 页面验证每个选择器是否命中。
// 实页里打开 DevTools 控制台即可看到 [DIAG-SELECTORS] 日志，用于回填真实选择器。

const SELECTOR_DIAG_FLAG = 'chatduel-claude-selector-diag-done'

function dumpSelectorDiagnostics(): void {
  if (sessionStorage.getItem(SELECTOR_DIAG_FLAG)) return
  sessionStorage.setItem(SELECTOR_DIAG_FLAG, '1')

  const rows: string[] = []
  for (const [key, sel] of Object.entries(CLAUDE_SELECTORS)) {
    const matches = document.querySelectorAll(sel)
    const count = matches.length
    let sample = ''
    if (count > 0) {
      const first = matches[0] as HTMLElement
      sample = (first.textContent ?? '').slice(0, 40).replace(/\s+/g, ' ')
    }
    const status = count > 0 ? `OK(${count})` : 'MISSING'
    rows.push(`  ${key.padEnd(14)} ${status.padEnd(9)} sel="${sel}"${sample ? ` sample="${sample}"` : ''}`)
  }
  console.log(`${LOG_PREFIX} [DIAG-SELECTORS] selectors.json hit check:\n` + rows.join('\n'))
  console.log(`${LOG_PREFIX} [DIAG-SELECTORS] 说明：MISSING 的选择器需要按真实 Claude DOM 回填到 src/adapters/claude/selectors.json`)

  // ── 额外：dump 关键 DOM 结构（用于回填选择器）───────────────────
  try {
    const main = document.querySelector('main')
    if (!main) {
      console.warn(`${LOG_PREFIX} [DIAG-DOM] <main> element not found!`)
      return
    }

    // 找所有可能的消息容器
    const msgCandidates = Array.from(main.querySelectorAll<HTMLElement>('[data-testid], [role="article"], [class*="message"], article'))
    if (msgCandidates.length > 0) {
      const msgRows = msgCandidates.slice(-10).map(el => {
        const tag = el.tagName.toLowerCase()
        const testId = el.getAttribute('data-testid') || ''
        const role = el.getAttribute('role') || ''
        const className = (el.getAttribute('class') || '').slice(0, 60)
        const textPreview = (el.textContent || '').slice(0, 50).replace(/\s+/g, ' ')
        return `    <${tag}${testId ? ` data-testid="${testId}"` : ''}${role ? ` role="${role}"` : ''}${className ? ` class="${className}"` : ''}> "${textPreview}"`
      })
      console.log(`${LOG_PREFIX} [DIAG-DOM] Last ${msgRows.length} message-like elements in <main>:\n${msgRows.join('\n')}`)
    }

    // 找按钮（send/stop/continue）
    const buttons = Array.from(main.querySelectorAll<HTMLElement>('button[data-testid], button[aria-label]')).filter(b => {
      const label = (b.getAttribute('aria-label') || '').toLowerCase()
      return /send|stop|continue|cancel|生成|停止|继续/i.test(label) ||
             /send|stop|continue|cancel/i.test(b.getAttribute('data-testid') || '')
    })
    if (buttons.length > 0) {
      const btnRows = buttons.map(b => {
        const testId = b.getAttribute('data-testid') || ''
        const ariaLabel = b.getAttribute('aria-label') || ''
        const disabled = (b as HTMLButtonElement).disabled ? ' [DISABLED]' : ''
        return `    button${testId ? `[data-testid="${testId}"]` : ''}[aria-label="${ariaLabel}"]${disabled}`
      })
      console.log(`${LOG_PREFIX} [DIAG-DOM] Action buttons found:\n${btnRows.join('\n')}`)
    } else {
      // 列出所有 button 供参考
      const allBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).slice(0, 20)
      const allBtnRows = allBtns.map(b => {
        const testId = b.getAttribute('data-testid') || ''
        const ariaLabel = b.getAttribute('aria-label') || ''
        return `    [data-testid="${testId}"] [aria-label="${ariaLabel}"]`
      })
      console.log(`${LOG_PREFIX} [DIAG-DOM] No action buttons matched. All buttons on page (${allBtns.length}):\n${allBtnRows.join('\n')}`)
    }

    // 找输入框区域
    const inputEl = document.querySelector<HTMLElement>('[contenteditable="true"], textarea, [data-testid*="chat-input"], [data-testid*="composer"]')
    if (inputEl) {
      const tag = inputEl.tagName.toLowerCase()
      const testId = inputEl.getAttribute('data-testid') || ''
      const ce = inputEl.isContentEditable ? '[contenteditable]' : ''
      console.log(`${LOG_PREFIX} [DIAG-DOM] Input area: <${tag}${testId ? ` data-testid="${testId}"` : ''}${ce}> parent=${inputEl.parentElement?.tagName}${inputEl.parentElement?.getAttribute('class')?.slice(0, 40) || ''}`)
    }

    // body / main 文本长度（判断页面是否渲染完）
    const bodyLen = document.body?.textContent?.length ?? 0
    const mainLen = main.textContent?.length ?? 0
    console.log(`${LOG_PREFIX} [DIAG-DOM] Page render state: body=${bodyLen} chars, main=${mainLen} chars`)
  } catch (e) {
    console.warn(`${LOG_PREFIX} [DIAG-DOM] Dump failed:`, e)
  }
}

// ── 主入口 ───────────────────────────────────────────────────────────

async function boot() {
  // ═══ 阶段 A：修复 lastActiveOrg cookie（最高优先级）═══
  // 这是 "Unsupported model" 的根因——iframe 分区缺少此 cookie。
  // 如果触发了 reload，本次 boot 在这里终止，等 reload 后重新进入。
  const reloadedForOrg = await ensureLastActiveOrgCookie()
  if (reloadedForOrg) return

  console.log(`${LOG_PREFIX} Org cookie OK. Continuing init...`)

  // ═══ 阶段 B：缓存清理兜底（cookie 方案后仍有问题才触发）═══
  scheduleStaleCacheCheck()

  // ═══ 阶段 C：正常初始化 adapter + 通信 ═══
  installMenuHeightPatch()

  // post-reload 日志
  if (sessionStorage.getItem(ORG_COOKIE_RELOAD_KEY)) {
    console.log(`${LOG_PREFIX} Post-org-reload init (cookie was set in previous load)`)
  }
  if (sessionStorage.getItem(CACHE_CLEAR_FLAG)) {
    console.log(`${LOG_PREFIX} Post-cache-reload init (cache was cleared in previous load)`)
  }

  const selectorConfig = await loadSelectorConfig('claude', CLAUDE_SELECTOR_VERSION)
  const adapter = createClaudeAdapter(selectorConfig.selectors)

  // 延迟 ~3s 等 Claude 页面渲染完，再诊断 selectors.json 命中情况
  setTimeout(dumpSelectorDiagnostics, 3000)

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
      | { source?: string; action?: string; text?: string; imageDataUrl?: string; imageMime?: string; imageName?: string; diagnostics?: unknown }
      | undefined
    if (!data || data.source !== 'aichatroom-parent') return
    if (data.action !== 'write-and-send') {
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
      .then(() => adapter.sendMessage(text, file, createAdapterDiagnostics('claude', data.diagnostics, selectorConfig.version)))
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
      const file = msg.imageDataUrl
        ? dataUrlToFile(msg.imageDataUrl, msg.imageMime || 'image/png', msg.imageName || 'image.png')
        : undefined
      adapter
        .sendMessage(msg.text, file, createAdapterDiagnostics('claude', msg.diagnostics, selectorConfig.version))
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
