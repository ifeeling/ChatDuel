// 发送前风险扫描（领域词见 CONTEXT.md，落地追踪 issue #12）。
//
// 本地规则扫描，不联网、不做语义理解：只能可靠识别结构化敏感信息
// （密钥、证件号、卡号、手机号），识别不了没有固定格式的机密文字。
// 供问题发送协调器在实际发送前调用，用来提醒用户，而非阻断发送。

export type SendRiskFindingType =
  | 'api-key'
  | 'private-key'
  | 'id-card'
  | 'bank-card'
  | 'phone-number'
  | 'keyword-secret'

export interface SendRiskFinding {
  type: SendRiskFindingType
  match: string
}

interface ClaimedRange {
  start: number
  end: number
}

function overlapsClaimed(start: number, end: number, claimed: ClaimedRange[]): boolean {
  return claimed.some((range) => start < range.end && end > range.start)
}

/** 命中未与更高优先级检测器认领的区间重叠时，认领并记录一条命中。 */
function recordIfNotClaimed(
  claimed: ClaimedRange[],
  findings: SendRiskFinding[],
  type: SendRiskFindingType,
  start: number,
  end: number,
  match: string,
): void {
  if (overlapsClaimed(start, end, claimed)) return
  claimed.push({ start, end })
  findings.push({ type, match })
}

// ---------- 已知格式前缀 ----------

const KNOWN_KEY_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/g, // OpenAI 等厂商常用的 sk- 前缀密钥
  /AKIA[0-9A-Z]{16}/g, // AWS Access Key ID
  /gh[pousr]_[A-Za-z0-9]{36,}/g, // GitHub 个人访问令牌（ghp_/gho_/ghu_/ghs_/ghr_）
]

const PRIVATE_KEY_HEADER_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g

function scanKnownPrefixes(text: string, claimed: ClaimedRange[]): SendRiskFinding[] {
  const findings: SendRiskFinding[] = []
  for (const pattern of KNOWN_KEY_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0
      recordIfNotClaimed(claimed, findings, 'api-key', start, start + match[0].length, match[0])
    }
  }
  for (const match of text.matchAll(PRIVATE_KEY_HEADER_PATTERN)) {
    const start = match.index ?? 0
    recordIfNotClaimed(claimed, findings, 'private-key', start, start + match[0].length, match[0])
  }
  return findings
}

// ---------- 身份证号校验位（GB 11643-1999） ----------

const ID_CARD_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
const ID_CARD_CHECK_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']
const ID_CARD_CANDIDATE_PATTERN = /(?<![0-9Xx])\d{17}[0-9Xx](?![0-9Xx])/g

function isValidIdCard(candidate: string): boolean {
  const digits = candidate.slice(0, 17)
  const checkChar = candidate[17].toUpperCase()
  let sum = 0
  for (let i = 0; i < 17; i += 1) {
    sum += Number(digits[i]) * ID_CARD_WEIGHTS[i]
  }
  return ID_CARD_CHECK_CODES[sum % 11] === checkChar
}

function scanIdCards(text: string, claimed: ClaimedRange[]): SendRiskFinding[] {
  const findings: SendRiskFinding[] = []
  for (const match of text.matchAll(ID_CARD_CANDIDATE_PATTERN)) {
    const candidate = match[0]
    if (!isValidIdCard(candidate)) continue
    const start = match.index ?? 0
    recordIfNotClaimed(claimed, findings, 'id-card', start, start + candidate.length, candidate)
  }
  return findings
}

// ---------- 银行卡号 Luhn 校验 ----------

const BANK_CARD_CANDIDATE_PATTERN = /(?<!\d)\d{13,19}(?!\d)/g

function isValidLuhn(candidate: string): boolean {
  let sum = 0
  let shouldDouble = false
  for (let i = candidate.length - 1; i >= 0; i -= 1) {
    let digit = Number(candidate[i])
    if (shouldDouble) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    shouldDouble = !shouldDouble
  }
  return sum % 10 === 0
}

