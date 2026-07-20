# ChatDuel 本地循环诊断记录设计

## 背景

ChatDuel 通过 iframe 或官方标签页操作各 AI 官网，并根据页面 DOM 推断消息是否发送、回答是否仍在生成以及回答是否完成。官网响应较慢、页面结构变化或跨 frame 消息超时时，可能出现“官网已经生成回答，但 ChatDuel 显示发送失败”的情况。

现有回答抓取调试日志需要用户提前开启，并且只输出到浏览器控制台。用户在问题发生后通常无法提供完整的前后过程，因此需要一份默认可用、只保存在本机、可以由用户主动导出的诊断记录。

## 目标

- 覆盖所有已支持的平台：ChatGPT、Gemini、Claude、豆包和 DeepSeek。
- 记录一次发送从开始到成功、完成或失败的技术轨迹。
- 明确区分发送失败、通信超时、回答仍在生成、回答抓取超时和页面结构识别失败。
- 用户遇到问题后，可以在“设置 → 诊断”中复制或下载记录并主动提供给开发者。
- 遵循 Chrome Web Store 的最小数据、明确披露和用户主动分享原则。

## 非目标

- 不自动上传诊断记录到 ChatDuel 服务器或第三方服务。
- 不保存用户的问题、AI 回答、附件内容、网页 URL、官方会话链接或账号信息。
- 不利用诊断记录进行用户画像、广告、使用统计或与故障排查无关的分析。
- 本次不改变各平台现有的发送、完成或超时判定规则。

## 方案

### 1. 统一诊断事件

新增独立的本地诊断记录模块。所有平台使用同一份事件结构，平台适配器只提供平台特有的阶段、状态和错误原因。

标识分为两层，并用数字表示重试次数：

- `batchId`：一次用户发送操作。群发到多个 AI 时共用同一个值。
- `platformRunId`：这次发送中，某个平台的一条完整执行链。
- `attempt`：该平台执行链中的重试序号，从 1 开始，不额外生成随机 ID。

每条事件至少包含：

- 事件结构版本 `schemaVersion`。
- 事件时间。
- `batchId`、`platformRunId` 和 `attempt`。
- 平台执行链内的 `runSequence`，以及后台写入器分配的全局 `storageSequence`。
- 扩展版本。
- AI 平台。
- 消息路由：iframe 或官方标签页。
- 组件，例如 chat UI、background、content script、iframe bridge、official tab、platform adapter、response capture 或 storage。
- 操作，例如选择路由、查找输入框、写入、点击发送、等待确认、读取状态、读取回答、比较回答或返回结果。
- 当前阶段，例如开始发送、等待按钮、已点击、等待官网接受、回答中、检查回答、完成或失败。
- `eventStatus`：observed、succeeded、failed、timed-out 或 skipped。
- 仅在终结事件填写 `runOutcome`：completed、paused、failed、timed-out 或 interrupted。批次层可以额外汇总为 partially-completed。
- 稳定的错误代码。
- 实际等待时间和适用的超时上限。
- 页面状态，例如 idle、sending、streaming、paused、finished 或 error。
- 选择器配置版本。
- 必要的非内容型上下文，例如是否有附件、读取到的字符数、是否检测到停止按钮、当前回答是否不同于发送前基线。

错误代码至少区分：

- `input-box-not-found`
- `send-button-not-found`
- `send-button-not-ready`
- `send-ack-timeout`
- `message-not-accepted`
- `iframe-result-timeout`
- `official-tab-unavailable`
- `message-route-unavailable`
- `state-request-timeout`
- `response-selector-empty`
- `response-still-streaming`
- `response-equals-baseline`
- `response-capture-timeout`
- `content-script-unavailable`
- `extension-context-invalidated`
- `tab-closed`
- `tab-navigation-detected`
- `input-write-failed`
- `send-click-failed`
- `attachment-preparation-timeout`
- `diagnostic-storage-failed`
- `diagnostic-schema-invalid`
- `unexpected-error`

底层异常的原始字符串不得直接保存。保存前需要映射为稳定错误代码和经过白名单限制的技术字段，避免第三方错误信息意外带入用户内容或 URL。

