import type { PrismaClient } from '@prisma/client'
import type {
  AttentionDispatchJobPayload,
  OrchestrateDecideJobPayload,
  PushDispatchJobPayload,
} from '@nessie/schemas'
import { withDelegatedSystemDmIdentity } from '@nessie/schemas'
import { enqueueQueueJob } from '@nessie/db'

// The raw queue insert + run.execute enqueue live in `@nessie/db` (shared with
// the worker and with the thread-serialization claim/drain seam); re-exported
// here so existing API call sites keep their import path.
export { enqueueQueueJob, enqueueRunExecution } from '@nessie/db'

/**
 * Waking an agent from a live human turn — and the one place the delegated
 * identity a single-member system DM implies is stamped.
 *
 * Three routes reach this: a typed message, an agent-card press, and an
 * invited agent's mention replay. The stamp used to live at the first of them
 * only, so the Agent Designer — whose whole interaction style is card-driven —
 * lost every identity-delegated tool exactly where it is most used, and said
 * so truthfully. Resolving the destination here, from the channel id the
 * payload already carries, is what makes a fourth wake path correct without
 * its author having to know this rule exists.
 *
 * One indexed read per agent-waking message. It is deliberately not optional:
 * a caller-supplied `systemChannelType` would be exactly the thing a new path
 * forgets to pass.
 */
export const enqueueOrchestrateDecide = async (
  prisma: Pick<PrismaClient, '$executeRaw' | 'channel'>,
  payload: OrchestrateDecideJobPayload,
  idempotencyKey?: string,
): Promise<boolean> => {
  const destination = await prisma.channel.findUnique({
    select: { systemChannelType: true },
    where: { id: payload.channelId },
  })
  return enqueueQueueJob(prisma, {
    idempotencyKey,
    payload: {
      ...payload,
      actorContext: withDelegatedSystemDmIdentity(payload.actorContext, {
        systemChannelType: destination?.systemChannelType ?? null,
      }),
    },
    topic: 'orchestrate.decide',
  })
}

export const enqueuePushDispatch = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  payload: PushDispatchJobPayload,
  idempotencyKey?: string,
): Promise<boolean> => {
  return enqueueQueueJob(prisma, {
    idempotencyKey,
    payload,
    topic: 'push.dispatch',
  })
}

export const enqueueAttentionDispatch = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  payload: AttentionDispatchJobPayload,
): Promise<boolean> => {
  return enqueueQueueJob(prisma, {
    idempotencyKey: `attention:${payload.alertId}`,
    payload,
    topic: 'attention.dispatch',
  })
}