function scanBankCards(text: string, claimed: ClaimedRange[]): SendRiskFinding[] {
  const findings: SendRiskFinding[] = []
  for (const match of text.matchAll(BANK_CARD_CANDIDATE_PATTERN)) {
    const candidate = match[0]
    if (!isValidLuhn(candidate)) continue
    const start = match.index ?? 0
    recordIfNotClaimed(claimed, findings, 'bank-card', start, start + candidate.length, candidate)
  }
  return findings
}

// ---------- 手机号（中国大陆） ----------

const PHONE_NUMBER_PATTERN = /(?<!\d)1[3-9]\d{9}(?!\d)/g

function scanPhoneNumbers(text: string, claimed: ClaimedRange[]): SendRiskFinding[] {
  const findings: SendRiskFinding[] = []
  for (const match of text.matchAll(PHONE_NUMBER_PATTERN)) {
    const start = match.index ?? 0
    recordIfNotClaimed(claimed, findings, 'phone-number', start, start + match[0].length, match[0])
  }
  return findings
}

// ---------- 关键词上下文 + 信息熵 ----------
// 定位「密码：」「身份证号：」这类标签紧跟的值，用信息熵过滤掉空泛/占位回答
// （"无"、"aaaaaaaa" 这类），不要求识别值本身是不是真的强密码。

// 全部是字面量关键词（不是正则片段），统一转义后再拼进正则源串，
// 避免以后新增含正则元字符的关键词时静默出错。
const SENSITIVE_KEYWORDS = [
  '密码', '口令', '身份证号', '身份证', '银行卡号', '卡号', '密钥', '令牌',
  'password', 'secret', 'token', 'api key', 'apikey',
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 值字符集：排除中日韩表意文字、常见中英文标点与空白，避免贪婪吃进后续的
// 中文句子（中文不靠空格分词，"\S" 会把标点后的整句都算进值里）。
const KEYWORD_VALUE_CHAR = '[^\\s\\u4e00-\\u9fff，。！？；：、,.!?;:]'
const KEYWORD_CONTEXT_PATTERN = new RegExp(
  `(?:${SENSITIVE_KEYWORDS.map(escapeRegExp).join('|')})\\s*[:：]\\s*(${KEYWORD_VALUE_CHAR}{3,128})`,
  'gi',
)

const KEYWORD_SECRET_MIN_LENGTH = 6
const KEYWORD_SECRET_MIN_ENTROPY = 1.0

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>()
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / value.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

function scanKeywordSecrets(text: string, claimed: ClaimedRange[]): SendRiskFinding[] {
  const findings: SendRiskFinding[] = []
  for (const match of text.matchAll(KEYWORD_CONTEXT_PATTERN)) {
    const value = match[1]
    const valueStart = (match.index ?? 0) + match[0].length - value.length
    const valueEnd = valueStart + value.length
    if (value.length < KEYWORD_SECRET_MIN_LENGTH) continue
    if (shannonEntropy(value) < KEYWORD_SECRET_MIN_ENTROPY) continue
    recordIfNotClaimed(claimed, findings, 'keyword-secret', valueStart, valueEnd, value)
  }
  return findings
}

/**
 * 对待发送文本做本地规则扫描，识别可能的结构化敏感信息。
 * 各检测器按优先级顺序运行，后运行的检测器跳过已被更高优先级检测器
 * 认领的字符区间（例如校验通过的 18 位身份证号不会再被计入银行卡号）。
 */
export function scanForSendRisk(text: string): SendRiskFinding[] {
  const claimed: ClaimedRange[] = []
  return [
    ...scanKnownPrefixes(text, claimed),
    ...scanIdCards(text, claimed),
    ...scanBankCards(text, claimed),
    ...scanPhoneNumbers(text, claimed),
    ...scanKeywordSecrets(text, claimed),
  ]
}
