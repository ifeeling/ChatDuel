import defaultPrompts from '../config/prompts.json'

export interface PromptTemplates {
  review: string
  summary: string
  rebut: string
  simplify: string
  transfer: string
}

// hardcode 兜底默认值。优先级最低:配置文件加载不到 / 加载失败时使用。
// 注意这里只放 transfer 一个最常用的(因为如果配置加载失败,大部分场景只会用到它);
// 其余 4 个保持和 prompts.json 一致(由配置加载)。
const FALLBACK_TEMPLATES: PromptTemplates = {
  review: '下面是另一个 AI 的回答，请你帮我审查：\n\n1. 哪些地方可能是错的？\n2. 哪些地方说得太笼统？\n3. 有没有遗漏？\n4. 请给出你认为更准确的版本。\n\n以下是对方的回答：\n\n{{response}}',
  summary: '下面是多个 AI 关于同一个问题的回答记录。\n\n请你综合这些内容，输出一个最终结论。\n\n要求：\n1. 先列出各方都认可的结论\n2. 再列出有分歧、矛盾或侧重点不同的地方\n3. 标出哪些内容需要进一步确认\n4. 去掉重复、空话和不确定表达\n5. 最后给出一版清晰、完整、可直接使用的最终答案\n\n【历史记录】\n{{historyBlock}}\n\n请按下面结构输出：\n\n## 共同结论\n\n## 分歧与风险\n\n## 需要进一步确认\n\n## 最终建议',
  rebut: '请以最强反驳姿态针对下面这段 AI 回答提出质疑，找出逻辑漏洞、事实错误和遗漏：\n\n{{response}}',
  simplify: '请用更简单、更口语化的话重写下面这段 AI 回答，让普通人也能听懂：\n\n{{response}}',
  transfer: '下面是一段来自 {{fromLabel}} 的回答，供你参考。\n\n请你**独立地**基于这个主题给出自己的回答：\n- 如果你认为对方的观点有问题，请明确指出并说明理由\n- 如果你认为对方说得对，可以补充更多细节、证据或案例\n- 不必同意也不必反对，只给出你认为**最准确**的版本\n\n⚠️ 下面是引用内容（请勿在回复中复述这段前缀）：\n\n==== 引用开始 ({{fromLabel}}) ====\n{{content}}\n==== 引用结束 ====\n\n接下来，请直接给出你的回应：',
}

// 配置加载缓存:异步加载完成后填充。
// 同步调用方(getDefaultTemplates)先拿到 FALLBACK,加载完后下次调用拿到新值。
let cachedTemplates: PromptTemplates | null = null

/**
 * 同步获取模板:返回当前已加载的版本;尚未加载完成时返回 hardcode 兜底。
 * 调用方拿到的是"当前最新"的模板,可能在调用瞬间被异步加载覆盖。
 *
 * 注意:对调用方不保证永远引用同一个对象。如果调用方需要稳定引用,
 * 请在调用瞬间把字符串值存到本地变量(见 chat.ts 的 transferTemplate 用法)。
 */
export function getDefaultTemplates(): PromptTemplates {
  return cachedTemplates ?? FALLBACK_TEMPLATES
}

/**
 * 异步加载配置文件,更新缓存。失败时静默保留 FALLBACK。
 * 在模块加载时自动触发一次,通常调用方不需要手动调。
 */
export async function loadTemplates(): Promise<void> {
  try {
    const fromJson = defaultPrompts as Partial<PromptTemplates>
    // 简单校验:5 个字段必须都是非空字符串
    const required: (keyof PromptTemplates)[] = ['review', 'summary', 'rebut', 'simplify', 'transfer']
    for (const k of required) {
      if (typeof fromJson[k] !== 'string' || (fromJson[k] as string).length === 0) {
        throw new Error(`prompts.json 缺少或字段类型错误: ${k}`)
      }
    }
    cachedTemplates = fromJson as PromptTemplates
  } catch (err) {
    // 加载失败:保留 FALLBACK,console 打一行警告方便排查
    console.warn('[AIChatRoom] 加载 prompts.json 失败,使用 fallback:', err)
  }
}

// 模块加载时立即触发异步加载(后台跑,不阻塞)
// 用 void 明确忽略 promise
void loadTemplates()

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const v = vars[key]
    return v !== undefined ? v : match
  })
}
