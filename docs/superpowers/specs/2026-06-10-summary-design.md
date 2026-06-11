# 历史记录 + 一键对比总结 + 文件附件功能设计

**日期**:2026-06-11
**状态**:需求对齐草案
**基线**:`main` 当前 chat 页面 + 设置页 + 跨 AI 转移功能
**作者**:头脑风暴协作(用户 + AI)

---

## 1. 背景

AIChatRoom 现在已经能做到:

- 同时把一个问题发给 ChatGPT 和 Gemini
- 把一边最后一条回答转移给另一边审查
- 在设置里修改“转移提示词”
- 在统一输入框里使用图片、`@` 指定 AI、展开大输入框

下一步要一次性设计三个功能:

1. **历史记录**:把用户在 AIChatRoom 里发起的对照问题、各 AI 的回答、转移、总结等关键内容存到本地。
2. **一键对比总结**:基于最近几轮历史，把多个 AI 的内容合并、去重、比较，整理成一个更可靠、更清楚的结论。
3. **文件附件**:保留现有图片能力，同时支持常见文档格式，尤其是把本项目生成的 `.md` 文档发给 ChatGPT / Gemini 审阅。

这三个功能应该一起考虑。因为“最近几次对话”如果只靠从官方网页 DOM 临时抓，会很脆弱；更稳的做法是先把 AIChatRoom 自己发起的对照过程保存成结构化历史，再让总结功能基于这份历史工作。文件附件也应该进入历史记录，但要区分处理方式:二进制文件不保存本体，`.txt` / `.md` / `.csv` 这类内联文本必须保存最终发送内容，否则后续总结会丢上下文。

---

## 1.1 外部评审意见采纳结论

把文档发给 Gemini 和 ChatGPT 评审后，有几条意见值得采纳:

- **历史记录是底座**:先跑通“纯文本发送 -> 写入本地历史 -> 历史 UI 查看”的最小闭环，再做总结和附件。
- **总结依赖历史**:一键总结不要假设能稳定从官方网页抓多轮历史，默认基于 AIChatRoom 自己保存的 session。
- **文件附件后置**:附件能力会碰到官方上传 DOM、上传等待、文件格式兼容等不确定性，应放在历史和总结之后做，避免把现有图片能力改坏。
- **inline-text 必须进历史**:`.txt` / `.md` / `.csv` 被拼进消息后，要保存 `sentPrompt` 或 `attachments[].inlinedText`，否则“最近几轮总结”只有文件名，没有文件内容。
- **回答和总结要有状态**:`getLastResponse()` 是尽力读取，不保证精确，所以 `responses`、`summaries`、`followUps` 都要能记录 `pending` / `captured` / `failed` 这类状态和错误信息。
- **最近 3/5 轮要防止跨话题**:第一版默认最近 1 轮最稳。最近 3/5 轮要么基于同一个 `conversationId`，要么让用户手动选择范围。
- **上传要等待就绪**:向官方页面注入 `input[type=file]` 后不能立刻发送，需要等待文件 chip、缩略图或 loading 结束；超时后提示用户手动确认。

---

## 2. 产品目标

### 2.1 用户想解决的问题

常见流程:

1. 用户在统一输入框里问 ChatGPT + Gemini 同一个问题
2. 两边各自回答
3. 用户可能把 ChatGPT 的回答转给 Gemini 审查
4. 也可能把 Gemini 的回答转给 ChatGPT 补充
5. 最后用户需要把这些内容合并成一个结论
6. 过几天用户还想找回当时问过什么、两边怎么回答、最后结论是什么

现在第 5、6 步都需要人工复制粘贴或去官方页面翻历史，很累，也容易丢上下文。

### 2.2 功能要做到什么

历史记录要做到:

- 自动记录用户通过 AIChatRoom 发出的原始问题
- 自动记录最终发送给 AI 的内容，包含内联文本文件拼接后的内容
- 自动记录每个 AI 最近一次可读取的回答
- 记录附件信息:文件名、类型、大小、处理方式，以及 inline-text 的文本内容或最终发送 prompt
- 记录转移动作:从哪个 AI 到哪个 AI、用了什么提示词
- 记录总结动作:总结范围、目标 AI、总结提示词、总结结果
- 本地保存，不上传云端
- 能在 UI 里查看、复制、删除历史

一键对比总结要做到:

