import type { PrismaClient } from '@prisma/client'
import { canUserReadDisclosureBasis } from '@nessie/runtime'
import type { UoaSessionIdentity } from '@nessie/schemas'
import type { AgentVisibilityScope } from '@nessie/team-admin'

import { canUserReadRunBasis } from './run-disclosure.js'

export type DisclosureAgentVisibilityScope = AgentVisibilityScope & {
  uoaIdentity: UoaSessionIdentity | undefined
}

/**
 * Agent ownership and ordinary channel visibility decide whether a person can
 * find a run. Provenance decides whether they can read what that run learned.
 */
export const filterReadableAgentRuns = async <TRun extends { id: string }>(
  prisma: PrismaClient,
  runs: readonly TRun[],
  visibility?: DisclosureAgentVisibilityScope,
): Promise<TRun[]> => {
  if (runs.length === 0) return []

  if (!visibility) {
    // A caller without a human viewer can only receive the public outcome.
    const results = await Promise.all(runs.map(async (run) => ({
      run,
      basis: await prisma.runBasisScope.findMany({
        where: { runId: run.id },
        select: { id: true },
        take: 1,
      }),
    })))
    return results.filter(({ basis }) => basis.length === 0).map(({ run }) => run)
  }

  const results = await Promise.all(runs.map(async (run) => ({
    readable: await canUserReadRunBasis(prisma, {
      organizationId: visibility.organizationId,
      runId: run.id,
      uoaIdentity: visibility.uoaIdentity,
      userId: visibility.userId,
    }),
    run,
  })))
  return results.filter(({ readable }) => readable).map(({ run }) => run)
}

export type AgentMessageDisclosureCandidate = {
  agentId: string | null
  basisScopes: Array<{ scopeId: string; scopeType: string }>
  disclosureSources: Array<{ sourceAuthorUserId: string | null; sourceChannelId: string }>
  id: string
  thread: { channelId: string }
}

export const canReadAgentMessage = async (
  prisma: PrismaClient,
  message: AgentMessageDisclosureCandidate,
  visibility?: DisclosureAgentVisibilityScope,
): Promise<boolean> => {
  if (message.basisScopes.length === 0) return true
  if (!visibility) return false

  return canUserReadDisclosureBasis(prisma, {
    agentId: message.agentId,
    basis: message.basisScopes,
    channelId: message.thread.channelId,
    disclosureSources: message.disclosureSources,
    messageId: message.id,
    organizationId: visibility.organizationId,
    uoaIdentity: visibility.uoaIdentity,
    userId: visibility.userId,
  })
}
