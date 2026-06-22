# DeepSeek 接入记录

## 最终结论

2026-06-20，DeepSeek 已作为第 4 个可选平台接入 ChatDuel 扩展，默认关闭。

当前接入范围：支持文本发送、读取最后回答、转发和总结目标选择。图片和 PDF/XLSX 等附件不再标记为自动上传；DeepSeek 需要用户在官方输入框里手动上传或粘贴。

原因：DeepSeek 官方页入口是 `https://chat.deepseek.com/`。第一次接入时没有完成登录后的真实 DOM 验证，所以先只开放文本能力。后续多轮实测确认文字能发出去，但图片自动上传不稳定：手动 `Cmd+V` 可以把图粘进 DeepSeek 输入框，扩展脚本模拟 paste/drop 或写剪贴板则会被浏览器安全限制或 DeepSeek 页面忽略。为避免误报成功，当前关闭 DeepSeek 图片自动上传能力。

注意：这不是永久放弃 DeepSeek 图片上传。下一轮会和 Copilot/Grok 一起重新验证真实上传入口、选择器和附件预览条件；确认能稳定收到图片后，再打开对应 capability。

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
  - 使用通用回答选择器读取最后回答，并把 DOM 结构转换成 Markdown-ish 文本。
  - 保留图片上传探测代码，但平台能力当前关闭，不再默认从 ChatDuel 自动上传图片到 DeepSeek。
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

### 3. 图片和文档上传都先不要打开

DeepSeek 平台元数据当前设置：

```ts
supportsImageUpload: false
supportsFileUpload: false
```

这样图片和 PDF/XLSX 都会提示用户手动处理，避免自动上传失败时仍发送文字并让用户误以为 DeepSeek 收到了附件。

以后要重新打开图片或文档上传能力，先验证：

1. DeepSeek iframe 中是否能看到稳定的 `input[type="file"]`。
2. 程序化上传后，附件预览是否稳定出现在 DeepSeek 输入区附近，而不是页面其它图标变化。
3. 发送后 DeepSeek 是否真的承认收到了附件，而不是回复“没有附带图片/文件”。
4. 如果必须依赖系统剪贴板，确认扩展页能否在用户手势内写入剪贴板，并确认浏览器允许把它粘到跨源 iframe。
5. 再把对应的 `supportsImageUpload` 或 `supportsFileUpload` 改成 true，并补 `file-handler` 和 adapter 测试。

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

## 2026-06-20 用户实测后的修正

用户在 Edge 扩展里实测 Gemini + DeepSeek 双面板后发现三个问题：

1. DeepSeek 可以收到文本，但图片附件没有传上去。
2. 历史记录里的 DeepSeek 回答只保存了最后一小段，没有保存完整助手回答。
3. Gemini 在官网页面里的回答有标题、段落、列表，但历史记录里被压成一段纯文本。

根因和修法：

- DeepSeek 附件问题：第一次接入时 `supportsImageUpload` 还是 false，`send` 链路不会把 `imageDataUrl` 发给 DeepSeek。修法是把 DeepSeek 图片 capability 打开，并在 `src/adapters/deepseek/adapter.ts` 中实现 `attachImage(file)`。
- DeepSeek 记录不全：通用 `response` 选择器会匹配到助手回复内部的多个小节点，旧逻辑按 DOM 最后一个候选取文本，容易只拿到最后一句。修法是给候选节点打分，优先选带 `assistant/answer/markdown/article` 特征、位于 `main` 中、文本更完整的节点。
- Gemini 格式丢失：旧 adapter 用 `textContent` 读取回答，浏览器会把标题、段落、列表都压平。修法是新增 `src/lib/dom-response-text.ts`，把 DOM 回答块转换成 Markdown-ish 文本，Gemini 和 DeepSeek 都复用它。

新增回归测试：

- `tests/unit/deepseek-adapter.test.ts`
  - DeepSeek 取完整助手回复块。
  - DeepSeek 保留有序列表编号。
  - DeepSeek 可以通过 file input 注入图片。
- `tests/unit/gemini-adapter.test.ts`
  - Gemini 捕获回答时保留段落、标题和列表。
- `tests/unit/file-handler.test.ts`
  - DeepSeek 对图片附件走自动上传。

## 2026-06-20 上传入口诊断

用户在 DeepSeek iframe 控制台运行诊断脚本后确认：