- 第一版基于历史里的最近 1 轮生成总结提示词
- 后续支持同一 `conversationId` 下的最近 3/5 轮，或由用户手动选择多条历史
- 汇总多个 AI 共同认可的结论
- 找出分歧、矛盾、遗漏和需要确认的地方
- 去掉重复、空话和不确定表达
- 输出一个可以直接使用的最终结论

文件附件要做到:

- 保留现有图片上传能力
- 支持常见文本/文档格式
- `.txt` / `.md` / `.csv` 这类文本文件优先直接读取内容并拼进消息
- 内联文本文件在 1MB 限制内保存到历史上下文，供后续总结使用
- `.pdf` / `.docx` / `.xlsx` 优先尝试真实文件上传，让官方 AI 自己解析
- 上传失败时不丢用户文字，明确提示用户手动上传

### 2.3 第一版不做什么

第一版不要做太复杂:

- 不调任何 AI API
- 不做云端同步
- 不做语义级自动判断谁对谁错
- 不抓官方网页完整多轮 DOM 历史
- 不做全文搜索高级筛选
- 不新增 Claude / DeepSeek / Grok 等平台
- 不支持所有文件格式
- 不在第一版解析 `.pdf` / `.docx` / `.xlsx` 内容
- 不保存附件原始二进制内容到历史；只保存内联文本内容或最终发送 prompt

第一版目标是:本地可保存、可查看、可用于最近 1 轮总结，并为后续多轮总结留好结构。

---

## 3. 当前技术基础

当前项目已有这些可复用零件:

- `chat.html` 双 iframe 显示 ChatGPT / Gemini
- `chat.ts` 已能通过 `postMessage` 读取某一侧最后回答
- `executeTransfer()` 已实现“取源回答 -> 套模板 -> 发给目标 AI”
- `settings` 已支持保存用户设置到 `chrome.storage.local`
- `prompt-template.ts` 已有 `summary` 默认模板
- `user-settings.ts` 已保存“转移提示词”，可以扩展保存“总结提示词”
- `session-store.ts` 已有本地保存、读取、删除、500 条 / 100MB 淘汰逻辑
- `types/index.ts` 已有 `Session` / `SessionFollowUp` / `SessionStats` 基础类型
- 现有图片附件链路已经能把图片转成 dataURL 发给 iframe 内 adapter

需要补齐的是:

- 让 `chat.ts` 在发送、转移、总结时真正写入历史
- 让历史 UI 能读出 `session-store.ts` 里的记录
- 让总结功能优先基于历史记录，而不是直接硬抓官方多轮 DOM
- 把“图片附件”升级成“文件附件”，同时保留图片原有路径

---

## 4. 通用数据模型

### 4.1 设计原则

历史记录要为未来多 AI 扩展留空间。虽然当前只有 ChatGPT / Gemini，但数据结构不要写死“左边/右边”。

建议原则:

- 用 `AIPlatform` 做 key，不用 `left/right`
- `responses` 用 `Partial<Record<AIPlatform, SessionResponse>>`
- 后续转移、总结、引用都记录成事件
- 一个用户原始问题对应一个 `Session`
- 用户每次通过统一输入框点发送，生成一条新的 session
- 同一主题后续要支持 `conversationId`，避免“最近 3/5 轮”跨话题

### 4.2 建议升级后的类型

当前类型可先小改，不必一步到位重构。

建议目标结构:

```ts
export interface Session {
  id: string
  conversationId?: string
  createdAt: number
  updatedAt: number
  prompt: string // 用户在输入框里写的原始内容
  sentPrompt: string // 实际发送给 AI 的内容,包含 inline-text 附件拼接内容
  targetPlatforms: AIPlatform[]
  responses: Partial<Record<AIPlatform, SessionResponse>>
  attachments: SessionAttachment[]
  followUps: SessionFollowUp[]
  summaries: SessionSummary[]
  stats?: SessionStats
}

export interface SessionResponse {
  text: string
  status: 'pending' | 'captured' | 'failed'
  capturedAt?: number
  error?: string
}

export interface SessionAttachment {
  id: string
  name: string
  mime: string
  size: number
  kind: 'image' | 'text' | 'document'
  handling: 'inline-text' | 'file-upload' | 'manual'
  inlinedText?: string // 仅 inline-text 且 1MB 内保存,二进制文件不保存本体
  uploadStatus?: 'pending' | 'ready' | 'failed' | 'manual'
  error?: string
}

export interface SessionFollowUp {
  type: 'transfer' | 'quote' | 'manual'
  from: 'user' | AIPlatform
  to: AIPlatform
  text: string
  promptTemplate?: string
  status: 'pending' | 'sent' | 'captured' | 'failed'
  result?: string
  timestamp: number
  capturedAt?: number
  error?: string
}

export interface SessionSummary {
  id: string
  target: AIPlatform
  range: SummaryRange
  mode: SummaryMode
  prompt: string
  status: 'pending' | 'sent' | 'captured' | 'failed'
  result?: string
  sourceSessionIds: string[]
  timestamp: number
  sentAt?: number
  capturedAt?: number
  error?: string
}

export type SummaryRange = 'latest-1' | 'latest-3' | 'latest-5'
export type SummaryMode = 'final-answer' | 'differences' | 'short-summary'
```

