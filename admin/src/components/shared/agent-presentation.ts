import type { AgentStatus } from '@nessie/schemas'
import type { PillTone } from '../primitives/Pill'

/**
 * The one place mapping `AgentStatus` to a colour, for both the shapes the
 * admin renders it as. `getStatusTone` was duplicated near-verbatim in
 * `AgentDetailPage` and `AgentDetailDrawer`, and `AgentStatusDot` held a third,
 * independent map of the same six-value union. This is the pattern
 * `todos/todo-presentation.ts` already models for to-do statuses.
 */
export const agentStatusTone = (status: AgentStatus): PillTone => {
  switch (status) {
    case 'error':
      return 'danger'
    case 'waiting_approval':
    case 'waiting_input':
      return 'warning'
    case 'idle':
    case 'offline':
      return 'muted'
    case 'executing':
    case 'thinking':
      return 'accent'
  }
}

/** The dot's fill, including the pulse a `Pill` has no equivalent for. */
export const agentStatusDotClass: Record<AgentStatus, string> = {
  error: 'bg-[color:var(--danger)]',
  executing: 'bg-[color:var(--executing)] status-pulse',
  idle: 'bg-[color:var(--muted)]/45',
  offline: 'bg-[color:var(--muted)]/25',
  thinking: 'bg-[color:var(--thinking)] status-pulse',
  waiting_approval: 'bg-[color:var(--warning)]',
  waiting_input: 'bg-[color:var(--warning)]',
}

/** A tool call's outcome: still running, succeeded, or failed. */
export const toolCallOutcomeTone = (success: boolean | undefined): PillTone => {
  if (success === true) return 'success'
  if (success === false) return 'danger'
  return 'warning'
}
