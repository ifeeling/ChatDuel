# 跨 AI 转移(C→G / G→C / N→N)设计

**日期**:2026-06-10
**状态**:待审核(可喂给外部 AI 评审)
**基线**:`v0.4.0`(已合并 `@` 弹层 + AI 元数据派生)
**作者**:头脑风暴协作(用户 + AI)

---

## 0. 给评审 AI 的项目背景(请先读这一节)

### 0.1 AIChatRoom 是什么

一个 **Chrome 扩展**(MV3),不是网页应用、不是桌面应用、不是 Electron。
主功能:**把用户已经登录好的 ChatGPT 和 Gemini 官方网页,以 iframe 形式并排嵌入到扩展自己提供的全屏页面里**,用户在一个统一输入框里打字,扩展通过浏览器自动化把内容"搬运"到两侧官方页面的输入框、点发送,实现"同一个问题问两个 AI,然后横向对比回答"。

**关键约束**(这些不是"设计选择"而是"产品形态决定",评审时不要建议改):
- ❌ **不调任何 AI 官方 API**(避免 API key、避免账号配额、避免厂商限流)
- ❌ **不做账号系统**、不存云端
- ✅ 扩展本身在用户**已登录**的官方页面上动手脚(类似 Vimium / Tampermonkey,不是 ChatBrawl 那种"全自研聊天")
- ✅ 本地存历史、设置(走 `chrome.storage`)
- ✅ 走"白嫖用户自己的 AI 订阅"路线

### 0.2 当前项目状态(2026-06-10)

| 版本 | 已完成 | 状态 |
|---|---|---|
| v0.1 | popup + 单 iframe 注入 | 已发布 |
| v0.2 | 全屏 chat 页 + 双 iframe 嵌入 | 已发布(走 `declarativeNetRequest` 改 CSP + X-Frame-Options) |
| v0.3 | 图片自动上传到 ChatGPT + Gemini(Gemini 走 paste 事件 fallback) | 已发布 |
| **v0.4** | **`@` 提及弹层 + chip,AI 元数据从 DOM 派生** | **已发布,本 spec 的基线** |
| v0.5 | 本 spec 要做的事:跨 AI 转移 | 设计中,本文档待评审 |
| v0.6+ | 总结 / 历史 / 设置页(AI 启停勾选) | 远期规划 |

**v0.4 关键技术点**(评审时如果涉及,这就是"已经能用的零件"):
- `lib/ai-platforms.ts` 单点维护 AI 元数据(key/label/icon)
- `activePlatforms()` 从 DOM 派生当前面板集合 → **加新 AI = 改元数据 + 加 HTML panel,不用改 chat.ts**
- at-chip 在工具栏显示已选 AI,at-popup 是 `@` 触发的下拉
- toast / 错误处理 / 输入验证等基础设施都现成

### 0.3 本 spec 解决什么问题

**用户当前的痛点**(从截图和反馈看):
1. 用户在 ChatGPT 那边得到一个回答
2. 想让 Gemini "接着说" / "挑刺" / "补充视角"
3. 现在必须:**手动选中 ChatGPT 回答 → 复制 → 切到 Gemini → 粘贴 → 手写一句"请基于以上内容继续" → 点发送**
4. 一来一回 5-10 秒,且容易粘错

**v0.5 转移功能要做的**:一键把源 AI 的回答,套个 prompt 模板,自动送到目标 AI 那边并发送。

### 0.4 评审时请聚焦的"开放问题"

文档 §3.0 表格列了所有评审意见的**采纳情况**。如果你评审后觉得哪条"❌ 不采纳"或"⚠️ 轻量采纳"实际应该 ✅,直接挑战,我会重新评估。

### 0.5 评审时**不要**建议的事(我已知,改不动)

- ❌ "建议加个 API 模式"—— 产品形态决定不调 API
- ❌ "建议用 Electron 重做"—— 已 v0.1 评估过否决,产品设想文档有记录
- ❌ "建议加 Claude / DeepSeek"—— 那是 v0.6+ 的事,本 spec 不在范围
- ❌ "建议改 Vue / React 重写整个 chat 页"—— 范围外,等用户提
- ❌ "prompt 模板为什么用中文"—— 因为用户用中文,目标 AI(Gemini/ChatGPT)都吃中文
- ❌ "为什么不直接拖拽"—— 跨 iframe 拖拽坑多,留 v3

