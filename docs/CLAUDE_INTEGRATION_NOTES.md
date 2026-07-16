# Claude 接入记录

## 状态（2026-07-16 更新）

✅ **已解决！** Claude 在扩展 iframe 里显示模型列表正常，用户于 2026-07-16 10:37 实页确认（完整模型列表：Sonnet 5 Medium 选中、Opus/Haiku/Fiable 等全部可选）。

### 根因（2026-07-16 实页排查确认，曾误判一年）

**不是缓存问题。** 我们曾把 localStorage / sessionStorage / IndexedDB / Cache API **全部清空**，问题依旧（"Unsupported model" + 空菜单）。

真正根因是 **浏览器存储分区隔离导致 iframe 内缺少 `lastActiveOrg` cookie**：

| 环境 | `lastActiveOrg` cookie | Claude 行为 |
|---|---|---|
| 独立 claude.ai 标签页 | ✅ 有（登录时设置） | 知道用户所属组织 → 显示可用模型 |
| 扩展 iframe 分区 | ❌ 无（分区隔离，不共享） | 无法识别用户身份 → "Unsupported model" + 空菜单 |

这解释了所有历史现象：最早能用（当时 cookie 通过某种方式存在）→ Claude 改版后 iframe 分区 cookie 失效 → 独立标签页切了新模型但 iframe 分区仍是空 → 模型菜单为空。

### 修复（commit 6e1035c，移植自 ChatBrawl）

在 `src/content-scripts/claude-content.ts` 的 boot 阶段（最高优先级）：

1. 检测 iframe 内是否有 `lastActiveOrg` cookie（JS 可读取的 non-httpOnly）。
2. 无 → 调 Claude 官方 API `/edge-api/bootstrap` 拿组织 UUID。
3. 将 UUID 写入 `lastActiveOrg` cookie（iframe 分区专属 cookie jar，`SameSite=None; Secure`）。
4. `sessionStorage` flag 防循环 + `location.reload()` 一次。
5. 第二次加载：cookie 已存在 → Claude 正常初始化 → 显示 Sonnet/Opus 等。

之前的客户端缓存清理逻辑（`clearAllCache` + `scheduleStaleCacheCheck`）保留为兜底，优先级降低（仅当 cookie 方案后仍有 "Unsupported model" 才触发）。

> 参考来源：`/Users/xucong/Downloads/Claude.js`（竞品 ChatBrawl 的 Claude iframe 脚本），其 `ensureLastActiveOrgCookie()` 函数实现相同思路——它也会先显示 "Unsupported model" 再自动变为 "Sonnet 5 Medium"。

### 时间线

- **2026-06-20**：Claude 从扩展移除。当时误判为"缓存/UI 问题"，实际是 `lastActiveOrg` cookie 缺失（文档见 `docs/research/2026-06-19-claude-integration-notes.md`）。
- **2026-07-15**：按用户授权（"沿用上次方式，不行就用我自己的方式"）重新接入 Claude，完整链路落地。
- **2026-07-16**：通过 ChatBrawl 源码定位真凶，修复 `lastActiveOrg` cookie 方案，实页验证通过。

---

## 当前已接回的完整内容

- 平台元数据：`AIPlatform` 联合类型、`SUPPORTED_PLATFORMS`、`AI_PLATFORMS` 均含 `claude`（icon ✺，url `https://claude.ai/`，能力全开）。
- 配置链路：manifest host permission + content script 入口、vite content script build input、DNR iframe 嵌入规则（`RULE_IDS.claude = 3`）、SW 官方 tab URL 前缀、远程 selector 白名单、会话 URL 识别、i18n、user-settings（默认关闭）、chat.html 面板与设置行。
- 实现：`src/adapters/claude/adapter.ts`、`src/adapters/claude/selectors.json`（Gemini 模板最佳猜测，待实页回填）、`src/content-scripts/claude-content.ts`（lastActiveOrg cookie 修复 + iframe 模型菜单高度补丁 + 缓存清理兜底）。
- 测试：`tests/unit/claude-adapter.test.ts`（5 项）、以及随新平台修正的 ai-platforms / at-parser / dnr-rules / chat-html / user-settings 单测。

---

## 已验证 / 待验证

| 项目 | 状态 | 说明 |
|---|---|---|
| iframe 模型菜单列出并切换可用模型 | ✅ 已解决 | 2026-07-16 实页确认 |
| 基础链路（iframe 加载 / content script ready） | ✅ 代码保证 | 模型菜单通了即证明 |
| 发送问题（写入 + 触发发送） | ⏳ 待实页 | adapter.sendMessage 有 Enter 兜底 + 残留检测 |
| 抓取回答（getLastResponse + 降噪） | ⏳ 待实页 | selectors.json 为最佳猜测 |
| 历史记录保存正常 | ⏳ 待验证 | 见下文"后续开发" |
| 附件上传（图片） | ⏳ 待验证 | attachImageToFileInput 逻辑待实页确认 |
| selectors.json 真实 Claude DOM 回填 | ⏳ 待回填 | Gemini 模板猜测，需实页替换 |

---

## 后续开发待办（进行中）

1. **历史记录保存**：确认 ChatDuel 的 session/conversation store 能正常保存 Claude 的问答（含转写摘要）。核查 `getConversationState()` / `getLastResponse()` 在真实 Claude 页面返回是否正确。
2. **附件上传**：实页验证 `attachImageToFileInput` 在真实 Claude 页面能找到 `fileInput`、注入文件、等待上传就绪。
3. **selectors.json 回填**：用真实 Claude DOM 选择器覆盖 `inputBox` / `sendButton` / `messageContainer` / `lastResponse` / `userMessage` / `fileInput` 等字段，并补 `tests/unit/selectors-schema.test.ts`。
4. 以上全通过后，按収尾清单走版本号 bump + GitHub 打包。

---

## 历史排查依据（已解决，保留供参考）

> 以下为 2026-06-20 移除 Claude 时的排查记录，问题现已通过上述 cookie 方案解决。完整版见 `docs/research/2026-06-19-claude-integration-notes.md`。

- **发送链路不是唯一问题**：`ok=true` 只代表写入/点击完成，不代表 Claude 官方页回答了。
- **模型菜单空不是 CSS 隐藏**：修复焦点/高度后菜单外壳可见，但 `role="group"` 为空——官方页在 iframe 环境没有生成模型列表。根因现已确认为 cookie 缺失，不是 UI 问题。
- **localStorage 不能同步当前模型**：iframe 和独立页都能看到 `claude-sonnet-4-6` 相关 key，但当前模型不同。说明模型状态由服务端 + cookie 决定，非纯前端缓存。
- **官方标签页兜底不适合当前框架**：会让 Claude 成为唯一"不按当前面板发送"的特殊平台，破坏"同屏对比"一致性。现因 cookie 方案已解决，无需此备选。
- 其余坑（发送按钮无稳定 aria-label 需 composer 兜底、工具进度降噪、Enter 兜底、父页抢焦点）的实现已固化在 adapter / content script 中，仍可参考 `docs/research/2026-06-19-claude-integration-notes.md` 的坑 1/7/8/9/10。
