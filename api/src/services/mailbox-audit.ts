/**
 * Lifecycle audit metadata is deliberately structural. Mail addresses,
 * passwords, usernames, and server settings are personal/secret content and
 * never belong in the durable audit stream.
 */
export const connectedMailboxAuditMetadata = (scope: 'team' | 'user') => ({ scope })

export const agentMailboxAuditMetadata = {
  created: (agentId: string) => ({ agentId }),
  retired: () => ({ addressRetired: true }),
  updated: (sendPolicy: string) => ({ sendPolicy }),
}
