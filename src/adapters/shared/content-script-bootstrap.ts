// 共享「content-script 引导」适配原语（content-script 引导工厂）。
//
// 五个平台 content-script 的引导流程逐字相同：加载选择器配置 → 创建适配器
// → 安装命令桥。本工厂把这三步收敛为一处，消除五份重复的引导模板。
//
// 约束（沿用适配器工具包其它原语）：
//   - 函数体零平台名分支；平台差异一律以参数传入
//     （createAdapter 决定创建哪个适配器、createExtensionHandler 决定平台专属命令处理）。
//   - 行为等价是硬约束：抽取不得悄悄改变任何平台的发送与回答捕获结果。
//
// 注：本工厂本身只服务于 content-script 引导，因此有意依赖
// content-scripts 下的命令桥与选择器配置加载；这是窄而明确的依赖，不构成平台分支。

import type { AIAdapter } from '../base'
import type { AIPlatform } from '../../types'
import type { SelectorOverrideMap } from '../../lib/remote-selector-config'
import { loadSelectorConfig } from '../../content-scripts/selector-overrides'
import {
  installContentScriptCommandBridge,
  type ContentScriptCommandExtensionHandler,
} from '../../content-scripts/content-script-command-bridge'

export interface BootContentScriptOptions {
  /** 平台标识，透传给选择器加载与命令桥。 */
  platform: AIPlatform
  /** 适配器内置的选择器版本号；远程配置版本更高时会被覆盖。 */
  selectorVersion: string
  /** 用（可能已被远程覆盖的）选择器创建平台适配器。 */
  createAdapter: (selectors?: SelectorOverrideMap) => AIAdapter
  /**
   * 平台专属命令处理器工厂：拿到已创建的适配器后返回命令桥用的 extensionHandler。
   * 平台专属逻辑（如登录/状态探针、会话网址解析）放在这里，保持工厂零平台分支。
   * 不传则命令桥只处理通用命令。
   */
  createExtensionHandler?: (adapter: AIAdapter) => ContentScriptCommandExtensionHandler
}

/**
 * 收敛后的 content-script 引导流程：
 *   1. 加载选择器配置（远程覆盖优先）；
 *   2. 用配置创建平台适配器；
 *   3. 安装命令桥，把平台标识、适配器与选择器版本一并交给它。
 */
export async function bootContentScript(options: BootContentScriptOptions): Promise<void> {
  const selectorConfig = await loadSelectorConfig(options.platform, options.selectorVersion)
  const adapter = options.createAdapter(selectorConfig.selectors)
  installContentScriptCommandBridge({
    platform: options.platform,
    adapter,
    selectorConfigVersion: selectorConfig.version,
    extensionHandler: options.createExtensionHandler?.(adapter),
  })
}
