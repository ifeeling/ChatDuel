# 故障复盘:Gemini 发送按钮 click() 无效的解决方案

**日期**:2026-06-09
**状态**:已解决(改用派发 Enter 键盘事件)
**影响**:`src/adapters/gemini/adapter.ts` 之前所有 `btn.click()` 派发都无效
**相关文档**:`docs/postmortems/2026-06-09-iframe-no-response.md`(第一阶段故障)

---

## 1. 现象

扩展的 chat 页面跑通后,ChatGPT 链路正常,Gemini 链路卡在"发送":

- 文字"你好"成功写入了 Gemini 的 `div.ql-editor` 输入框
- 发送按钮(蓝色 ↑)变蓝(说明 React 知道文字已输入)
- 但调用 `button.submit.click()` 后,Gemini **没真的提交**,输入框文字保留
- 控制台无新错误(只有已知无害的 cross-origin focus 警告和 Gemini 内嵌登录页的 CSP 警告)

## 2. 排查过程(避免重蹈)

### 2.1 试过的失败方案

**方案 A:`btn.click()`**
```ts
const btn = document.querySelector('button.submit')
btn.click()
```
**结果**:Gemini 文字保留,不提交。

**方案 B:派发完整 PointerEvent + MouseEvent + Click 序列**
```ts
btn.dispatchEvent(new PointerEvent('pointerdown', {...}))
btn.dispatchEvent(new PointerEvent('pointerup', {...}))
btn.dispatchEvent(new MouseEvent('mousedown', {...}))
btn.dispatchEvent(new MouseEvent('mouseup', {...}))
btn.click()
```
**结果**:Gemini 文字保留,不提交。

**方案 C:找 React 18 内部 onClick 直接调**
```ts
const reactKey = Object.keys(btn).find(k => k.startsWith('__reactProps$'))
const onClick = btn[reactKey]?.onClick
onClick?.({ preventDefault: () => {}, stopPropagation: () => {} })
```
**结果**:Gemini 文字保留,不提交。

### 2.2 关键转折点:用户实测发现

用户**手动把光标定位到 Gemini 输入框后按回车,真的提交了**。这是关键的"用户反馈":

- 手动 focus + Enter → 提交 ✓
- 脚本派发 click(任何形式)→ 不提交 ✗

**结论**:Gemini 内部对 send 的监听**不是 button click 路径**,而是 **contenteditable 上的 keydown Enter 路径**(由 Quill 自己管理,不走 React 合成 click)。

### 2.3 真实根因

Gemini 的 send 按钮在 **视觉上**是 React 18 渲染的(`button.submit`),但**它的 onClick 行为**实际上由 **Quill 富文本编辑器**在 `div.ql-editor` 上的 `keydown` Enter 监听驱动。Quill 拦截 keydown Enter → 阻止默认 → 调用内部的提交函数 → 这个提交函数**顺便把 button.submit 设为激活**(作为 UI 反馈)。

**反推**:
- 派发 click → button.submit 视觉变蓝(因为 React 18 内部状态可能确实更新了)→ 但 **Quill 内部状态没同步**(没收到 keydown Enter)→ 所以**不真正提交**
- 派发 keydown Enter → Quill 立即处理 → 真正提交

**这也是为什么 ChatGPT 那边的 button.click() 有效而 Gemini 不行**:ChatGPT 用 ProseMirror/TipTap,提交完全由 React 18 的 button onClick 驱动(`btn.click()` 走的是真实 React 合成事件链路 —— 见下面"为什么 ChatGPT 行"的细节);Gemini 用 Quill,提交由 Quill 内部 keydown 驱动,**绕过 React 合成事件**。

## 3. 解决方案

**派发 `keydown` Enter 键盘事件到 `div.ql-editor`**(不是 button):

```ts
function dispatchEnterKey(el: HTMLElement): void {
  const init: KeyboardEventInit = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,        // 兼容老代码(jQuery era)
    which: 13,          // 同上
    bubbles: true,      // 冒泡到 document 上的全局监听(Quill 在 document 上挂全局 keydown)
    cancelable: true,   // Quill 可能 preventDefault
    composed: true,     // 跨 shadow DOM 边界
  }
  el.dispatchEvent(new KeyboardEvent('keydown', init))
}
```

**关键参数**:
- **`keyCode: 13` + `which: 13`**:Quill 内部代码可能用 `event.keyCode` 判断(老代码风格),`key: 'Enter'` 不够,必须三个都设
- **`bubbles: true`**:Quill 在 `document` 上挂了全局 keydown 监听,事件必须冒泡
- **`composed: true`**:跨 shadow DOM 边界(虽然 Gemini 不用 shadow DOM,但留个保险)

