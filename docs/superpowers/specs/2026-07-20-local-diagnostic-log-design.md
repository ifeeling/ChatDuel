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

标识分为两层：

- `batchId`：一次用户发送操作。群发到多个 AI 时共用同一个值。
- `platformRunId`：这次发送中，某个平台的一条完整执行链。

当前源码没有重新执行整条平台链路的业务重试，只有按钮点击或 Enter 等步骤内部重试，因此 schema 不保存永远为 1 的 `attempt`。步骤重试使用 `retryNumber`，并在最终事件中汇总 `retryCount`。未来真正增加整链重试时再升级 schema。

每条事件至少包含：

- 事件结构版本 `schemaVersion`。
- 事件时间。
- `batchId` 和 `platformRunId`。
- reporter 实例唯一的 `producerId` 和该生产者内部递增的 `producerSequence`。
- 后台写入器分配的全局 `storageSequence`。
- 扩展版本。
- AI 平台。
- 消息路由：iframe 或官方标签页。
- 组件，例如 chat UI、background、content script、iframe bridge、official tab、platform adapter、response capture 或 storage。
- 操作，例如选择路由、查找输入框、写入、点击发送、等待确认、读取状态、读取回答、比较回答或返回结果。
- 当前阶段，例如开始发送、等待按钮、已点击、等待官网接受、回答中、检查回答、完成或失败。
- `eventStatus`：observed、succeeded、failed、timed-out 或 skipped。其中 `skipped` 只表示该步骤按设计不适用或无需执行，例如无附件发送跳过附件准备；不得用作未知状态或错误兜底。
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
- `unexpected-error`

底层异常的原始字符串不得直接保存。保存前需要映射为稳定错误代码和经过白名单限制的技术字段，避免第三方错误信息意外带入用户内容或 URL。

项目不为此引入新的 schema 依赖。诊断模块提供运行时校验和净化函数，只构造并返回预定义字段；未知字段、类型不匹配、枚举范围外和超长字段直接丢弃，并在控制台输出不含原始值的固定警告。`batchId`、`platformRunId`、版本、序号、计时和计数字段都有固定格式及数值范围。读取数据时按 `schemaVersion` 做兼容净化；完全没有版本号、无法识别或无法迁移的记录直接跳过，不能让诊断界面崩溃。

诊断系统内部故障不进入同一份持久化日志。schema 校验失败或 storage 写入失败只输出限频的固定控制台警告，并可在当前后台生命周期内保留一个内存状态供诊断页显示。禁止为了记录诊断系统写入失败而再次调用诊断 writer，也不无限重试。

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

单个平台失败不会阻止其它平台继续记录。一次群发中的平台共享 `batchId`，各自使用独立的 `platformRunId`。步骤内部重试只记录 `retryNumber` 或 `retryCount`。

轮询不逐次落盘。仅在状态或关键布尔值变化、等待达到 5 秒/15 秒/30 秒/60 秒等检查点，以及出现最终结果时记录。最终事件汇总 `pollCount`、`stateChangeCount` 和 `lastObservedState`，减少重复事件。

### 3. 本地循环保存

- 使用现有 `storage` 权限保存到 `chrome.storage.local`，不申请新权限。
- 默认自动记录，不要求用户在问题发生前开启开关。
- 最多保留最近 20 个发送批次、100 个平台执行链、1000 条事件、最近 7 天，且序列化总大小不超过 1 MB。
- 任一上限触发时，从最旧的完整 `batchId` 开始整体淘汰，不截断一次群发或其中某个平台的执行链。
- 单个发送批次最多 200 条事件和 256 KB；单个 `platformRunId` 最多 50 条事件。
- 存储写入失败不得影响消息发送；仅在控制台输出固定前缀的技术警告。
- 清除浏览器扩展数据或卸载扩展时，记录随本地扩展数据一并删除。

如果当前批次或平台执行链自身达到上限，按固定优先级保留：终结事件、失败/超时事件、每个生产者的起始事件、状态变化、首次达到的稀疏检查点，剩余容量保留最新事件；同一事件只保留一次，最终按 `storageSequence` 排序。被省略的中间事件折叠为 `eventsTruncated: true` 和 `droppedEventCount`。截断元数据分别按 batch 和 run 保存；整体淘汰 batch 时同步删除其元数据。

所有 content script、adapter 和 chat 页面只发送诊断事件，不直接读改诊断 storage。后台 Service Worker 是唯一写入者，append、summary、snapshot 和 clear 全部进入同一条命令队列串行执行。事件已经按状态变化和稀疏检查点降频，不再引入短定时批处理；每条事件串行写入，行为更确定。业务发送流程以 fire-and-forget 方式提交诊断事件，不等待诊断结果；后台则在持久化完成后才响应对应 runtime message，使 Chrome 在写入期间保持 Service Worker 生命周期。

