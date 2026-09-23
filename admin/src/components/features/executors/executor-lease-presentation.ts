import type { ExecutorConversationLeaseRecord } from '@nessie/schemas'

/** "21:40" in the reader's own clock; a lease never outlives twelve hours. */
export const executorLeaseUntil = (expiresAt: string): string =>
  new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * "Minis · local apps · until 21:40". The agent is named only when the reader
 * holds leases with more than one agent in this conversation, because only
 * then does the line need telling apart.
 */
export const executorLeaseLabel = (
  lease: Pick<ExecutorConversationLeaseRecord, 'executorLabel' | 'expiresAt'>,
  agentName?: string | null,
): string => [
  ...(agentName ? [agentName] : []),
  lease.executorLabel,
  'local apps',
  `until ${executorLeaseUntil(lease.expiresAt)}`,
].join(' · ')

/** Spelled out for the title and the End button, where a glance is not enough. */
export const executorLeaseDescription = (
  lease: Pick<ExecutorConversationLeaseRecord, 'executorLabel' | 'expiresAt'>,
  agentName?: string | null,
): string => `${agentName ?? 'The agent'} can use local apps on ${lease.executorLabel} for your own `
  + `messages in this conversation until ${executorLeaseUntil(lease.expiresAt)}, or until you end it.`
