# 参考研究:ChatBrawl 0.7.2 扩展架构拆解

**日期**:2026-06-09
**目的**:理解 ChatBrawl "多 AI 一键对比" 扩展是怎么实现"在扩展页面里 iframe 嵌入官方 AI 页面并直接发送消息"的,作为本项目设计参考
**来源**:本地 Chrome 扩展目录 `~/Library/Application Support/Google/Chrome/Default/Extensions/daeejbkgpkoagacncliemiienmlnclmj/0.7.2_0/`
**关键文件**:`manifest.json`、`background.js`、`config.js`、`injection/common/iframe.js`、`injection/ChatGPT.js`、`injection/Gemini.js`、`chatbrawl.html`、`chatbrawl.js`

---

## 1. 整体架构

```
chrome-extension://<chatbrawl-id>/
  ├── chatbrawl.html              ← 全屏主页面(暗色,左/中/右三栏 iframe)
  ├── chatbrawl.js                ← 主逻辑:iframe 加载、状态同步、@mention 输入框、发送分发
  ├── background.js               ← SW:DNR 规则 + webNavigation 监听 + 注入调度
  ├── config.js                   ← SUPPORTED_SITES 配置表(每个站对应 injection/XXX.js)
  ├── injection/                  ← 注入到官方 AI 页面里运行的脚本
  │   ├── common/iframe.js        ← 通用桥(浮动引用按钮、URL 变化监听)
  │   ├── ChatGPT.js / Gemini.js / Claude.js / ... ← 每个站点一份适配
  │   └── <Site>.css
  └── assets/icons/sites/         ← 各站图标
```

**核心特点**:
- 一个"主页面" `chatbrawl.html`,内嵌 N 个 iframe(用户配置启用的站)
- 每个 iframe 用 `declarativeNetRequest` 改写响应头让官方页面允许被嵌
- 每个 iframe 子 frame 里**主动注入**一个 `injection/<Site>.js`,监听 `window.message`,接收父页指令
- 父页 `chatbrawl.js` 通过 `iframe.contentWindow.postMessage` 给每个 iframe 发指令
- 不需要 popup,工具栏点图标 → 新开 tab 到 `chatbrawl.html`

## 2. manifest.json 关键点

```json
{
  "action": { "default_icon": { "48": "..." } },     // 没 default_popup
  "background": { "service_worker": "background.js", "type": "module" },
  "host_permissions": [
    "https://chatgpt.com/*",
    "https://chat.deepseek.com/*",
    "...",
    "https://*/*",                                   // 关键:还要 <all_urls>
    "http://*/*",
    "<all_urls>"                                     // 关键
  ],
  "permissions": ["activeTab", "storage", "declarativeNetRequest",
                  "webNavigation", "scripting"],     // 关键
  "web_accessible_resources": [{
    "matches": ["<all_urls>"],
    "resources": ["chatbrawl.html", "chatbrawl.js", "config.js",
                  "assets/icons/sites/*", "pages/feedback.html"]
  }]
}
```

**`web_accessible_resources` 范围是 `<all_urls>`**:允许在任意 https/http 页面访问扩展资源(让 webNavigation 注入的脚本可以加载 CSS 等)。

**没有声明式 `content_scripts`**:完全靠编程式注入。

## 3. background.js 关键流程

### 3.1 启动时注册 DNR 规则(永久)

```js
async function updateMyDynamicRules() {
  const removeIds = (await chrome.declarativeNetRequest.getDynamicRules()).map(r => r.id)
  const addRules = SUPPORTED_SITES.reduce((acc, site) => {
    (site.urlFilters ?? []).forEach(filter => {
      acc.push({
        id: nextAvailableRuleId++,
        priority: 1,
        action: {
          type: "modifyHeaders",
          responseHeaders: [
            { header: "Content-Security-Policy", operation: "set",
              value: "frame-ancestors 'self' chrome-extension://*" },
            { header: "X-Frame-Options", operation: "remove" }
          ]
        },
        condition: { urlFilter: filter, resourceTypes: ["sub_frame"] }
      })
    })
    return acc
  }, [])
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds, addRules })
}
updateMyDynamicRules()  // 启动即调用
```

