# DeepSeek 接入记录

## 最终结论

2026-06-20，DeepSeek 已作为第 4 个可选平台接入 ChatDuel 扩展，默认关闭。

当前接入范围是“方案 A”：支持文本发送、读取最后回答、转发和总结目标选择；不自动上传图片或文件。

原因：DeepSeek 官方页入口是 `https://chat.deepseek.com/`，但没有在当前环境里完成登录后的真实 DOM 验证。为了避免给用户一个“看起来支持上传，但实际可能失败”的入口，先只开放文本能力。以后如果确认图片/文件上传控件稳定，再打开对应 capability。

## 当时实现了什么

- 在 `src/types/index.ts` 的 `AIPlatform` 联合类型中加入 `deepseek`。
- 在 `src/lib/ai-platforms.ts` 注册 DeepSeek 元数据：
  - label: `DeepSeek`
  - icon: `DS`
  - url: `https://chat.deepseek.com/`
  - `supportsText: true`
  - `supportsLastResponse: true`
  - `supportsImageUpload: false`
  - `supportsFileUpload: false`
- 在 `src/lib/user-settings.ts` 中把 DeepSeek 加入默认设置和面板顺序，默认关闭。
- 在 `src/chat/chat.html` 中新增 DeepSeek 面板和设置页站点行。
- 在 `manifest.json` 中新增 `https://chat.deepseek.com/*` host permission 和 `deepseek-content.ts` content script。
- 在 `vite.config.ts` 中新增 `content-deepseek` 构建入口。
- 在 `src/background/dnr-rules.ts` 中新增 DeepSeek iframe 嵌入规则，规则 ID 使用 `5`。
- 在 `src/background/service-worker.ts` 中新增 DeepSeek 官方 tab URL 前缀识别。
- 新增 `src/adapters/deepseek/adapter.ts`：
  - 使用通用输入框选择器写入文本。
  - 使用通用发送按钮选择器触发发送。
  - 如果找不到发送按钮，退回到对输入框派发 Enter。
  - 使用通用回答选择器读取最后回答。
  - 图片上传明确抛错，不做自动上传。
- 新增 `src/content-scripts/deepseek-content.ts`：
  - 支持 `get-state`
  - 支持 `get-last-response`
  - 支持 `get-location`
  - 支持 `write-and-send`
- 在 `src/lib/remote-selector-config.ts` 中允许远程配置 DeepSeek 的 `inputBox`、`sendButton`、`response` 选择器。
- 更新 README，加入 `@deepseek` 和 DeepSeek 支持说明。

## 关键问题

### 1. DeepSeek 页面需要 JavaScript/真人验证

直接打开 `https://chat.deepseek.com/` 时，页面会显示需要 JavaScript 验证，不适合只靠静态抓取确认真实 DOM。

这意味着 DeepSeek 的输入框、发送按钮、回答区域选择器，最好以后在真实登录后的扩展 iframe 里验证，不要只看外部网页源码。

### 2. 选择器只能先做通用兜底

这次没有拿到稳定的 DeepSeek 登录后 DOM，所以 adapter 使用了通用选择器：

- 输入框：`textarea`、`[contenteditable="true"]`、`[role="textbox"]`
- 发送按钮：`aria-label/title` 里包含 `Send` 或 `发送` 的按钮、`button[type="submit"]`
- 回答内容：包含 `assistant`、`answer`、`message`、`markdown` 的节点，以及 `article`

这些选择器能覆盖常见聊天页结构，但如果 DeepSeek 改 class 或 DOM 层级，最可能坏的是发送按钮和最后回答读取。

### 3. 不要一开始打开图片/文件上传

DeepSeek 平台元数据里故意设置：

```ts
supportsImageUpload: false
supportsFileUpload: false
```

这样即使用户附加图片或 PDF，ChatDuel 也不会把文件自动塞进 DeepSeek 页面，避免文件入口没验证时误发失败。

以后要打开上传能力，先验证：

1. DeepSeek iframe 中是否能看到稳定的 `input[type="file"]`。
2. 图片上传后 DOM 中是否有明确附件预览。
3. 发送后附件是否真的随问题一起进入 DeepSeek 对话。
4. 再把 capability 改成 true，并补 `file-handler` 和 adapter 测试。

### 4. 官网会话 URL 没有加特判

这次没有给 `src/lib/conversation-store.ts` 的 `isSpecificConversationUrl()` 加 DeepSeek 会话 URL 判断。

原因：没有确认 DeepSeek 的具体会话 URL 规则。如果猜错，会导致“官网会话”保存无效链接或误判首页为具体会话。

以后要补 DeepSeek 官网会话时，先在真实页面确认：

1. 新会话 URL 是什么格式。
2. 历史会话 URL 是什么格式。
3. 首页、登录页、验证页是否会被误判。
4. 再给 `isSpecificConversationUrl('deepseek', url)` 加规则和单测。

### 5. DNR 规则 ID 需要避开旧值

DeepSeek 使用 DNR 规则 ID `5`。当前规则 ID 分配：

- ChatGPT: `1`
- Gemini: `2`
- 历史遗留清理: `3`
- 豆包: `4`
- DeepSeek: `5`

`REMOVE_RULE_IDS` 和 service worker 启动清理都包含 `[1, 2, 3, 4, 5]`。以后新增平台时不要复用这些 ID。

## 验证记录

接入后跑过：

```bash
npm run test
npm run typecheck
npm run build
```

结果：

- 单元测试：29 个测试文件、209 条测试通过。
- TypeScript 检查通过。
- 生产构建通过，产物里包含 `content-deepseek`。

## 以后如果 DeepSeek 网页变了

优先按这个顺序排查，不要一上来全链路重写：

1. 看 iframe 有没有成功加载 DeepSeek 页面。
2. 看 content script 是否发出 `ready`。
3. 在 iframe DOM 里确认输入框选择器是否还能找到元素。
4. 如果能写入但不能发送，优先查 `sendButton` 选择器。
5. 如果发送成功但历史/转发读不到回答，优先查 `response` 选择器。
6. 能通过远程 selector 配置修的，先改远程配置，不急着发新版扩展。
7. 只有 capability 或通信协议要变时，再改代码。

最可能需要改的文件：

- `src/adapters/deepseek/adapter.ts`
- `src/content-scripts/deepseek-content.ts`
- `src/lib/remote-selector-config.ts`
- `tests/unit/remote-selector-config.test.ts`
- `tests/unit/content-script-location.test.ts`
- `tests/unit/ai-platforms.test.ts`

如果只是 DOM 选择器变化，优先通过 `chatduel.ifeeling.app/api/extension/config` 下发 DeepSeek 的 `inputBox`、`sendButton`、`response` 覆盖。
