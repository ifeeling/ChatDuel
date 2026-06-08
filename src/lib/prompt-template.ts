export interface PromptTemplates {
  review: string
  summary: string
  rebut: string
  simplify: string
}

export function getDefaultTemplates(): PromptTemplates {
  return {
    review: `下面是另一个 AI 的回答，请你帮我审查：

1. 哪些地方可能是错的？
2. 哪些地方说得太笼统？
3. 有没有遗漏？
4. 请给出你认为更准确的版本。

以下是对方的回答：

{{response}}`,
    summary: `请总结下面两个 AI 的回答差异：

【AI A 的回答】
{{responseA}}

【AI B 的回答】
{{responseB}}

输出结构：
1. 两边共同认可的结论
2. 两边说法不同的地方
3. 哪些内容需要进一步确认
4. 最后更建议采用哪种方案`,
    rebut: `请以最强反驳姿态针对下面这段 AI 回答提出质疑，找出逻辑漏洞、事实错误和遗漏：

{{response}}`,
    simplify: `请用更简单、更口语化的话重写下面这段 AI 回答，让普通人也能听懂：

{{response}}`,
  }
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const v = vars[key]
    return v !== undefined ? v : match
  })
}
