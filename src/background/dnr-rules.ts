// declarativeNetRequest 规则:按需启用,把 chatgpt.com / gemini.google.com / doubao.com
// 的 X-Frame-Options 删掉,把它们 CSP 里的 frame-ancestors 改写为允许
// 被 chrome-extension://* 页面嵌入,这样 chat.html 才能用 iframe 嵌官方页面。
//
// ⚠️ 重要:urlFilter 在 modifyHeaders 动作下不接受 `||...^` 这种
// declarativeNetRequest 专用语法,只接受"普通子串匹配"。误用会导致
// updateDynamicRules 静默失败,iframe 嵌入不进去,content script 也没法注入。
// 详见 docs/postmortems/2026-06-09-iframe-no-response.md

const RULE_IDS = { chatgpt: 1, gemini: 2, doubao: 3 } as const

const FRAME_ANCESTORS_VALUE = "frame-ancestors 'self' chrome-extension://*"

type ModifyHeadersRule = chrome.declarativeNetRequest.Rule

function buildChatGPTRule(): ModifyHeadersRule {
  return {
    id: RULE_IDS.chatgpt,
    priority: 1,
    condition: {
      // 普通子串,不要用 "||chatgpt.com^" 那种声明式语法
      urlFilter: 'chatgpt.com',
      resourceTypes: [chrome.declarativeNetRequest.ResourceType.SUB_FRAME, chrome.declarativeNetRequest.ResourceType.MAIN_FRAME],
    },
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      responseHeaders: [
        { header: 'Content-Security-Policy', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: FRAME_ANCESTORS_VALUE },
        { header: 'X-Frame-Options', operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE },
      ],
    },
  }
}

function buildGeminiRule(): ModifyHeadersRule {
  return {
    id: RULE_IDS.gemini,
    priority: 1,
    condition: {
      urlFilter: 'gemini.google.com',
      resourceTypes: [chrome.declarativeNetRequest.ResourceType.SUB_FRAME, chrome.declarativeNetRequest.ResourceType.MAIN_FRAME],
    },
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      responseHeaders: [
        { header: 'Content-Security-Policy', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: FRAME_ANCESTORS_VALUE },
        { header: 'X-Frame-Options', operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE },
      ],
    },
  }
}

function buildDoubaoRule(): ModifyHeadersRule {
  return {
    id: RULE_IDS.doubao,
    priority: 1,
    condition: {
      urlFilter: 'doubao.com',
      resourceTypes: [chrome.declarativeNetRequest.ResourceType.SUB_FRAME, chrome.declarativeNetRequest.ResourceType.MAIN_FRAME],
    },
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      responseHeaders: [
        { header: 'Content-Security-Policy', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: FRAME_ANCESTORS_VALUE },
        { header: 'X-Frame-Options', operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE },
      ],
    },
  }
}

export async function enableEmbedRules(): Promise<void> {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_IDS.chatgpt, RULE_IDS.gemini, RULE_IDS.doubao],
    addRules: [buildChatGPTRule(), buildGeminiRule(), buildDoubaoRule()],
  })
  const rules = await chrome.declarativeNetRequest.getDynamicRules()
  console.log('[AIChatRoom] embed rules enabled, count =', rules.length)
}

export async function disableEmbedRules(): Promise<void> {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_IDS.chatgpt, RULE_IDS.gemini, RULE_IDS.doubao],
  })
  console.log('[AIChatRoom] embed rules disabled')
}
