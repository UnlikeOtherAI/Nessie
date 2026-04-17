// Hook event, result, and context types for the plugin hook system

export interface BeforeToolCallEvent {
  toolName: string
  params: Record<string, unknown>
}

export interface BeforeToolCallResult {
  block?: boolean
  blockReason?: string
}

export interface BeforeToolCallContext {
  agentId?: string
  sessionKey?: string
  toolName: string
}

export interface AfterToolCallEvent {
  toolName: string
  params: Record<string, unknown>
  result?: unknown
  error?: string
  durationMs?: number
  blocked?: boolean
  blockReason?: string
}

export interface AfterToolCallContext {
  agentId?: string
  sessionKey?: string
  toolName: string
}