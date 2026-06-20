# Claude 接入记录

## 最终结论

2026-06-20，Claude 已从 ChatDuel 扩展运行时移除。

保留这份记录，删除或不再构建 Claude adapter、Claude content script、Claude iframe panel、Claude manifest 权限、Claude DNR 规则和 Claude 相关测试。

原因：Claude 官方页在 ChatDuel iframe 里会卡在不可用的旧模型 `claude-3-5-haiku-latest`，而模型菜单虽然能打开外壳，却不生成任何可选模型项。用户在独立 Claude 标签页里切到 `Sonnet 4.6 Low` 后，回到 iframe 刷新仍然显示旧模型。继续保留 Claude 会给用户一个“看起来能用，但模型不可用且无法切换”的入口。

## 当时实现过什么

- 把 Claude 作为第 4 个可选平台加入平台元数据和设置项，默认关闭。
- 增加 Claude iframe panel、manifest host permission、content script 入口和 DNR iframe 嵌入规则。
- 实现过 Claude adapter：
  - 写入 Claude 输入框。
  - 查找无稳定 `aria-label` 的发送按钮。
  - 发送后确认 prompt 是否真的离开输入框。
  - 捕获 Claude 回答内容，并过滤工具进度、按钮图标等页面噪音。
- 给 Claude 模型菜单做过 iframe 样式补丁，解决过菜单外壳高度过小的问题。
- 尝试过“官方标签页兜底”：iframe 模型不可用时，转而向用户单独打开并已切好模型的 Claude 标签页发送消息。

## 关键问题

### 1. 发送链路不是唯一问题

Claude 输入框可以写入，发送按钮也能被点击。部分情况下父页日志会出现：

```text
[AIChatRoom chat] write-and-send result for claude: ok=true error=
```

但 `ok=true` 只代表 ChatDuel 写入/点击动作完成，不代表 Claude 官方页一定能回答。

### 2. 旧模型不可用

iframe 内 Claude 显示：

```text
claude-3-5-haiku-latest
```

官方提示：

```text
This model isn't available right now. You can switch to another model to continue using Claude.
```

问题是 iframe 里无法切换模型，所以这个入口实际不可用。

### 3. 模型菜单空，不是 CSS 隐藏

修掉父页抢焦点和菜单外壳高度后，iframe 中模型按钮可以变成展开状态，菜单外壳也可见。但调试结果显示：

- `role="menu"` 容器可见。
- 内部有滚动层和 `role="group"`。
- `role="group"` 为空。
- iframe DOM 里没有 `Sonnet` / `Opus` / `Haiku` 菜单项。

所以问题不是菜单项被遮住，而是 Claude 官方页在 iframe 环境没有生成模型列表。

### 4. localStorage 不能同步当前模型

独立 Claude 标签页和 ChatDuel iframe 都能看到类似下面的 key：

```text
LSS-model-selector-thinking:...:chat:claude-sonnet-4-6
```

但 iframe 当前模型仍是 `claude-3-5-haiku-latest`。这说明当前模型不是简单复制 `localStorage` 就能改变的状态。

### 5. 官方标签页兜底不适合当前框架

官方标签页兜底能绕过 iframe 模型菜单问题，但它会让 Claude 成为唯一一个“不按当前扩展面板发送”的特殊平台：

- 面板里显示旧模型。
- 真实发送可能发生在另一个独立 Claude 标签页。
- 用户很难判断当前到底发给了哪个页面、哪个模型。

这会破坏 ChatDuel “同屏对比官方网页”的一致性，所以最后没有保留。

## 以后如果重新接 Claude

先验证，不要直接恢复旧代码：

1. 在 ChatDuel iframe 中打开 Claude 模型菜单。
2. 确认 DOM 里真的生成了 `Sonnet` / `Opus` / `Haiku` 等模型项。
3. 确认能在 iframe 中切换到可用模型，并且刷新后仍保持可用模型。
4. 再接回 adapter、content script、manifest、DNR、设置项和测试。

如果 Claude 仍然不能在 iframe 里切模型，就不要把它作为普通 iframe 平台接回。那时需要重新设计官方标签页方案，并在 UI 上明确告诉用户真实发送发生在独立 Claude 标签页，而不是当前面板。
