# 回答抓取维护手册

这份文档记录历史记录“回答抓取”踩过的坑和当前处理方式。以后如果 DeepSeek、豆包或其它官网页面结构变化，先看这里，再改适配器代码。

## 背景

ChatDuel 不是调用各平台 API，而是在 iframe 里操作用户已登录的官方网页。因此历史记录里的回答来自官方网页 DOM。官网 DOM 会频繁变化，class 也可能是混淆名，所以抓取逻辑必须同时处理：

- 哪一块是用户问题。
- 哪一块是 AI 回答。
- 哪一块只是外层列表容器。
- 回答是否还在生成中。
- 搜索模式下的“参考资料、建议问题、引用编号”等杂质。

这几个问题不要混在一起修。先保证边界正确，再做内容清理。

## 调试方法

设置页里打开：

`诊断 -> 回答抓取调试日志`

然后复现问题，在控制台过滤：

`[ChatDuel capture debug]`

重点看这些字段：

- `event: "candidates"`：当前平台候选节点列表。
- `selected`：最终选中的节点。
- `event: "backfill-poll"`：回填轮询状态。
- `textPreview`：这次读到的文本。
- `baselinePreview`：发送前已有的旧文本。
- `previousStableCount` / `nextStableCount`：文本稳定计数。
- `event: "history-capture"`：最终保存进历史的文本。

如果 `selected` 已经选错，问题在平台 adapter 的候选选择逻辑。  
如果 `selected` 对，但 `history-capture` 不对，再看回填和保存逻辑。  
如果历史里一直 pending，看 `backfill-timeout` 和完成状态判断。

## 这次踩过的坑

### 1. 不能只按“最后一个匹配节点”抓回答

DeepSeek、豆包页面里会同时出现：

- 用户问题。
- AI 回答。
- 搜索状态。
- 参考资料。
- 建议问题。
- 整个对话列表容器。

这些节点都可能匹配宽泛 selector，例如 `main div`、`[class*="message"]`。所以只能按候选评分和平台特征选择，不能简单取最后一个 DOM 节点。

### 2. DeepSeek 的 class 会变化

观察到的 DeepSeek 行为：

- 当前最新回答常见 class：`_4f9bf79 d7dc56a8 _43c05b5`
- 当继续发下一条消息后，旧回答可能变成：`_4f9bf79 _43c05b5`
- 用户气泡曾出现过：`_9663006 ...`
- 用户气泡也曾出现过：`d29f3d7d ds-message _63c77b1`

因此 DeepSeek 当前逻辑：

- 把 `_9663006` 和 `d29f3d7d` 识别为用户消息。
- 优先保留 `_4f9bf79 d7dc56a8 ...` 这类当前回答块。
- 避免让 `p.ds-markdown-paragraph`、`li` 这种碎片段落压过完整回答块。

### 3. 豆包会有外层列表容器

豆包曾出现两类外层容器：

- `message-list...`
- `v_list-D34x3M`

如果把这些容器当回答，会把多轮对话、用户问题和旧回答一起保存进历史。

因此豆包当前逻辑：

- 遇到 `message-list` / `v_list` 先拆成直接子节点。
- 排除列表容器本身。
- 不让“整段列表”胜过单条回答。

### 4. 搜索短答案容易输给用户问题

豆包搜索结果可能很短，例如：

`搜索 2 个关键词，参考 11 篇资料 奥亚萨瓦尔 参考 11 篇资料`

如果把所有 `搜索/参考` 都强行降权，用户问题反而会胜出。现在豆包逻辑区分：

- `正在搜索`：降权。
- 纯 `参考 N 篇资料`：降权。
- 带实际答案的 `搜索 N 个关键词...答案...参考 N 篇资料`：加权。

### 5. 旧历史不能被后续轮次覆盖

一轮回答完成后，对应历史记录不应再被后续消息改写。当前历史保存层只允许 pending 状态继续回填，已经 captured 的回答不会被覆盖。

### 6. 回填不能无限等待

如果长时间没有稳定文本，回填会超时，将仍 pending 的平台标记为 failed，并解锁发送状态。这样不会一直等。

## 当前责任边界

### `src/chat/chat.ts`

负责：

- 发送前读取 baseline。
- 轮询各平台回答。
- 等回答稳定后保存历史。
- 超时兜底。

不负责：

- 判断某个平台哪个 DOM 节点是回答。
- 清理某个平台的搜索杂质。

### `src/adapters/deepseek/adapter.ts`

负责 DeepSeek：

- 输入、发送、停止按钮识别。
- 候选回答节点选择。
- DeepSeek 专属用户气泡过滤。
- DeepSeek 专属回答块扩展。

### `src/adapters/doubao/adapter.ts`

负责豆包：

- 输入、发送、停止按钮识别。
- 外层列表容器拆分。
- 搜索结果、参考资料、建议问题的候选评分。
- 豆包专属回答节点选择。

## 后续内容清理建议

内容清理应单独做，不要和边界选择混在一起。

### DeepSeek 清理

建议新增平台专属函数，例如：

`cleanDeepSeekResponseText(text: string): string`

优先只清高确定性杂质：

- 开头或结尾的 `已阅读 N 个网页`
- 结尾的 `N 个网页`
- 引用编号，例如 `-1`、`-2`、`-5`、`-8`

不要一开始就做激进正则，避免删掉答案正文。

### 豆包清理

建议先 DOM 层过滤，再文本层清理：

- DOM 层排除 `suggest-list-item`、`suggest-message` 等建议问题节点。
- 文本层去掉 `搜索 N 个关键词，参考 N 篇资料`。
- 文本层去掉 `参考 N 篇资料`。
- 去掉末尾建议问题行。

短答案要保留，例如 `奥亚萨瓦尔`。

## 改动检查清单

改回答抓取逻辑时，至少跑：

```bash
npm test -- tests/unit/deepseek-adapter.test.ts tests/unit/doubao-adapter.test.ts
npm run typecheck
npm test
npm run build
```

如果涉及历史保存，还要重点看：

```bash
npm test -- tests/unit/session-record.test.ts tests/unit/response-capture.test.ts
```

## 新增回归测试的原则

每次从真实日志里发现新 DOM 结构，都应该补一个最小测试。

推荐测试样本来自：

- `candidates[].className`
- `candidates[].textPreview`
- `selected`
- `history-capture.textPreview`

测试要直接表达用户看到的问题，例如：

- 不把用户问题保存成 DeepSeek 回答。
- 不把豆包整段列表保存成回答。
- 搜索短答案不能输给用户问题。
- 已 captured 的历史不能被下一轮覆盖。

## 不要做的事

- 不要用一个通用正则清理所有平台。
- 不要因为 DeepSeek 的规则影响 Gemini / ChatGPT。
- 不要把内容清理和边界修复混在同一个大改动里。
- 不要只根据 `ok=true` 判断官网已经真正完成回答。