体积检查在每次合并写入时对最多 1 MB 的候选日志做一次完整序列化，以准确计算转义后的 UTF-8 大小。不维护容易在 Service Worker 重启后失准的运行时字节累加器。

每个 reporter 实例创建一次唯一且稳定的 `producerId`，并用自己的 `producerSequence` 表达内部顺序；同一 reporter 生命周期内不能重置序号。`storageSequence` 只由后台写入器分配，表示后台实际接收并持久化的全局顺序。查看和导出按 `storageSequence` 排序，必要时结合生产者时间和 `producerSequence` 理解跨上下文的并发事件；不让多个上下文各自生成会重复的 `runSequence`。

`storageSequence` 不能只存在内存中。持久化数据同时保存下一个可用序号；Service Worker 初始化写入器时，读取该值并与已保存事件中的最大序号核对，从更大的值继续分配，保证重启后新事件序号仍严格递增。

清空、摘要、快照和追加共享同一队列。清空命令移除其之前的全部事件、重置 cache 和序号为 1；清空命令之后进入队列的新事件正常保留。损坏、无版本或未知版本的 envelope 安全回退为空 envelope。

### 4. 隐私边界

诊断记录禁止保存：

- 问题或回答的正文、前缀、摘要和哈希。
- 附件名称、附件内容或本地路径。
- 当前网页 URL、官方会话 ID、标签页标题。
- 用户名、邮箱、账号标识、Cookie、Token 或其它凭据。
- DOM 的 `textContent`、`innerHTML`、完整 class 列表或任意未经过白名单的异常消息。

允许保存：

- 问题和回答的字符数。只接受 0 到 100000 的整数，超过上限时按 100000 记录。
- 是否包含附件及附件的大类，不包含文件名。
- 是否找到目标 DOM、是否为空、是否不同于基线等布尔值。
- 预先定义的状态、阶段、错误代码、计时和版本号。

诊断模块对写入字段采用白名单结构，不接受任意对象直接落盘。测试需要验证类似问题正文、回答正文、URL 和文件名的诱饵字符串不会出现在序列化结果中。

### 5. 诊断界面

在“设置 → 诊断”中保留现有详细控制台调试开关，并新增本地诊断记录区域：

- 显示当前记录数量和最早记录时间。
- “查看最近诊断”：设置区初始只加载记录数量、最早时间和写入状态；用户主动点击查看或准备导出时才读取完整快照，再按 `batchId` 和 `platformRunId` 分组展示。
- “复制诊断记录”：复制格式化 JSON。
- “复制最近一次失败”：按最终结果定位最近失败的平台执行链，并复制它所属的完整批次，包含同批次成功平台作为时间线对照。
- “下载 JSON”：把用户已预览确认的同一份字符串创建为 Blob，通过用户点击的 `<a download>` 导出并及时释放 object URL；不调用 `chrome.downloads` API，不新增权限。
- “清空记录”：清除前要求用户确认，并立即更新数量。
- “本地诊断记录”开关：默认开启；关闭后不新增事件，并让用户选择保留或清空已有记录。
- 后台当前生命周期发生过写入或 schema 错误时，诊断区域显示“本地诊断写入异常”；该状态只来自后台内存，不写入诊断日志。

界面明确显示：

> 诊断记录只保存在本机，不包含问题和回答正文。只有你主动复制、下载或发送时，记录才会离开设备。

复制或下载前先显示摘要；用户展开后使用只读纯文本区域显示实际 JSON，不使用 `innerHTML`。预览、复制和下载复用同一次生成的序列化字符串，用户确认后不重新读取日志，保证三者字节一致。导出文件包含导出 schema 版本、字段说明版本、扩展版本、导出时间、固定的“不是完整会话快照”说明、保留策略和诊断事件，不包含其它设置或历史记录。

首次安装以及首次升级到包含该功能的版本时，显示一次简短说明：默认在本机保存最少量技术诊断记录、不包含对话正文、不会自动上传，并可以随时关闭或清空。

提示使用独立的 `diagnosticNoticeVersionSeen` 版本号，仅当已读版本小于当前提示版本时显示。`diagnosticEnabled` 只在该设置不存在时初始化为 `true`；后续升级不能把用户已经关闭的设置重新打开。只有诊断数据处理范围发生实质变化时才提高提示版本。

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

终结事件有明确所有权：官网接受消息前，由发送链路在输入、按钮、确认或路由失败时终结；一旦记录 `send-ack/accepted`，发送层不再写 `runOutcome`，之后只由 chat 页的回答 tracker 写 completed、paused、failed、timed-out 或 interrupted。导出层校验同一 `platformRunId` 最多一个有效终结结果，冲突记录标记为结构异常，不能简单用数组最后一条覆盖。

