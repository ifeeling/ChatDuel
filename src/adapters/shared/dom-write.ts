// 共享「写值 / 发送确认」适配原语。
//
// 平台差异一律以参数传入，函数体内零平台名分支。行为等价是硬约束：
// 抽取不得悄悄改变任何平台的发送与回答捕获结果，平台间已有的事件顺序
// 差异通过 DispatchOrder 参数原样保留。

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// 写值后派发的 input / beforeinput 事件顺序。不同平台的前端框架
// （ProseMirror / TipTap / 自研富文本）对事件顺序的敏感方向不同，
// 这是真实存在的平台差异，必须按平台保留，不能统一成单一顺序。
export type DispatchOrder = 'input-then-beforeinput' | 'beforeinput-then-input'

// 往 contenteditable 输入框写值：
//   1) 清空并写入 text（contenteditable 的内容直接就在 DOM 里，无需走
//      原生 value setter，框架靠 MutationObserver 感知变化）；
//   2) 派发 input / beforeinput 事件让框架内部 state 同步。
//
// order 必须显式传入，由各平台指定正确顺序：
//   - 'input-then-beforeinput' 对应 ChatGPT / Claude（ProseMirror/TipTap）；
//   - 'beforeinput-then-input' 对应豆包 / DeepSeek。
// 这是真实存在的平台差异，不得统一成单一顺序，否则会静默改掉某个平台的输入行为。
//
// ⚠️ 绝不能调 el.focus()：跑在跨源 iframe 子 frame 里时 Chrome 会拒绝
// 跨源子 frame 的 textarea 主动 focus，抛 "Blocked autofocusing on a
// <textarea> element in a cross-origin subframe"（见
// docs/postmortems/2026-06-09-iframe-no-response.md §2.3）。本原语被多个平台
// 共用，加一句 focus() 会一次性打挂所有依赖它的平台。
export function writeEditableValue(
  el: HTMLElement,
  text: string,
  order: DispatchOrder,
): void {
  el.textContent = text
  const build = (type: 'input' | 'beforeinput') =>
    new InputEvent(type, { bubbles: true, cancelable: true, inputType: 'insertText', data: text })
  if (order === 'beforeinput-then-input') {
    el.dispatchEvent(build('beforeinput'))
    el.dispatchEvent(build('input'))
  } else {
    el.dispatchEvent(build('input'))
    el.dispatchEvent(build('beforeinput'))
  }
}

// 轮询等待发送被接受：每 100ms 检查一次 isAccepted 谓词，直到超时才返回最终判定。
//
// isAccepted 由各平台传入（通常语义是「出现停止生成按钮 或 输入框已清空」），
// 函数体内不写任何平台专属判断，只负责轮询节奏与返回语义。
// 返回 true 表示在超时前判定为已接受；false 表示超时仍未接受。
export async function waitForSendAccepted(
  isAccepted: () => boolean,
  maxMs = 700,
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (isAccepted()) return true
    await sleep(100)
  }
  return isAccepted()
}