### 4.3 第一版可以简化

第一版为了少改，可以先不完全重构类型，只做这些字段:

- `updatedAt`
- `sentPrompt`
- `conversationId`
- `targetPlatforms`
- `attachments`
- `summaries`
- `responses` 的状态对象

旧字段 `summary?: string` 可以保留兼容，但新代码尽量写 `summaries[]`。

---

## 5. 历史记录功能设计

### 5.1 保存时机

历史记录不是用户手动点“保存”才存，而是自动存。

建议保存节点:

1. 用户点击发送后，立即创建 session
   - 保存用户原始问题
   - 保存最终发送文本 `sentPrompt`
   - 保存目标 AI 列表
   - 保存附件信息
   - 二进制文件只保存元信息，不保存文件本体
   - `inline-text` 文件在 1MB 限制内保存内容或保存已拼接后的 `sentPrompt`
2. 发送后延迟读取各目标 AI 最后一条回答
   - 第一版可以在发送成功后等待几秒，或者用户点历史/总结时再刷新读取
   - 更稳的是“按需刷新”:打开历史详情或点击总结前，主动读取当前最后回答并更新 session
   - 读取不到时记录 `status: 'pending'` 或 `status: 'failed'`，不要把空字符串当成确定结果
3. 用户点击转移时，写入 `followUps[]`
4. 用户点击总结时，写入 `summaries[]`

### 5.2 为什么不强求实时流式保存

实时监听每个 token 更复杂，也容易被官方 DOM 改版影响。

第一版建议:

- 不实时保存流式内容
- 只保存“当前能读取到的最后回答”
- 用户打开历史详情或点击总结时再尝试刷新一次

这样会更稳，也更符合当前项目“每一步能测试”的开发方式。

### 5.3 历史按钮交互

底部已有 `历史`按钮。

点击后建议打开一个侧边面板或弹窗:

```text
历史记录

[搜索框: 后续再做]

今天
  18:32  如何生成海岛日落图标提示词?
        ChatGPT ✓  Gemini ✓  总结 1

昨天
  21:10  某个问题...
        ChatGPT ✓  Gemini ✓
```

第一版不做搜索，只做:

- 按时间倒序
- 显示问题前 60 个字
- 显示包含哪些 AI 回答
- 显示是否有总结
- 点击一条打开详情

### 5.4 历史详情

历史详情建议显示:

```text
问题:
...

目标:
ChatGPT / Gemini

ChatGPT 回答:
...

Gemini 回答:
...

转移记录:
Gemini -> ChatGPT  18:40

总结:
...

[复制 Markdown] [删除]
```

第一版可以先做:

- 查看
- 复制 Markdown
- 删除

不用先做编辑。

### 5.5 删除策略

删除历史是本地操作:

- 删除前弹确认
- 删除后从 `chrome.storage.local.sessions` 移除
- 不影响 ChatGPT / Gemini 官方网页里的历史

### 5.6 容量策略

沿用现有 `session-store.ts`:

- 最多 500 条
- 最多 100MB
- 超出后删最旧记录

注意:当前 `manifest.json` 已包含 `unlimitedStorage` 权限，所以这里的 100MB 是项目自己的保守淘汰策略，不是 Chrome 默认容量承诺。如果未来移除 `unlimitedStorage`，需要重新评估容量上限。

后续可以在设置里加:

- 自动保留最近 100 / 500 / 1000 条
- 一键清空历史
- 导出 Markdown / JSON

---

## 6. 一键对比总结功能设计

### 6.1 第一版范围