**关键点**:
- **`urlFilter` 是普通子串**(e.g. `"chatgpt.com"`、`"grok.com/*"`),**不用 `||...^` 语法**。见 `config.js` 里的 `urlFilters` 都是普通字符串。
- `resourceTypes: ["sub_frame"]` —— 只对子 frame(即 iframe 内部)改写,不污染主框架
- 启动即注册,规则永久生效(不像我们之前 spec 计划那样"按需启用"——更激进)

### 3.2 工具栏图标 → 新开主页面 tab

```js
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("chatbrawl.html") })
})
```

注意: `action` 没有 `default_popup`,所以点图标会触发 `onClicked`(Chrome 行为)。

### 3.3 webNavigation.onCommitted 注入子 frame(最关键的步骤)

```js
chrome.webNavigation.onCommitted.addListener(async (e) => {
  if (!e || e.frameId === 0) return console.log("当前页面不支持注入", e)
  const chatbrawlTabIds = (await chrome.storage.local.get(["chatbrawlTabIds"])).chatbrawlTabIds ?? []
  if (!chatbrawlTabIds.includes(e.tabId)) return console.log("当前页面不支持注入", e, chatbrawlTabIds)
  const site = SUPPORTED_SITES.filter(s => s.urlFilters).find(s => e.url.startsWith(s.url))
  if (!site) return console.log(`Site not supported Injection: ${e.url}`)

  console.log(`Injection start for ${e.frameId}, ${e.url}, ${site.name}, ${site.injectionScript}`)
  const cssFiles = await getExistingFiles(["injection/common/iframe.css", site.injectionStyle])
  cssFiles.length > 0 && chrome.scripting.insertCSS({
    target: { tabId: e.tabId, frameIds: [e.frameId] },
    files: cssFiles
  }).catch(t => console.log(`Injection css failed for ${e.url}:`, t))

  const jsFiles = await getExistingFiles(["injection/common/iframe.js", site.injectionScript])
  jsFiles.length > 0 && chrome.scripting.executeScript({
    target: { tabId: e.tabId, frameIds: [e.frameId] },
    files: jsFiles
  }).catch(t => console.log(`Injection js failed for ${e.url}:`, t))
}, { url: [{ urlMatches: "https://*/*" }] })
```

**这段是 ChatBrawl 整套机制的核心**:

1. `webNavigation.onCommitted` 监听**任意 https 页面的任意 frame 提交**(`urlMatches: "https://*/*"`,`frameId` 包括 0 和非 0)
2. **过滤**:
   - `frameId === 0`(顶层 frame)跳过 —— 只注入子 frame(即 iframe 内)
   - `e.tabId` 必须在 `chatbrawlTabIds` 列表里(`chatbrawlTabIds` 记录"哪些 tab 是 ChatBrawl 自己的主页 tab")—— 避免给用户普通浏览的 chatgpt.com tab 注入
   - `e.url` 命中 `SUPPORTED_SITES` 里的某站(用 `url.startsWith(site.url)` 匹配)—— 只给支持的站注入
3. 注入两步:
   - 先 `chrome.scripting.insertCSS({ target: { tabId, frameIds: [e.frameId] }, files: [...] })` 注入 CSS
   - 再 `chrome.scripting.executeScript({ target: { tabId, frameIds: [e.frameId] }, files: [...] })` 注入 JS
4. `target.frameIds: [e.frameId]` 精确锁定到那一个子 frame

**这就是为什么 ChatBrawl 能用"编程式注入"代替"声明式 content_scripts"** —— `chrome.scripting` 配合 `frameIds` 可以精确注入到任意子 frame,前提是 `host_permissions` 有 `<all_urls>`。

### 3.4 chatbrawlTabIds 维护

```js
// 1. 安装时打开
chrome.runtime.onInstalled.addListener(async (e) => {
  if (e.reason === "install") {
    await chrome.storage.local.set({ firstInstall: true })
    openChatBrawlPage()  // 新建 tab 到 chatbrawl.html,同时把 tabId 存到 chatbrawlTabIds
    ...
  }
})

// 2. 工具栏点图标
chrome.action.onClicked.addListener(() => openChatBrawlPage())
function openChatBrawlPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL("chatbrawl.html") }, (tab) => {
    chrome.storage.local.get("chatbrawlTabIds", (t) => {
      const ids = new Set(t.chatbrawlTabIds ?? [])
      ids.add(tab.id)
      chrome.storage.local.set({ chatbrawlTabIds: [...ids] })
    })
  })
}

// 3. tab 关闭
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get("chatbrawlTabIds", (t) => {
    const ids = new Set(t.chatbrawlTabIds ?? [])
    if (ids.has(tabId)) { ids.delete(tabId); chrome.storage.local.set({ chatbrawlTabIds: [...ids] }) }
  })
})

// 4. tab 刷新/导航(以防 tabId 重用时 chatbrawlTabIds 残留)
chrome.webNavigation.onCommitted.addListener((e) => {
  if (e.url === chrome.runtime.getURL("chatbrawl.html")) {
    chrome.storage.local.get("chatbrawlTabIds", (t) => {
      const ids = new Set(t.chatbrawlTabIds ?? [])
      ids.add(e.tabId)
      chrome.storage.local.set({ chatbrawlTabIds: [...ids] })
    })
  }
})
```

