// declarativeNetRequest 规则:按需启用,把 chatgpt.com / gemini.google.com /
// doubao.com / chat.deepseek.com 的 X-Frame-Options 删掉,把它们 CSP 里的
// frame-ancestors 改写为允许
// 被 chrome-extension://* 页面嵌入,这样 chat.html 才能用 iframe 嵌官方页面。
//
// 详见 docs/postmortems/2026-06-09-iframe-no-response.md

const RULE_IDS = { chatgpt: 1, gemini: 2, claude: 3, doubao: 4, deepseek: 5 } as const
const REMOVE_RULE_IDS = [1, 2, 3, 4, 5, 6, 7, 8]

type ModifyHeadersRule = chrome.declarativeNetRequest.Rule
const SUB_FRAME = 'sub_frame' as chrome.declarativeNetRequest.ResourceType
const MODIFY_HEADERS = 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType
const SET_HEADER = 'set' as chrome.declarativeNetRequest.HeaderOperation
const REMOVE_HEADER = 'remove' as chrome.declarativeNetRequest.HeaderOperation

export function getEmbedRuleCleanupIds(): number[] {
  return [...REMOVE_RULE_IDS]
}

export function getFrameAncestorsValue(): string {
  return "frame-ancestors 'self' chrome-extension://*"
}

function hostFilter(host: string): string {
  return `||${host}/*`
}

function buildRule(id: number, host: string, frameAncestorsValue: string): ModifyHeadersRule {
  return {
    id,
    priority: 1,
    condition: {
      urlFilter: hostFilter(host),
      resourceTypes: [SUB_FRAME],
    },
    action: {
      type: MODIFY_HEADERS,
      responseHeaders: [
        { header: 'Content-Security-Policy', operation: SET_HEADER, value: frameAncestorsValue },
        { header: 'X-Frame-Options', operation: REMOVE_HEADER },
      ],
    },
  }
}

export function buildEmbedRules(frameAncestorsValue: string): ModifyHeadersRule[] {
  return [
    buildRule(RULE_IDS.chatgpt, 'chatgpt.com', frameAncestorsValue),
    buildRule(RULE_IDS.gemini, 'gemini.google.com', frameAncestorsValue),
    buildRule(RULE_IDS.doubao, 'doubao.com', frameAncestorsValue),
    buildRule(RULE_IDS.claude, 'claude.ai', frameAncestorsValue),
    buildRule(RULE_IDS.deepseek, 'chat.deepseek.com', frameAncestorsValue),
  ]
}

export async function enableEmbedRules(): Promise<void> {
  const frameAncestorsValue = getFrameAncestorsValue()
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: REMOVE_RULE_IDS,
    addRules: buildEmbedRules(frameAncestorsValue),
  })
  const rules = await chrome.declarativeNetRequest.getDynamicRules()
  console.log('[AIChatRoom] embed rules enabled, count =', rules.length)
}

export async function disableEmbedRules(): Promise<void> {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: REMOVE_RULE_IDS,
  })
  console.log('[AIChatRoom] embed rules disabled')
}