项目不为此引入新的 schema 依赖。诊断模块提供运行时校验和净化函数，只构造并返回预定义字段；未知字段、类型不匹配、枚举范围外和超长字段直接丢弃，并在控制台输出不含原始值的固定警告。读取旧数据时按 `schemaVersion` 做兼容净化，无法识别的记录跳过，不能让诊断界面崩溃。

### 2. 全平台数据流

一次发送开始时创建 `batchId`，为每个目标平台创建 `platformRunId`，并把它们传递到发送路由、对应平台 content script、平台 adapter 和回答回填流程。

所有平台记录相同的主干轨迹：

1. 创建发送任务。
2. 选择 iframe 或官方标签页路由。
3. 查找输入框并写入。
4. 查找并点击发送按钮。
5. 等待官网接受消息。
6. 定期读取官网生成状态，但只在状态变化或稀疏检查点写入事件。
7. 检查是否出现不同于发送前基线的新回答。
8. 回答完成、用户暂停、通信失败或等待超时。

ChatGPT、Gemini、Claude、豆包和 DeepSeek 均接入这条主干。平台特有行为，例如 DeepSeek 识图模式切换或不同平台的附件准备，只增加对应阶段事件，不建立独立日志系统。

单个平台失败不会阻止其它平台继续记录。一次群发中的平台共享 `batchId`，各自使用独立的 `platformRunId`。发送按钮内部重试使用递增的 `attempt` 区分。

轮询不逐次落盘。仅在状态或关键布尔值变化、等待达到 5 秒/15 秒/30 秒/60 秒等检查点，以及出现最终结果时记录。最终事件汇总 `pollCount`、`stateChangeCount` 和 `lastObservedState`，减少重复事件。

### 3. 本地循环保存

- 使用现有 `storage` 权限保存到 `chrome.storage.local`，不申请新权限。
- 默认自动记录，不要求用户在问题发生前开启开关。
- 最多保留最近 20 个发送批次、100 个平台执行链、1000 条事件、最近 7 天，且序列化总大小不超过 1 MB。
- 任一上限触发时，从最旧的完整 `batchId` 开始整体淘汰，不截断一次群发或其中某个平台的执行链。
- 存储写入失败不得影响消息发送；仅在控制台输出固定前缀的技术警告。
- 清除浏览器扩展数据或卸载扩展时，记录随本地扩展数据一并删除。

所有 content script、adapter 和 chat 页面只发送诊断事件，不直接读改诊断 storage。后台 Service Worker 是唯一写入者：它先执行 schema 净化，再通过串行队列追加；同时到达的少量事件可以合并为一次写入，并在对应 runtime message 响应前完成落盘。这样不依赖不可靠的页面卸载回调，也避免多个上下文读改写同一个 key 时互相覆盖。

`runSequence` 由平台执行链产生；`storageSequence` 只由后台写入器分配。跨平台按 `storageSequence` 和时间近似排序，单个平台执行链按 `runSequence` 还原。

### 4. 隐私边界

诊断记录禁止保存：

- 问题或回答的正文、前缀、摘要和哈希。
- 附件名称、附件内容或本地路径。
- 当前网页 URL、官方会话 ID、标签页标题。
- 用户名、邮箱、账号标识、Cookie、Token 或其它凭据。
- DOM 的 `textContent`、`innerHTML`、完整 class 列表或任意未经过白名单的异常消息。

允许保存：

- 问题和回答的字符数。
- 是否包含附件及附件的大类，不包含文件名。
- 是否找到目标 DOM、是否为空、是否不同于基线等布尔值。
- 预先定义的状态、阶段、错误代码、计时和版本号。

诊断模块对写入字段采用白名单结构，不接受任意对象直接落盘。测试需要验证类似问题正文、回答正文、URL 和文件名的诱饵字符串不会出现在序列化结果中。

### 5. 诊断界面

在“设置 → 诊断”中保留现有详细控制台调试开关，并新增本地诊断记录区域：

- 显示当前记录数量和最早记录时间。
- “查看最近诊断”：按 `batchId` 和 `platformRunId` 分组显示，可折叠查看完整轨迹。
- “复制诊断记录”：复制格式化 JSON。
- “复制最近一次失败”：只复制包含最近失败平台执行链的批次。
- “下载 JSON”：使用现有下载能力导出。
- “清空记录”：清除前要求用户确认，并立即更新数量。
- “本地诊断记录”开关：默认开启；关闭后不新增事件，并让用户选择保留或清空已有记录。

