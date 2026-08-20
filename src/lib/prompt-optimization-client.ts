export const OPTIMIZE_PROMPT_URL =
  import.meta.env.VITE_OPTIMIZE_PROMPT_URL ?? 'https://chatduel.ifeeling.app/api/extension/optimize-prompt'

export type OptimizePromptOutcome =
  | { kind: 'success'; text: string; remainingToday: number }
  | { kind: 'quota_exceeded' }
  | { kind: 'error' }

export interface RequestPromptOptimizationInput {
  prompt: string
  deviceId: string
  extensionVersion: string
}

export async function requestPromptOptimization(input: RequestPromptOptimizationInput): Promise<OptimizePromptOutcome> {
  try {
    const response = await fetch(OPTIMIZE_PROMPT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ChatDuel-Device-Id': input.deviceId,
        'X-ChatDuel-Version': input.extensionVersion,
      },
      body: JSON.stringify({ prompt: input.prompt }),
    })
    if (response.status === 429) return { kind: 'quota_exceeded' }
    if (!response.ok) return { kind: 'error' }

    const data = await response.json()
    if (typeof data.text !== 'string' || typeof data.remainingToday !== 'number') return { kind: 'error' }
    return { kind: 'success', text: data.text, remainingToday: data.remainingToday }
  } catch {
    return { kind: 'error' }
  }
}