## 4. 注入到子 frame 里的脚本:injection/ChatGPT.js

```js
!function() {
  "use strict"
  console.log("ChatGPT.js page loaded")
  // 通知父页 iframe 已加载
  window.parent.postMessage({ type: "IFRAME_LOADED", title: document.title }, "*")

  // 接收父页指令
  const handlers = {
    CHAT_MESSAGE: async (data) => {
      // 切换 tools(思考模式/网络搜索)
      if (data.config.deepSearch) await toggleTool("deepSearch", data.config.deepSearch)
      else if (data.config.thinking) await toggleTool("thinking", data.config.thinking)
      else if (data.config.webSearch) await toggleTool("webSearch", data.config.webSearch)
      // 写输入框
      const input = document.querySelector("#prompt-textarea")
      if (input) {
        input.textContent = data.message
        setTimeout(() => {
          const sendBtn = document.querySelector('button[data-testid="send-button"]')
          sendBtn ? sendBtn.click() : console.log("Send button not found")
        }, 100)
      } else console.log("Chat input not found")
    },
    NEW_CHAT: (data) => {
      const btn = document.querySelector('[data-testid="create-new-chat-button"]') ?? ...
      btn?.click()
    },
    SYNC_SESSION: (data) => {
      window.siteItem = { ...data.message, siteName: data.config.siteId }
    }
  }
  window.addEventListener("message", (e) => {
    if (!e.data) return
    const { type, message, config } = e.data
    if (!type) return
    const handler = handlers[type] ?? (() => console.log(`No handler: ${type}`))
    try { handler(e.data) } catch (e) { console.log("Error processing:", e) }
  })
}()
```

**关键点**:
- **走原生 setter 写值**(`input.textContent = data.message`),不调 `focus()`(因为跨源子 frame 不能 focus 跨源 textarea)
- 用 `setTimeout(..., 100)` 等 React 状态更新后**点真实的 send button**(`button[data-testid="send-button"]`),不调 Enter 键盘事件
- 通过 `window.parent.postMessage` 和 `window.addEventListener("message")` 跟父页通信,协议是 `{ type: "CHAT_MESSAGE" | "NEW_CHAT" | ..., message, config }`

## 5. 注入到子 frame 里的通用脚本:injection/common/iframe.js

```js
!function() {
  "use strict"
  // 浮动引用按钮:用户选中文本后,在选区下方显示"引用"按钮
  const debouncedShowQuote = debounce(() => {
    const sel = window.getSelection()
    const text = sel?.toString().trim()
    if (!text || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    const btn = createQuoteButton(range.getBoundingClientRect(), text)
    document.body.appendChild(btn)
  }, 200)
  document.addEventListener("mouseup", debouncedShowQuote)
  document.addEventListener("touchend", debouncedShowQuote)

  // URL 变化监听(SPA 路由):history 不变时用 setInterval 兜底
  let lastHref = location.href
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href
      window.siteItem && (window.siteItem.url = lastHref)
      window.parent.postMessage({ type: "UPDATE_HISTORY", payload: { siteItem: window.siteItem } }, "*")
    }
  }, 500)
}()
```

**关键点**:
- 通用桥,所有站都用
- "引用"按钮:用户选中文本 → 出现浮动按钮 → 点击 → `window.parent.postMessage({ type: "QUOTE_TEXT", payload: text }, "*")` 通知父页
- URL 变化监听:用 500ms 轮询,弥补 `popstate` 事件在 SPA 下不稳定

## 6. 父页 chatbrawl.js 关键逻辑(摘录)

### 6.1 postMessage 派发

