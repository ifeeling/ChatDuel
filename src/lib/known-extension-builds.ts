// 发布出去的两个扩展 ID；必须和 chatduel_ifeeling_app 仓库
// lib/prompt-optimization.js 里的 ALLOWED_EXTENSION_ORIGINS 保持一致。
const KNOWN_EXTENSION_IDS = new Set([
  'ggddfpmgeppjejfanaloopfpiiakljjl', // Chrome Web Store
  'jnnocldpbodbnnkojbdklkgcoeiajekk', // Edge Add-ons
])

export function isKnownExtensionBuild(extensionId: string): boolean {
  // 本地开发构建(`npm run dev` / `vite build --mode development`)不检查具体 ID，
  // 跟后端 isAllowedOrigin 的 NODE_ENV 闸门是同一个"物理隔离而非开关"设计，
  // 商店构建(默认 production mode)不受影响。见 ADR-0007。
  if (import.meta.env.MODE === 'development') return true
  return KNOWN_EXTENSION_IDS.has(extensionId)
}
