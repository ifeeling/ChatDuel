// 开发者自用的调试提醒：某个平台的关键选择器（输入框/发送按钮/回答容器/停止按钮，
// 也就是 remote-selector-config.ts 里能被服务器端热更新覆盖的那几个字段）在页面上
// 完全找不到目标元素，或者像豆包的"停止生成"信号那样没法确认、只能退回保守的
// 静默超时兜底——两种情况都说明对应网站大概率又改版了，内置默认值/远程热更新
// 配置该更新了。这个开关默认关闭、不在设置界面里暴露，只有开发者自己通过
// devtools 控制台手动打开：
//   chrome.storage.local.set({ [DEBUG_NOTIFY_FALLBACK_KEY]: true })
// 通知完全走浏览器本地 Notification API，不发送任何网络请求、不上传任何数据，
// 跟 PRIVACY.md「不收集用户数据」的承诺没有冲突——普通用户默认不会开启这个开关，
// 也就永远不会触发这条代码路径。
export const DEBUG_NOTIFY_FALLBACK_KEY = 'chatduelDebugNotifyFallbackCompletion'

async function debugNotifyFallbackEnabled(): Promise<boolean> {
  try {
    if (typeof chrome === 'undefined' || !chrome?.storage?.local) return false
    const result = await chrome.storage.local.get(DEBUG_NOTIFY_FALLBACK_KEY)
    return result?.[DEBUG_NOTIFY_FALLBACK_KEY] === true
  } catch {
    return false
  }
}

function fireLocalNotification(title: string, body: string): void {
  try {
    if (typeof Notification === 'undefined') return
    const show = () => {
      try {
        new Notification(title, { body })
      } catch {
        /* 通知失败不影响正常抓取流程 */
      }
    }
    if (Notification.permission === 'granted') {
      show()
    } else if (Notification.permission === 'default') {
      void Notification.requestPermission().then((permission) => {
        if (permission === 'granted') show()
      })
    }
  } catch {
    /* 调试专用，任何异常都静默忽略 */
  }
}

/**
 * title/body 由调用方拼好——本模块只负责"该不该提醒"（开关有没有开）和
 * "怎么提醒"（本地 Notification），不关心具体是哪个平台/哪个选择器出的问题。
 * fire-and-forget：不 await 这个函数，不能让调试通知拖慢正常的完成判定/诊断上报。
 */
export function notifyDebugAlert(title: string, body: string): void {
  void (async () => {
    if (!(await debugNotifyFallbackEnabled())) return
    fireLocalNotification(title, body)
  })()
}
