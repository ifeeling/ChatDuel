// 平台就绪体检（issue #13）：把「iframe 有没有成功加载目标站点」「content-script
// 命令桥还活不活」「有没有可能未登录」拆成三项独立检查，每项各自超时、互不阻塞——
// 一项卡住不该拖累另外两项的判定，也方便 UI 给出针对性的修复按钮。
//
// 零平台名分支：三项检查全部复用 platform-communication.ts 已有的原语
// （routeFor / pingContentScript / readConversationState），不为体检另建通道。

import type { AIPlatform } from '../types'
import type { PlatformCommunication } from './platform-communication'

export type HealthCheckStatus = 'ok' | 'fail' | 'unknown'

export interface PlatformHealthCheckResult {
  platform: AIPlatform
  /**
   * iframe 是否成功加载了目标站点，复用 platform-communication.ts 路由选择时
   * 已有的判断（frame.src 是否落在 chrome-error:// 网络错误兜底页）。
   * 只能捕捉浏览器级导航失败（离线、DNS 失败、站点故障）；不覆盖"帧还是
   * about:blank 从未开始加载"或"加载成功但落在应用级错误页"这两类场景——
   * 5 个平台域名已由 dnr-rules.ts 主动剥离 X-Frame-Options/frame-ancestors，
   * 真正因此类响应头被拦截的情况本就被网络层缓解了大半。
   */
  frame: { status: HealthCheckStatus }
  /** content-script 命令桥是否在当下就能响应。 */
  ping: { status: HealthCheckStatus }
  /** 登录态：ping 都不通时无法判断，标为 unknown 而不是误报失败。 */
  login: { status: HealthCheckStatus; errorMessage?: string }
}

export interface PlatformHealthCheckDependencies {
  communication: Pick<PlatformCommunication, 'routeFor' | 'readConversationState' | 'pingContentScript'>
  /** 每项检查的超时时间；对齐 ai-arena 参考实现的 5 秒。 */
  timeoutMs?: number
}

export async function checkPlatformHealth(
  platform: AIPlatform,
  dependencies: PlatformHealthCheckDependencies,
): Promise<PlatformHealthCheckResult> {
  const timeoutMs = dependencies.timeoutMs ?? 5000
  const { communication } = dependencies

  const frameStatus: HealthCheckStatus = communication.routeFor(platform) === 'iframe' ? 'ok' : 'fail'

  // 注意：readConversationState 在 iframe 命令桥首次超时后会自带一次
  // "重连并重试"（platform-communication.ts 的 requestReadOnlyCommandBridge），
  // 这是全站统一的读操作自愈行为，体检并未特别绕开它——命令桥已经不通时，
  // 体检本身可能顺带触发一次重连尝试，这与"体检只读"的直觉略有出入，
  // 但重连成功等价于问题已自愈，重连失败也不影响本次体检判定为 fail。
  const [pingAlive, state] = await Promise.all([
    communication.pingContentScript(platform, timeoutMs),
    communication.readConversationState(platform, timeoutMs),
  ])

  const pingStatus: HealthCheckStatus = pingAlive ? 'ok' : 'fail'
  const loginStatus: HealthCheckStatus = !pingAlive ? 'unknown' : state.needsLogin ? 'fail' : 'ok'

  return {
    platform,
    frame: { status: frameStatus },
    ping: { status: pingStatus },
    login: {
      status: loginStatus,
      errorMessage: loginStatus === 'fail' ? state.errorMessage : undefined,
    },
  }
}

export function checkAllPlatformsHealth(
  platforms: readonly AIPlatform[],
  dependencies: PlatformHealthCheckDependencies,
): Promise<PlatformHealthCheckResult[]> {
  return Promise.all(platforms.map((platform) => checkPlatformHealth(platform, dependencies)))
}

/** 一项检查是否可以被"重开/刷新"这类通用操作自动修复（登录需要人工，排除在外）。 */
export function isAutoFixable(result: PlatformHealthCheckResult): boolean {
  return result.frame.status === 'fail' || result.ping.status === 'fail'
}