这次既然要和历史记录一起做，第一版先把最小可用链路做稳:

- 支持最近 1 轮
- 最近 3 轮 / 5 轮先预留数据结构和 UI 位置，默认不作为第一版主路径
- 数据来源优先取本地历史
- 如果本地历史缺少最新回答，点击总结前尝试刷新当前 iframe 的最后回答

原因:最近 3/5 轮很容易跨话题。第一版先把最近 1 轮做稳；后续再通过 `conversationId` 或“用户手动勾选历史记录”的方式扩展到多轮总结。

### 6.2 总结弹窗

点击底部 `总结` 后弹窗:

```text
对比总结

总结范围:
[ 最近 1 轮 ] [ 最近 3 轮 ] [ 最近 5 轮 ]

总结方式:
[ 最终结论 ] [ 找分歧 ] [ 简短摘要 ]

交给:
( ) ChatGPT
( ) Gemini

[ 生成总结 ]
```

第一版可先支持:

- 最近 1 轮
- 最终结论

`最近 3 轮`、`最近 5 轮`、`找分歧`、`简短摘要`可以显示为禁用，或后续再加。

### 6.3 默认目标

建议默认目标:

- 如果 ChatGPT 启用，默认交给 ChatGPT
- 如果 ChatGPT 被关掉，默认交给 Gemini

原因:

- ChatGPT 整理长文本通常更稳定
- 用户不用每次多点一次
- 但仍保留切换目标的能力

### 6.4 按钮状态

`总结`按钮启用条件:

- 至少启用 2 个 AI
- 至少有 1 条历史 session

点击后再做内容检查:

- 如果最近 N 轮没有足够内容，自动降级到可用轮数，并提示
- 如果某一轮某个 AI 没有回答，模板里标记“未获取到”
- 如果目标 AI 正在生成，toast 提示“目标 AI 还在生成中，稍后再试”

---

## 7. 提示词设计

### 7.1 默认总结提示词

建议默认模板:

```text
下面是多个 AI 最近几轮关于相关问题的回答记录。

请你综合这些内容，输出一个最终结论。

要求：
1. 先列出各方都认可的结论
2. 再列出有分歧、矛盾或侧重点不同的地方
3. 标出哪些内容需要进一步确认
4. 去掉重复、空话和不确定表达
5. 最后给出一版清晰、完整、可直接使用的最终答案

【历史记录】
{{historyBlock}}

请按下面结构输出：

## 共同结论

## 分歧与风险

## 需要进一步确认

## 最终建议
```

### 7.2 `historyBlock` 格式

由代码生成，建议格式:

```text
### 第 1 轮

【用户问题】
...

【ChatGPT 回答】
...

【Gemini 回答】
...

### 第 2 轮
...
```

这样比给每个 AI 单独变量更通用。未来加第三个 AI，只要继续往 block 里加:

```text
【Claude 回答】
...
```

### 7.3 可用变量

总结提示词模板建议支持:

- `{{historyBlock}}`
- `{{targetLabel}}`
- `{{rangeLabel}}`
- `{{modeLabel}}`

第一版必须支持 `{{historyBlock}}`。

### 7.4 放进设置页

设置页 `提示词`栏目:

- 转移提示词
- 总结提示词

每个提示词都有:

- 大文本框
- 变量说明
- 恢复默认按钮
- 保存按钮沿用设置页已有保存

---

## 8. 执行流程

### 8.1 发送时创建历史

```ts
async function onSend() {
  const sentPrompt = buildFinalPrompt(text, attachments)
  const session = createSession({
    prompt: text,
    sentPrompt,
    targetPlatforms: targets,
    attachments: toSessionAttachments(attachments),
  })

  await addSession(session)
  await sendToTargets(targets, sentPrompt, attachments)
}
```

### 8.2 刷新当前 session 回答

```ts
async function refreshLatestSessionResponses(session: Session) {
  for (const p of session.targetPlatforms) {
    const text = await getLastResponse(p)
    if (text.trim()) {
      session.responses[p] = {
        text,
        status: 'captured',
        capturedAt: Date.now(),
      }
      session.updatedAt = Date.now()
    } else {
      session.responses[p] = {
        text: '',
        status: 'pending',
      }
    }
  }
  await updateSession(session)
}
```

当前 `session-store.ts` 没有 `updateSession`，需要补一个。

### 8.3 生成总结

