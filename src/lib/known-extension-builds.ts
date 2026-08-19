// 发布出去的两个扩展 ID；必须和 chatduel_ifeeling_app 仓库
// lib/prompt-optimization.js 里的 ALLOWED_EXTENSION_ORIGINS 保持一致。
const KNOWN_EXTENSION_IDS = new Set([
  'ggddfpmgeppjejfanaloopfpiiakljjl', // Chrome Web Store
  'jnnocldpbodbnnkojbdklkgcoeiajekk', // Edge Add-ons
])

export function isKnownExtensionBuild(extensionId: string): boolean {
  return KNOWN_EXTENSION_IDS.has(extensionId)
}
