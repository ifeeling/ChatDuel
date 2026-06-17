# ChatDuel Chrome / Edge 上架材料草稿

更新日期：2026-06-16

这份文档用于准备 Chrome Web Store 和 Microsoft Edge Add-ons 的上架表单。提交前需要把截图、联系邮箱、官网或隐私政策 URL 补齐。

## 1. 扩展名称

ChatDuel

## 2. 一句话简介

在一个页面里同时使用 ChatGPT、Gemini、豆包，对比多个 AI 的回答。

## 3. 简短描述

ChatDuel 是一个多 AI 同步问答与横向对比工具。它不会调用任何 LLM API，也不需要 API Key，而是在用户已经登录的官方网页上辅助输入、发送、读取回答，并把结果放在同一个工作区里对比。

## 4. 详细描述

ChatDuel 适合需要同时比较多个 AI 回答的人。用户打开 ChatDuel 后，可以在同一个页面里并排查看 ChatGPT、Gemini、豆包，使用一个共用输入框同时发送问题，也可以用 `@chatgpt`、`@gemini`、`@doubao` 指定只发给某一个 AI。

主要功能：

- 多 AI 同屏对比：当前支持 ChatGPT、Gemini、豆包。
- 共用输入框：输入一次，可以发送到多个已启用 AI。
- 指定目标：使用 `@chatgpt`、`@gemini`、`@doubao` 精确选择发送对象。
- 附件辅助：支持图片、TXT、Markdown、CSV、PDF、Excel 等文件，并按平台能力自动处理。
- 回答转发：把某个 AI 的回答转发给其它 AI 解读或审查。
- 对比总结：从历史问答中选择内容，让指定 AI 生成总结、分歧或最终结论。
- 本地记录：保存用户自己的问答历史，方便回看、复制、导出 Markdown、总结和转发。
- 官方会话恢复：保存官方网页会话链接和面板状态，方便回到原平台继续聊。
- 多语言界面：支持中文、English、Français、Deutsch、Svenska、Norsk、Nederlands。

ChatDuel 不是 AI 服务提供商，不替用户生成内容，不提供代理账号，不绕过任何平台登录、付费、限流或内容规则。用户仍然使用自己已经登录的官方 AI 平台账号。

隐私说明：

- ChatDuel 不会把用户聊天内容、AI 回复或附件内容上传到 ChatDuel 服务器。
- 历史记录保存在用户自己的浏览器本地存储中。
- ChatDuel 只请求配置接口，用于获取页面选择器配置。
- 配置服务器只记录最小技术日志：时间、脱敏 IP、User-Agent、扩展版本、配置版本、状态码。

## 5. 类别建议

优先选择：

- Productivity

备选：

- Tools

## 6. 语言

建议首发：

- 中文
- English

当前扩展界面还支持：

- Français
- Deutsch
- Svenska
- Norsk
- Nederlands

## 7. 权限说明

### storage / unlimitedStorage

用于在用户浏览器本地保存历史记录、设置、会话状态、附件信息和远程配置缓存。历史记录只保存在本地，不上传到 ChatDuel 服务器。

### tabs

用于识别用户是否已经打开 ChatGPT、Gemini、豆包官方网页，并在 ChatDuel 页面中显示平台状态。

### scripting

用于在用户已打开的官方 AI 网页中注入内容脚本，辅助输入、发送和读取页面回答。

### declarativeNetRequest

用于在用户主动打开 ChatDuel 工作区时，按需调整官方网页的嵌入限制，使官方网页可以显示在扩展页面中。关闭 ChatDuel 页面后会清理相关规则。

### downloads

用于把用户本地记录导出为文件。

### alarms

用于定期刷新远程选择器配置，减少官方网页结构变化导致扩展失效的时间。

### host_permissions

仅用于访问以下必要域名：

- `https://chatgpt.com/*`：ChatGPT 官方网页。
- `https://gemini.google.com/*`：Gemini 官方网页。
- `https://doubao.com/*` 和 `https://www.doubao.com/*`：豆包官方网页。
- `https://chatduel.ifeeling.app/*`：ChatDuel 配置接口。

## 8. 数据使用声明草稿

建议在上架表单中按下面口径填写：

- 是否收集个人身份信息：否。
- 是否收集健康、金融、身份认证、私人通讯等敏感数据：否。
- 是否收集网页浏览记录：否。
- 是否收集用户内容：ChatDuel 服务器不收集。扩展会在本地保存用户主动使用扩展产生的问答历史，用于本地回看、复制、导出、总结和转发。
- 是否向第三方出售或共享数据：否。
- 是否把数据用于广告或追踪：否。

需要注意：

用户主动发送到 ChatGPT、Gemini、豆包官方平台的内容，会由对应平台按其隐私政策处理。ChatDuel 只是辅助用户在已登录网页上操作，不控制第三方平台的数据处理。

## 9. 隐私政策 URL

提交审核时需要填写一个公开可访问的隐私政策 URL。

建议把 `docs/store/privacy-policy.md` 的内容发布到以下任一位置：

- 官网页面，例如 `https://chatduel.ifeeling.app/privacy`
- GitHub Pages
- 项目 README 中稳定可访问的隐私政策页面

上架前需要替换为正式 URL：

`请替换为正式隐私政策 URL`

## 10. 截图清单

建议准备 4 到 5 张截图：

- ChatDuel 主工作区，三栏显示 ChatGPT、Gemini、豆包。
- 共用输入框和 `@` 指定目标发送。
- 回答对比和差异高亮。
- 历史记录 / 总结 / 转发功能。
- 设置页，展示平台开关、语言和提示词配置。

截图里不要出现真实个人账号、私人聊天内容、邮箱、手机号或敏感信息。

## 11. 审核备注草稿

ChatDuel is a browser extension for comparing responses from official AI web pages in a split-screen workspace. It does not provide AI services, does not call LLM APIs, and does not require API keys.

Users must already be logged in to the official websites. The extension only helps users input text, click existing send buttons, read visible responses, and compare results locally.

ChatDuel does not collect or upload users' prompts, AI responses, attachments, cookies, tokens, sessions, or browsing history to the ChatDuel server. Local history is stored in the user's browser storage only.

The extension requests `https://chatduel.ifeeling.app/api/extension/config` only to fetch selector configuration for maintaining compatibility with supported official websites. The config server stores minimal technical access logs: timestamp, masked IP, User-Agent, extension version, config version, and HTTP status code.

## 12. 发布前检查

- 隐私政策已发布到公开 URL。
- 隐私政策里已补正式联系邮箱。
- README、manifest、上架说明里的产品名都是 ChatDuel。
- 截图不含私人数据。
- `npm test` 通过。
- `npm run typecheck` 通过。
- `npm run build` 成功。
