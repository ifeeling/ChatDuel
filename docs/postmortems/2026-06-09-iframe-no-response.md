# 故障复盘:Chat 页面 iframe 嵌入后"输入内容无反应"

**日期**:2026-06-09
**状态**:已定位根因,待修复
**影响**:扩展 `dist-chat-page/` 产物在 Chrome 中加载后,iframe 内的 ChatGPT/Gemini 页面无法成功嵌入,导致 content script 无法注入,发送链路彻底失败
**相关文档**:`docs/superpowers/specs/2026-06-08-chat-page-iframe-design.md`、`docs/superpowers/plans/2026-06-08-chat-page-iframe-impl.md`

---

## 1. 现象

用户在 Chrome 中加载 `dist-chat-page/` 产物(从工具栏图标点开 → `src/chat/chat.html`),看到:

- 顶部状态条显示 "ChatGPT: 已打开" "Gemini: 已打开"(`enable-embed-rules` 的 `sendResponse` 返回 `{ok:true}`)
- 底部输入框输入文字,点发送按钮 → **无任何反应**(输入框文字清空,但两侧 iframe 内的官方页面无变化)
- DevTools Console 报错:
  - `Framing 'https://accounts.google.com/' violates the following Content Security Policy directive: "frame-ancestors https://gemini.google.com". The request has been blocked.`
  - `Blocked autofocusing on a <textarea> element in a cross-origin subframe.`(来源 `chatgpt.com`)
  - `Uncaught (in promise) Error: Seroval Error (step: 1)`(来源 `accounts.google.com`)
- ChatGPT iframe 显示为一片黑;Gemini iframe 仅显示登录态/账号选择,没有 chat 主界面

## 2. 排查路径(避免后人重蹈)

### 2.1 第一次错误判断:"content script 不会注入到扩展页面嵌的 iframe"

排查时**先入为主**地认为 `content_scripts` 在 `chrome-extension://xxx/chat.html` 的 iframe 子 frame 上不会注入,因此推断"必须改用 `webNavigation` + `chrome.scripting` 编程式注入"。

**真实情况**:`content_scripts` 在 `manifest.json` 配 `matches: ["https://chatgpt.com/*"]` + `all_frames: true` 时,**Chrome MV3 会注入到任意匹配 URL 的子 frame**,包括由扩展页面(`chrome-extension://`)嵌入的 `<iframe src="https://chatgpt.com/">`。这跟 ChatBrawl 用的 `webNavigation + chrome.scripting` 是**两条等价可达的路径**,不是互斥。

> ChatBrawl 选择 `chrome.scripting` 的原因不是为了"能注入",而是因为它要在 `host_permissions: ["<all_urls>"]` 下向"任何 https 页面"注入工具栏按钮(浮动引用按钮等),通用性更强;我们这个项目**只注入到 chatgpt.com/gemini.google.com 两个站**,用 `content_scripts` 完全够用,更简单。

### 2.2 真实根因(已通过代码对照确认)

`dist-chat-page/` 里的 Service Worker 试图注册 `declarativeNetRequest` 规则来剥离 `X-Frame-Options` 和改写 CSP `frame-ancestors`,**但 urlFilter 用了 `||chatgpt.com^` / `||gemini.google.com^`**。

**问题**:`||` 和 `^` 是 `declarativeNetRequest` 用于 `block` / `redirect` / `upgradeScheme` 等**行为类动作**的专用 URL 匹配语法(Chrome 内部用 Google 的 URLPattern 库解析)。但**当动作类型是 `modifyHeaders` 时,`urlFilter` 字段只接受"普通子串匹配"**,不接受 `||` 和 `^` 这种模式语法。

证据:
- `dist-chat-page/assets/service-worker-BnjOa-Hm.js` 源码:
  ```js
  const m = (e, a) => ({
    id: e, priority: 1,
    condition: { urlFilter: a, resourceTypes: ["main_frame", "sub_frame"] },
    action: { type: "modifyHeaders", responseHeaders: [
      { header: "Content-Security-Policy", operation: "set",
        value: "frame-ancestors 'self' chrome-extension://*" },
      { header: "X-Frame-Options", operation: "remove" }
    ]}
  });
  // 调用:
  addRules: [m(o.chatgpt, "||chatgpt.com^"), m(o.gemini, "||gemini.google.com^")]
  ```
- `chrome.declarativeNetRequest.updateDynamicRules` 在这个 urlFilter 下会**直接抛 `Invalid urlFilter`** 异常
- SW 里这段被 `try { await p() } catch(t) { console.error(t) }` 吞了,所以**控制台没明显报错**(除非手动展开 Service Worker 控制台)
- 规则注册失败 → 后续 `enable-embed-rules` 仍然 `sendResponse({ok: true})` 误导调用方 → iframe 嵌入失败 → content script 没法注入 → 发送链路断

### 2.3 副根因:子 frame 不能 focus() textarea

`adapter.writeText` 第一句是 `e.focus()`,但 iframe 内的 chatgpt.com 与父页 `chrome-extension://.../chat.html` **跨源**,Chrome 默认拒绝**对跨源子 frame 的 textarea 主动 focus**(就是 Console 里那条 `Blocked autofocusing on a <textarea> element in a cross-origin subframe`)。

