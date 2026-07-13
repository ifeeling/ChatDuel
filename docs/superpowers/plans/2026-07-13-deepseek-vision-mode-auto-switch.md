# DeepSeek 自动切换到识图模式实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DeepSeek 新对话面板自动进入识图模式，并让现有附件分发链路真正上传图片。

**Architecture:** adapter 使用三态检测、单次点击和明确页面证据完成模式切换；content script 在 ready 之后异步触发，不阻塞面板初始化。随后开放 DeepSeek 图片 capability，并删除与新能力冲突的前台预警。

**Tech Stack:** TypeScript, Chrome MV3 extension APIs, Vitest.

**Spec:** [2026-07-13-deepseek-vision-mode-auto-switch-design.md](../specs/2026-07-13-deepseek-vision-mode-auto-switch-design.md)

## Global Constraints

- 仅修改 DeepSeek 模式切换和现有图片能力接线，不改其他平台 adapter；
- 不依赖 DeepSeek 混淆 class；
- 面板 ready 和消息监听不能等待最长 8 秒的模式切换；
- 模式按钮最多点击一次，`click()` 本身不算成功；
- 图片上传仍以 composer 附近出现附件预览、文件名或上传块为成功证据；
- `supportsFileUpload` 保持 `false`；
- 不新增依赖。

---

## Files

- Modify: `src/adapters/deepseek/adapter.ts` — 三态检测和自动切换；
- Modify: `src/content-scripts/deepseek-content.ts` — ready 后异步触发切换；
- Modify: `src/lib/ai-platforms.ts` — 开放 DeepSeek 图片能力；
- Modify: `src/chat/chat.ts` — 删除过时的 DeepSeek 图片预警；
- Modify: `tests/unit/deepseek-adapter.test.ts` — 模式切换测试；
- Modify: `tests/unit/ai-platforms.test.ts` — capability 回归；
- Modify: `tests/unit/file-handler.test.ts` — 图片分发回归；
- Modify: `docs/DEEPSEEK_INTEGRATION_NOTES.md` — 记录模式、按钮、成功证据和失败表现。

---

### Task 1: 用红测定义模式切换行为

**Files:**
- Modify: `tests/unit/deepseek-adapter.test.ts`

**Interfaces:**
- Consumes: `ensureDeepSeekVisionMode(): Promise<boolean>`；
- Verifies: 明确状态判断、延迟渲染、单次点击、超时和不可用按钮。

- [ ] **Step 1: 添加失败测试**

先从 `adapter.ts` 导入尚未实现的 `ensureDeepSeekVisionMode`，添加以下场景。测试使用 fake timers，并在每个用例后恢复 real timers：

```ts
describe('ensureDeepSeekVisionMode', () => {
  it('does not click when vision mode is explicitly active', async () => { /* active control -> true, 0 clicks */ })
  it('clicks once and waits for explicit vision evidence', async () => { /* quick -> click -> aria-selected=true -> true */ })
  it('waits for a delayed vision mode button', async () => { /* insert button after initial render -> true */ })
  it('returns false when the button never appears', async () => { /* advance beyond timeout */ })
  it('does not repeatedly click when verification times out', async () => { /* expect 1 click and false */ })
  it('ignores hidden and disabled matching controls', async () => { /* expect 0 clicks and false */ })
  it('does not treat an unknown page state as success', async () => { /* empty semantic state -> false */ })
})
```

断言只锁行为，不锁内部轮询次数或混淆 DOM 结构。

- [ ] **Step 2: 运行红测**

```bash
npx vitest run tests/unit/deepseek-adapter.test.ts
```

Expected: FAIL，原因是 `ensureDeepSeekVisionMode` 尚未导出或行为尚未实现。

- [ ] **Step 3: 提交测试**

```bash
git add tests/unit/deepseek-adapter.test.ts
git commit -m "test(deepseek): define vision mode switching behavior"
```

---

### Task 2: 实现可验证、单次点击的模式切换

**Files:**
- Modify: `src/adapters/deepseek/adapter.ts`
- Test: `tests/unit/deepseek-adapter.test.ts`

**Interfaces:**
- Produces: `export async function ensureDeepSeekVisionMode(): Promise<boolean>`；
- Internal: `type DeepSeekModeState = 'vision' | 'non-vision' | 'unknown'`；
- Reuses: `activateControl()`、`logCaptureDebug()` 和现有模式证据。

- [ ] **Step 1: 提取三态检测**

将现有布尔模式判断的 DOM 证据提取为三态检测。`assertCanSendImageInCurrentMode()` 保持当前兼容语义：只有明确 `non-vision` 时阻止上传；自动切换只有明确 `vision` 才算成功。

- [ ] **Step 2: 实现等待按钮与切换验证**

实现以下流程：

```ts
export async function ensureDeepSeekVisionMode(): Promise<boolean> {
  // 1. explicit vision => true
  // 2. poll up to 8s for one visible, enabled semantic control
  // 3. activate exactly once
  // 4. poll for explicit vision evidence
  // 5. log a stable reason and return false on timeout/exception
}
```

按钮候选仅包含 `button, [role="button"], [role="tab"], [role="radio"]`。匹配规范化后的 `textContent`、`aria-label` 或 `title` 等于“识图模式”；排除 `hidden`、`aria-hidden="true"`、`disabled`、`aria-disabled="true"` 和没有布局可见性的元素。为 jsdom 测试提供不依赖真实布局尺寸的可测试可见性边界。

