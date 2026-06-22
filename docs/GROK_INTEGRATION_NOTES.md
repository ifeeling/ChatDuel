# Grok 接入归档记录

## 当前结论

2026-06-22，Grok 接入暂时从当前主线移除。原因是用户侧优先级调整：Grok 网页端聊天使用占比暂时较低，当前阶段只继续保留 DeepSeek 接入优化。

如果以后要恢复 Grok 接入，请先查看 GitHub tag：

`copilot-grok-wip-2026-06-22`

该 tag 保留了 2026-06-21 的实验实现，包括基础文本发送、读取最后回答、转发和总结目标选择。图片、PDF/XLSX 等附件当时未标记为自动上传。

官方入口：`https://grok.com/`

## 归档版本实现了什么

- 在 `AIPlatform`、`SUPPORTED_PLATFORMS` 和 `AI_PLATFORMS` 中加入 `grok`。
- 在用户设置中加入 Grok，默认关闭，并加入面板顺序。
- 在 `chat.html` 中新增 Grok 面板和设置页站点行。
- 在 `manifest.json` 中加入 `https://grok.com/*` host permission 和 `grok-content.ts` content script。
- 在 `vite.config.ts` 中加入 `content-grok` 构建入口。
- 在 `src/background/dnr-rules.ts` 中加入 Grok iframe 嵌入规则，规则 ID 使用 `7`。
- 在 `src/background/service-worker.ts` 中加入 Grok 官方 tab URL 前缀识别。
- 新增 `src/adapters/grok/adapter.ts`，复用 `src/adapters/generic/text-web-adapter.ts`。
- 新增 `src/content-scripts/grok-content.ts`，支持：
  - `get-state`
  - `get-last-response`
  - `get-location`
  - `write-and-send`
- 在 `src/lib/remote-selector-config.ts` 中允许远程配置 Grok 的 `inputBox`、`sendButton`、`response` 选择器。

## 当前选择器策略

Grok 暂用通用文本网页选择器：

- 输入框：`textarea`、`[contenteditable="true"]`、`[role="textbox"]`，以及 placeholder 包含 `Message`、`Ask`、`Send` 的 textarea。
- 发送按钮：`aria-label/title/data-testid` 包含 `Send` 的按钮、`button[type="submit"]`。
- 回答内容：包含 `assistant`、`answer`、`message`、`markdown` 的节点，以及 `article`。

这些选择器是基础版兜底，后续应在真实登录后的 Grok iframe 里验证并收窄。

## 2026-06-21 文本发送假成功问题

用户实测时，Grok iframe 已加载，控制台显示：

```text
[AIChatRoom chat] ready: grok
[AIChatRoom chat] write-and-send result for grok: ok=true error=
```

但官方 Grok 页面仍停在输入区，没有出现用户消息，也没有开始回答。

根因判断：

- 旧通用 adapter 对 `contenteditable` / `role="textbox"` 只设置 `textContent` 并派发 `input` 事件。
- Grok 这类 React 输入框不一定把直接改 DOM 当成真实用户输入。
- `chat.ts` 旧逻辑还有一个 8 秒兜底：iframe 没回 result 也算 `ok=true`，这会把失败包装成“已发送，等待回答”。

修正：

- `src/adapters/generic/text-web-adapter.ts` 对非 textarea 输入框先 `focus()`，再优先走 `document.execCommand('insertText')`，更接近手动输入。
- 对 contenteditable 写入后补发 `input` 和 `change` 事件，和 ChatBrawl 的 Grok 注入脚本行为保持一致。
- `src/adapters/grok/adapter.ts` 按 ChatBrawl 可工作路径收窄选择器：
  - 输入框优先 `textarea[aria-label]`，其次 `div[contenteditable="true"]`。
  - 发送按钮优先 `button[type="submit"]`，避免误点附件、模型、语音等其它按钮。
- `sendMessage()` 现在会做两次确认：
  - 写入后，输入框必须真的包含待发送文本。
  - 点击发送后，输入框必须清掉这段文本；否则抛出“发送后没有确认”。
- `src/chat/chat.ts` 去掉“没收到 result 也算成功”的兜底。超时或 adapter 报错都算发送失败。
- 新增/更新 `tests/unit/text-web-adapter.test.ts` 覆盖：
  - contenteditable 使用 `insertText`。
  - contenteditable 写入后派发 `change`。
  - Grok 优先点击 `button[type="submit"]`，不会点到附件按钮。
  - 输入框内容没有清掉时不再返回成功。

后续如果 Grok 文本发送又坏了，先看这三处：

1. 输入框是不是还能被 `inputBox` 选择器找到。
2. `document.execCommand('insertText')` 后输入框内容是否真的变化。
3. 点击发送后输入框是否清空；如果 Grok 改成“发送时输入框不清空”，需要换成“出现用户气泡/发送中状态”的确认条件。

## 附件上传待验证

当前平台能力：

```ts
supportsImageUpload: false
supportsFileUpload: false
```

后续做图片上传时，先在 Grok iframe 控制台确认：

1. 是否有稳定的 `input[type=file]`。
2. 官方页面是否支持输入框内真实粘贴图片。
3. 程序化 `input.files + input/change`、paste、drop 哪一种能稳定出现附件预览。
4. 附件预览是否在 composer 附近，而不是页面其它图片或图标变化。
5. 发送后 Grok 是否明确收到图片，而不是只收到文本。

确认前不要打开 `supportsImageUpload`，避免误报附件发送成功。

## 如果 Grok 网页变了

优先排查：

1. iframe 是否加载 `https://grok.com/`。
2. content script 是否发出 `ready`。
3. `inputBox` 是否还能找到输入框。
4. `sendButton` 是否还能触发发送。
5. `response` 是否还能读到最后回答。
6. 如果只是 DOM 选择器变化，优先通过远程 selector 配置覆盖。

最可能需要改的文件：

- `src/adapters/grok/adapter.ts`
- `src/adapters/generic/text-web-adapter.ts`
- `src/content-scripts/grok-content.ts`
- `src/lib/remote-selector-config.ts`
- `tests/unit/text-web-adapter.test.ts`
