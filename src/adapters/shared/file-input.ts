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

/**
 * 在所有 frame（同源子 frame）里递归查找 file input。
 * 找不到时递归进入子 frame；跨源子 frame 无法访问 document，自动跳过。
 */
export function findFileInput(): HTMLInputElement | null {
  function search(doc: Document): HTMLInputElement | null {
    for (const sel of FILE_INPUT_CANDIDATES) {
      const el = doc.querySelector<HTMLInputElement>(sel)
      if (el) return el
    }
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
export async function attachImageToFileInput(file: File): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < 5000) {
    const input = findFileInput()
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
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}
