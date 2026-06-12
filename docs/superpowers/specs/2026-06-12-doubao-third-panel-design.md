# 豆包第三分屏接入设计

## 背景

当前 AIChatRoom 已稳定支持 ChatGPT + Gemini 两个官方网页分屏。用户希望下一步扩展到最多 3 个 AI，同时先接入豆包。

目标不是一次性复制 ChatBrawl 的完整交互，而是在现有架构上稳妥增加第三个平台：

- 默认仍然显示 2 个 AI：ChatGPT + Gemini。
- 用户可在设置页启用豆包。
- 启用豆包后显示 3 个 AI：左 / 中 / 右三栏。
- 最少同时显示 2 个 AI。
- 最多同时显示 3 个 AI。
- 豆包也参与发送、@ 指定、历史记录、总结、转移、状态检测。

豆包官网入口为：

- `https://www.doubao.com/chat/`

## 不做的内容

第一阶段不做 ChatBrawl 的悬浮面板菜单。

也就是说，暂时不实现这些浮动操作：

- 鼠标移入 iframe 边缘出现菜单。
- 在菜单中刷新当前 AI。
- 在菜单中切换当前面板 AI。
- 在菜单中添加分屏。
- 在菜单中关闭当前 AI。

原因：

1. 当前项目已有设置页，可以先用设置页控制显示站点，改动更小。
2. 豆包真正的风险在页面适配，不在菜单 UI。
3. 先验证豆包能否稳定输入、发送、读取回答，再做更复杂的面板管理更稳。

## 用户体验设计

### 设置页

设置页“显示站点”中新增豆包：

- ChatGPT：默认开启。
- Gemini：默认开启。
- 豆包：默认关闭。

开关规则：

- 如果当前只剩 2 个 AI，再关闭其中一个时要阻止，并提示“至少保留 2 个 AI”。
- 如果未来平台数量超过 3 个，再打开第 4 个时要在 UI 层阻止，并提示“最多同时显示 3 个 AI”。
- 不强制恢复到 ChatGPT + Gemini。用户可以使用 ChatGPT + 豆包，也可以使用 Gemini + 豆包。
- 不静默裁剪“前三个启用平台”。如果用户操作会超过上限，应该阻止这次操作，而不是悄悄关闭另一个平台。
- 本阶段平台总数刚好 3 个，但代码结构要为后续新增 Claude / DeepSeek 等平台预留。

### 主界面布局

主界面继续使用水平分屏：

- 2 个 AI：左右两栏，各占 50%。
- 3 个 AI：左 / 中 / 右三栏，各占约 33.33%。

现有布局已经改成 `flex: 1 1 0`，适合继续扩展到 3 栏。

分隔条规则：

- 2 个 AI 时显示 1 条分隔条。
- 3 个 AI 时显示 2 条分隔条。
- 每条分隔条只调整它左右相邻的两个面板。
- 第一版可以先采用固定比例布局：2 栏 50 / 50，3 栏 1 / 1 / 1。
- 如果拖拽逻辑变复杂或影响豆包接入主线，允许先把 splitter 作为视觉分隔，后续再增强拖拽。

注意：

- 现在代码里只有一个 `#splitter`。
- 支持 3 个 AI 时，不应继续依赖单一 `id="splitter"`。
- 建议改成多个 `.splitter`，通过 DOM 相邻关系处理拖拽。

### 底部输入区

底部输入区保持当前设计：

- 设置
- 上传
- 引用
- 总结
- 历史
- 刷新
- 输入框
- 展开
- 发送

豆包启用后不新增底部按钮。

### @ 指定目标

现有 `activePlatforms()` 从 DOM 中读取可见面板，理论上可以自动支持豆包。

需要确认：

- 豆包出现在 @ 候选里。
- `@doubao` 可指定只发豆包。
- 空目标时默认发送给当前启用的所有 AI。
- @ 候选应从“已启用平台 + 平台能力”派生。只有能接收文本的平台才进入 @ 候选。

## 技术设计

### 平台注册与能力模型

代码层不要把平台数量写死为 3，也不要到处写 `platform === 'doubao'`。

建议新增或整理为统一平台注册：

```ts
export const SUPPORTED_PLATFORMS: AIPlatform[] = ['chatgpt', 'gemini', 'doubao']
export const MAX_ACTIVE_PLATFORMS = 3
export const MIN_ACTIVE_PLATFORMS = 2
```