## 4. 为什么 ChatGPT 的 `btn.click()` 能工作

ChatGPT 用 ProseMirror/TipTap,提交流程:

1. 用户在 `#prompt-textarea`(contenteditable div)输入文字
2. ProseMirror 通过 input 事件监听 DOM 变化 → 同步内部 state
3. 用户点击 `button[data-testid='send-button']` → React 18 派发合成 onClick → ProseMirror 调内部提交函数

**关键**:`btn.click()` 派发的是**原生 click 事件**,Chrome 浏览器会把它**冒泡到 document**,React 18 在 document 上有事件委托,会**接收**这个原生 click 并**派发对应的 React 合成事件**。`btn.click()` 派发的事件 `isTrusted: false`,但**React 18 的事件委托对 isTrusted 不做强制检查**(只对 input/change 等需要 isTrusted 的事件才检查)。

所以 ChatGPT 的 button.click() **侥幸**能跑通 —— 它依赖的是 React 18 的全局事件委托 + 对 click 事件不严格 isTrusted 检查。

**Gemini 不一样**:Gemini 的 button click **不直接调提交函数**;它只是 UI 反馈。**真正提交由 Quill 监听 keydown Enter 触发**,这条路完全不经过 React 合成事件。

## 5. 给后来人的提示(写给其他 AI 或开发者)

### 5.1 选 send 触发方式的判断流程

```
1. 找到 send 按钮:document.querySelector('button.submit') 或 [aria-label*='Send']
2. 找到输入框:document.querySelector('.ql-editor') 或 #prompt-textarea
3. 试派发 button.click()
4. 试派发完整 PointerEvent 序列
5. 找 React fiber 直接调 onClick
6. (以上都不行?) 试派发 keydown Enter 到输入框 ← Gemini 走这条
7. 还不行?在 iframe 里手动截图对比,看哪条路径在原生 DevTools console 跑有效
```

### 5.2 重要:必须"实测派发"而不能"看代码猜"

**不能**因为"Gemini 是 Google 的现代页面,所以 click 派发应该有效"。**必须**在真实页面上用 DevTools console 跑:

```js
// 1. 先确认 button 存在
const btn = document.querySelector('button.submit')
console.log('button:', btn)

// 2. 直接 click 看效果
btn.click()
// → 不动就说明 click 路径不是真正提交

// 3. 试 keydown
const editor = document.querySelector('.ql-editor')
editor.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', keyCode: 13, bubbles: true}))
// → 提交了就说明走 keydown
```

**这个实测**只能用真人 Chrome + DevTools console,自动化测试(Playwright)也跑不出 Quill 内部状态同步的微妙行为。

### 5.3 类似的 Quill/ProseMirror 站点(可作为 v2/v3 扩展时的参考)

| 站点 | 编辑器 | send 监听路径 | 备注 |
|---|---|---|---|
| gemini.google.com | Quill | ql-editor keydown Enter | **本项目已验证** |
| chatgpt.com | ProseMirror/TipTap | button.click() 即可 | **本项目已验证** |
| claude.ai | ProseMirror | 大概率 keydown Enter(同 Gemini) | v2 验证 |
| grok.com | 未知 | 需实测 | v2 验证 |
| chat.deepseek.com | 自研 | 大概率 button.click | v2 验证 |

## 6. 后续(可能需要的小优化)

- [ ] 把 send 按钮派发逻辑封装成可复用的 `sendViaEnter(el)` / `sendViaClick(btn)`,供 v2 多平台扩展用
- [ ] 写一个 adapter 单元测试,模拟 contenteditable + keydown 事件(用 jsdom 不能完整跑 Quill 内部,但可以验证事件参数)
- [ ] 当 Gemini 改版时(Quill 升级或换成 ProseMirror),需要重新实测;但本经验贴出了判断流程,5 分钟能定位

## 7. 与第一阶段故障复盘的关系

第一阶段(DNR urlFilter 错误 + 跨源 focus)修复了"iframe 嵌入 + content script 注入 + content script 调 adapter"这条**主链路**。

本阶段(本文件)修复的是"adapter 调 Gemini 真实 DOM 的 send 动作"这条**适配层链路**。

两层独立,不要混淆。第一阶段的根因是 `declarativeNetRequest` 规则没生效,本阶段的根因是 React 18/Quill 的 click 派发防线。

---

**关键代码位置**:`src/adapters/gemini/adapter.ts` 的 `triggerSend()` 函数。
