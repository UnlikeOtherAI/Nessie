import {
  ExecutorCapabilityDescriptorSchema,
  ExecutorLocalMcpReportSchema,
  type ExecutorLocalMcpReport,
} from '@nessie/schemas'

/**
 * What one stored capability revision looks like to a reviewer.
 *
 * Three fields follow the same rule and it is the whole subtlety here: each is
 * carried only when the signed descriptor carried it, because an absent key is
 * the only projection that distinguishes "named none" — which permits none —
 * from a descriptor signed before that field existed. An empty array would be
 * a third reading of a two-state fact.
 */
export const descriptorRevisionViews = (
  revisions: readonly {
    descriptor: unknown
    localPolicyDigest: string
    reviewStatus: 'pending_review' | 'active' | 'disabled'
    revision: number
  }[],
) => revisions.flatMap((revision) => {
      const descriptor = ExecutorCapabilityDescriptorSchema.safeParse(revision.descriptor)
      return descriptor.success
        ? [{
            // Carried only when the descriptor carried it: a descriptor signed
            // before the allowlist existed names no program, and an absent key
            // is the only projection that says so.
            ...(descriptor.data.commandAllowlist
              ? { commandAllowlist: descriptor.data.commandAllowlist }
              : {}),
            localPolicyDigest: revision.localPolicyDigest,
            operationKeys: descriptor.data.operationKeys,
            profiles: descriptor.data.profiles,
            reviewStatus: revision.reviewStatus,
            revision: revision.revision,
            // Same rule as the allowlist: an absent key is how a descriptor
            // signed before folders had names says it named none.
            ...(descriptor.data.workspaceFolders
              ? { workspaceFolders: descriptor.data.workspaceFolders }
              : {}),
            // Same rule again: an absent key is how a descriptor that named no
            // local MCP server says so, and naming none permits none.
            ...(descriptor.data.mcpServers
              ? { mcpServers: descriptor.data.mcpServers }
              : {}),
            // And once more: absent is how a descriptor that does not offer
            // the coding bridge says so.
            ...(descriptor.data.codingSessions
              ? { codingSessions: descriptor.data.codingSessions }
              : {}),
          }]
        : []
    })

/**
 * The stored heartbeat report, echoed only when it parses.
 *
 * SQL NULL means this executor has never reported, which is a different fact
 * from a stored empty array — a daemon that reports and names no server — and
 * the absent key is the only projection that says the first one. A report this
 * release cannot parse is dropped whole rather than half-rendered: it can only
 * come from a daemon speaking a grammar we do not know, and a partial reading
 * of it would be a guess.
 */
export const localMcpFor = (
  stored: unknown,
  observedAt: Date | null,
): { localMcp?: ExecutorLocalMcpReport; localMcpObservedAt?: string } => {
  if (stored === null || stored === undefined) return {}
  const parsed = ExecutorLocalMcpReportSchema.safeParse(stored)
  if (!parsed.success) return {}
  return {
    localMcp: parsed.data,
    ...(observedAt === null ? {} : { localMcpObservedAt: observedAt.toISOString() }),
  }
}