```ts
async function executeSummary(range: SummaryRange, mode: SummaryMode, target: AIPlatform) {
  const sessions = await loadSessions()
  const sourceSessions = pickRecentSessions(sessions, range)

  if (sourceSessions.length === 0) {
    showToast('还没有历史记录可总结', 'warn')
    return
  }

  const historyBlock = buildHistoryBlock(sourceSessions)
  const prompt = renderTemplate(userSettings.promptTemplates.summary, {
    historyBlock,
    targetLabel: getPlatformMeta(target)?.label ?? target,
    rangeLabel: labelOfRange(range),
    modeLabel: labelOfMode(mode),
  })

  const summaryId = await appendSummaryRecord(sourceSessions, {
    target,
    range,
    mode,
    prompt,
    status: 'pending',
  })

  await postToIframe(target, 'write-and-send', { text: prompt })
  await markSummarySent(summaryId)
}
```

### 8.4 长文本保护

建议限制:

- 每轮最多 20,000 字符
- 总 prompt 最多 60,000 字符
- 超出后从最旧轮开始截断
- 截断时在 `historyBlock` 里写明

原因:

- 官方网页输入框太长可能卡顿
- 目标 AI 也可能因为上下文过长而忽略前文
- “最近 5 轮”如果每轮都很长，需要保护

---

## 9. 文件附件功能设计

### 9.1 支持范围

第一版支持:

| 类型 | 扩展名 | 处理方式 | 说明 |
|---|---|---|---|
| 图片 | `.png` / `.jpg` / `.jpeg` / `.webp` / `.gif` | 继续走现有图片上传链路 | 保留现有能力 |
| 文本 | `.txt` | 读取文本后拼进消息 | 最稳 |
| Markdown | `.md` | 读取文本后拼进消息 | 重点支持,方便把项目文档发给 AI |
| CSV | `.csv` | 读取文本后拼进消息 | 表格较小时很稳 |
| PDF | `.pdf` | 尝试真实文件上传 | 不自己解析 |
| Word | `.docx` | 尝试真实文件上传 | 不支持老 `.doc` |
| Excel | `.xlsx` | 尝试真实文件上传 | 不支持老 `.xls` |

第一版暂不支持:

- `.doc`
- `.xls`
- `.ppt`
- `.pptx`
- `.zip`
- 目录上传
- 超大文件

如果用户后续确实需要 PPT 或压缩包，再单独评估。

### 9.2 为什么文本文件直接内联

`.txt` / `.md` / `.csv` 本质是文本。直接读出来拼进提示词，比模拟网页文件上传更稳定。

优点:

- 不依赖 ChatGPT / Gemini 上传按钮 DOM
- 不受官方文件解析能力变化影响
- 对 `.md` 文档尤其合适
- 失败概率低，容易测试

缺点:

- 超长文本会撑大输入框
- 需要做长度限制和截断提示

### 9.3 文本文件拼接格式

如果用户输入框里有问题，同时附加了 `summary-design.md`，实际发送给 AI 的内容建议是:

```text
{{userText}}

下面是我附加的文件内容，请结合它一起处理。

【文件名】
2026-06-10-summary-design.md

【文件内容开始】
...
【文件内容结束】
```

如果用户没有额外输入文字，只上传文件，则默认文字可以是:

```text
请阅读下面这个文件，并总结重点、指出问题、给出改进建议。
```

### 9.4 文件大小限制

建议第一版限制:

- 图片:沿用 20MB
- 文本类 `.txt` / `.md` / `.csv`:最多 1MB
- 可上传文档 `.pdf` / `.docx` / `.xlsx`:最多 20MB

如果文本文件超过 1MB:

- 不直接内联
- 提示用户文件过大
- 后续可以考虑降级为真实文件上传

第一版先简单处理:超过限制就提示，不发送附件。

### 9.5 UI 改动

把现在的 `+` 从“附加图片”改成“附加文件”。

选择文件后显示:

```text
summary-design.md · 18KB
```

图片仍显示缩略图。

文档文件显示:

- 文件名
- 文件大小
- 文件类型
- 移除按钮

### 9.6 技术实现建议

把 `image-handler.ts` 升级或新增为 `file-handler.ts`:

```ts
export type AttachmentKind = 'image' | 'text' | 'document'
export type AttachmentHandling = 'inline-text' | 'file-upload'

export interface PendingAttachment {
  file: File
  kind: AttachmentKind
  handling: AttachmentHandling
  textContent?: string
}
```