### 0.6 评审输出建议

希望你(评审 AI)重点看:

1. **§3 设计方案** 是否漏了什么关键的交互/状态(比如 N=2 直接执行之外是否还要"点工具栏别处取消"等)
2. **§4 边界 case 清单** 我漏了哪些情况(用户极端操作、平台变更等)
3. **§8 6 个决策** 哪个你觉得选错了,理由
4. **§3.3 模板措辞** 写法对 AI 效果影响如何(你比我更懂 prompt)

不太需要你评:
- 代码结构 / 文件名 / 命名(项目有自己的约定)
- TS 类型细节(项目用 strict + 现成模式)
- 测试覆盖细节(我会自己加,主要看有没有"集成测试"漏掉的)

---

## 2. 核心问题:不只 2 个 AI

v1 阶段产品设想明确"先做 ChatGPT + Gemini"两栏,但 AGENTS.md / spec 都强调:
- **未来会加** DeepSeek / Claude / Grok / Qwen / Doubao 等
- 每次加 AI = `types/index.ts` 联合 + `ai-platforms.ts` 元数据 + `chat.html` 加 `<section>`

因此**转移功能必须为 N 个 AI 设计**。如果只做"2 个按钮 C→G / G→C",加到第 3 个 AI 时按钮会变成 C×2 + G×2 = 6 个,第 10 个 AI 时是 90 个,不可维护。

**目标:N 个 AI 时,UI 元素数量仍为 1 个(单按钮 + 临时模式),逻辑支持任意源/目标组合。**

---

## 3. 设计方案

### 3.0 评审意见采纳表(2026-06-10)

| # | 来源 | 意见 | 采纳? | 处理 |
|---|---|---|---|---|
| 1 | Gemini | 改用 panel header `转移 ➔` 按钮 + 复用 at-popup | ✅ 采纳 | §3.1 / §3.2 整段重写;目标 = 源之外所有 panel(无粒度) |
| 2 | Gemini | 补"源 AI 正在生成中"边界 | ✅ 采纳 | §4 + §3.3,加 `getConversationState().status` 检查 |
| 3 | Gemini | Prompt 加 Markdown 隔离 | ✅ 采纳 | §3.3 模板改用"引用开始/结束"中文围栏 |
| 1 | GPT | 转移前检查源是否仍在生成 | ✅ 采纳 | 同 #2 Gemini |
| 2 | GPT | 检查目标是否忙碌 | ⚠️ 轻量采纳 | §3.4 改为"不预检,失败时 toast 明示" |
| 3 | GPT | 长文本保护 + MAX_TRANSFER_LENGTH | ✅ 采纳 | §3.3 截断到 50k + toast |
| 4 | GPT | 执行中状态反馈 | ✅ 采纳 | §3.4 按钮变 `转移中...` + 进度 |
| 5 | GPT | Prompt 改"独立评估并补充" | ✅ 采纳 | §3.3 模板重写 |
| 6 | GPT | atSelected 备份/恢复 | ❌ 不采纳 | 方案 1 改了,不再有"模式切换"概念,问题消失 |
| 7 | GPT | 远期:消息级转移 | ✅ 采纳为远期 | §7 加一段 |

---

### 3.1 入口:每个 panel header 一个 `转移 ➔` 按钮

**v0.4 现状**:
- 工具栏有 `C→G` 和 `G→C` 两个按钮(默认 disabled)
- `onC2G()` / `onG2C()` 各打 console.log

**v0.5 改动**(评审 v1 采纳 Gemini 建议):
- 删 `C→G` / `G→C` 两个按钮
- 在**每个** `<section class="panel">` 的 header 里加一个 `转移 ➔` 按钮(点击 = "本 panel 是源")
- 2 个 AI 时:每边各 1 个按钮(2 个总);N 个 AI 时:每边各 1 个(N 个总)
- 点 `转移 ➔` → 复用 v0.4 的 `at-popup` 弹层(单选模式)→ 用户在弹层里选目标 AI → 选完立即执行

**按钮 disabled 条件**(任何一条满足):
- `activePlatforms().length < 2`(没有可转移目标)
- iframe 还没 ready
- 当前源 AI 还在生成中(`getConversationState().status` 不在 idle/finished/error 范围)
- 已经在执行转移(避免重复触发)