- DeepSeek 页面里存在 1 个 `input[type=file]`。
- 这个 input 是隐藏的，`display: none`。
- `accept` 包含 `.png`、`.jpg`、`.jpeg`、`.webp`、`.pdf`、`.txt`、`.md` 等大量格式。
- 页面没有暴露明显的上传按钮，诊断结果里的 `uploadLikeButtons` 是空数组。
- 文本输入框是 `textarea`，placeholder 为 `给 DeepSeek 发送消息`。
- DOM 路径类似：

```text
div._77cefa5._3d616d3 > div._020ab5b > div.ec4f5d61 > div.bf38813a > input
```

所以问题不是“找不到上传入口”，而是第一次实现只设置 `files` 并派发 `change` 后很快发送，DeepSeek 可能还没来得及把附件预览/上传状态挂到页面里。

修正：

- `attachFileToInput()` 设置 `input.files` 后同时派发 `input` 和 `change`。
- 发送前等待页面出现附件证据，例如文件名、上传相关 class、图片/预览节点。
- 如果找不到 file input，仍保留 paste/drop 输入框兜底。

第二次主动诊断确认：

- 在 DeepSeek iframe 控制台创建 `chatduel-upload-test.png` 后，程序化设置 `input.files`、向 textarea 派发 paste、向 textarea/父级 div 派发 drop 都能让页面出现附件块。
- 页面附件块显示图片名 `chatduel-upload-test.png`，并提示“未提取到文字”。
- 因为测试脚本依次跑了多条路线，页面上会出现多个测试附件，这说明附件注入路线是可用的。

这次真正的代码问题：

- `attachFileToInput()` 虽然调用了 `waitForAttachmentEvidence()`，但没有使用等待结果。
- 所以即使 file input 路径没有等到附件预览，它也会直接返回成功，导致不会继续尝试 paste/drop 兜底。
- 修法是让 `attachFileToInput()` 和 `pasteFileIntoComposer()` 都只有在看到附件证据时才返回 `true`；如果 file input 没产生预览，就继续走 paste/drop。

第三次实测发现：

- 修正 fallback 后，DeepSeek 仍可能回复“收不到图片”。
- 控制台仍显示 `write-and-send result for deepseek: ok=true`，但 DeepSeek 输入区没有稳定出现附件预览。
- 根因是附件证据判断太宽：旧逻辑在整个 DeepSeek 页面里数 `img`、`canvas`、`upload/file/image` class。DeepSeek 页面自身有很多图标和动态节点，可能导致“页面其它地方变化”被误判成“附件已进入输入区”。

继续修正：

- 附件证据只在输入区附近的 DOM 范围内统计，不再看整个页面。
- 文件名、图片预览、上传相关节点必须出现在 composer 附近，才算上传成功。
- drop 事件补上 `dataTransfer`，和控制台主动诊断里能触发附件预览的事件形态保持一致。
- 新增回归测试：页面其它地方出现无关图片时，DeepSeek adapter 必须继续走 paste/drop 兜底，不能提前返回成功。

用户随后手动验证：

- 光标在 DeepSeek 输入框内时，直接用复制/粘贴可以把图片加到输入框里。
- 这说明 DeepSeek 当前更可靠的图片入口是 composer paste，而不是隐藏 file input。

因此 DeepSeek 图片上传策略调整为：

1. 优先 focus 输入框并派发带文件的 paste/drop 事件。
2. 只有 paste/drop 没有产生输入区附件证据时，才退回隐藏 file input。
3. 隐藏 file input 只作为兜底，不再作为第一路径，避免误判或走到 DeepSeek 不真正提交图片的路径。

最终剪贴板诊断：

- 用户在 DeepSeek frame 控制台运行剪贴板诊断脚本。
- `navigator.clipboard.write()` 失败，错误为 `NotAllowedError: Failed to execute 'write' on 'Clipboard': Document is not focused.`
- `document.execCommand('paste')` 返回 `false`。
- 程序化 paste 后没有出现附件块，`attachments` 为空数组。
- 用户把光标放在 DeepSeek 输入框里再运行脚本，结果仍相同，因为执行脚本时焦点在 DevTools，浏览器不把它当作官方页面内的真实用户粘贴。

最终结论：

