import type { ExecutorConversationLeaseRecord } from '@nessie/schemas'

/**
 * The leases a message sent from this composer would carry, which are the
 * only ones it may show: a lease claims reach, and a chip beside a composer
 * whose messages would not carry it tells the person the agent can reach the
 * machine when it cannot. The main composer posts at the top level
 * (`rootMessageId` null), which carries only a lease covering the whole
 * thread; a reply panel also carries the lease launched at its root.
 */
export const executorLeasesCarriedFrom = <Lease extends Pick<ExecutorConversationLeaseRecord, 'rootMessageId' | 'wholeThread'>>(
  leases: readonly Lease[],
  rootMessageId: string | null,
): Lease[] => leases.filter((lease) => lease.wholeThread || lease.rootMessageId === rootMessageId)

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