并为每个平台声明能力：

```ts
export interface AIPlatformCapabilities {
  supportsText: boolean
  supportsImageUpload: boolean
  supportsFileUpload: boolean
  supportsLastResponse: boolean
}
```

豆包能力应按验证阶段逐步打开。阶段 1/2 只注册平台和加载页面，不把豆包放进可发送目标。阶段 3 纯文本发送验证通过后，再打开 `supportsText`。

阶段 1/2：

```ts
doubao: {
  supportsText: false,
  supportsImageUpload: false,
  supportsFileUpload: false,
  supportsLastResponse: false,
}
```

阶段 3 通过后：

```ts
doubao: {
  supportsText: true,
  supportsImageUpload: false,
  supportsFileUpload: false,
  supportsLastResponse: false,
}
```

阶段 4 最后回答读取验证通过后，再把 `supportsLastResponse` 改为 `true`。

能力使用规则：

- @ 候选：启用且 `supportsText` 的平台。
- 总结目标：启用且 `supportsText` 的平台。
- 转移来源：启用且 `supportsLastResponse` 的平台。
- 转移目标：启用且 `supportsText` 的平台。
- 图片自动上传：启用且 `supportsImageUpload` 的平台。
- 文件自动上传：启用且 `supportsFileUpload` 的平台。

### 平台类型

`src/types/index.ts`

把：

```ts
export type AIPlatform = 'chatgpt' | 'gemini'
```

改为：

```ts
export type AIPlatform = 'chatgpt' | 'gemini' | 'doubao'
```

相关类型需要天然支持豆包：

- `Session.responses`
- `Session.targetPlatforms`
- `SessionSummary.target`
- `StreamEvent.platform`

需要检查目前是否还有写死 `{ chatgpt, gemini }` 的地方。

### 平台元数据

`src/lib/ai-platforms.ts`

新增：

```ts
doubao: { key: 'doubao', label: '豆包', icon: '豆' }
```

这里是 @ 候选、历史显示、总结显示等 UI 的平台名称来源。

### 用户设置

`src/lib/user-settings.ts`

默认设置：

```ts
enabledPlatforms: {
  chatgpt: true,
  gemini: true,
  doubao: false,
}
```

新增规范化逻辑：

- 旧用户没有 `doubao` 字段时自动补 `false`。
- 加载旧设置时，如果启用数量少于 2，可以用默认值兜底，避免页面不可用。
- 用户在设置页主动关闭平台时，如果会导致少于 2 个，应在 UI 层阻止并提示，不要自动恢复到 ChatGPT + Gemini。
- 用户在设置页主动打开平台时，如果会导致超过 3 个，应在 UI 层阻止并提示，不要静默关闭其它平台。

更好的做法是抽一个小函数：

```ts
function normalizeEnabledPlatforms(value?: Partial<Record<AIPlatform, boolean>>): Record<AIPlatform, boolean>
```

并补单元测试。

### 设置页 UI

`src/chat/chat.html`

新增豆包站点行：

- checkbox: `id="setting-doubao"`
- `data-platform="doubao"`
- 名称：豆包
- 归属：字节跳动
- 打开链接：`https://www.doubao.com/chat/`

`src/chat/chat.ts`

当前有写死：

```ts
function allPlatforms(): AIPlatform[] {
  return ['chatgpt', 'gemini']
}
```

需要改成从平台元数据统一导出，例如：

```ts
export const PLATFORM_KEYS: AIPlatform[] = ['chatgpt', 'gemini', 'doubao']
```

然后 chat.ts、service-worker.ts 都复用它，避免多处手写数组。

设置表单也要从写死 `settingChatgpt / settingGemini` 过渡到按 `data-platform` 批量读取。

### 主界面 HTML

`src/chat/chat.html`

新增豆包面板：

```html
<div class="splitter"></div>
<section class="panel" data-platform="doubao">
  <header class="panel-header">
    <span class="panel-title-wrap">
      <span class="panel-title">豆包</span>
      <span class="status-item" data-platform="doubao">
        <span class="dot"></span><span class="status-text">检测中…</span>
      </span>
    </span>
    <button class="panel-transfer" data-platform="doubao" title="把这里的回答转移到其它 AI">转移 ➔</button>
    <button class="panel-open" data-platform="doubao" title="在新标签页打开官方页面">↗</button>
  </header>
  <iframe class="panel-iframe" data-platform="doubao" src="about:blank" allow="clipboard-read; clipboard-write"></iframe>
</section>
```

