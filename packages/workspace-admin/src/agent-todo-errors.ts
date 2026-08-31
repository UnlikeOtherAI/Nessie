export const AGENT_TODO_ERROR_CODES = {
  CANCELLED: 'AGENT_TODO_CANCELLED',
  HUMAN_TERMINAL_STATUS: 'AGENT_TODO_HUMAN_TERMINAL_STATUS',
  NOT_CANCELLABLE: 'AGENT_TODO_NOT_CANCELLABLE',
  NOT_FOUND: 'AGENT_TODO_NOT_FOUND',
  STEP_NOT_FOUND: 'AGENT_TODO_STEP_NOT_FOUND',
  TEMPLATE_CHANGED: 'AGENT_TODO_TEMPLATE_CHANGED',
  TEMPLATE_NOT_FOUND: 'AGENT_TODO_TEMPLATE_NOT_FOUND',
  TEMPLATE_UNAVAILABLE: 'AGENT_TODO_TEMPLATE_UNAVAILABLE',
} as const

export type AgentTodoErrorCode =
  (typeof AGENT_TODO_ERROR_CODES)[keyof typeof AGENT_TODO_ERROR_CODES]

export class AgentTodoError extends Error {
  override readonly name = 'AgentTodoError'

  constructor(
    public readonly code: AgentTodoErrorCode,
    message: string,
  ) {
    super(message)
  }
}
