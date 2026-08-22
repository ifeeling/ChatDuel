// 响应游标：用发送前记住的候选节点位置判断"这是不是新回答"，代替逐平台的文本
// 特征/前缀猜测。移植自 ai-arena 的 rememberResponseCursor/getResponseTailCandidates
// （tmp/ai-arena-extension/src/content-shared.js:52-103），决策见 ADR-0008。
//
// 与 ai-arena 原版的两处刻意差异：
// - 不用 site 字符串在模块级 Map 里分号：ChatDuel 每个平台 content-script 只在启动时
//   创建一次适配器实例（见 adapters/shared/content-script-bootstrap.ts），此后长期复用，
//   所以游标状态放在 createResponseCursor() 返回的闭包里即可，不需要跨实例共享的全局态——
//   全局 Map 反而会在单测里跨用例互相沾染（每个测试各自新建适配器，但模块只加载一次）。
// - 不做 tail-N 截断：ai-arena 截断是为了控制 9 个平台高频轮询的开销，与"新旧判断"这个
//   机制本身无关；截断在候选数天然较多时（如结构复杂的长回答）可能误删真实候选，
//   这正是本机制要消灭的那类"读漏"问题，不应该重新引入。
//
// 用法：发送前调用 remember(候选列表) 记住最后一个元素作为锚点；读取时调用
// sinceAnchor(候选列表) 只保留锚点之后新出现的候选。未 remember 过时原样放行全部候选。
//
// 两个方法都只接受数组：两个调用方（DeepSeek/豆包 adapter）传入的候选列表本来就是
// `document.querySelectorAll` 结果过滤后的普通数组，没有 NodeList/单元素调用场景，
// 不提前支持用不到的输入形状。
export interface ResponseCursor {
  remember(elements: readonly Element[]): void
  sinceAnchor<T extends Element>(elements: readonly T[]): T[]
}

export function createResponseCursor(): ResponseCursor {
  let hasAnchor = false
  let anchor: Element | null = null

  return {
    remember(elements) {
      hasAnchor = true
      anchor = elements.length ? elements[elements.length - 1] : null
    },

    sinceAnchor<T extends Element>(elements: readonly T[]): T[] {
      if (!hasAnchor || !anchor) return [...elements]

      const idx = elements.indexOf(anchor as T)
      if (idx >= 0) return elements.slice(idx + 1)

      // 锚点已被站点 SPA 重渲染整体摘除（detached）：compareDocumentPosition 对不在
      // 文档内的元素只会返回 DISCONNECTED（不含 FOLLOWING 位），按位置过滤会把真实新
      // 回答全部丢掉——锚点失效一律回退全部候选，交给调用方原有的评分/去重逻辑兜底。
      if (!anchor.isConnected) return [...elements]

      const following = Node.DOCUMENT_POSITION_FOLLOWING
      const capturedAnchor = anchor
      return elements.filter((el) => {
        try {
          return !!(capturedAnchor.compareDocumentPosition(el) & following)
        } catch {
          return false
        }
      })
      // 锚点仍在文档中但其后确无新候选：本轮回答尚未出现，上面的 filter 已经是空数组，
      // 按调用方原有逻辑处理"没有候选"即可，不需要额外分支。
    },
  }
}