判断规则:

```ts
if (file.type.startsWith('image/')) kind = 'image'
else if (['.txt', '.md', '.csv'].includes(ext)) handling = 'inline-text'
else if (['.pdf', '.docx', '.xlsx'].includes(ext)) handling = 'file-upload'
else unsupported
```

### 9.7 适配器改动

当前 `AIAdapter.sendMessage(text, image?: File)` 只支持一个可选图片。

建议改成:

```ts
sendMessage(text: string, attachment?: File): Promise<void>
attachFile(file: File): Promise<void>
```

第一版可以少改类型名，只把 `image?: File` 改成 `file?: File`，内部:

- ChatGPT:继续找 `input[type=file]` 注入文件
- Gemini:优先找 `input[type=file]`
- Gemini 图片如果找不到 input，保留 paste fallback
- Gemini 文档如果找不到 input，提示失败，不走 paste

注入文件后不能立刻发送，需要增加上传就绪探测:

```ts
async function attachFileAndWaitReady(file: File) {
  await attachFile(file)

  const ready = await waitForAttachmentReady({ timeoutMs: 5000 })
  if (!ready) {
    showToast('文件已尝试上传，请确认上传完成后手动发送', 'warn')
    return false
  }

  return true
}
```

`waitForAttachmentReady()` 可以按平台分别实现，优先观察:

- 文件名 chip 是否出现
- 图片缩略图是否出现
- loading / spinner 是否消失
- 发送按钮是否恢复可点

5 秒超时只是第一版兜底值，不代表上传一定失败；超时后不要自动点发送，避免文件还没准备好就把文字发出去。

### 9.8 历史记录里的附件

历史按附件类型分两类保存。

inline-text 文件保存元信息和文本内容:

```ts
attachments: [
  {
    id: '...',
    name: '2026-06-10-summary-design.md',
    mime: 'text/markdown',
    size: 18000,
    kind: 'text',
    handling: 'inline-text',
    inlinedText: '...',
  }
]
```

但对于 `handling === 'inline-text'` 的 `.txt` / `.md` / `.csv`，必须在 1MB 限制内保存 `inlinedText`，或者至少保存已经拼接完成的 `sentPrompt`。否则历史详情和一键总结只能看到文件名，看不到文件内容。

不保存 PDF / Word / Excel / 图片这类二进制文件本体，原因:

- 本地容量容易爆
- 隐私风险更高
- 文档内容可能很大

如果文本文件被内联发送，历史里的 `prompt` 和 `sentPrompt` 要分开。第一版建议:

- `prompt`:用户原始输入
- `sentPrompt`:最终发送文本，包含 inline-text 附件内容
- `attachments`:文件元信息
- `attachments[].inlinedText`:可选保存，用于历史详情展示单个文件内容

总结构造 `historyBlock` 时优先使用 `sentPrompt`，这样即使不单独读取 `inlinedText`，上下文也是完整的。

### 9.9 风险

- ChatGPT / Gemini 官方上传按钮可能变
- Gemini 对非图片文件的上传路径可能和图片不同
- 有些文件官方 AI 支持，但当前 DOM 注入不一定成功
- `.docx` / `.xlsx` 不自己解析，所以失败时只能提示手动上传

第一版应明确告诉用户:

> 文本和 Markdown 最稳；PDF/Word/Excel 是尽力上传，如果失败请手动上传。

---

## 10. 推荐实施顺序

### Step 1: 升级类型和 session-store

- `Session` 增加 `updatedAt`
- `Session` 增加 `conversationId`
- `Session` 增加 `sentPrompt`
- `Session` 增加 `targetPlatforms`
- `Session` 增加 `attachments`
- `Session` 增加 `summaries`
- `responses` 调整为 `Partial<Record<AIPlatform, SessionResponse>>`
- `followUps` / `summaries` 增加状态、时间和错误字段
- `session-store.ts` 增加 `updateSession`
- 单测覆盖新增字段和更新逻辑

### Step 2: onSend 写入历史

- 用户点击发送时创建 session
- 保存 `prompt`、`sentPrompt`、`targetPlatforms`、`attachments`、`createdAt`、`updatedAt`
- 纯文本发送先跑通，不依赖附件能力
- 发送成功后可尝试刷新当前回答
- 如果暂时读不到回答，允许 responses 为 `pending`

### Step 3: 历史 UI

