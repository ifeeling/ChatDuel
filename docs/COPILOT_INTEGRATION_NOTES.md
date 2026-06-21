# Copilot 接入记录

## 当前结论

2026-06-21，Copilot 已作为可选平台接入 ChatDuel 扩展，默认关闭。

当前接入范围：基础文本发送、读取最后回答、转发和总结目标选择。图片、PDF/XLSX 等附件暂不标记为自动上传。

官方入口：`https://copilot.microsoft.com/`

## 本次实现了什么

- 在 `AIPlatform`、`SUPPORTED_PLATFORMS` 和 `AI_PLATFORMS` 中加入 `copilot`。
- 在用户设置中加入 Copilot，默认关闭，并加入面板顺序。
- 在 `chat.html` 中新增 Copilot 面板和设置页站点行。
- 在 `manifest.json` 中加入 `https://copilot.microsoft.com/*` host permission 和 `copilot-content.ts` content script。
- 在 `vite.config.ts` 中加入 `content-copilot` 构建入口。
- 在 `src/background/dnr-rules.ts` 中加入 Copilot iframe 嵌入规则，规则 ID 使用 `6`。
- 在 `src/background/service-worker.ts` 中加入 Copilot 官方 tab URL 前缀识别。
- 新增 `src/adapters/copilot/adapter.ts`，复用 `src/adapters/generic/text-web-adapter.ts`。
- 新增 `src/content-scripts/copilot-content.ts`，支持：
  - `get-state`
  - `get-last-response`
  - `get-location`
  - `write-and-send`
- 在 `src/lib/remote-selector-config.ts` 中允许远程配置 Copilot 的 `inputBox`、`sendButton`、`response` 选择器。

## 当前选择器策略

Copilot 暂用通用文本网页选择器：

- 输入框：`textarea`、`[contenteditable="true"]`、`[role="textbox"]`，以及 placeholder 包含 `Message`、`Ask`、`Send` 的 textarea。
- 发送按钮：`aria-label/title/data-testid` 包含 `Send` 的按钮、`button[type="submit"]`。
- 回答内容：包含 `assistant`、`answer`、`message`、`markdown` 的节点，以及 `article`。

这些选择器是基础版兜底，后续应在真实登录后的 Copilot iframe 里验证并收窄。

## 附件上传待验证

当前平台能力：

```ts
supportsImageUpload: false
supportsFileUpload: false
```

后续做图片上传时，先在 Copilot iframe 控制台确认：

1. 是否有稳定的 `input[type=file]`。
2. 官方页面是否支持输入框内真实粘贴图片。
3. 程序化 `input.files + input/change`、paste、drop 哪一种能稳定出现附件预览。
4. 附件预览是否在 composer 附近，而不是页面其它图片或图标变化。
5. 发送后 Copilot 是否明确收到图片，而不是只收到文本。

确认前不要打开 `supportsImageUpload`，避免误报附件发送成功。

## 如果 Copilot 网页变了

优先排查：

1. iframe 是否加载 `https://copilot.microsoft.com/`。
2. content script 是否发出 `ready`。
3. `inputBox` 是否还能找到输入框。
4. `sendButton` 是否还能触发发送。
5. `response` 是否还能读到最后回答。
6. 如果只是 DOM 选择器变化，优先通过远程 selector 配置覆盖。

最可能需要改的文件：

- `src/adapters/copilot/adapter.ts`
- `src/adapters/generic/text-web-adapter.ts`
- `src/content-scripts/copilot-content.ts`
- `src/lib/remote-selector-config.ts`
- `tests/unit/text-web-adapter.test.ts`
