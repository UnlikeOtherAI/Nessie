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

import type { PathPermissions } from '../agent/types.js'

export type ToolUseContext = {
  abortController: AbortController
  messages: Message[]
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  options: {
    tools: Tools
    debug: boolean
    /** Optional per-agent path permissions for file access tools. */
    agentPathPermissions?: PathPermissions
  }
}

export type Tools = readonly import('./Tool.js').Tool[]

export type ToolUseBlock = {
  id: string
  name: string
  input: Record<string, unknown>
}