按钮查找阶段和点击后验证阶段使用独立 deadline，点击后不能回到查找循环再次点击。

- [ ] **Step 3: 运行 adapter 测试**

```bash
npx vitest run tests/unit/deepseek-adapter.test.ts
```

Expected: PASS，包括现有快速模式拒绝图片和附件预览证据测试。

- [ ] **Step 4: 提交实现**

```bash
git add src/adapters/deepseek/adapter.ts tests/unit/deepseek-adapter.test.ts
git commit -m "feat(deepseek): switch to vision mode safely"
```

---

### Task 3: 在 content script 中非阻塞启动

**Files:**
- Modify: `src/content-scripts/deepseek-content.ts`

**Interfaces:**
- Consumes: `ensureDeepSeekVisionMode` from `../adapters/deepseek/adapter`。

- [ ] **Step 1: 调整 boot 顺序**

保持现有 adapter 创建、父页面监听和 `chrome.runtime.onMessage` 注册逻辑。`postReadyToParent()` 不能等待切换；在监听已经注册且 ready 已发送后调用：

```ts
void ensureDeepSeekVisionMode()
```

函数自身处理失败，不能产生未处理的 Promise rejection。

- [ ] **Step 2: 运行类型检查和 adapter 测试**

```bash
npm run typecheck
npx vitest run tests/unit/deepseek-adapter.test.ts
```

Expected: PASS。

- [ ] **Step 3: 提交接线**

```bash
git add src/content-scripts/deepseek-content.ts
git commit -m "feat(deepseek): start vision switch after panel ready"
```

---

### Task 4: 开放 DeepSeek 图片分发并删除冲突提示

**Files:**
- Modify: `tests/unit/ai-platforms.test.ts`
- Modify: `tests/unit/file-handler.test.ts`
- Modify: `src/lib/ai-platforms.ts`
- Modify: `src/chat/chat.ts`

**Interfaces:**
- Produces: DeepSeek capability `{ supportsImageUpload: true, supportsFileUpload: false }`；
- Verifies: DeepSeek 位于图片 `autoUploadTargets`，不在 `manualUploadTargets`。

- [ ] **Step 1: 先更新 capability 和分发红测**

把当前断言 DeepSeek 不支持图片、只发送文字的测试改为：

```ts
expect(getPlatformCapabilities('deepseek')).toMatchObject({
  supportsImageUpload: true,
  supportsFileUpload: false,
})
expect(supportsAutoUpload('deepseek', image)).toBe(true)
```

同时断言带图片的 delivery plan 将 DeepSeek 放入 `autoUploadTargets`。

- [ ] **Step 2: 运行红测**

```bash
npx vitest run tests/unit/ai-platforms.test.ts tests/unit/file-handler.test.ts
```

Expected: FAIL，显示当前 capability 和分发计划仍是旧行为。

- [ ] **Step 3: 最小实现**

- 将 `src/lib/ai-platforms.ts` 中 DeepSeek `supportsImageUpload` 改为 `true`；
- 保持 `supportsFileUpload: false`；
- 删除 `updateAttachmentWarning()` 中针对 DeepSeek 图片的错误预警及其调用链中只为该预警存在的逻辑；若 DOM 结构仍被其他功能使用则只移除平台特判，不顺手重构。

- [ ] **Step 4: 运行相关测试**

```bash
npx vitest run tests/unit/ai-platforms.test.ts tests/unit/file-handler.test.ts tests/unit/deepseek-adapter.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交能力接线**

```bash
git add src/lib/ai-platforms.ts src/chat/chat.ts tests/unit/ai-platforms.test.ts tests/unit/file-handler.test.ts
git commit -m "feat(deepseek): enable image delivery in vision mode"
```

---

### Task 5: 更新维护说明并完整验证

**Files:**
- Modify: `docs/DEEPSEEK_INTEGRATION_NOTES.md`

- [ ] **Step 1: 记录页面契约**

补充以下已验证信息：模式按钮的语义线索、明确选中态、切换失败表现、最长等待、只点击一次、ready 不被阻塞，以及附件上传最终仍以 composer 附近预览/文件名为成功证据。不要记录未经实测的混淆 class。

- [ ] **Step 2: 运行完整验证**

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: 全部退出码为 0。

- [ ] **Step 3: 手动验证**

按设计文档“手动验收”执行新对话、图片实传和旧对话失败三类场景。没有看到附件预览/文件名或 DeepSeek 没有根据图片内容回答时，不能判定功能完成。

- [ ] **Step 4: 提交文档**

```bash
git add -f docs/DEEPSEEK_INTEGRATION_NOTES.md docs/superpowers/specs/2026-07-13-deepseek-vision-mode-auto-switch-design.md docs/superpowers/plans/2026-07-13-deepseek-vision-mode-auto-switch.md
git commit -m "docs(deepseek): document vision mode automation"
```

仓库当前通过 `.gitignore` 忽略整个 `docs/` 目录，因此本步骤必须使用 `git add -f`；否则文档不会进入提交。

## 完成标准

- 新对话自动进入识图模式且不延迟面板 ready；
- 图片被实际传给 DeepSeek，不是只发送文字；
- 模式切换按钮最多点击一次，失败原因可从 debug 日志区分；
- 旧对话失败不影响文本功能，并返回明确错误；
- 单元测试、类型检查、构建、diff 检查和真实页面手动验收全部通过。