**这个报错其实不是 content script 注入成功后的失败**,而是 iframe 内官方页面自身的 JS 报出来的(chatgpt.com 自己的某个组件尝试聚焦 textarea)。但**它暗示了 content script 的 writeText 路径很可能也走不通**(同样会被同源策略拒绝)。

正确的写法是**不调 focus()**,直接通过 `Object.getOwnPropertyDescriptor` 拿 `value`/`textContent` 的原生 setter 把字符串灌进去,然后 `dispatchEvent(new InputEvent('input', {bubbles: true}))` 触发框架内部的状态更新。这是 React 受控组件(ChatGPT/Gemini 用的都是)必须的"绕过 React 状态"的标准做法。

## 3. 修复方案

### 3.1 改用 `urlFilter` 普通子串(优先)或 `regexFilter`

```ts
// 错:declarativeNetRequest 专用语法,modifyHeaders 不认
{ urlFilter: '||chatgpt.com^' }

// 对:普通子串匹配
{ urlFilter: 'chatgpt.com' }

// 也对:正则(转义需要双反斜杠)
{ regexFilter: '^https://[^/]*chatgpt\\.com/' }
```

**建议用 `urlFilter: 'chatgpt.com'`** —— ChatBrawl 0.7.2 的实际源码正是这样写的(我们 `dist-chat-page/` 是之前手动抄错的版本):

```js
// ChatBrawl 0.7.2 background.js 真实写法
{ id: 1000+, priority: 1, action: { type: "modifyHeaders", responseHeaders: [...] },
  condition: { urlFilter: t, resourceTypes: ["sub_frame"] } }
// 其中 t = "chatgpt.com" / "gemini.google.com" 等普通子串
```

> 注意 ChatBrawl 只配 `resourceTypes: ["sub_frame"]`;`main_frame` 不需要(用户手动打开 chatgpt.com 标签页时不需要改响应头)。但配 `sub_frame` + `main_frame` 也无害,可读性更好。

### 3.2 改 adapter.writeText,去掉 focus() + 走原生 setter

```ts
// 适配器改写:不再 focus,改走原生 setter 注入值
async function writeText(el: HTMLElement, text: string) {
  const proto = Object.getPrototypeOf(el)
  const desc = 'value' in el
    ? Object.getOwnPropertyDescriptor(proto, 'value')
    : Object.getOwnPropertyDescriptor(proto, 'textContent')
  desc?.set?.call(el, text)
  el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }))
}
```

### 3.3 修复后验证步骤

1. `npm run build` 生成新的 `dist/`
2. Chrome 加载 `dist/`,打开 `chrome://extensions` → "Service Worker" 链接进入 SW 控制台
3. 刷新扩展,在 SW 控制台跑 `chrome.declarativeNetRequest.getDynamicRules()`,应返回 2 条 modifyHeaders 规则(id 1 和 2)
4. 点工具栏图标打开 chat 页面
5. 验证两个 iframe 内**真的显示了** ChatGPT/Gemini 官方主界面(不是空白,不是登录页)
6. 顶部状态条显示绿色 dot
7. 在底部输入框输入"你好"点发送 → 两侧 iframe 内都出现用户消息
8. 关闭 chat tab → 回到 SW 控制台再跑 `getDynamicRules()`,应返回 `[]`

## 4. 容易踩的坑(写给后来人)

| 坑 | 原因 | 规避方法 |
|----|------|----------|
| `declarativeNetRequest` 的 urlFilter 在 `modifyHeaders` 动作下不接受 `||`、`^`、`*` 等专用语法 | 这些语法是 block/redirect 类动作的;modifyHeaders 只认普通子串 | urlFilter 写裸域名/裸路径;复杂匹配用 `regexFilter`(注意双反斜杠) |
| iframe 子 frame 不能 `el.focus()` 跨源 | Chrome 隐私策略,防止扩展偷偷抢焦点 | 写值用原生 setter + dispatchEvent,不要 focus |
| `try { } catch {}` 吞错导致"看起来成功实际失败" | SW 里 `enable-embed-rules` 的 try/catch 静默失败 | 关键规则注册后必须 `console.log` 成功 + getDynamicRules 验证 |
| 以为是 `content_scripts` 不注入,实际是 iframe 根本没嵌进去 | 控制台只看到 CSP/X-Frame 报错,没有 "content script loaded" | 排查顺序:①iframe 真的嵌进去了吗? ②content script 真的注入了? ③adapter 真的能操作 DOM? |
| ChatBrawl 的 `webNavigation + chrome.scripting` 看起来更"高级",其实只是因为它要在 `<all_urls>` 下注入 | 跟 `content_scripts` 不是互斥;只注入两站用 content_scripts 即可 | 别盲目照搬 ChatBrawl 的"高级"路径,先看自己的 host_permissions 和使用范围 |

## 5. 待办(把这次经验沉淀到 spec)

- [ ] 在 `docs/superpowers/specs/2026-06-08-chat-page-iframe-design.md` 的 §3.2 `DNR 规则` 章节**加粗红字**写明 urlFilter 在 modifyHeaders 动作下的正确语法,并显式给出反例
- [ ] 在同一份 spec 的 §4 风险表里加一行"urlFilter 语法误用,导致规则静默失败"
- [ ] 在 `src/background/dnr-rules.ts`(新建)的实现注里写明这条限制
- [ ] 给 `adapter.writeText` 写一条单测,确保不调 focus 也能写入 + 触发 input 事件