默认由用户设置隐藏。

### 分隔条

当前：

- HTML 只有一个 `id="splitter"`。
- TS 通过 `const splitter = $('#splitter')` 绑定。

改为：

- HTML 使用多个 `<div class="splitter"></div>`。
- TS 使用 `document.querySelectorAll('.splitter')` 批量绑定。
- `applyUserSettings()` 根据可见面板数量显示对应分隔条。

隐藏逻辑建议：

- 遍历 `.panels` 子元素。
- 如果分隔条左右两侧至少各有一个可见 `.panel`，则显示。
- 否则隐藏。

### manifest

`manifest.json`

新增 host permission：

```json
"https://doubao.com/*",
"https://www.doubao.com/*"
```

新增 content script：

```json
{
  "matches": ["https://doubao.com/*", "https://www.doubao.com/*"],
  "js": ["src/content-scripts/doubao-content.ts"],
  "run_at": "document_idle",
  "all_frames": true
}
```

如果豆包实际跳转到其它域名，需要在验证后补充 host permission。

### DNR 嵌入规则

`src/background/dnr-rules.ts`

新增规则 ID：

```ts
const RULE_IDS = { chatgpt: 1, gemini: 2, doubao: 3 } as const
```

新增豆包规则：

- `urlFilter: 'doubao.com'`
- 删除 `X-Frame-Options`
- 改写 `Content-Security-Policy` 的 `frame-ancestors`

注意：

- 豆包可能有更复杂的 CSP 或登录策略。
- 即使 DNR 规则通过，也要实际 iframe 验证。
- 先覆盖 `doubao.com` 和 `www.doubao.com`，如果登录、跳转或页面主应用使用其它子域名，再根据实际网络记录补 host permissions / content script matches。

### Service Worker

`src/background/service-worker.ts`

需要去掉写死：

```ts
const PLATFORMS: AIPlatform[] = ['chatgpt', 'gemini']
```

改为复用统一平台列表。

`PLATFORM_URL_PREFIX` 新增：

```ts
doubao: 'https://www.doubao.com/'
```

`findOfficialTab()` 当前写死三元表达式，需要改成查表。

如果豆包实际存在 `https://doubao.com/` 和 `https://www.doubao.com/` 两个入口，状态检测需要支持多个 URL prefix，而不是只检查一个字符串。

### 豆包 Adapter

新增文件：

- `src/adapters/doubao/adapter.ts`
- `src/adapters/doubao/selectors.json`
- `src/content-scripts/doubao-content.ts`

第一版适配目标：

1. 判断是否登录。
2. 找到输入框。
3. 写入文本。
4. 触发发送。
5. 获取最后一条回答。
6. 判断是否正在生成。
7. 发出 `ready`、`result`、`state`、`last-response` 消息。

豆包 selector 暂不能凭空确定，需要手动验证页面 DOM。

可以先用保守候选：

- 输入框：
  - `textarea`
  - `[contenteditable="true"]`
  - `[role="textbox"]`
- 发送按钮：
  - `button[type="submit"]`
  - `button[aria-label*="发送"]`
  - `button[aria-label*="send" i]`
- 停止生成：
  - `button[aria-label*="停止"]`
  - `button[aria-label*="stop" i]`
- 回答内容：
  - 先从页面中最后一个 assistant/message 容器探索，不要盲目提交最终 selector。

写入输入框时不能假设 `textarea.value = text` 一定有效。豆包如果使用富文本编辑器，需要准备多级写入策略：

1. `focus()` 输入框。
2. 如果是 `textarea`，设置 `value` 并派发 `input` / `change`。
3. 如果是 `contenteditable`，优先尝试 `document.execCommand('insertText', false, text)`。
4. 必要时派发 `beforeinput` / `input` / `compositionend` 等事件，让内部框架同步状态。
5. 每种策略都要在真实页面验证，不能只靠 DOM 赋值判断成功。

建议实现顺序：

1. 先让 iframe 打开豆包页面。
2. 用 DevTools 找输入框和发送按钮。
3. 写最小 adapter，只支持纯文本发送。
4. 再做最后回答读取。
5. 最后做图片/附件支持。

### 附件策略

第一阶段豆包只保证纯文本。

