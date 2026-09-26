import type { AgentStatus } from '@nessie/schemas'
import type { PillTone } from '../primitives/Pill'

/**
 * An agent's status as a dot. Its words and its pill tone are
 * `lib/status-sentences.ts` → `agentStatusSentence`, the one place every
 * status is said; the dot keeps a map of its own only for the pulse a `Pill`
 * has no equivalent for.
 */
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
