import type { PrismaClient } from '@prisma/client'
import { canUserReadDisclosureBasis } from '@nessie/runtime'

import { canUserReadRunBasis } from './run-disclosure.js'

/**
 * Tasks and plans can retain text supplied to a run before it writes a reply.
 * They therefore inherit the run's channel entitlement as well as its durable
 * disclosure basis. An organisation role and agent stewardship never replace
 * membership of a non-public source channel here.
 */
export const canUserReadRunDerivedRecord = async (
  prisma: PrismaClient,
  input: { organizationId: string; runId: string | null; userId: string },
): Promise<boolean> => {
  if (!input.runId) return true

  const run = await prisma.run.findFirst({
    where: {
      id: input.runId,
      thread: {
        channel: {
          organizationId: input.organizationId,
          OR: [
            { visibility: 'public' },
            { members: { some: { userId: input.userId } } },
          ],
        },
      },
    },
    select: {
      agentId: true,
      id: true,
      thread: { select: { channelId: true } },
      triggerMessage: {
        select: {
          basisScopes: { select: { scopeId: true, scopeType: true } },
          disclosureSources: { select: { sourceAuthorUserId: true, sourceChannelId: true } },
          id: true,
        },
      },
    },
  })
  if (!run) return false

  // RunBasisScope is normally persisted with the first response. A hidden
  // delegation trigger can already have a stamped basis while the run is still
  // planning, so metadata created during that interval must read the trigger's
  // durable provenance directly rather than briefly publishing its prompt.
  const trigger = run.triggerMessage
  if (trigger && trigger.basisScopes.length > 0 && !(await canUserReadDisclosureBasis(prisma, {
    agentId: run.agentId,
    basis: trigger.basisScopes,
    channelId: run.thread.channelId,
    disclosureSources: trigger.disclosureSources,
    messageId: trigger.id,
    organizationId: input.organizationId,
    userId: input.userId,
  }))) return false

  return canUserReadRunBasis(prisma, {
    organizationId: input.organizationId,
    runId: run.id,
    userId: input.userId,
  })
}
