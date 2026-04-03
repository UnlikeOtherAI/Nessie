export type Message = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

export type AppState = {
  isOnline: boolean
  isListening: boolean
  isSpeaking: boolean
  hotwordActive: boolean
  activeAgentId?: string
}

export type ToolResult<T> = {
  data: T
  newMessages?: Message[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext
}

export type ToolUseContext = {
  abortController: AbortController
  messages: Message[]
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  options: {
    tools: Tools
    debug: boolean
  }
}

export type Tools = readonly Tool[]
