# DeepSeek 自动切换到识图模式设计

## 目标

DeepSeek 新对话面板加载后自动切换到“识图模式”，并让 ChatDuel 的附件分发链路真正把图片交给 DeepSeek。切换失败时不阻塞面板，也不能把“点击过按钮”误报为“切换成功”。

## 当前状态与根因

当前代码已经具备 DeepSeek 图片上传实现：

- `adapter.ts` 能检测识图模式，并能通过 paste / file input 上传图片；
- `deepseek-content.ts` 能把 `imageDataUrl` 还原成 `File`；
- 上传成功以输入区附近出现附件预览、文件名或上传块为证据。

但完整发送链路仍未开放：

- `src/lib/ai-platforms.ts` 中 DeepSeek 的 `supportsImageUpload` 仍是 `false`；
- `buildAttachmentDeliveryPlan()` 因而不会把图片传给 DeepSeek；
- `chat.ts` 仍无条件显示“DeepSeek 当前不支持上传图片，只会发送文字”。

所以只增加“启动时点击识图模式”并不能实现目标，必须同时更新能力开关、警告逻辑和相应测试。

## 范围

仅修改扩展仓库中的 DeepSeek 模式切换和现有附件能力声明：

1. `src/adapters/deepseek/adapter.ts`：增加可测试的模式检测和自动切换函数；
2. `src/content-scripts/deepseek-content.ts`：面板初始化后后台触发切换；
3. `src/lib/ai-platforms.ts`：在自动切换与上传链路接通后启用 DeepSeek 图片能力；
4. `src/chat/chat.ts`：删除已经不准确的 DeepSeek 图片“不支持”预警；
5. 更新对应单元测试和 DeepSeek 集成说明。

不涉及：

- 其他 AI 平台的 adapter 或能力；
- PDF、Excel 等普通文件上传；
- DeepSeek 远程 selector 配置或官网仓库；
- 强制修改旧对话的既有模式。

## 设计

### 1. 使用三态模式检测

新增内部检测结果：

```ts
type DeepSeekModeState = 'vision' | 'non-vision' | 'unknown'
```

- 有明确的 active / selected / checked 识图控件，或页面明确显示“使用识图模式开始对话”时，返回 `vision`；
- 页面明确显示快速模式或专家模式时，返回 `non-vision`；
- DOM 信息不足时返回 `unknown`。

现有图片发送校验可以继续保持“未知时不误拦截”的兼容行为；自动切换逻辑不能把 `unknown` 当成已经切换成功。

### 2. 自动切换只点击一次

`ensureDeepSeekVisionMode()` 返回 `Promise<boolean>`：

1. 明确已是 `vision` 时直接返回 `true`；
2. 在最多 8 秒内等待一个可见、可用、语义精确匹配“识图模式”的交互控件；
3. 找到后只点击一次；
4. 点击后轮询明确的 `vision` 证据，成功返回 `true`；
5. 按钮未出现、不可用、旧对话不可切换、验证超时或发生异常时返回 `false`。

按钮候选限定为 `button`、`[role="button"]`、`[role="tab"]`、`[role="radio"]`。匹配标准使用规范化后的可见文字、`aria-label` 或 `title`，且元素必须可见、未禁用。不能把说明文字、隐藏模板或包含“识图模式”的大容器当作按钮。

切换成功的依据是明确的选中态或页面状态文字，不是 `click()` 已执行。

### 3. 不阻塞面板就绪

`deepseek-content.ts` 先完成消息监听注册并向父页面发送 ready，再以 fire-and-forget 方式启动自动切换：

```ts
postReadyToParent()
void ensureDeepSeekVisionMode()
```

这样按钮最多等待 8 秒也不会让面板被判定为未就绪。自动切换函数内部自行吞掉预期的 DOM/时序异常，并通过现有 capture debug 日志记录结果。

### 4. 接通真实图片分发

自动切换功能落地后，将 DeepSeek 的 `supportsImageUpload` 改为 `true`，使 `buildAttachmentDeliveryPlan()` 把图片数据传给 DeepSeek。`supportsFileUpload` 仍保持 `false`。

删除 `chat.ts` 中“DeepSeek 当前不支持上传图片，只会发送文字”的平台特判，因为它与新能力矛盾。若模式切换失败，真正发送图片时由现有 `assertCanSendImageInCurrentMode()` 返回具体错误；上传是否成功仍由附件预览证据判定。

### 5. 旧对话与失败处理

- 旧对话若没有可用模式按钮，自动切换返回 `false`，但不影响文本发送和面板使用；
- 用户随后发送图片时，若页面明确处于快速/专家模式，沿用现有错误：“DeepSeek 仅识图模式支持图片，请新建或切换到识图模式后重试”；
- DOM 状态不明确时不提前伪造成功，最终仍以附件预览证据和发送结果为准；
- 调试日志至少区分：already-vision、button-not-found、button-disabled、verification-timeout、switched、exception。

## 测试要求

### Adapter 单元测试

1. 明确已处于识图模式时返回 `true`，不点击按钮；
2. 快速模式下找到可用按钮，点击一次，出现明确选中态后返回 `true`；
3. 按钮延迟渲染时能等待并点击；
4. 按钮不存在时超时返回 `false`；
5. 按钮存在但切换未生效时只点击一次并返回 `false`；
6. 隐藏或 disabled 的同名按钮不能被点击；
7. `unknown` 状态不能被当作切换成功。

### 分发与回归测试

1. `ai-platforms.test.ts` 断言 DeepSeek `supportsImageUpload: true`、`supportsFileUpload: false`；
2. `file-handler.test.ts` 断言图片会进入 DeepSeek 的 `autoUploadTargets`；
3. 保留“快速模式发送图片时报错”的现有测试；
4. DeepSeek 现有附件预览证据测试继续通过；
5. `chat.ts` 不再显示错误的“不支持上传图片”警告。

### 验证命令

```bash
npx vitest run tests/unit/deepseek-adapter.test.ts tests/unit/ai-platforms.test.ts tests/unit/file-handler.test.ts tests/unit/chat-html.test.ts
npm run typecheck
npm run build
git diff --check
```

## 手动验收

1. 新开 DeepSeek 面板，ChatDuel 面板应立即就绪，随后 DeepSeek 自动进入识图模式；
2. 附加一张带唯一文件名的图片并发送，DeepSeek 输入区先出现该附件的预览/文件名，再提交问题；
3. 确认 DeepSeek 实际根据图片内容回答，而不是只收到文字；
4. 打开一个不能切换模式的旧对话，确认文本仍可发送，图片发送给出明确失败原因；
5. 开启 capture debug，确认日志能区分切换成功与失败原因。

## 风险

DeepSeek 的页面结构和中文文案可能变化。当前方案不使用混淆 class，并把“查找按钮”和“验证切换成功”分开，可降低误点击和误报风险；如果语义文案变化，应先依据实测 DOM 更新对应平台实现，再考虑是否增加远程热更新字段。
