/**
 * 平台无关的文件输入框查找与图片挂载原语，被五个平台适配器共用。
 *
 * 函数体不含任何平台名分支，因此对任意平台适配器通用；
 * 查找与挂载行为与现状一致，用户上传图片行为不变。
 *
 * - findFileInput：在所有 frame（同源子 frame）里递归查找 file input。
 * - attachImageToFileInput：把图片以 DataTransfer 挂载到 file input 上，
 *   容忍 file input 延迟插入（点完按钮才出现）而做有限重试。
 */

// 候选选择器按优先级排列，命中即返回。采用五个适配器现有列表的并集，
// 因此任一平台原先能命中的选择器在此处仍能命中，不丢能力、不引入平台分支。
const FILE_INPUT_CANDIDATES = [
  "input[type='file'][accept*='image']",
  "input[type='file'][data-testid*='upload' i]",
  "input[type='file'][aria-label*='upload' i]",
  "input[type='file'][aria-label*='image' i]",
  "input[type='file'][aria-label*='附件' i]",
  "input[type='file'][aria-label*='图片' i]",
  "input[type='file']",
]

export interface FindFileInputOptions {
  /** 候选选择器，按优先级排列、命中即返回。默认用五平台并集 FILE_INPUT_CANDIDATES。 */
  candidates?: string[]
  /** 是否递归进入同源子 frame 查找。默认 true（与 chatgpt/gemini/claude 原版一致）。 */
  recurseIframes?: boolean
}

/**
 * 查找 file input。
 * 默认在主文档与所有同源子 frame 里递归查找（与 chatgpt/gemini/claude 原版行为一致）；
 * deepseek/doubao 原版不递归 frame、且只用自己的选择器子集，可显式传
 * { candidates: <原版子集>, recurseIframes: false } 恢复原版行为，避免无意的行为扩张。
 */
export function findFileInput(options: FindFileInputOptions = {}): HTMLInputElement | null {
  const { candidates = FILE_INPUT_CANDIDATES, recurseIframes = true } = options
  function search(doc: Document): HTMLInputElement | null {
    for (const sel of candidates) {
      const el = doc.querySelector<HTMLInputElement>(sel)
      if (el) return el
    }
    if (!recurseIframes) return null
    // 递归子 frame
    const frames = doc.querySelectorAll<HTMLIFrameElement>('iframe')
    for (const f of frames) {
      try {
        const cw = f.contentWindow
        if (!cw) continue
        const r = search(cw.document)
        if (r) return r
      } catch {
        // 跨源子 frame 不能访问 document,跳过
      }
    }
    return null
  }
  return search(document)
}

/**
 * 把图片以 DataTransfer 挂载到 file input 上。
 * file input 可能延迟插入（点完按钮才出现），最多重试 5 秒。
 * 挂载成功返回 true；超时仍未找到 file input 返回 false。
 *
 * 行为与现状一致：命中即挂载、派发 change 事件、异步等待延迟插入。
 */
export interface AttachImageOptions {
  /** 找不到文件输入框时的最长重试等待（毫秒）。默认 5000，兼容 chatgpt/gemini/claude「点完按钮才出现」的场景。 */
  maxMs?: number
  /** 转发给 findFileInput 的候选选择器。默认五平台并集。 */
  candidates?: string[]
  /** 转发给 findFileInput 的递归开关。默认 true。 */
  recurseIframes?: boolean
}

// maxMs：找不到文件输入框时的最长重试等待。默认 5000ms，兼容 chatgpt / gemini / claude
// 等「点完按钮才出现」输入框的平台；传入 0 则只尝试一次、立即返回（豆包走粘贴兜底，无需等待）。
// candidates / recurseIframes 原样转发给 findFileInput，便于各平台恢复原版查找行为。
export async function attachImageToFileInput(file: File, options: AttachImageOptions = {}): Promise<boolean> {
  const { maxMs = 5000, candidates, recurseIframes } = options
  const deadline = Date.now() + maxMs
  for (;;) {
    const input = findFileInput({ candidates, recurseIframes })
    if (input) {
      const dt = new DataTransfer()
      dt.items.add(file)
      try {
        input.files = dt.files
      } catch {
        // 真实浏览器的 DataTransfer.files 即 FileList，赋值直接成功；
        // 个别环境（如 jsdom）的 setter 要求严格 FileList，用 defineProperty 兜底挂载。
        Object.defineProperty(input, 'files', { value: dt.files, configurable: true })
      }
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