界面明确显示：

> 诊断记录只保存在本机，不包含问题和回答正文。只有你主动复制、下载或发送时，记录才会离开设备。

复制或下载前先显示实际 JSON 预览，让用户可以人工检查。导出文件包含字段说明、扩展版本、导出时间和诊断事件，不包含其它设置或历史记录。

首次安装以及首次升级到包含该功能的版本时，显示一次简短说明：默认在本机保存最少量技术诊断记录、不包含对话正文、不会自动上传，并可以随时关闭或清空。

### 6. Chrome Web Store 合规

- 本地诊断数据仅用于维护和排查扩展核心发送、读取功能的可靠性。
- 不自动传输，不增加远程服务，不增加浏览器权限。
- 在扩展内清楚说明记录内容、用途、本地保存、保留周期、清除方式和主动导出行为。
- 更新商店隐私政策，补充本地诊断记录的字段范围、用途、7 天及批次/执行链/事件/体积上限和用户清除方式。
- 在上架前将隐私政策中的联系邮箱占位符替换为正式联系方式。
- 在 Chrome Web Store Developer Dashboard 的隐私披露中，按照最终实现准确声明本地处理的数据类型和用途。

### 7. 错误状态与诊断记录的关系

用户界面继续显示简短状态，但诊断记录必须保留具体原因。例如同样显示“发送失败”时，日志可以分别记录 `iframe-result-timeout` 或 `response-capture-timeout`。

当前平台 adapter 的 `paused` 只能说明页面出现“继续生成”按钮，不能证明一定由用户主动点击停止。因此它使用非错误结局 `paused`，不命名为 `paused-by-user`。只有 ChatDuel 自己明确接收到用户取消操作时，才可以记录用户主动取消；当前版本不虚构无法观测的原因。

回答较长时，如果达到当前回填上限，记录最后一次检测到的页面状态、已等待时长、回答字符数、停止按钮是否存在以及超时上限。不得记录回答文本。

诊断日志是排查证据，不保证能够完整复现第三方官网当时的页面状态。导出内容需要包含这一说明，避免把日志描述成完整会话快照。

## 测试与验收

至少覆盖：

- 五个平台都能写入统一格式的发送阶段和最终结果。
- 群发事件可以通过 `batchId` 串联，各平台通过 `platformRunId` 区分，重试通过 `attempt` 区分。
- 正常完成、发送确认超时、iframe 结果超时、回答抓取超时和页面状态请求超时均有稳定错误代码。
- 只有状态变化、稀疏检查点和最终结果会形成事件，逐次轮询不会产生大量重复记录。
- 任一保存上限触发后，只按完整批次淘汰，不留下半条执行链。
- 超过 7 天的事件会被清除。
- 两个平台并发各写入 50 条事件时，不丢失、不覆盖，并由后台分配唯一 `storageSequence`。
- 未知字段、错误类型、枚举外值和旧 schema 数据会被净化或安全跳过。
- 本地写入失败不影响正常发送。
- 复制、下载和清空功能正常。
- 日志序列化结果不包含问题正文、回答正文、附件名、URL 或原始异常消息。
- 不新增 manifest 权限，不发生自动网络上传。
- 现有发送、回答抓取、历史记录和设置测试继续通过。

## 风险与控制

- 官网状态仍可能因页面改版而误判：通过稳定错误代码、版本号和选择器版本保留排查依据。
- 保存范围仍不能覆盖很久以前的问题：界面提示用户遇到问题后尽快导出，不扩大默认收集范围。
- 多个异步事件可能乱序：后台分配全局写入序号，平台执行链保留自己的顺序，导出时稳定排序。
- 平台异常字符串可能包含敏感内容：禁止直接保存原始异常，只允许经过映射的代码和白名单字段。
- 七天淘汰依赖系统时间；不引入无法跨 frame、Service Worker 重启和浏览器重启比较的单调时钟。批次、执行链、事件和体积硬上限保证系统时间异常时存储仍然有界。

## 参考政策

- [Chrome Web Store User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Chrome Web Store Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
- [Chrome Web Store Privacy Policies](https://developer.chrome.com/docs/webstore/program-policies/privacy)
