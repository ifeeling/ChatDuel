# Copilot/Grok 文本基础版接入设计

## 目标

先把 Copilot 和 Grok 接入 ChatDuel 的基础文本链路：能作为可选平台显示，能加载官方网页，能写入文本、触发发送、读取最后回答，并参与 @ 指定、记录、转发和总结目标。

图片上传不在本阶段直接打开能力。实现文本接入时同步记录 Copilot、Grok、DeepSeek 的附件入口线索，后续统一做图片上传攻关。

## 范围

本阶段包含：

1. 新增平台 key：`copilot`、`grok`。
2. 新增平台元数据、默认设置、面板 HTML、iframe URL、content script、adapter、DNR 规则、service worker URL 前缀、构建入口和测试。
3. Copilot/Grok 默认关闭，避免用户升级后界面突然变成太多面板。
4. `supportsText: true`、`supportsLastResponse: true`，图片和文件自动上传先关闭。
5. 写入每个平台的接入记录文档。

本阶段不包含：

1. 图片自动上传。
2. 官方会话 URL 特判。
3. 超过当前最多 3 个面板的布局改造。
4. 远程 selector 服务端发布。

## 平台入口

- Copilot：`https://copilot.microsoft.com/`
- Grok：`https://grok.com/`

## 架构

沿用现有平台接入方式。每个平台一套 adapter 和 content script，通过统一 `AIAdapter` 接口接入主页面。平台能力只在 `src/lib/ai-platforms.ts` 中声明，发送链路根据 capability 自动决定是否上传附件。

Copilot/Grok 第一版 adapter 使用通用选择器：

- 输入框：`textarea`、`[contenteditable="true"]`、`[role="textbox"]`
- 发送控件：`button[aria-label/title*="Send"]`、中文“发送”、`button[type="submit"]`
- 回答内容：`article`、`[data-testid*="message"]`、`[class*="message"]`、`[class*="response"]`、`[class*="answer"]`

如果真实页面选择器失效，优先用 DevTools 诊断并补平台文档，再改 adapter 或远程 selector 白名单。

## 附件策略

Copilot/Grok 初始设置：

```ts
supportsImageUpload: false
supportsFileUpload: false
```

原因：

1. DeepSeek 已证明“看似可派发 paste/drop”不等于官方页面真的随消息提交附件。
2. Copilot/Grok 需要先确认真实页面的附件入口、预览节点和发送后模型是否承认收到附件。
3. 以后做图片上传时，三平台一起按同一调试清单验证：DeepSeek、Copilot、Grok。

## 测试要求

1. 平台注册测试覆盖 `SUPPORTED_PLATFORMS` 和 capability。
2. 默认设置测试覆盖 Copilot/Grok 默认关闭且顺序可归一化。
3. manifest 测试覆盖 content script 和 host permission。
4. content script location 测试覆盖新域名。
5. adapter 单测覆盖文本写入、发送触发和回答读取。
6. 构建、类型检查、全量单测都必须通过。

## 文档要求

新增：

- `docs/COPILOT_INTEGRATION_NOTES.md`
- `docs/GROK_INTEGRATION_NOTES.md`

每份文档至少记录入口 URL、当前能力、初始选择器、未开启图片上传的原因、后续图片上传调试清单。
