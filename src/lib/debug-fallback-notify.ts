// 开发者自用的调试提醒：某个平台的回答完成判定，如果没能靠可靠信号
// （比如豆包的打断按钮/操作栏跳变）快速确认，退回了保守的静默超时兜底，
// 说明该平台官网很可能又改版、内置选择器该更新了——这个开关默认关闭、
// 不在设置界面里暴露，只有开发者自己通过 devtools 控制台手动打开：
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
 * 平台名 + 一句人话描述用来区分"哪个信号没等到"，调用方各自传入自己的文案。
 * fire-and-forget：不 await 这个函数，不能让调试通知拖慢正常的完成判定返回。
 */
export function notifyFallbackCompletionIfDebugEnabled(platformLabel: string, reason: string): void {
  void (async () => {
    if (!(await debugNotifyFallbackEnabled())) return
    fireLocalNotification(`${platformLabel}完成判定用了静默超时兜底`, reason)
  })()
}
