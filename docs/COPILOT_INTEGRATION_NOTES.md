# Copilot 接入归档记录

## 当前结论

2026-06-22，Copilot 接入暂时从当前主线移除。原因是用户侧优先级调整：Copilot 网页端聊天使用占比暂时较低，当前阶段只继续保留 DeepSeek 接入优化。

如果以后要恢复 Copilot 接入，请先查看 GitHub tag：

`copilot-grok-wip-2026-06-22`

该 tag 保留了 2026-06-21 的实验实现，包括基础文本发送、读取最后回答、转发和总结目标选择。图片、PDF/XLSX 等附件当时未标记为自动上传。

官方入口：`https://copilot.microsoft.com/`

浏览器兼容结论：

- Chrome 扩展环境当时已验证：Copilot iframe 可以正常显示，基础文本可以发送并收到回答。
- Edge 扩展环境暂不支持：新版 Edge 自带 Copilot 入口，实测仍会让 Copilot iframe 进入 `chrome-error://chromewebdata/` 或发送失败。当前不再继续为 Edge 追 Copilot iframe，设置界面和使用帮助会提示用户在 Chrome 中使用 Copilot。

## 归档版本实现了什么

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

## 2026-06-21 iframe 加载问题

用户实测时，Copilot 面板显示 `加载超时`，iframe 变成 `chrome-error://chromewebdata/`。

控制台错误：

```text
Framing 'https://copilot.microsoft.com/' violates the following Content Security Policy directive:
"frame-ancestors 'self' https://edgeservices.bing.com edge://* *.microsoft365.com *.office.com
m365.cloud.microsoft copilot.cloud.microsoft ccm.mobile.m365.svc.cloud.microsoft copilot.cloud-dev.microsoft".
```

根因判断：

- Copilot 页面在 iframe 加载阶段就被 CSP 拦截，content script 还没机会注入。
- 当时 DNR 规则数量显示为 6，说明规则注册过，但 Copilot 报错里仍显示原始 `frame-ancestors`。
- 对照 ChatBrawl 可工作的 Copilot iframe 后确认：不是 Copilot 天生不能 iframe，而是本项目 DNR 写法和它不一致。
- 失败写法包括：`urlFilter: 'copilot.microsoft.com'`、同时覆盖 `main_frame`、以及把 `frame-ancestors` 改成精确扩展 ID。

修正：

- DNR 改成 ChatBrawl 同款形态：
  - `urlFilter: '||copilot.microsoft.com/*'`
  - `resourceTypes: ['sub_frame']`
  - `Content-Security-Policy: frame-ancestors 'self' chrome-extension://*`
  - 移除 `X-Frame-Options`
- `getEmbedRuleCleanupIds()` 统一返回 `[1, 2, 3, 4, 5, 6, 7, 8]`，避免启动清理漏掉 Copilot/Grok 新规则。
- `src/chat/platform-message-route.ts` 不再因为 Copilot 未 ready 就直接走官方标签页；只有 iframe 已经进入 `chrome-error://` 时才判定嵌入失败。
- Copilot 选择器按 ChatBrawl 验证过的 DOM 收窄：
  - 输入框：`textarea[data-testid="composer-input"]`
  - 发送按钮：`button[data-testid="submit-button"]`
- 新增/更新 `tests/unit/dnr-rules.test.ts` 和 `tests/unit/platform-message-route.test.ts` 覆盖以上行为。

后续如果 Copilot 在 Chrome 仍然不可用，优先确认：

1. 重新加载扩展后，浏览器动态规则里 Copilot 是否变成 `||copilot.microsoft.com/*`。
2. 控制台是否还报原始 Copilot `frame-ancestors`；如果还报，优先查 DNR 是否刷新成功。
3. iframe 是否仍然是 `chrome-error://chromewebdata/`；如果不是，再查输入框和发送按钮。
4. 不要把“未 ready”直接当成官方标签页兜底，否则会掩盖 iframe 真实问题。

如果只是在 Edge 中失败，先按当前产品结论处理为“不支持 Edge 扩展环境中的 Copilot”，不要继续消耗时间调 selector。

## 2026-06-21 历史记录多出 Copilot said

用户实测历史记录时发现：Copilot 回答前面多了类似下面的内容：

```text
###### Copilot

said
```

根因：

- Copilot 页面为了无障碍读屏，会在回答容器里放入“Copilot said”这类标题或标签。
- 通用 DOM 转 Markdown 逻辑会把 `h6` 转成 `###### Copilot`，导致历史记录把页面标签当成回答正文。

修正：

- `src/adapters/generic/text-web-adapter.ts` 对 `platform === 'copilot'` 的回答做轻量清洗。
- 只清理开头的 `Copilot said` / `###### Copilot\n\nsaid`，不影响回答正文里的普通文本。
- `src/lib/session-record.ts` 在写入历史前也做同样清洗，避免远程选择器、旧 content script 或其它入口绕过 adapter 清洗。
- 历史详情和 Markdown 导出会在显示层清理 Copilot 前缀；不要在打开历史时写回旧记录，避免旧历史被当前 iframe 内容污染。
- 清洗规则不要只匹配固定的 `###### Copilot\n\nsaid`，真实历史里可能有额外空行、空格或隐藏字符；当前按“开头是 Copilot + said 标签”这一语义清理。
- 新增 `tests/unit/text-web-adapter.test.ts` 用例，防止历史记录再次带入这个站点标签。
- 新增 `tests/unit/session-record.test.ts` 用例，防止保存历史时再次带入这个站点标签。

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
- `src/chat/platform-message-route.ts`
- `src/background/service-worker.ts`
- `src/lib/remote-selector-config.ts`
- `tests/unit/text-web-adapter.test.ts`