**为什么选 panel header 而不是工具栏单按钮**:
- 语义零歧义("在这点 = 这是源"),不用给 chip 标金色/蓝色
- 不引入"模式切换"概念,@ chip 永远服务于普通发送,转移是 panel 自己的属性
- 目标粒度:用户**单选 1 个目标**(走 at-popup 单选模式)。N=2 时只有一个候选,优化动线(见 §3.2);N>2 时弹层让用户选。**多选粒度"只想给 B 不给 C"留 v0.6 设置页**。

### 3.2 候选列表与 N=2 优化(由 panel header 触发)

点 panel A 的 `转移 ➔`:
- **候选集** = `activePlatforms().filter(p => p !== sourceKey)`
- **N=2 优化**(评审 v2 采纳 Gemini):如果候选数 = 1,**直接执行转移**,不弹 at-popup(避免"在唯一选项上再点一次"的多余操作)
- **N>2**:复用 v0.4 的 at-popup 弹层(单选模式),用户点候选 = 立即执行
- **N=1(源 panel 之外没有其它 panel)**:toast "没有可转移的目标",不弹层
- 用户 Esc 取消 = at-popup 自身支持的取消(关闭弹层,不执行)

**为什么"点候选即执行"**:
- N=2 时:点 `转移 ➔` → 立即执行(1 步)
- N>2 时:点 `转移 ➔` → 弹层 → 点目标(2 步,比"点目标 + 点确认"少 1 步)
- "选错目标"的风险低(单选 + 弹层在源 panel 旁,视觉邻近,误选概率小)

### 3.3 执行流程

```ts
// 伪代码,不是最终代码
async function executeTransfer(sourceKey: AIPlatform, targetKey: AIPlatform) {
  // 1. 源 AI 状态检查(评审 v1 采纳)
  const srcState = await sourceAdapter.getConversationState()
  if (!['idle', 'finished', 'error'].includes(srcState.status)) {
    showToast(`源 AI 还在生成中,等一会儿再试(当前: ${srcState.status})`, 'warn')
    return
  }

  // 1b. 目标 AI 状态预检(评审 v2 轻量采纳 GPT #3)—— 低成本 try,拿不到就跳过
  try {
    const tgtState = await Promise.race([
      targetAdapter.getConversationState(),
      new Promise<null>((r) => setTimeout(() => r(null), 50)),  // 50ms 超时
    ])
    if (tgtState && !['idle', 'finished', 'error'].includes(tgtState.status)) {
      showToast(`目标 AI 还在生成中,等一会儿再试(当前: ${tgtState.status})`, 'warn')
      return
    }
  } catch {/* 预检失败不阻塞,继续发送 */}

  // 2. 取源回答
  const content = await sourceAdapter.getLastResponse()
  if (!content || !content.trim()) {
    showToast('源 AI 还没有回答可转移', 'warn')
    return
  }

  // 3. 长文本保护(评审 v1 采纳 GPT #3)
  const MAX_TRANSFER_LENGTH = 50_000
  let finalContent = content
  if (content.length > MAX_TRANSFER_LENGTH) {
    finalContent = content.slice(0, MAX_TRANSFER_LENGTH) +
      `\n\n[...已截断,原回答共 ${content.length} 字符]`
    showToast(`源回答过长,已截断到 ${MAX_TRANSFER_LENGTH} 字符`, 'warn', 4000)
  }

  // 4. 渲染 prompt 模板
  const fromLabel = getPlatformMeta(sourceKey)?.label ?? sourceKey
  const prompt = renderTemplate(transferTemplate, { fromLabel, content: finalContent })

  // 5. 发送(v0.3 那套 toast 收集 + 8s 兜底逻辑)
  await targetAdapter.sendMessage(prompt)
}
```

