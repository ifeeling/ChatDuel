import defaultPrompts from '../config/prompts.json'
import { DEFAULT_PROMPTS_BY_LANGUAGE, type UserLanguage } from './i18n'

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
  ...DEFAULT_PROMPTS_BY_LANGUAGE['zh-CN'],
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

export function getDefaultTemplatesForLanguage(language: UserLanguage): PromptTemplates {
  if (language === 'zh-CN') return getDefaultTemplates()
  return DEFAULT_PROMPTS_BY_LANGUAGE[language] ?? DEFAULT_PROMPTS_BY_LANGUAGE['en-US']
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
