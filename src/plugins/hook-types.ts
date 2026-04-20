// Hook event, result, and context types for the plugin hook system
// Adapted from OpenClaw plugin-sdk (https://github.com/openclaw/openclaw/pull/18810)

export interface BeforeToolCallEvent {
  toolName: string
  params: Record<string, unknown>
  toolCallId?: string
}

export interface BeforeToolCallResult {
  blocked?: boolean
  blockReason?: string
  params?: Record<string, unknown>
}

export interface BeforeToolCallContext {
  agentId?: string
  sessionKey?: string
  toolName: string
  toolCallId?: string
}

export interface AfterToolCallEvent {
  toolName: string
  params: Record<string, unknown>
  result?: unknown
  error?: string
  durationMs?: number
  toolCallId?: string
  /** True if before_tool_call blocked this tool call */
  blocked?: boolean
  /** Reason for blocking, if blocked */
  blockReason?: string
}

export interface AfterToolCallContext {
  agentId?: string
  sessionKey?: string
  toolName: string
  toolCallId?: string
}