```js
function sendMessageToAllIframe(type, payload) {
  document.querySelectorAll("iframe").forEach(f => {
    f.contentWindow?.postMessage({ type, ...payload }, "*")
  })
}
function sendMessageToTargetIframes(targets, type, payload) {
  document.querySelectorAll("iframe").forEach(f => {
    if (targets.includes(f.getAttribute("name"))) {
      f.contentWindow?.postMessage({ type, ...payload }, "*")
    }
  })
}
```

### 6.2 接收子 frame 消息

```js
window.addEventListener("message", (e) => {
  if (e.data?.type === "FROM_IFRAME") {
    console.log("Received Message from iframe:", e.data)
  }
  if (e.data?.type === "QUOTE_TEXT") {
    const text = e.data.payload
    const input = document.getElementById("prompt-input")
    input.innerText = text
    input.dispatchEvent(new Event("input", { bubbles: true }))
    setTimeout(() => {
      input.focus()
      const range = document.createRange()
      const sel = window.getSelection()
      range.selectNodeContents(input)
      range.collapse(false)
      sel.removeAllRanges()
      sel.addRange(range)
    }, 10)
  }
  if (e.data?.type === "UPDATE_HISTORY") {
    const siteItem = e.data.payload.siteItem
    recordHistory(null, { [siteItem.siteName]: siteItem.url })
  }
})
```

### 6.3 @mention 输入解析(发送前先看用户有没有 @指定平台)

```js
// 在 #prompt-input 的 keyup 监听里,检测光标前面是否有 @
// 用 window.getSelection() 拿 caret offset
// 用 i() 函数拿到当前激活的 iframe 列表
// 弹下拉菜单让用户选平台(1-9 数字键也能选)
```

## 7. 总结:本项目能借鉴什么、不必借鉴什么

| ChatBrawl 做法 | 我们的对应 | 建议 |
|---|---|---|
| `<all_urls>` host_permission | `host_permissions: ["https://chatgpt.com/*", "https://gemini.google.com/*"]` | **不必**加 `<all_urls>`(权限越少越安全,Chrome Store 审核也更友好),用 `content_scripts` 即可 |
| 启动即注册 DNR 规则(永久) | "按需启用"(spec 计划) | 沿用按需启用(更保守,ChatBrawl 是为了 2000 用户已稳定才敢永久) |
| `webNavigation` + `chrome.scripting.executeScript` 编程式注入 | `content_scripts` 声明式注入 + `all_frames: true` | **用 content_scripts 即可**——我们只注入两站,编程式注入是过度设计;前提是 `all_frames: true` |
| 每个站一份 `injection/<Site>.js` | `src/content-scripts/{chatgpt-content,gemini-content}.ts` | 沿用(已经存在) |
| `chatbrawl.html` 全屏主页面 | `src/chat/chat.html` 全屏主页面 | 沿用 |
| postMessage `IFRAME_LOADED` / `CHAT_MESSAGE` / `NEW_CHAT` | `IFRAME_LOADED` / `write-and-send` | 沿用 `IFRAME_LOADED` + `write-and-send`,命名更简洁 |
| `chatbrawlTabIds` 维护注入白名单 | 不需要(content_scripts 本身就只对 matches 注入) | 跳过,少一个状态 |
| DNR 规则 `urlFilter: "chatgpt.com"`(普通子串) | `urlFilter: "||chatgpt.com^"`(误用语法) | **必须改**:见 `2026-06-09-iframe-no-response.md` 第 2.2 节 |
| adapter 调 `el.focus()` 然后写 `value` | 同 | **必须改**:跨源子 frame focus 会被拒,改走原生 setter |
| `siteItem` 模式(每个 iframe 持有自己的 sessionItem,URL 变化时上报) | 不需要 v1 | 跳过 |

## 8. 沉淀到本项目的建议

1. **保留 `content_scripts` 路线**,不引入 `webNavigation + chrome.scripting`(过度设计)
2. **DNR 规则用普通子串 urlFilter**(`"chatgpt.com"`,**不是** `"||chatgpt.com^"`)
3. **content script 的 writeText 不调 focus**,走原生 setter
4. **`host_permissions` 保持两站**,不引入 `<all_urls>`
5. **DNR 规则按需启用**(spec 原计划不变),不永久启用
6. **postMessage 协议保留** `IFRAME_LOADED` 和 `write-and-send`,命名跟之前一致