**模板**(`prompt-template.ts` 新增,评审 v1 采纳 GPT #5 + Gemini #3 重写):

```
下面是一段来自 {{fromLabel}} 的回答,供你参考。
请你**独立地**基于这个主题给出自己的回答:
- 如果你认为对方的观点有问题,请明确指出并说明理由
- 如果你认为对方说得对,可以补充更多细节、证据或案例
- 不必同意也不必反对,只给出你认为**最准确**的版本

⚠️ 下面是引用内容(请勿在回复中复述这段前缀):
==== 引用开始 ({{fromLabel}}) ====
{{content}}
==== 引用结束 ====

接下来,请直接给出你的回应:
```

**为什么这个模板**:
- "独立地" 让 AI 不会被原回答牵着走(避免"为了反驳而反驳")
- 中文围栏 `引用开始/引用结束` 比 `---` 更难误碰(源回答里如果本身有 `---` 不会破坏结构)
- 明确告诉 AI "别复述前缀",省 token + 避免无意义复读

**变量**:`fromLabel`(人类友好名,如 "ChatGPT")+ `content`(已截断的回答全文)。

### 3.4 执行中反馈(评审 v1 采纳 GPT #4)

- 点击 `转移 ➔` 那一刻:弹层立即显示候选
- 选中目标 → 弹层关闭 + 源 panel header 按钮**临时**变成 `转移中…` 并 disabled(防重复点)
- 单目标:不显示进度数字
- 多目标(若 v0.6 扩展):按钮文字 `转移中 (2/3)`

**目标 AI 状态**:v0.5 **不预检**目标是否忙碌(采纳评审 v1 折中方案):

- 理由:`sendMessage` 内部已有重试 / 等机制,预检会让用户多一步
- 实施:`sendMessage` 失败 / 超时时,toast 文案明确写"目标 AI 当前可能正忙,已尝试发送但未确认"而不是笼统的"发送失败"

### 3.5 与 at-chip / 普通 send 通路的关系

- **完全独立**:转移操作不读不写 `atSelected`(`atSelected` 永远服务于"@ 发送"场景)
- **复用 onSend 的发送通路**:`adapter.sendMessage(text)` 已经验证过(图片 + 文字),转移就是套模板 + 调它,不需要新代码路径
- **不动**:`lib/ai-platforms.ts` / `lib/at-parser.ts` / `adapters/*`

---

## 4. 边界 case 清单(头脑风暴)

| 情况 | 当前设计应对 |
|---|---|
| 源 AI 还没收到任何回答(空字符串) | toast "源 AI 还没有回答可转移",不执行 |
| 源 AI 回答为空 / 只有空白 | 同上 |
| 面板数 = 1(只有 1 个 AI) | 转移按钮直接 disabled |
| 选了"源"后目标池空了(只有 2 个 AI 时) | 执行按钮 disabled,提示"至少需要 2 个 AI 才能转移" |
| 选源时,源已被选为目标 | 选源时自动从目标里清掉它(代码里 set 操作顺序) |
| 转移执行中网络失败(目标 AI 没收到) | 走 v0.3 的 toast 合并逻辑:成功 toast / 部分失败 / 全部失败 |
| 源回答 > 50,000 字符(已合并) | 见上 50k 截断行 |
| 源回答里包含 `---`(Markdown 水平线) | 模板改用"引用开始/引用结束"中文围栏,不被水平线破坏 |
| 源回答 > 50,000 字符 | 截断到 50k + 加省略尾巴 + toast 提示 |
| 目标 AI 正在忙(回上一题) | v0.5 不预检,失败时 toast 明示"目标可能正忙" |
| panel header 按钮被改版 / 改位置 | panel header 改动应同步更新 selector;v0.5 用 `.panel-header [data-action='transfer']` 锁定 |
| 转移后又立刻点转移 | 旧转移未完成时新按钮 disabled(避免并发) |
| 历史记录需要记"这次是转移" | v1 不做,留 v2(`session-store` 加 `transferFrom` 字段) |
| 用户想"先让源 AI 总结再转移" | v1 不做,留 v2(模板变体) |

---

## 5. 改动范围

### 5.1 新增

| 文件 | 用途 |
|---|---|
| `src/chat/chat.ts`(内嵌,无需新文件) | panel header 转移按钮 + executeTransfer 逻辑 + 弹层触发 |
| `docs/superpowers/specs/2026-06-10-transfer-design.md` | 本文档 |

### 5.2 修改

| 文件 | 改动 |
|---|---|
| `src/chat/chat.html` | 删 `btn-transfer-c2g` / `btn-transfer-g2c`,加 `btn-transfer` |
| `src/chat/chat.css` | panel header 转移按钮样式(简洁,跟现有 ↗ 按钮一致) |
| `src/chat/chat.ts` | 删 `onC2G` / `onG2C` 死代码;加 transfer 状态 + 模式切换 + 执行 |
| `src/lib/prompt-template.ts` | `PromptTemplates` 接口加 `transfer: string`;`getDefaultTemplates()` 加 transfer 默认值 |
| `tests/unit/prompt-template.test.ts` | 加 `renderTemplate(transfer, ...)` 测试 |
| `docs/postmortems/`(可选) | 写一个"为什么用 chip 复用而非下拉"的短文档,防未来重构迷路 |

### 5.3 不改

- `lib/ai-platforms.ts` —— 不动,自动支持新 AI
- `lib/at-parser.ts` —— 不动
- `adapters/*` —— 不动,只用 `getLastResponse()` 和 `sendMessage()` 现有 API
- `types/index.ts` —— 不动,协议层窄类型保持

---

## 6. 测试

| 类型 | 覆盖 |
|---|---|
| 单元 | `renderTemplate(transfer, ...)` 变量替换正确;多 AI 派生 + chip 渲染 |
| 集成(vitest 已有 jsdom) | N=2 直接执行分支;N>3 弹层 + 选目标分支;at-popup Esc 取消分支 |
| 手动(用户跑) | reload 扩展 → 强刷 → 测真实 2 AI 转移 → toast 看结果 |

**手动验证清单**:
1. C→G:Gemini 输入框出现"下面是 ChatGPT 的回答..."开头 + 源回答全文,点 send 后看到 Gemini 真的收到并回复
2. G→C:同上反向
3. N=2 转移:点 panel A 的 `转移 ➔` → 不弹层,目标 panel B 直接收到 prompt,toast 报成功
4. 选源后再选同一个 AI 当目标:不出现(目标自动排除源)
5. 只剩 1 个 AI 时按转移按钮:按钮 disabled

---

## 7. 长期性 / 扩展性(给未来 AI 看的)

- **加新 AI**:零代码改动,只要在 `ai-platforms.ts` 加元数据 + HTML 加 panel + 写 adapter,转移功能自动支持。
- **转移 + 引用叠加**:v2 可能允许"先引用自己的上一轮,再转移别人的",在状态机上加一层即可,不影响核心。
- **panel header 右键 / 拖拽**:UI 增强,留 v2/v3。
- **先摘要后转移**:模板变体,不影响 UI 状态机。
- **消息级转移**(评审 v1 GPT 远期建议,v0.5 不做):现在只能转移 `getLastResponse()` = 整个会话的"最后一条",真实场景里用户可能想转"倒数第二条"或"某条特定回答"。演进方向:在 panel 内的每条回答右上角加一个"转移"按钮,点哪个转哪个。需要先把 `adapter.getLastResponse()` 拆成 `getResponses(): Promise<Response[]>`(带 id / 顺序 / 时间戳),v0.6+ 评估。

---

## 8. 风险 / 取舍(评审 v1 后)

| 取舍 | 选了什么 | 理由 |
|---|---|---|
| 入口位置 | 每个 panel header 一个按钮 | 评审 v1 采纳 Gemini;语义零歧义 |
| 候选列表 | 源之外所有 panel(用户单选) | 评审 v1 简化;失去"目标多选 + 排除某些"粒度,留 v0.6 |
| 源单选 vs 多选 | 单选 | 物理上"拼多源给一目标"罕见,先不做 |
| 目标 AI 预检 | 不预检,失败时明示 | 评审 v1 折中;少一步操作 + 不漏风险 |
| 长文本 | 50k 截断 + 尾巴 + toast | 评审 v1 采纳 GPT #3;50k 是保守值 |
| 模板措辞 | "独立评估 + 补充" | 评审 v1 采纳 GPT #5;不让 AI 偏激 |
| 模板隔离符 | "引用开始/引用结束"中文围栏 | 评审 v1 采纳 Gemini #3;比 `---` 不易被源内容破坏 |
| 消息级转移 | v0.5 不做,留 v0.6 | 评审 v1 远期建议 GPT #7 |
| 源状态预检 | 是,status 不在 idle/finished/error 时拒绝 | 评审 v1 采纳 GPT #1;避免半截回答 |

---

**审核请重点关注**:
- §3.1 单按钮设计是否过激进(你的偏好可能是保留 C→G / G→C)
- §3.2 复用 at-chip 是否合适(可能觉得转移应该有独立 UI)
- §3.3 模板措辞是否合你口味(可以改)