- `历史`按钮从占位改为打开历史面板
- 列表按时间倒序
- 详情可看 prompt、responses、followUps、summaries
- 支持删除
- 支持复制 Markdown

### Step 4: 设置页增加总结提示词 + 总结弹窗

- `UserSettings.promptTemplates.summary`
- 设置页 `提示词`栏目增加总结模板编辑框
- 单测补默认值、保存、空值 fallback
- 点击底部 `总结`
- 弹出范围/模式/目标选择
- 第一版支持最近 1 轮 + 最终结论

### Step 5: 生成总结并发送

- 从历史取最近 1 条
- 构造 `historyBlock`
- 渲染 summary 模板
- 发给用户选择的目标 AI
- 写入 `summaries[]`，先标记 `pending` / `sent`
- 后续按需刷新目标 AI 回答并回填 `captured` / `failed`

### Step 6: 附件能力升级

- `+` 按钮从图片改为文件
- 保留图片预览
- 增加文档文件元信息展示
- `.txt` / `.md` / `.csv` 读取文本并内联发送
- inline-text 文件内容进入 `sentPrompt`，并可保存 `attachments[].inlinedText`
- `.pdf` / `.docx` / `.xlsx` 尝试真实文件上传
- 注入文件后等待上传就绪，5 秒超时则提示用户手动确认发送
- 不支持格式给明确 toast

### Step 7: 最近 3/5 轮总结增强

- 引入或完善 `conversationId`
- 只在同一 conversation 内选择最近 3/5 轮
- 或增加历史手动勾选，让用户明确选择总结范围

### Step 8: 验证

手动验证:

1. 发送一个问题后，历史里出现记录
2. 附加 `.md` 后发送，AI 能看到文件内容
3. 附加图片后发送，现有图片能力不退化
4. 两边回答后，打开历史详情能看到回答
5. 点删除能删掉历史
6. 点复制 Markdown 能复制可读内容
7. 最近 1 轮总结能生成正确 prompt
8. 目标 AI 收到总结 prompt
9. 关闭某个 AI 后总结目标选择不出现它
10. `.txt` / `.md` / `.csv` 发送后，历史里的总结上下文能看到文件内容
11. `.pdf` / `.docx` / `.xlsx` 上传超时后，不自动误发送文字

自动验证:

- `npm run typecheck`
- `npm test`
- `npm run build`

---

## 11. 风险与取舍

### 11.1 回答抓取不一定实时

AI 官方页面在流式输出时，最后回答可能还没完整。第一版不做实时追踪，只在需要时刷新最后回答。

风险可接受，因为:

- 用户点总结通常发生在回答完成后
- 如果抓到空内容，可以提示用户稍后再试

### 11.2 官方页面 DOM 会变

读取最后回答依赖 adapter selector。这个风险已经存在于转移功能里。

应对:

- 总结复用转移读取链路
- 不新增多轮 DOM 抓取
- 多轮范围基于本地历史，而不是官方 DOM

### 11.3 历史只覆盖 AIChatRoom 发起的对话

如果用户直接在 iframe 内手动和 ChatGPT/Gemini 聊，这部分第一版不保证写入历史。

这是有意取舍:

- 自动追踪官方页面所有用户操作会复杂很多
- 第一版只保证通过统一输入框发出的内容可记录

后续可以考虑监听 iframe 内用户手动消息，但不建议第一版做。

---

## 12. 未决问题

1. 总结结果是否要自动回填到历史?
   - 建议记录总结 prompt，结果可在目标 AI 回答完成后按需刷新读取。

2. 第一版是否需要“发送前预览”?
   - 建议不做，先保证一键可用。

3. 默认交给 ChatGPT 还是让用户每次选择?
   - 建议默认 ChatGPT，但弹窗允许切换。

4. 如果用户只启用了一个 AI，是否还能总结?
   - 第一版建议不能，因为“对比总结”至少需要两个来源。

5. 总结时要不要包含用户原始问题?
   - 必须包含。历史记录能稳定提供原始问题。

6. 历史记录是否保存附件本体?
   - 第一版不保存图片、PDF、Word、Excel 这类二进制附件本体，只保存文件名、大小、类型、处理方式等元信息。
   - `.txt` / `.md` / `.csv` 这类 `inline-text` 文件例外:在 1MB 限制内必须保存文本内容或保存拼接后的 `sentPrompt`，否则历史总结会丢上下文。
