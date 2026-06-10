// @ 提及解析。
//
// 两路并存:
//   1) 文本路径:用户在 textarea 手打 "@chatgpt ...",这里解析出 mention
//   2) UI 路径:用户点弹层选中 AI,走 at-popup 状态(不进文本)
//
// 这里只负责路径 1(纯函数,好测)。路径 2 的状态在 chat.ts 里维护。
// 候选 key 集合从外部传入,这样加新 AI 不用改这里。

import { AI_PLATFORMS, type AIPlatformMeta } from './ai-platforms'
import type { AIPlatform } from '../types'

const AT_RE = /@([A-Za-z][\w-]*)/g

/**
 * 从文本中解析出所有 @mention。
 * @param text 原始文本
 * @param validKeys 可接受的 key 集合(默认 = 所有已注册 AI);不在集合里的 @xxx 被忽略
 */
export function parseAtMentions(
  text: string,
  validKeys: ReadonlySet<string> = new Set(Object.keys(AI_PLATFORMS)),
): AIPlatform[] {
  if (!text) return []
  const seen = new Set<string>()
  const result: AIPlatform[] = []
  let m: RegExpExecArray | null
  AT_RE.lastIndex = 0
  while ((m = AT_RE.exec(text)) !== null) {
    const name = m[1]
    const key = name.toLowerCase()
    if (!validKeys.has(key)) continue
    if (seen.has(key)) continue
    seen.add(key)
    result.push(key as AIPlatform)
  }
  return result
}

/**
 * 解析当前"@ 输入中"的状态:返回光标前那个未完成的 @mention,以及它应该
 * 用来过滤候选的前缀。返回 null 表示当前没有 @ 输入中。
 *
 * 例子:
 *   text = "@cha"          → { prefix: "cha", startIndex: 0 }
 *   text = "hello @cha"    → { prefix: "cha", startIndex: 6 }
 *   text = "hello world"   → null
 *   text = "@"             → { prefix: "", startIndex: 0 }
 *   text = "abc@chat"      → null(@chat 不在词首)
 */
export interface AtInputState {
  prefix: string
  startIndex: number
}

export function detectAtInput(textBeforeCaret: string): AtInputState | null {
  // 找最后一个 @,且 @ 必须是词首(前面是空白/行首)
  const idx = textBeforeCaret.lastIndexOf('@')
  if (idx < 0) return null
  // @ 前面必须是空白/行首(避免 email 之类误伤)
  if (idx > 0) {
    const prev = textBeforeCaret[idx - 1]
    if (!/\s/.test(prev)) return null
  }
  const after = textBeforeCaret.slice(idx + 1)
  // @ 之后到光标之间不能有空白(否则 @mention 结束)
  if (/\s/.test(after)) return null
  return { prefix: after.toLowerCase(), startIndex: idx }
}

/**
 * 给一个 prefix,从候选里筛出"label 或 key 以 prefix 开头"的项。
 * 大小写不敏感;空 prefix = 全部。
 */
export function filterCandidates(
  candidates: ReadonlyArray<AIPlatformMeta>,
  prefix: string,
): AIPlatformMeta[] {
  if (!prefix) return [...candidates]
  const p = prefix.toLowerCase()
  return candidates.filter(
    (c) => c.key.toLowerCase().startsWith(p) || c.label.toLowerCase().startsWith(p),
  )
}