- DeepSeek 官方页面能接受用户手动 `Cmd+V` 粘贴图片。
- 扩展脚本不能稳定伪造同等可信的系统剪贴板粘贴。
- 因此当前关闭 DeepSeek 的 `supportsImageUpload`，把 DeepSeek 归为手动上传侧。
- 如果用户同时发图片给 Gemini/ChatGPT/豆包 和 DeepSeek，ChatDuel 只自动上传到已验证平台，并提示 DeepSeek 需要手动上传/粘贴。

后续如果又出现“发送成功但附件没带上”，先在 DeepSeek iframe 控制台看：

1. `input[type=file]` 是否仍存在。
2. `input.files` 设置后是否触发页面里的附件预览。
3. 文件名或上传预览是否出现在 DOM。
4. 如果预览出现但发送后 DeepSeek 没读到，问题就从“上传入口”转移到“发送前等待 DeepSeek 文件处理完成”，需要延长或改进等待条件。
5. 如果程序化设置 `input.files`、paste、drop 都不触发预览，说明 DeepSeek 可能要求真实用户文件选择事件；这时不要继续误报 `ok=true`，要改成失败提示或手动上传兜底。

## 2026-06-21 历史记录回答缺段

用户实测历史记录时发现：DeepSeek 页面上完整回答有 3 段，但历史详情里只保存了前 2 段，最后一句“今天有什么我可以为你做的呢？请随时告诉我！”漏掉了。

根因：

- DeepSeek 的回答 DOM 可能把主体内容放在内层 `.markdown`，但把最后的续段放在同一个回答外层容器里的兄弟节点。
- 旧逻辑只读取命中的 `.markdown` 候选节点，所以它能拿到前两段，却看不到外层容器里的续段。
- 不能简单改成读取更大的 `main`，否则容易把用户问题、推荐卡片或输入框附近文本混进历史。

修正：

- `src/adapters/deepseek/adapter.ts` 在命中回答候选后，会向父级最多扩展 3 层。
- 父级不要求一定以当前候选文本开头，因为真实页面可能命中回答中间段；只要父级包含当前候选，并且父级不是用户消息、输入区、按钮、导航，也不包含用户消息节点，才把父级作为更完整的回答块。
- 新增 `tests/unit/deepseek-adapter.test.ts` 用例：内层 `.markdown` 后面还有同一回答续段时，历史必须保存完整 3 段。
- 新增中间段命中用例：如果选择器只命中回答中间段，也要扩展到同一回答块，不能只保存中间一句。

以后再改 DeepSeek 历史抓取时，重点确认两件事：

1. 不能只看 `ok=true` 或历史列表状态，要打开历史详情核对完整段落。
2. 如果页面 DOM 变动，优先检查“候选节点是否只是回答内层”，不要直接扩大到整个聊天主区域。

后续实测又发现一个更真实的历史缺段原因：

- DeepSeek 页面回答还在流式增长时，ChatDuel 可能先抓到某个稳定了两轮的小片段，并把它写成“已记录”。
- 旧逻辑一旦状态变成“已记录”，后续回填和打开历史都不会再尝试覆盖，所以后面完整回答出现了也不会进历史。

追加修正：

- `applyCapturedResponses()` 允许更完整的新回答覆盖旧的已记录文本：新文本包含旧文本，或明显更长时才覆盖，避免短片段反向覆盖完整回答。
- 后台回填会在一段时间内继续复查已记录回答，不再只追 pending。
- 不要在打开历史或点击某条历史时用当前官方页面内容修复旧记录；旧历史必须保持只读，否则当前 iframe 已切到别的问题时会污染旧记录。

## 附件上传功能记录规则

附件上传最容易受官方网页 DOM、隐藏 input、可信事件和上传预览状态影响。以后新增或修改任何平台的附件上传能力，都要把踩坑记录补进对应平台文档，至少记录这些信息：

1. 官方页面里真实的上传入口，例如 `input[type=file]`、按钮、label、paste/drop 区域。
2. 上传入口是否隐藏，以及当时可用的关键 DOM 路径、placeholder、`accept`、class 或 aria 信息。
3. 尝试过的触发方式，例如设置 `input.files` 后派发 `input/change`、向输入框派发 paste/drop、点击上传按钮等。
4. 页面有没有出现附件证据，例如文件名、缩略图、上传进度、图片预览节点。
5. 失败时官方页面的表现，例如只收到文字、提示没有附件、发送按钮提前可点但文件还没处理完。
6. 最终采用的等待条件和兜底策略。
7. 如果官方页面改版，优先复查这些记录，不要一上来重写整条发送链路。

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