`interrupted` 表示平台执行链没有正常完成，并且 ChatDuel 已无法继续观察最终状态。它必须同时带有可观测的原因代码，例如 `extension-context-invalidated`、`tab-closed`、`tab-navigation-detected`、`content-script-unavailable`、`official-tab-unavailable` 或 `message-route-unavailable`，不允许保存没有原因的裸 `interrupted`。

回答较长时，如果达到当前回填上限，记录最后一次检测到的页面状态、已等待时长、回答字符数、停止按钮是否存在以及超时上限。不得记录回答文本。

诊断日志是排查证据，不保证能够完整复现第三方官网当时的页面状态。导出内容需要包含这一说明，避免把日志描述成完整会话快照。

“复制最近一次失败”只匹配最终 `runOutcome` 为 `failed`、`timed-out` 或 `interrupted` 的平台执行链，按终结事件的 `storageSequence` 查找最近一条，并导出其完整批次。`paused` 和步骤内部重试不属于最终失败。

如果某个执行链没有终结事件、最后事件已超过 10 分钟且当前不存在对应活跃任务，查看和导出时派生显示 `derivedOutcome: abandoned` 与 `derivedReason: missing-terminal-event`。这是导出时的说明，不补写或伪造历史事件。

## 测试与验收

至少覆盖：

- 五个平台都能写入统一格式的发送阶段和最终结果。
- 群发事件可以通过 `batchId` 串联，各平台通过 `platformRunId` 区分；不同执行上下文通过 `producerId`/`producerSequence` 区分，后台用唯一 `storageSequence` 排序。
- 正常完成、发送确认超时、iframe 结果超时、回答抓取超时和页面状态请求超时均有稳定错误代码。
- 只有状态变化、稀疏检查点和最终结果会形成事件，逐次轮询不会产生大量重复记录。
- 任一保存上限触发后，只按完整批次淘汰，不留下半条执行链。
- 单批次或单平台执行链异常膨胀时，记录保持有界，并保留起始、关键、最近和终结信息以及截断计数。
- 超过 7 天的事件会被清除。
- 两个平台并发各写入 50 条事件时，不丢失、不覆盖，并由后台分配唯一 `storageSequence`；不同 reporter 的生产者序号不会被误当作全局顺序。
- 模拟 Service Worker 重启后，新事件的 `storageSequence` 严格大于已持久化最大值。
- append、summary、snapshot 和 clear 并发时遵守同一命令队列边界；clear 后序号从 1 重新开始。
- 发送确认前后只产生一个符合所有权规则的有效终结结果。
- 未知字段、错误类型、枚举外值、缺少 `schemaVersion` 和无法迁移的数据会被安全跳过，界面不崩溃。
- 本地写入失败不影响正常发送。
- storage 持续写入失败或 schema 持续校验失败时，不递归写诊断、不无限重试，只限频输出固定控制台警告。
- 用户关闭诊断后升级，设置保持关闭；提示版本未变化时不重复显示。
- 步骤内部重试后最终成功时，不被“复制最近一次失败”识别为最终失败。
- 缺少终结事件的执行链安全显示为派生的“未观测到最终结果”。
- 预览、剪贴板和下载文件使用同一份序列化字符串。
- 复制、下载和清空功能正常。
- 日志序列化结果不包含问题正文、回答正文、附件名、URL 或原始异常消息。
- 不新增 manifest 权限，不发生自动网络上传。
- 现有发送、回答抓取、历史记录和设置测试继续通过。

## 风险与控制

- 官网状态仍可能因页面改版而误判：通过稳定错误代码、版本号和选择器版本保留排查依据。
- 保存范围仍不能覆盖很久以前的问题：界面提示用户遇到问题后尽快导出，不扩大默认收集范围。
- 多个异步事件可能乱序：后台分配全局写入序号，每个执行上下文通过 `producerId` 和 `producerSequence` 保留自身顺序，导出时稳定排序；不虚构跨上下文的因果顺序。
- 平台异常字符串可能包含敏感内容：禁止直接保存原始异常，只允许经过映射的代码和白名单字段。
- 七天淘汰依赖系统时间；不引入无法跨 frame、Service Worker 重启和浏览器重启比较的单调时钟。批次、执行链、事件和体积硬上限保证系统时间异常时存储仍然有界。

## 参考政策

- [Chrome Web Store User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Chrome Web Store Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
- [Chrome Web Store Privacy Policies](https://developer.chrome.com/docs/webstore/program-policies/privacy)
