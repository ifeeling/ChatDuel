/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OPTIMIZE_PROMPT_URL?: string
  readonly VITE_REMOTE_SELECTOR_CONFIG_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
