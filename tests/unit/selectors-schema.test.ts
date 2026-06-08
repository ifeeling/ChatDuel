import { describe, it, expect } from 'vitest'
import chatgpt from '../../src/adapters/chatgpt/selectors.json'
import gemini from '../../src/adapters/gemini/selectors.json'

interface SelectorFile {
  version: string
  lastVerified: string
  selectors: Record<string, string>
}

function check(file: SelectorFile, name: string) {
  expect(file.version, `${name}.version`).toMatch(/^\d{4}\.\d{2}(\.\d+)?$/)
  expect(file.lastVerified, `${name}.lastVerified`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(file.selectors.inputBox, `${name}.selectors.inputBox`).toBeTruthy()
  expect(file.selectors.sendButton, `${name}.selectors.sendButton`).toBeTruthy()
  expect(file.selectors.messageContainer, `${name}.selectors.messageContainer`).toBeTruthy()
  expect(file.selectors.lastResponse, `${name}.selectors.lastResponse`).toBeTruthy()
}

describe('selectors.json schema', () => {
  it('chatgpt selectors.json has required fields', () => check(chatgpt as SelectorFile, 'chatgpt'))
  it('gemini selectors.json has required fields', () => check(gemini as SelectorFile, 'gemini'))
})