对于文件：

- 文本类 inline-text 可以正常发送，因为最终只是变成文本 prompt。
- 图片/file-upload 先不支持自动上传到豆包。
- 如果用户同时发图片到 ChatGPT/Gemini/豆包，豆包应被标为“不支持自动上传”，并沿用现有 toast 提醒。

需要在 `supportsAutoUpload()` 或相关分类逻辑里加入豆包规则。

## 历史、总结、转移

豆包第一版不要一开始要求完整接入历史、总结、转移。

推荐顺序：

1. 先验证豆包能加载。
2. 再验证豆包能发送纯文本。
3. 再验证豆包能读取最后回答。
4. 最后再把豆包纳入历史、总结、转移。

原因是历史、总结、转移都依赖“最后回答读取”和“生成完成判断”。如果 selector 不稳定，过早接入会让历史里误显示“已记录”。

### 历史

`Session.responses` 已经是 `Partial<Record<AIPlatform, SessionResponse>>`，类型扩展后应自然支持豆包。

需要确认：

- 历史列表显示 `豆包 已记录 / 待回填`。
- 历史详情出现“豆包 回答”。
- Markdown 复制包含豆包回答。
- 豆包 selector 未稳定前，允许显示 `待回填` 或 `捕获失败`，不能误显示 `已记录`。
- 豆包回答原始捕获不应截断；但保存、转移、总结时仍然必须走统一长度保护，避免超长内容拖慢页面或塞爆目标输入框。

### 总结

总结目标下拉应包含当前启用且支持文本输入的平台。

需要确认：

- 可以选择豆包作为总结目标。
- 总结来源历史能包含豆包回答。
- 总结生成后写入历史记录。
- 只有当豆包 `supportsText` 验证通过后，豆包才作为总结目标出现。
- 总结来源可以包含豆包的 captured 回答；pending / failed 回答要按现有“待回填 / 发送失败”文案进入预览。

### 转移

每个 panel 的“转移”按钮应从能力模型派生：

- 支持 `supportsLastResponse` 的平台才能作为转移来源。
- 支持 `supportsText` 的平台才能作为转移目标。

风险：

- 如果豆包 adapter 不能稳定读取最后回答，豆包作为来源会失败。
- 如果豆包 adapter 不能稳定发送，豆包作为目标会失败。

## 测试计划

### 单元测试

新增或更新：

1. `tests/unit/user-settings.test.ts`
   - 默认 ChatGPT/Gemini 开启，豆包关闭。
   - 旧设置缺少豆包时自动补齐。
   - 加载异常旧设置时至少恢复到 2 个可用平台。
   - UI 层关闭到少于 2 个时应阻止。
   - UI 层打开到超过 3 个时应阻止。
   - 不强制恢复 ChatGPT + Gemini，允许 ChatGPT + 豆包、Gemini + 豆包。

2. `tests/unit/chat-html.test.ts`
   - 页面包含 3 个 `.panel`。
   - 豆包 panel 默认存在于 DOM。
   - 有 2 条 `.splitter`。
   - 每个 panel 都有状态元素。

3. `tests/unit/ai-platforms.test.ts`
   - `AI_PLATFORMS` 包含 `chatgpt/gemini/doubao`。
   - activePlatforms 能从 DOM 派生可见平台。
   - `SUPPORTED_PLATFORMS` 和 `MAX_ACTIVE_PLATFORMS` 是统一来源。
   - 平台能力能派生 @ 候选、总结目标和转移目标。

4. `tests/unit/file-handler.test.ts`
   - 豆包不支持图片自动上传。
   - inline-text 文件可以被发送给豆包。

### 手动验证

1. 默认打开 AIChatRoom：
   - 只显示 ChatGPT + Gemini。
   - 左右两栏正常。

2. 设置页打开豆包：
   - 显示三栏。
   - 豆包 iframe 能加载。
   - 状态显示“已打开”或合理错误。
   - 每栏约 1/3 宽度时，豆包没有切到不可操作的移动端/H5 页面。
   - 没有出现强制 App 下载弹窗遮挡输入框。

3. 发送纯文本：
   - 空目标发送给 3 个 AI。
   - `@doubao` 只发豆包。
   - `@chatgpt @doubao` 只发这两个。

4. 回答捕获：
   - 豆包回答结束后写入历史。
   - 原始捕获不截断长回答。
   - 保存、转移、总结仍然使用统一长度保护。

5. 总结：
   - 历史记录里包含豆包回答。
   - 能把总结目标设为豆包。

6. 附件：
   - 图片发给 3 个 AI 时，豆包不能自动上传时要提示，不影响其它 AI。

7. 最少 / 最多：
   - 尝试只保留 1 个 AI，应被阻止。
   - 同时最多 3 个。
   - 可以保留 Gemini + 豆包 或 ChatGPT + 豆包。

8. 3 栏窄屏：
   - 输入框仍可定位。
   - 发送按钮仍可定位。
   - 回答 DOM 没有因为窄屏切换而换成另一套 selector。
   - 如果页面切换到 H5 DOM，记录 selector 差异后再决定是否支持。

## 分阶段实施建议

### 阶段 1：平台注册和布局

目标：

- 类型和设置支持豆包。
- 主界面能显示 3 栏。
- 设置页能开关豆包。
- 不加载豆包真实页面，不要求豆包真正能发送。

验证：

- typecheck/test/build 通过。
- 打开设置页启用豆包后，三栏布局出现。
- 设置规则能阻止少于 2 个和超过 3 个。

### 阶段 2：豆包 iframe、DNR 和可加载性探针

目标：

- 豆包能在 iframe 中加载。
- 状态检测能识别官方页面是否打开。
- content script 能注入成功。
- iframe 内能复用登录态。

验证：

- iframe 不报 X-Frame-Options / CSP 拦截。
- 未登录/已登录状态能被基本识别。
- 如果这一步不稳定，先停止，不进入发送和读取。

### 阶段 3：豆包纯文本发送

目标：

- content script 注入豆包。
- adapter 可以写入输入框并发送。

验证：

- 手动发送 “你好” 到豆包成功。
- `@doubao` 只发豆包成功。

### 阶段 4：豆包回答捕获

目标：

- 能读取最后一条回答。
- 能判断 streaming / finished。

验证：

- 原始长回答捕获不截断。
- selector 不稳定时显示 pending / failed，不误报 captured。

### 阶段 5：接入历史、总结和转移

目标：

- 历史记录能保存豆包回答。
- 总结来源可以包含豆包回答。
- 豆包在能力允许时可以作为总结目标。
- 豆包在能力允许时可以作为转移来源或目标。

验证：

- 历史详情显示豆包回答状态。
- 总结预览能展示豆包回答。
- 转移动作遵守 capability，不向不支持的平台发送。

### 阶段 6：附件能力与体验优化

目标：

- 保持豆包第一版图片/文件自动上传关闭。
- 如果后续验证豆包支持文件，再单独扩展能力。
- 评估是否需要 ChatBrawl 风格悬浮菜单。

验证：

- 图片发送到 3 个 AI 时，豆包被跳过并提示，不影响其它平台。

### 阶段 7：收尾和发布

目标：

- 补齐单元测试和手动验证文档。
- 提交并发布新版本。

验证：

- `npm run typecheck`
- `npm test`
- `npm run build`
- 浏览器手动验证 2 栏和 3 栏。

## 已知风险

1. 豆包可能禁止 iframe 嵌入。
2. 豆包登录态可能在 iframe 内不可用。
3. 豆包输入框可能不是普通 textarea，需要像 Gemini 一样特殊写入。
4. 豆包发送按钮可能依赖内部框架状态，简单 click 可能无效。
5. 豆包回答 DOM 结构可能变化快，selector 需要保守。
6. 3 栏下每栏宽度变窄，官方页面自身响应式可能表现不一致。
7. 豆包可能在 1/3 栏宽度下切换到移动端/H5 DOM，导致输入框、发送按钮、回答 selector 都变化。
8. 豆包可能跳转到其它子域名，需要根据实际跳转补充 host permissions 和 content script matches。
9. User-Agent 伪装可以作为防止 H5 降级的备选方案，但不作为第一阶段默认依赖；先实际验证 3 栏宽度下的页面表现。

## 决策

本轮先采用“设置页启用豆包”的方案。

豆包第一版定位为“第三个可选文本 AI”：

- 先完成 iframe 加载。
- 再完成纯文本发送。
- 再完成最后回答读取。
- 最后接入历史、总结、转移。

ChatBrawl 风格悬浮菜单作为后续增强，不进入豆包第一阶段接入范围。
